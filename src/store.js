// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

/* Persistence for WinClip.
 *
 * Text lives inline in store.json; image payloads are content-addressed files
 * under blobs/ so that re-copying the same picture costs nothing. Pinned
 * entries are never evicted by the history cap.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const TYPE_TEXT = 'text';
export const TYPE_IMAGE = 'image';

const SAVE_DEBOUNCE_MS = 500;

export class Store {
    constructor() {
        this.dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'winclip']);
        this.blobDir = GLib.build_filenamev([this.dataDir, 'blobs']);
        this.gifDir = GLib.build_filenamev([this.dataDir, 'gifs']);
        this._file = GLib.build_filenamev([this.dataDir, 'store.json']);

        for (const dir of [this.dataDir, this.blobDir, this.gifDir])
            GLib.mkdir_with_parents(dir, 0o700);

        this.items = [];
        this._nextId = 1;
        this._saveSource = 0;
        this._changedCbs = new Set();

        this._load();
    }

    destroy() {
        if (this._saveSource) {
            GLib.source_remove(this._saveSource);
            this._saveSource = 0;
            this._writeNow();
        }
        this._changedCbs.clear();
    }

    connectChanged(cb) {
        this._changedCbs.add(cb);
        return cb;
    }

    disconnectChanged(cb) {
        this._changedCbs.delete(cb);
    }

    _emitChanged() {
        for (const cb of this._changedCbs) {
            try {
                cb();
            } catch (e) {
                console.error('winclip: store listener failed', e);
            }
        }
    }

    // ---------------------------------------------------------------- load

    _load() {
        let raw;
        try {
            const [ok, bytes] = GLib.file_get_contents(this._file);
            if (!ok)
                return;
            raw = new TextDecoder().decode(bytes);
        } catch {
            return; // first run
        }

        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            console.error('winclip: store.json unreadable, starting fresh', e);
            this._backupCorrupt();
            return;
        }

        if (!data || !Array.isArray(data.items))
            return;

        // Drop entries whose blob went missing or was left truncated. This
        // used to happen silently, which made a picture vanishing from the
        // history impossible to explain after the fact.
        let dropped = 0;
        this.items = data.items.filter(it => {
            if (it.type === TYPE_IMAGE) {
                const ok = it.file && blobIsUsable(this._blobPath(it.file));
                if (!ok)
                    dropped++;
                return ok;
            }
            return typeof it.text === 'string';
        });
        if (dropped)
            console.warn(`winclip: dropped ${dropped} image entr${dropped === 1 ? 'y' : 'ies'} whose file was gone`);
        this._nextId = Number(data.nextId) || this.items.length + 1;
    }

    _backupCorrupt() {
        try {
            const dest = `${this._file}.corrupt`;
            Gio.File.new_for_path(this._file).move(
                Gio.File.new_for_path(dest), Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch {
            // best effort
        }
    }

    // ---------------------------------------------------------------- save

    _scheduleSave() {
        this._emitChanged();
        if (this._saveSource)
            return;
        this._saveSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, SAVE_DEBOUNCE_MS, () => {
            this._saveSource = 0;
            this._writeNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _writeNow() {
        const payload = JSON.stringify({
            version: 1,
            nextId: this._nextId,
            items: this.items,
        });
        try {
            GLib.file_set_contents(this._file, payload);
        } catch (e) {
            console.error('winclip: could not write store.json', e);
        }
    }

    // --------------------------------------------------------------- blobs

    _blobPath(name) {
        // Three flavours: an absolute path to a file the user already owns, a
        // "gifs/" favourite, or a bare basename in our own blob store.
        if (name.startsWith('/'))
            return name;
        if (name.startsWith('gifs/'))
            return GLib.build_filenamev([this.gifDir, name.slice(5)]);
        return GLib.build_filenamev([this.blobDir, name]);
    }

    blobPath(item) {
        return this._blobPath(item.file);
    }

    /* Writes an image payload beside the index.
     *
     * Uses replace_contents_bytes_async rather than an output stream:
     * write_bytes_async marshals the buffer unsafely from GJS and fails with
     * EFAULT ("Bad address"), leaving a truncated file that will not decode.
     */
    _writeBlobAsync(path, bytes, onError) {
        Gio.File.new_for_path(path).replace_contents_bytes_async(
            bytes, null, false, Gio.FileCreateFlags.PRIVATE, null, (src, res) => {
                try {
                    src.replace_contents_finish(res);
                } catch (e) {
                    console.error('winclip: could not write blob', e);
                    onError?.();
                }
            });
    }

    /* Deletes a blob we own. Entries can also point at the user's own files
     * (a pinned GIF from Pictures, say), so this refuses to touch anything
     * outside our blob directory — losing someone's pictures to a cache
     * eviction would be unforgivable.
     */
    _deleteBlobIfUnused(name) {
        if (!name)
            return;
        const path = this._blobPath(name);
        if (!path.startsWith(`${this.blobDir}/`))
            return;
        if (this.items.some(it => it.file === name))
            return;
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch {
            // already gone
        }
    }

    // ----------------------------------------------------------- mutations

    /** Adds text, or promotes an existing identical entry to the front. */
    addText(text) {
        if (!text || !text.trim())
            return null;

        const existing = this.items.find(it => it.type === TYPE_TEXT && it.text === text);
        if (existing) {
            this._promote(existing);
            return existing;
        }

        const item = {
            id: this._nextId++,
            type: TYPE_TEXT,
            text,
            pinned: false,
            ts: this._now(),
        };
        this.items.unshift(item);
        this._evict();
        this._scheduleSave();
        return item;
    }

    /** Adds an image payload; identical bytes reuse the existing entry. */
    addImage(bytes, mime) {
        const digest = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        const ext = mimeExtension(mime);
        const name = `${digest}${ext}`;

        const existing = this.items.find(it => it.type === TYPE_IMAGE && it.file === name);
        if (existing) {
            this._promote(existing);
            return existing;
        }

        const item = {
            id: this._nextId++,
            type: TYPE_IMAGE,
            file: name,
            mime,
            bytes: bytes.get_size(),
            pinned: false,
            ts: this._now(),
        };
        const path = this._blobPath(name);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            // An entry pointing at a blob we failed to write would only render
            // as a broken thumbnail, so drop it if the write does not land.
            this._writeBlobAsync(path, bytes, () => this.remove(item.id));
        }

        this.items.unshift(item);
        this._evict();
        this._scheduleSave();
        return item;
    }

    /** Registers a GIF already sitting in the favourites folder. */
    addGifFavourite(basename) {
        const name = `gifs/${basename}`;
        let item = this.items.find(it => it.type === TYPE_IMAGE && it.file === name);
        if (item) {
            item.pinned = true;
        } else {
            item = {
                id: this._nextId++,
                type: TYPE_IMAGE,
                file: name,
                mime: 'image/gif',
                pinned: true,
                ts: this._now(),
            };
            this.items.push(item);
        }
        this._scheduleSave();
        return item;
    }

    /** Pins/unpins a file that lives outside our store, by absolute path. */
    togglePinPath(path, mime = 'image/gif') {
        const existing = this.items.find(it => it.type === TYPE_IMAGE && it.file === path);
        if (existing) {
            // Unpinning a reference to someone's own file means forgetting it,
            // not keeping a stray history entry. The file itself is untouched.
            this.remove(existing.id);
            return false;
        }
        this.items.unshift({
            id: this._nextId++,
            type: TYPE_IMAGE,
            file: path,
            mime,
            pinned: true,
            ts: this._now(),
        });
        this._scheduleSave();
        return true;
    }

    isPinnedPath(path) {
        return this.items.some(it => it.file === path && it.pinned);
    }

    _promote(item) {
        const i = this.items.indexOf(item);
        if (i > 0) {
            this.items.splice(i, 1);
            this.items.unshift(item);
        }
        item.ts = this._now();
        this._scheduleSave();
    }

    remove(id) {
        const i = this.items.findIndex(it => it.id === id);
        if (i < 0)
            return;
        const [item] = this.items.splice(i, 1);
        if (item.type === TYPE_IMAGE)
            this._deleteBlobIfUnused(item.file);
        this._scheduleSave();
    }

    togglePin(id) {
        const item = this.items.find(it => it.id === id);
        if (!item)
            return;
        item.pinned = !item.pinned;
        this._scheduleSave();
        return item.pinned;
    }

    clearUnpinned() {
        const removed = this.items.filter(it => !it.pinned);
        this.items = this.items.filter(it => it.pinned);
        for (const it of removed) {
            if (it.type === TYPE_IMAGE)
                this._deleteBlobIfUnused(it.file);
        }
        this._scheduleSave();
    }

    setHistorySize(n) {
        this._historySize = n;
        // Persist the trim: without this the eviction lived only in memory
        // until some later copy happened to schedule a save.
        if (this._evict())
            this._scheduleSave();
    }

    setMaxBlobMb(n) {
        this._maxBlobMb = n;
        if (this._evict())
            this._scheduleSave();
    }

    /** Trims to the entry cap and the image budget. Returns true if anything went. */
    _evict() {
        const doomed = [...this._overCountCap(), ...this._overBlobBudget()];
        if (!doomed.length)
            return false;

        const dropping = new Set(doomed);
        this.items = this.items.filter(it => !dropping.has(it));
        for (const it of dropping) {
            if (it.type === TYPE_IMAGE)
                this._deleteBlobIfUnused(it.file);
        }
        return true;
    }

    /** Unpinned entries past the history cap, oldest first. */
    _overCountCap() {
        const cap = this._historySize || 100;
        const doomed = [];
        let seen = 0;
        for (const it of this.items) {
            if (it.pinned)
                continue;
            seen++;
            if (seen > cap)
                doomed.push(it);
        }
        return doomed;
    }

    /* Images are the only entries that can grow without bound — a hundred
     * screenshots at the per-image limit would be gigabytes. Walking newest
     * first, once the blobs we own exceed the budget the rest are dropped.
     * Pinned images and references to the user's own files are never counted
     * against it, since neither is ours to reclaim.
     */
    _overBlobBudget() {
        const budget = (this._maxBlobMb || 200) * 1024 * 1024;
        const doomed = [];
        let total = 0;
        for (const it of this.items) {
            if (it.type !== TYPE_IMAGE || it.file.startsWith('/'))
                continue;
            if (it.pinned)
                continue;
            total += it.bytes || 0;
            if (total > budget)
                doomed.push(it);
        }
        return doomed;
    }

    _now() {
        return GLib.DateTime.new_now_local().to_unix();
    }

    // ------------------------------------------------------------- queries

    get pinned() {
        return this.items.filter(it => it.pinned);
    }

    get recent() {
        return this.items.filter(it => !it.pinned);
    }

    gifs() {
        return this.items.filter(it => it.type === TYPE_IMAGE && it.mime === 'image/gif');
    }
}

function blobIsUsable(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            'standard::size', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_size() > 0;
    } catch {
        return false;
    }
}

export function mimeExtension(mime) {
    switch (mime) {
    case 'image/gif': return '.gif';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/bmp': return '.bmp';
    case 'image/tiff': return '.tiff';
    default: return '.png';
    }
}
