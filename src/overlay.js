// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

/* The Super+V panel.
 *
 * Lives in the shell's uiGroup with a modal grab, so it draws over whatever is
 * on screen — fullscreen windows included — instead of being confined to the
 * top bar the way a panel-menu extension would be. Opens at the pointer, like
 * the Windows clipboard opens at the caret.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClipboardTab, GifTab} from './tabs.js';
import {EmojiTab, KaomojiTab, SymbolTab} from './glyphTab.js';
import {sendPaste} from './paste.js';

const SEARCH_DEBOUNCE_MS = 90;
const TAB_IDS = ['clipboard', 'gif', 'emoji', 'kaomoji', 'symbols'];

export class Overlay {
    constructor({settings, store, monitor, openPrefs}) {
        this.settings = settings;
        this.store = store;
        this.monitor = monitor;
        this._openPrefs = openPrefs;

        this._panel = null;
        this._grab = null;
        this._selected = -1;
        this._searchSource = 0;
        this._tabs = [];
        this._activeTab = null;
    }

    get isOpen() {
        return !!this._grab;
    }

    get activeTab() {
        return this._activeTab;
    }

    /** Width available to a tab's content, used to work out grid columns. */
    get contentWidth() {
        return this.settings.get_int('panel-width') - 28;
    }

    // ---------------------------------------------------------------- build

    _build() {
        this._panel = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'winclip-panel',
            reactive: true,
            can_focus: true,
            visible: false,
        });

        // -- tab bar
        const bar = new St.BoxLayout({style_class: 'winclip-tabbar', x_expand: true});
        this._tabs = [new ClipboardTab(this), new GifTab(this), new EmojiTab(this),
            new KaomojiTab(this), new SymbolTab(this)];
        this._tabButtons = this._tabs.map((tab, i) => {
            const button = new St.Button({
                style_class: 'winclip-tab',
                label: tab.title,
                x_expand: true,
            });
            button.connect('clicked', () => this.selectTab(i));
            bar.add_child(button);
            return button;
        });

        const prefs = new St.Button({
            style_class: 'winclip-icon-button',
            child: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 16}),
        });
        prefs.connect('clicked', () => {
            this.close();
            this._openPrefs();
        });
        bar.add_child(prefs);
        this._panel.add_child(bar);

        // -- search
        this._search = new St.Entry({
            style_class: 'winclip-search',
            hint_text: 'Search',
            can_focus: true,
            x_expand: true,
        });
        this._search.set_primary_icon(
            new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 14}));
        this._search.clutter_text.connect('text-changed', () => this._onSearchChanged());
        this._search.clutter_text.connect('activate', () => this._activateSelected());
        this._panel.add_child(this._search);

        // -- content
        this._content = new St.Bin({x_expand: true, y_expand: true});
        this._panel.add_child(this._content);

        this._footer = new St.Label({
            style_class: 'winclip-footer',
            text: '↵ paste   ·   Ctrl+P pin   ·   Del remove   ·   Tab switches',
        });
        this._panel.add_child(this._footer);

        this._panel.connect('key-press-event', (_a, event) => this._onKeyPress(event));
        this._panel.connect('button-press-event', (_a, event) => {
            const [x, y] = event.get_coords();
            const [px, py] = this._panel.get_transformed_position();
            const inside = x >= px && x <= px + this._panel.width &&
                           y >= py && y <= py + this._panel.height;
            if (!inside)
                this.close();
            return Clutter.EVENT_PROPAGATE;
        });

        Main.layoutManager.uiGroup.add_child(this._panel);
    }

    destroy() {
        if (this.isOpen)
            this.close();
        if (this._searchSource) {
            GLib.source_remove(this._searchSource);
            this._searchSource = 0;
        }
        for (const tab of this._tabs)
            tab.destroy?.();
        this._panel?.destroy();
        this._panel = null;
        this._tabs = [];
    }

    // ----------------------------------------------------------- open/close

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (!this._panel)
            this._build();

        this._panel.width = this.settings.get_int('panel-width');
        this._panel.height = this.settings.get_int('panel-height');

        const wanted = this.settings.get_boolean('remember-tab')
            ? this.settings.get_string('last-tab')
            : 'clipboard';
        const index = TAB_IDS.indexOf(wanted);
        this._setTab(index < 0 ? 0 : index);

        this._search.set_text('');
        this._position();
        this._panel.show();
        Main.layoutManager.uiGroup.set_child_above_sibling(this._panel, null);

        // Clutter.Grab in shell 50 reports failure through is_revoked(); older
        // releases exposed get_seat_state(), which no longer exists.
        this._grab = Main.pushModal(this._panel, {actionMode: Shell.ActionMode.POPUP});
        if (!this._grab || this._grab.is_revoked?.()) {
            if (this._grab)
                Main.popModal(this._grab);
            this._grab = null;
            this._panel.hide();
            return;
        }

        global.stage.set_key_focus(this._search.clutter_text);
        this.refresh();
    }

    close() {
        if (!this._grab)
            return;
        Main.popModal(this._grab);
        this._grab = null;
        this._panel.hide();
        global.stage.set_key_focus(null);
    }

    _position() {
        const [px, py] = global.get_pointer();
        const monitor = Main.layoutManager.currentMonitor;
        const work = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const w = this._panel.width;
        const h = this._panel.height;

        let x = px - 24;
        let y = py + 18;
        if (y + h > work.y + work.height)
            y = py - h - 10;                       // flip above the pointer
        y = Math.max(work.y + 4, Math.min(y, work.y + work.height - h - 4));
        x = Math.max(work.x + 4, Math.min(x, work.x + work.width - w - 4));

        this._panel.set_position(Math.round(x), Math.round(y));
    }

    // ----------------------------------------------------------------- tabs

    selectTab(index) {
        this._setTab(index);
        this.refresh();
        global.stage.set_key_focus(this._search.clutter_text);
    }

    _setTab(index) {
        this._activeTab = this._tabs[index];
        this._tabIndex = index;
        this._content.set_child(this._activeTab.actor);
        this._tabButtons.forEach((b, i) => {
            if (i === index)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        });
        this.settings.set_string('last-tab', TAB_IDS[index]);
    }

    _cycleTab(step) {
        const next = (this._tabIndex + step + this._tabs.length) % this._tabs.length;
        this.selectTab(next);
    }

    // -------------------------------------------------------------- content

    refresh() {
        if (!this._activeTab)
            return;
        const query = this._search.get_text().trim().toLowerCase();
        this._activeTab.refresh(query);
        this._selected = -1;
        if (this._activeTab.cells.length)
            this._select(0);
    }

    _onSearchChanged() {
        if (this._searchSource)
            GLib.source_remove(this._searchSource);
        this._searchSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
            this._searchSource = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------ selection

    _select(index) {
        const cells = this._activeTab.cells;
        if (!cells.length)
            return;
        index = Math.max(0, Math.min(index, cells.length - 1));

        const previous = cells[this._selected];
        previous?.actor.remove_style_pseudo_class('selected');

        this._selected = index;
        const cell = cells[index];
        cell.actor.add_style_pseudo_class('selected');
        this._ensureVisible(cell.actor);
    }

    _move(delta) {
        if (this._activeTab.cells.length)
            this._select(this._selected + delta);
    }

    _ensureVisible(actor) {
        const scroll = this._activeTab.scrollView;
        const adjustment = scroll?.vadjustment;
        const content = scroll?.get_child();
        if (!adjustment || !content)
            return;

        let y = 0;
        let node = actor;
        while (node && node !== content) {
            y += node.y;
            node = node.get_parent();
        }
        if (!node)
            return; // actor is not inside this scroll view

        const height = actor.height;
        if (y < adjustment.value)
            adjustment.value = y;
        else if (y + height > adjustment.value + adjustment.page_size)
            adjustment.value = y + height - adjustment.page_size;
    }

    /** Called by tabs when a cell is clicked. */
    activateCell(cell) {
        if (!cell)
            return;
        this._commit(cell);
    }

    _activateSelected() {
        const cell = this._activeTab?.cells[this._selected];
        if (cell)
            this._commit(cell);
    }

    _commit(cell) {
        // Close first: the grab has to be gone before the target window can
        // take focus and receive the synthetic paste.
        this.close();

        let result;
        try {
            result = cell.activate();
        } catch (e) {
            console.error('winclip: could not apply clipboard entry', e);
            return;
        }

        const paste = () => {
            if (this.settings.get_boolean('auto-paste'))
                sendPaste(this.settings.get_int('paste-delay-ms'));
        };

        // An entry that has to be downloaded first hands back a promise, so
        // the paste waits for the clipboard to actually hold the content.
        if (result && typeof result.then === 'function') {
            result.then(ok => {
                if (ok)
                    paste();
            }).catch(e => console.error('winclip: could not apply entry', e));
            return;
        }
        paste();
    }

    // ------------------------------------------------------------- keyboard

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const columns = this._activeTab?.columns || 1;
        const searchEmpty = this._search.get_text().length === 0;

        switch (symbol) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this._activateSelected();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Down:
            this._move(columns);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Up:
            this._move(-columns);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Right:
            // Let the entry keep Left/Right for editing once there is text.
            if (searchEmpty || ctrl) {
                this._move(1);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;

        case Clutter.KEY_Left:
            if (searchEmpty || ctrl) {
                this._move(-1);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;

        case Clutter.KEY_Page_Down:
            this._move(columns * 4);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Page_Up:
            this._move(-columns * 4);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab:
            this._cycleTab(shift ? -1 : 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Delete:
            if (searchEmpty || ctrl) {
                this._activeTab?.cells[this._selected]?.remove?.();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;

        case Clutter.KEY_p:
        case Clutter.KEY_P:
            if (ctrl) {
                this._activeTab?.cells[this._selected]?.togglePin?.();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;

        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
}
