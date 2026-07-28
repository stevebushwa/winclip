// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

/* The emoji, kaomoji and symbol tabs.
 *
 * All three are the same thing — a searchable grid of text that gets inserted
 * on click, with pins and recents — over different datasets, so they share one
 * implementation. Each dataset is a list of {c: glyph, n: name, g: group
 * index, k: keywords}, which is what the generators emit.
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {column, emptyNotice, gridOf, matches, scrollable, sectionHeader} from './uiHelpers.js';
import {EMOJI, EMOJI_GROUPS} from './emojiData.js';
import {KAOMOJI, KAOMOJI_GROUPS} from './kaomojiData.js';
import {SYMBOLS, SYMBOL_GROUPS} from './symbolData.js';

// Browsing stays inside one group, so a refresh never builds every button;
// searching spans all of them and is capped instead.
const MAX_CELLS = 400;
const FAVOURITES = -1;

/* Ranks a search hit, lower being better. Without this, results come out in
 * codepoint order, so searching "euro" offers the obsolete ₠ ahead of €.
 * Ties are broken by name length, the shorter name generally being the
 * canonical character rather than a variant.
 */
function relevance(entry, query) {
    const name = entry.n;
    if (name === query)
        return 0;
    if (name.startsWith(query))
        return 1;
    if (name.split(/[\s-]+/).some(word => word.startsWith(query)))
        return 2;
    if (name.includes(query))
        return 3;
    return 4; // matched on keywords alone
}

class GlyphTab {
    constructor(overlay, config) {
        this._overlay = overlay;
        this._config = config;
        this._group = 0; // FAVOURITES is the pinned/recent view

        this._box = column();
        this._groupBar = new St.BoxLayout({style_class: 'winclip-groupbar', x_expand: true});
        this.scrollView = scrollable(this._box);

        const wrapper = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        wrapper.add_child(this._groupBar);
        wrapper.add_child(this.scrollView);

        this.actor = wrapper;
        this.columns = 9;
        this.cells = [];
        this._buildGroupBar();
    }

    get title() {
        return this._config.title;
    }

    // ------------------------------------------------------------ group bar

    _buildGroupBar() {
        const entries = [['★', FAVOURITES],
            ...this._config.groups.map((name, i) => [this._config.groupIcon(i, name), i])];
        for (const [label, index] of entries) {
            const button = new St.Button({style_class: 'winclip-group-button', label});
            button.connect('clicked', () => {
                this._group = index;
                this._syncGroupBar();
                this._overlay.refresh();
            });
            button._groupIndex = index;
            this._groupBar.add_child(button);
        }
        this._syncGroupBar();
    }

    _syncGroupBar() {
        for (const child of this._groupBar.get_children()) {
            if (child._groupIndex === this._group)
                child.add_style_pseudo_class('checked');
            else
                child.remove_style_pseudo_class('checked');
        }
    }

    // --------------------------------------------------------------- render

    refresh(query) {
        this._box.destroy_all_children();
        this.cells = [];

        const settings = this._overlay.settings;
        const pinnedSet = new Set(settings.get_strv(this._config.pinnedKey));
        this.columns = Math.max(1,
            Math.floor(this._overlay.contentWidth / this._config.cellWidth));

        const q = (query || '').toLowerCase();
        if (q) {
            const hits = this._config.entries
                .filter(e => matches(`${e.n} ${e.k}`, q))
                .sort((a, b) => relevance(a, q) - relevance(b, q) || a.n.length - b.n.length);
            if (!hits.length) {
                this._box.add_child(emptyNotice(`Nothing in ${this.title} matches that.`));
                return;
            }
            this._addGrid(hits.slice(0, MAX_CELLS), pinnedSet);
            if (hits.length > MAX_CELLS) {
                this._box.add_child(emptyNotice(
                    `${hits.length - MAX_CELLS} more — keep typing to narrow it down.`));
            }
            return;
        }

        if (this._group === FAVOURITES) {
            const pinned = [...pinnedSet];
            const recents = settings.get_strv(this._config.recentKey)
                .filter(g => !pinnedSet.has(g));
            if (!pinned.length && !recents.length) {
                this._box.add_child(emptyNotice(
                    `No favourites yet.\nPick one, or press Ctrl+P to pin it.`));
                return;
            }
            if (pinned.length) {
                this._box.add_child(sectionHeader('Pinned'));
                this._addGrid(pinned.map(c => ({c, n: c, k: ''})), pinnedSet);
            }
            if (recents.length) {
                this._box.add_child(sectionHeader('Recent'));
                this._addGrid(recents.map(c => ({c, n: c, k: ''})), pinnedSet);
            }
            return;
        }

        this._addGrid(this._config.entries.filter(e => e.g === this._group), pinnedSet);
    }

    _addGrid(entries, pinnedSet) {
        this._box.add_child(gridOf(
            entries.map(e => this._cell(e, pinnedSet)), this.columns, 'winclip-grid'));
    }

    _cell(entry, pinnedSet) {
        const glyph = this._decorate(entry);
        const button = new St.Button({
            style_class: pinnedSet.has(glyph)
                ? `${this._config.cellClass} winclip-pinned-cell`
                : this._config.cellClass,
            label: glyph,
        });
        button.set_size(this._config.cellWidth - 4, this._config.cellHeight - 4);

        const cell = {
            actor: button,
            activate: () => this._apply(glyph),
            togglePin: () => this._togglePin(glyph),
        };
        button.connect('clicked', () => this._overlay.activateCell(cell));
        this.cells.push(cell);
        return cell;
    }

    /** Hook for datasets that transform a glyph before display. */
    _decorate(entry) {
        return entry.c;
    }

    _togglePin(glyph) {
        const settings = this._overlay.settings;
        const pinned = settings.get_strv(this._config.pinnedKey);
        const i = pinned.indexOf(glyph);
        if (i >= 0)
            pinned.splice(i, 1);
        else
            pinned.unshift(glyph);
        settings.set_strv(this._config.pinnedKey, pinned.slice(0, 64));
        this._overlay.refresh();
    }

    _apply(glyph) {
        const settings = this._overlay.settings;
        const recents = settings.get_strv(this._config.recentKey).filter(g => g !== glyph);
        recents.unshift(glyph);
        settings.set_strv(this._config.recentKey, recents.slice(0, 40));
        // setText goes through the monitor's self-write guard, so picking a
        // glyph does not pollute the clipboard history.
        this._overlay.monitor.setText(glyph);
    }
}

// --------------------------------------------------------------------- emoji

/** Splices a skin-tone modifier in after the base codepoint. */
export function applyTone(glyph, tone) {
    if (!tone)
        return glyph;
    const cps = [...glyph];
    if (cps.length > 1 && cps[1] === '️')
        cps.splice(1, 1); // the tone modifier replaces the variation selector
    cps.splice(1, 0, String.fromCodePoint(0x1F3FA + tone));
    return cps.join('');
}

const EMOJI_GROUP_ICONS = ['😀', '👋', '🐻', '🍎', '✈️', '⚽', '💡', '🔣', '🏳️'];

export class EmojiTab extends GlyphTab {
    constructor(overlay) {
        super(overlay, {
            title: 'Emoji',
            groups: EMOJI_GROUPS,
            entries: EMOJI,
            pinnedKey: 'emoji-pinned',
            recentKey: 'emoji-recent',
            cellClass: 'winclip-emoji',
            cellWidth: 42,
            cellHeight: 42,
            groupIcon: i => EMOJI_GROUP_ICONS[i] ?? '•',
        });
    }

    _decorate(entry) {
        return entry.t
            ? applyTone(entry.c, this._overlay.settings.get_int('skin-tone'))
            : entry.c;
    }
}

// ------------------------------------------------------------------ kaomoji

const KAOMOJI_GROUP_ICONS = ['◕', '╯', '✿', 'ʕ', '☞'];

export class KaomojiTab extends GlyphTab {
    constructor(overlay) {
        super(overlay, {
            title: 'Kaomoji',
            groups: KAOMOJI_GROUPS,
            entries: KAOMOJI,
            pinnedKey: 'kaomoji-pinned',
            recentKey: 'kaomoji-recent',
            cellClass: 'winclip-kaomoji',
            // Wide, because these are whole strings rather than one character.
            cellWidth: 190,
            cellHeight: 40,
            groupIcon: i => KAOMOJI_GROUP_ICONS[i] ?? '•',
        });
    }
}

// ------------------------------------------------------------------ symbols

const SYMBOL_GROUP_ICONS = ['—', '€', '±', '→', '★', 'Ω'];

export class SymbolTab extends GlyphTab {
    constructor(overlay) {
        super(overlay, {
            title: 'Symbols',
            groups: SYMBOL_GROUPS,
            entries: SYMBOLS,
            pinnedKey: 'symbol-pinned',
            recentKey: 'symbol-recent',
            cellClass: 'winclip-symbol',
            cellWidth: 42,
            cellHeight: 42,
            groupIcon: i => SYMBOL_GROUP_ICONS[i] ?? '•',
        });
    }
}
