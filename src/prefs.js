// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {describeFolder} from './gifScanner.js';

const SKIN_TONES = ['Default', 'Light', 'Medium-light', 'Medium', 'Medium-dark', 'Dark'];
const DEFAULT_FOLDERS = ['@DOWNLOAD', '@PICTURES'];
const GIF_FORMATS = [
    ['png', 'Still image (PNG)', 'Pastes into anything, but not animated'],
    ['gif', 'Animated GIF', 'Stays animated, but only some apps accept it'],
    ['uri', 'The file itself', 'Chat apps and file managers attach the animation'],
];
const SEARCH_PROVIDERS = [['none', 'Off'], ['giphy', 'Giphy']];
const SEARCH_RATINGS = [['strict', 'Strict'], ['moderate', 'Moderate'], ['off', 'Off']];

export default class WinClipPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._behaviourPage(settings));
        window.add(this._appearancePage(settings, window));
        window.add(this._gifPage(settings, window));
    }

    // ------------------------------------------------------------------ gifs

    _gifPage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: 'GIFs',
            icon_name: 'image-x-generic-symbolic',
        });

        const folders = () => settings.get_strv('gif-scan-folders');
        const setFolders = list => settings.set_strv('gif-scan-folders', list);

        const group = new Adw.PreferencesGroup({
            title: 'Where to look',
            description: 'The GIF tab shows animated GIFs found in these folders, ' +
                'alongside anything you have copied or pinned.',
        });

        const defaults = new Adw.SwitchRow({
            title: 'Downloads and Pictures',
            subtitle: 'Follows your XDG user folders',
            active: DEFAULT_FOLDERS.some(t => folders().includes(t)),
        });
        defaults.connect('notify::active', () => {
            const custom = folders().filter(t => !DEFAULT_FOLDERS.includes(t));
            setFolders(defaults.active ? [...DEFAULT_FOLDERS, ...custom] : custom);
        });
        group.add(defaults);
        page.add(group);

        // -- extra folders, each removable
        const extra = new Adw.PreferencesGroup({title: 'Other folders'});
        const add = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add a folder',
            css_classes: ['flat'],
        });
        extra.set_header_suffix(add);

        let rows = [];
        const rebuild = () => {
            for (const row of rows)
                extra.remove(row);
            rows = [];

            const custom = folders().filter(t => !DEFAULT_FOLDERS.includes(t));
            if (!custom.length) {
                const row = new Adw.ActionRow({
                    title: 'None',
                    subtitle: 'Use + to scan somewhere else',
                    sensitive: false,
                });
                extra.add(row);
                rows.push(row);
                return;
            }
            for (const token of custom) {
                const row = new Adw.ActionRow({title: describeFolder(token)});
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => {
                    setFolders(folders().filter(t => t !== token));
                    rebuild();
                });
                row.add_suffix(remove);
                extra.add(row);
                rows.push(row);
            }
        };

        add.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Choose a folder to scan'});
            dialog.select_folder(window, null, (src, res) => {
                let folder;
                try {
                    folder = src.select_folder_finish(res);
                } catch {
                    return; // cancelled
                }
                const path = folder?.get_path();
                if (path && !folders().includes(path)) {
                    setFolders([...folders(), path]);
                    rebuild();
                }
            });
        });

        rebuild();
        page.add(extra);

        const paste = new Adw.PreferencesGroup({
            title: 'Pasting GIFs',
            description: 'GNOME publishes a single clipboard type per copy, so a GIF ' +
                'has to be offered as one thing. Most applications only ask for ' +
                'image/png, which is why an animated GIF can appear to paste nowhere.',
        });
        const format = new Adw.ComboRow({
            title: 'Copy GIFs as',
            model: Gtk.StringList.new(GIF_FORMATS.map(f => f[1])),
            subtitle: GIF_FORMATS.find(
                f => f[0] === settings.get_string('gif-paste-format'))?.[2] ?? '',
            selected: Math.max(0, GIF_FORMATS.findIndex(
                f => f[0] === settings.get_string('gif-paste-format'))),
        });
        format.connect('notify::selected', () => {
            const choice = GIF_FORMATS[format.selected];
            settings.set_string('gif-paste-format', choice[0]);
            format.subtitle = choice[2];
        });
        paste.add(format);
        page.add(paste);

        page.add(this._searchGroup(settings));

        const limits = new Adw.PreferencesGroup({
            title: 'Limits',
            description: 'Scanning runs in the background; these keep it cheap on big folders.',
        });

        const depth = new Adw.SpinRow({
            title: 'Folder depth',
            subtitle: 'How many levels below each folder to search',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 8, step_increment: 1}),
        });
        settings.bind('gif-scan-depth', depth, 'value', Gio.SettingsBindFlags.DEFAULT);
        limits.add(depth);

        const max = new Adw.SpinRow({
            title: 'Most GIFs to list',
            adjustment: new Gtk.Adjustment({lower: 20, upper: 5000, step_increment: 20}),
        });
        settings.bind('gif-scan-max', max, 'value', Gio.SettingsBindFlags.DEFAULT);
        limits.add(max);

        page.add(limits);

        const files = new Adw.PreferencesGroup({
            title: 'Favourites folder',
            description: 'Any .gif dropped in here is always listed first.',
        });
        const folder = new Adw.ActionRow({
            title: 'Open folder',
            subtitle: '~/.local/share/winclip/gifs',
            activatable: true,
        });
        folder.add_suffix(new Gtk.Image({icon_name: 'folder-symbolic'}));
        folder.connect('activated', () => {
            const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'winclip', 'gifs']);
            GLib.mkdir_with_parents(path, 0o700);
            Gtk.FileLauncher.new(Gio.File.new_for_path(path)).launch(window, null, null);
        });
        files.add(folder);
        page.add(files);

        return page;
    }

    // ------------------------------------------------------------ behaviour

    _behaviourPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Behaviour',
            icon_name: 'preferences-system-symbolic',
        });

        const shortcut = new Adw.PreferencesGroup({title: 'Shortcut'});
        shortcut.add(this._shortcutRow(settings));
        page.add(shortcut);

        const paste = new Adw.PreferencesGroup({
            title: 'Pasting',
            description: 'Picking an entry can paste it straight into the window underneath.',
        });

        const autoPaste = new Adw.SwitchRow({
            title: 'Paste on selection',
            subtitle: 'Sends Ctrl+V after choosing an item',
        });
        settings.bind('auto-paste', autoPaste, 'active', Gio.SettingsBindFlags.DEFAULT);
        paste.add(autoPaste);

        const delay = new Adw.SpinRow({
            title: 'Paste delay',
            subtitle: 'Milliseconds to wait for focus to return',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 1000, step_increment: 10}),
        });
        settings.bind('paste-delay-ms', delay, 'value', Gio.SettingsBindFlags.DEFAULT);
        autoPaste.bind_property('active', delay, 'sensitive',
            2 /* SYNC_CREATE */);
        paste.add(delay);
        page.add(paste);

        const history = new Adw.PreferencesGroup({title: 'History'});

        const size = new Adw.SpinRow({
            title: 'Entries to keep',
            subtitle: 'Pinned items are never dropped',
            adjustment: new Gtk.Adjustment({lower: 5, upper: 1000, step_increment: 5}),
        });
        settings.bind('history-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);
        history.add(size);

        const images = new Adw.SwitchRow({
            title: 'Store images',
            subtitle: 'Screenshots and copied pictures appear in the history',
        });
        settings.bind('capture-images', images, 'active', Gio.SettingsBindFlags.DEFAULT);
        history.add(images);

        const preferText = new Adw.SwitchRow({
            title: 'Prefer text over image',
            subtitle: 'Rich-text copies also offer a picture; keep the text instead',
        });
        settings.bind('prefer-text-when-both', preferText, 'active', Gio.SettingsBindFlags.DEFAULT);
        history.add(preferText);

        const maxSize = new Adw.SpinRow({
            title: 'Largest image to store',
            subtitle: 'Megabytes; bigger copies are skipped',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 256, step_increment: 1}),
        });
        settings.bind('max-image-mb', maxSize, 'value', Gio.SettingsBindFlags.DEFAULT);
        history.add(maxSize);

        const blobBudget = new Adw.SpinRow({
            title: 'Total space for images',
            subtitle: 'Megabytes; oldest unpinned images go first',
            adjustment: new Gtk.Adjustment({lower: 16, upper: 4096, step_increment: 16}),
        });
        settings.bind('max-blob-mb', blobBudget, 'value', Gio.SettingsBindFlags.DEFAULT);
        history.add(blobBudget);

        page.add(history);
        return page;
    }

    // ----------------------------------------------------------- appearance

    _appearancePage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: 'Panel',
            icon_name: 'view-grid-symbolic',
        });

        const size = new Adw.PreferencesGroup({title: 'Size'});
        const width = new Adw.SpinRow({
            title: 'Width',
            adjustment: new Gtk.Adjustment({lower: 280, upper: 900, step_increment: 10}),
        });
        settings.bind('panel-width', width, 'value', Gio.SettingsBindFlags.DEFAULT);
        size.add(width);

        const height = new Adw.SpinRow({
            title: 'Height',
            adjustment: new Gtk.Adjustment({lower: 300, upper: 1200, step_increment: 10}),
        });
        settings.bind('panel-height', height, 'value', Gio.SettingsBindFlags.DEFAULT);
        size.add(height);
        page.add(size);

        const behaviour = new Adw.PreferencesGroup({title: 'Tabs'});
        const remember = new Adw.SwitchRow({
            title: 'Reopen on the last tab',
            subtitle: 'Otherwise it always opens on Clipboard',
        });
        settings.bind('remember-tab', remember, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(remember);

        const tone = new Adw.ComboRow({
            title: 'Emoji skin tone',
            model: Gtk.StringList.new(SKIN_TONES),
            selected: settings.get_int('skin-tone'),
        });
        tone.connect('notify::selected', () => settings.set_int('skin-tone', tone.selected));
        behaviour.add(tone);
        page.add(behaviour);

        return page;
    }

    // --------------------------------------------------------- online search

    _searchGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Online search',
            description: 'Off by default. When enabled, what you type in the GIF tab ' +
                'is sent to Giphy. It needs an API key of your own — none is bundled, ' +
                'because a key shipped inside an open-source extension would be ' +
                'extracted and revoked. Type at least two characters to search.',
        });

        const provider = new Adw.ComboRow({
            title: 'Service',
            model: Gtk.StringList.new(SEARCH_PROVIDERS.map(p => p[1])),
            selected: Math.max(0, SEARCH_PROVIDERS.findIndex(
                p => p[0] === settings.get_string('gif-search-provider'))),
        });
        provider.connect('notify::selected', () => settings.set_string(
            'gif-search-provider', SEARCH_PROVIDERS[provider.selected][0]));
        group.add(provider);

        const giphyKey = new Adw.PasswordEntryRow({title: 'Giphy API key'});
        settings.bind('gif-giphy-key', giphyKey, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(giphyKey);

        const syncKeyRows = () => {
            giphyKey.visible = SEARCH_PROVIDERS[provider.selected][0] === 'giphy';
        };
        provider.connect('notify::selected', syncKeyRows);
        syncKeyRows();

        const rating = new Adw.ComboRow({
            title: 'Content filter',
            subtitle: 'Applied by the service to its results',
            model: Gtk.StringList.new(SEARCH_RATINGS.map(r => r[1])),
            selected: Math.max(0, SEARCH_RATINGS.findIndex(
                r => r[0] === settings.get_string('gif-search-rating'))),
        });
        rating.connect('notify::selected', () => settings.set_string(
            'gif-search-rating', SEARCH_RATINGS[rating.selected][0]));
        group.add(rating);

        const limit = new Adw.SpinRow({
            title: 'Results per search',
            adjustment: new Gtk.Adjustment({lower: 8, upper: 50, step_increment: 2}),
        });
        settings.bind('gif-search-limit', limit, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(limit);

        const help = new Adw.ActionRow({
            title: 'Where to get a key',
            subtitle: 'A free account on the Giphy developer portal',
        });
        help.add_suffix(new Gtk.LinkButton({
            label: 'Giphy developers',
            uri: 'https://developers.giphy.com/docs/api/',
            valign: Gtk.Align.CENTER,
        }));
        group.add(help);

        return group;
    }

    // -------------------------------------------------------------- shortcut

    _shortcutRow(settings) {
        const row = new Adw.ActionRow({
            title: 'Open the clipboard',
            subtitle: 'Click to record a new shortcut',
            activatable: true,
        });

        const label = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER,
            disabled_text: 'Disabled',
        });
        const sync = () => {
            const [binding] = settings.get_strv('toggle-overlay');
            label.set_accelerator(binding ?? '');
        };
        sync();
        settings.connect('changed::toggle-overlay', sync);
        row.add_suffix(label);

        row.connect('activated', () => this._captureShortcut(row, settings));
        return row;
    }

    _captureShortcut(row, settings) {
        const dialog = new Adw.AlertDialog({
            heading: 'Press a shortcut',
            body: 'Press the key combination you want, or Esc to cancel.',
        });
        dialog.add_response('cancel', 'Cancel');

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;

            if (keyval === Gdk.KEY_Escape && !mask) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // Ignore bare modifier presses while the user builds a combo.
            if (isModifier(keyval))
                return Gdk.EVENT_STOP;
            if (!mask)
                return Gdk.EVENT_STOP;

            const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
            settings.set_strv('toggle-overlay', [accel]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present(row.get_root());
    }
}

function isModifier(keyval) {
    return [
        Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
        Gdk.KEY_Control_L, Gdk.KEY_Control_R,
        Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
        Gdk.KEY_Super_L, Gdk.KEY_Super_R,
        Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
        Gdk.KEY_ISO_Level3_Shift,
    ].includes(keyval);
}
