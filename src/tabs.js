// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

/* The clipboard and GIF pages of the overlay.
 *
 * Every tab exposes the same small contract so the overlay can drive keyboard
 * navigation without knowing what it is looking at:
 *
 *   actor      the scrollable widget to show
 *   columns    cells per row, for arrow-key movement
 *   cells      [{ actor, activate(), togglePin()?, remove()? }]
 *   refresh(q) rebuild for the current search string
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {TYPE_IMAGE, TYPE_TEXT} from './store.js';
import {createImageActor, setThumbHovered} from './imageUtil.js';
import {column, emptyNotice, gridOf, matches, scrollable, sectionHeader} from './uiHelpers.js';
import {GifScanner} from './gifScanner.js';
import {GifSearch} from './gifSearch.js';

const TEXT_PREVIEW_CHARS = 220;
const THUMB_W = 260;
const THUMB_H = 84;
const GIF_CELL_W = 124;
const GIF_CELL_H = 96;

// ---------------------------------------------------------------- clipboard

export class ClipboardTab {
    constructor(overlay) {
        this._overlay = overlay;
        this._box = column();
        this.actor = scrollable(this._box);
        this.scrollView = this.actor;
        this.columns = 1;
        this.cells = [];
    }

    get title() {
        return 'Clipboard';
    }

    refresh(query) {
        this._box.destroy_all_children();
        this.cells = [];

        const store = this._overlay.store;
        const hit = it => matches(it.type === TYPE_TEXT ? it.text : (it.file || ''), query);
        const pinned = store.pinned.filter(hit);
        const recent = store.recent.filter(hit);

        if (!pinned.length && !recent.length) {
            this._box.add_child(emptyNotice(
                query ? 'Nothing matches that.' : 'Copy something and it will show up here.'));
            return;
        }

        if (pinned.length) {
            this._box.add_child(sectionHeader('Pinned'));
            pinned.forEach(it => this._addRow(it));
        }
        if (recent.length) {
            if (pinned.length)
                this._box.add_child(sectionHeader('Recent'));
            recent.forEach(it => this._addRow(it));
        }
    }

    _addRow(item) {
        const row = new St.BoxLayout({
            style_class: 'winclip-row',
            x_expand: true,
            reactive: true,
            track_hover: true,
        });

        const body = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'winclip-row-body',
        });

        if (item.type === TYPE_IMAGE) {
            const path = this._overlay.store.blobPath(item);
            const thumb = createImageActor(path, THUMB_W, THUMB_H,
                {animate: this._overlay.settings.get_boolean('gif-animate')});
            if (thumb) {
                body.add_child(thumb);
            } else {
                body.add_child(new St.Label({
                    style_class: 'winclip-row-text',
                    text: '[unreadable image]',
                }));
            }
            const kb = item.bytes ? `  ·  ${Math.max(1, Math.round(item.bytes / 1024))} KB` : '';
            body.add_child(new St.Label({
                style_class: 'winclip-row-meta',
                text: `${item.mime === 'image/gif' ? 'GIF' : 'Image'}${kb}`,
            }));
        } else {
            const preview = item.text.length > TEXT_PREVIEW_CHARS
                ? `${item.text.slice(0, TEXT_PREVIEW_CHARS)}…`
                : item.text;
            const label = new St.Label({
                style_class: 'winclip-row-text',
                text: preview.replace(/\s*\n\s*/g, ' ⏎ ').trim(),
            });
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = 2; // Pango.WrapMode.WORD_CHAR
            label.clutter_text.ellipsize = 3;      // Pango.EllipsizeMode.END
            body.add_child(label);
        }

        row.add_child(body);
        row.add_child(this._buttons(item));

        row.connect('button-release-event', () => {
            this._overlay.activateCell(this.cells.find(c => c.item === item));
            return Clutter.EVENT_STOP;
        });

        this._box.add_child(row);
        this.cells.push({
            actor: row,
            item,
            activate: () => this._apply(item),
            togglePin: () => {
                this._overlay.store.togglePin(item.id);
                this._overlay.refresh();
            },
            remove: () => {
                this._overlay.store.remove(item.id);
                this._overlay.refresh();
            },
        });
    }

    _buttons(item) {
        const box = new St.BoxLayout({style_class: 'winclip-row-actions'});

        const pin = new St.Button({
            style_class: item.pinned ? 'winclip-icon-button winclip-pinned' : 'winclip-icon-button',
            child: new St.Icon({
                icon_name: item.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
                icon_size: 16,
            }),
        });
        pin.connect('clicked', () => {
            this._overlay.store.togglePin(item.id);
            this._overlay.refresh();
        });

        const del = new St.Button({
            style_class: 'winclip-icon-button',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 16}),
        });
        del.connect('clicked', () => {
            this._overlay.store.remove(item.id);
            this._overlay.refresh();
        });

        box.add_child(pin);
        box.add_child(del);
        return box;
    }

    _apply(item) {
        if (item.type === TYPE_TEXT) {
            this._overlay.monitor.setText(item.text);
            return;
        }
        const path = this._overlay.store.blobPath(item);
        // Resolves once the clipboard actually holds it, so the overlay can
        // hold the synthetic paste back until then.
        return this._overlay.monitor.setImageFile(path, item.mime || 'image/png')
            .then(ok => {
                if (!ok)
                    console.error(`winclip: could not put ${path} on the clipboard`);
                return ok;
            });
    }
}

// --------------------------------------------------------------------- gifs

/**
 * Where GIFs come from. Only the local provider ships today; an online one
 * just has to return the same shape from search(), so the tab does not change.
 */
class LocalGifProvider {
    constructor(store) {
        this._store = store;
        this._folder = [];
        this._listing = false;
        this._listedAt = 0;
    }

    get id() {
        return 'local';
    }

    /** Re-lists the favourites folder if the cached listing has gone stale. */
    refreshFolder(onDone) {
        const FOLDER_STALE_US = 10 * 1000 * 1000;
        if (this._listing)
            return;
        if (this._listedAt && GLib.get_monotonic_time() - this._listedAt < FOLDER_STALE_US)
            return;

        this._listing = true;
        Gio.File.new_for_path(this._store.gifDir).enumerate_children_async(
            'standard::name,standard::is-hidden', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, null, (file, res) => {
                let enumerator;
                try {
                    enumerator = file.enumerate_children_finish(res);
                } catch {
                    this._listing = false;
                    this._listedAt = GLib.get_monotonic_time();
                    return;
                }
                const found = [];
                const readMore = () => {
                    enumerator.next_files_async(32, GLib.PRIORITY_LOW, null, (src, r) => {
                        let infos;
                        try {
                            infos = src.next_files_finish(r);
                        } catch {
                            infos = [];
                        }
                        if (!infos.length) {
                            src.close_async(GLib.PRIORITY_LOW, null, () => {});
                            this._folder = found;
                            this._listing = false;
                            this._listedAt = GLib.get_monotonic_time();
                            onDone?.();
                            return;
                        }
                        for (const info of infos) {
                            const name = info.get_name();
                            if (info.get_is_hidden() || !name.toLowerCase().endsWith('.gif'))
                                continue;
                            found.push({
                                name,
                                path: GLib.build_filenamev([this._store.gifDir, name]),
                            });
                        }
                        readMore();
                    });
                };
                readMore();
            });
    }

    /** Returns [{path, pinned, source, item?}] — history plus the favourites folder. */
    search(query) {
        const results = [];
        const seen = new Set();

        for (const item of this._store.gifs()) {
            const path = this._store.blobPath(item);
            if (seen.has(path))
                continue;
            seen.add(path);
            results.push({
                path,
                pinned: !!item.pinned,
                // Pinned entries pointing outside our store are files the user
                // picked from their own folders, not clipboard captures.
                source: item.file.startsWith('/') ? 'disk' : 'clipboard',
                item,
            });
        }

        // Anything the user dropped into ~/.local/share/winclip/gifs. Listed
        // asynchronously and cached, since this runs on every refresh and
        // blocking the compositor on a directory read would be felt.
        for (const entry of this._folder) {
            if (seen.has(entry.path))
                continue;
            seen.add(entry.path);
            results.push({
                path: entry.path,
                pinned: true,
                source: 'folder',
                favouriteName: entry.name,
            });
        }

        const q = (query || '').toLowerCase();
        return results.filter(r => matches(GLib.path_get_basename(r.path), q));
    }
}

export class GifTab {
    constructor(overlay) {
        this._overlay = overlay;
        this._box = column();
        this.actor = scrollable(this._box);
        this.scrollView = this.actor;
        this.columns = 3;
        this.cells = [];
        this.providers = [new LocalGifProvider(overlay.store)];
        this._scanner = new GifScanner(overlay.settings);
        this._search = new GifSearch(overlay.settings);
    }

    get title() {
        return 'GIF';
    }

    destroy() {
        this._scanner.destroy();
        this._search.destroy();
    }

    refresh(query) {
        this._box.destroy_all_children();
        this.cells = [];
        this.columns = Math.max(1, Math.floor(this._overlay.contentWidth / GIF_CELL_W));

        const q = (query || '').toLowerCase();

        // Every source below is async and cached: this draws from whatever is
        // known now, and redraws if fresh results land while the tab is up.
        const redraw = () => {
            if (this._overlay.isOpen && this._overlay.activeTab === this)
                this._overlay.refresh();
        };

        for (const provider of this.providers)
            provider.refreshFolder?.(redraw);
        const local = this.providers.flatMap(p => p.search(query));
        const known = new Set(local.map(r => r.path));

        this._scanner.maybeScan(redraw);
        const scanned = this._scanner.results
            .filter(r => !known.has(r.path) && matches(r.name, q))
            .map(r => ({path: r.path, pinned: false, source: 'scan'}));

        // Online search, only if the user turned one on and typed something.
        // Nothing here touches the network otherwise.
        this._search.maybeSearch(query, redraw);
        const online = this._search.results.map(r => ({
            path: r.path, pinned: false, source: 'online', online: r,
        }));

        const pinned = local.filter(r => r.pinned);
        const clipboard = local.filter(r => !r.pinned);

        if (!pinned.length && !clipboard.length && !scanned.length && !online.length) {
            this._box.add_child(emptyNotice(this._emptyText(q)));
            return;
        }

        this._addSection('Favourites', pinned);
        this._addSection('From clipboard', clipboard);
        this._addSection('On this computer', scanned);
        this._addSection(this._search.label, online);

        if (this._scanner.scanning)
            this._box.add_child(emptyNotice('Still looking on this computer…'));
        if (this._search.searching)
            this._box.add_child(emptyNotice(`Searching ${this._search.label}…`));
        else if (this._search.error)
            this._box.add_child(emptyNotice(`${this._search.label}: ${this._search.error}`));
    }

    _emptyText(q) {
        if (this._search.searching)
            return `Searching ${this._search.label}…`;
        if (this._search.error)
            return `${this._search.label}: ${this._search.error}`;
        if (q)
            return this._search.enabled
                ? 'No GIFs match that.'
                : 'No GIFs match that.\nTurn on online search in preferences to look further.';
        if (this._scanner.scanning)
            return 'Looking for GIFs on this computer…';
        return 'Copy a GIF, drop files into ~/.local/share/winclip/gifs,\nor add a folder to scan in preferences.';
    }

    _addSection(title, results) {
        if (!results.length)
            return;
        this._box.add_child(sectionHeader(title));
        this._box.add_child(gridOf(
            results.map(r => this._cell(r)), this.columns, 'winclip-grid'));
    }

    _cell(result) {
        const button = new St.Button({
            style_class: result.pinned ? 'winclip-gif winclip-pinned-cell' : 'winclip-gif',
            width: GIF_CELL_W - 8,
            height: GIF_CELL_H,
        });
        const thumb = createImageActor(result.path, GIF_CELL_W - 16, GIF_CELL_H - 8,
            {animate: this._overlay.settings.get_boolean('gif-animate')});
        if (thumb) {
            button.set_child(thumb);
            // Whatever the pointer is over gets an animation slot.
            button.track_hover = true;
            button.connect('notify::hover',
                () => setThumbHovered(thumb, button.hover));
        } else {
            button.set_child(new St.Label({text: '?', style_class: 'winclip-row-text'}));
        }

        const store = this._overlay.store;
        const cell = {
            actor: button,
            activate: () => this._apply(result),
            togglePin: () => {
                if (result.item)
                    store.togglePin(result.item.id);
                else if (result.source === 'scan')
                    store.togglePinPath(result.path);
                else if (result.source === 'online')
                    return this._pinOnline(result);
                // Files in the favourites folder are already favourites; the
                // way to remove one is to move the file out.
                this._overlay.refresh();
                return undefined;
            },
            remove: () => {
                // Only ever forgets our own captures — never deletes a file
                // the user keeps in Pictures or Downloads.
                if (result.item)
                    store.remove(result.item.id);
                this._overlay.refresh();
            },
        };
        button.connect('clicked', () => this._overlay.activateCell(cell));
        this.cells.push(cell);
        return cell;
    }

    _apply(result) {
        // Search results are only previews on disk; fetch the full-size file
        // before it goes anywhere. The promise lets the overlay hold the
        // synthetic paste back until the clipboard actually holds the GIF.
        if (result.source === 'online') {
            return new Promise(resolve => {
                this._search.fetchFull(result.online, path => {
                    if (!path) {
                        console.warn('winclip: could not download the full-size GIF');
                        resolve(false);
                        return;
                    }
                    resolve(this._toClipboard(path));
                });
            });
        }
        return this._toClipboard(result.path);
    }

    _toClipboard(path) {
        return this._overlay.monitor.setImageFile(path, 'image/gif').then(ok => {
            if (!ok)
                console.error(`winclip: could not put ${path} on the clipboard`);
            return ok;
        });
    }

    /* Pinning a search result keeps it: the cache is wiped on disable, so the
     * full-size file is copied into the favourites folder instead. */
    _pinOnline(result) {
        return new Promise(resolve => {
            this._search.fetchFull(result.online, path => {
                if (path)
                    this._search.saveAsFavourite(result.online, path);
                this._overlay.refresh();
                resolve(!!path);
            });
        });
    }
}

