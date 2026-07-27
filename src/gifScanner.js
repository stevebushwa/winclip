// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

/* Finds GIFs already sitting on disk.
 *
 * This runs inside the compositor, so a synchronous walk of Pictures (a couple
 * of thousand files here) would visibly stall the desktop. Everything below is
 * async and cancellable, bounded by depth and result count, and the outcome is
 * cached so reopening the tab does not rescan.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BATCH = 32;
const STALE_US = 30 * 1000 * 1000; // rescan at most every 30s
const ATTRS = [
    'standard::name',
    'standard::type',
    'standard::is-hidden',
    'standard::is-symlink',
    'standard::size',
    'time::modified',
].join(',');

const SPECIAL = {
    '@DOWNLOAD': GLib.UserDirectory.DIRECTORY_DOWNLOAD,
    '@PICTURES': GLib.UserDirectory.DIRECTORY_PICTURES,
    '@DOCUMENTS': GLib.UserDirectory.DIRECTORY_DOCUMENTS,
    '@DESKTOP': GLib.UserDirectory.DIRECTORY_DESKTOP,
    '@VIDEOS': GLib.UserDirectory.DIRECTORY_VIDEOS,
    '@MUSIC': GLib.UserDirectory.DIRECTORY_MUSIC,
};

/** '@PICTURES' and '~/foo' both become absolute paths. */
export function resolveFolder(token) {
    if (token in SPECIAL)
        return GLib.get_user_special_dir(SPECIAL[token]);
    if (token === '~')
        return GLib.get_home_dir();
    if (token.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), token.slice(2)]);
    return token;
}

export function describeFolder(token) {
    const path = resolveFolder(token);
    if (!path)
        return token;
    const home = GLib.get_home_dir();
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export class GifScanner {
    constructor(settings) {
        this._settings = settings;
        this._results = [];
        this._scanning = false;
        this._lastScan = 0;
        this._cancellable = null;
    }

    get results() {
        return this._results;
    }

    get scanning() {
        return this._scanning;
    }

    get everScanned() {
        return this._lastScan !== 0;
    }

    destroy() {
        this.cancel();
        this._results = [];
    }

    cancel() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._scanning = false;
    }

    folders() {
        return this._settings.get_strv('gif-scan-folders')
            .map(resolveFolder)
            .filter(path => path && GLib.file_test(path, GLib.FileTest.IS_DIR));
    }

    /** Scans only if the cached result has gone stale. */
    maybeScan(onDone) {
        if (this._scanning)
            return;
        if (this._lastScan && GLib.get_monotonic_time() - this._lastScan < STALE_US)
            return;
        this.scan(onDone);
    }

    scan(onDone) {
        this.cancel();

        const folders = this.folders();
        if (!folders.length) {
            this._results = [];
            this._lastScan = GLib.get_monotonic_time();
            onDone?.();
            return;
        }

        this._cancellable = new Gio.Cancellable();
        this._scanning = true;

        const state = {
            found: [],
            seen: new Set(),
            queue: folders.map(path => ({file: Gio.File.new_for_path(path), depth: 0})),
            maxResults: this._settings.get_int('gif-scan-max'),
            maxDepth: this._settings.get_int('gif-scan-depth'),
            cancellable: this._cancellable,
        };

        this._pump(state, () => {
            this._scanning = false;
            this._lastScan = GLib.get_monotonic_time();
            // Most recently modified first — newly saved GIFs surface at the top.
            state.found.sort((a, b) => b.mtime - a.mtime);
            this._results = state.found;
            this._cancellable = null;
            onDone?.();
        });
    }

    _pump(state, finish) {
        if (state.cancellable.is_cancelled()) {
            finish();
            return;
        }
        if (!state.queue.length || state.found.length >= state.maxResults) {
            finish();
            return;
        }
        const {file, depth} = state.queue.shift();
        this._scanDir(file, depth, state, () => this._pump(state, finish));
    }

    _scanDir(dir, depth, state, done) {
        dir.enumerate_children_async(ATTRS, Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, state.cancellable, (src, res) => {
                let enumerator;
                try {
                    enumerator = src.enumerate_children_finish(res);
                } catch {
                    done(); // unreadable directory: skip it, keep scanning
                    return;
                }
                this._readBatch(enumerator, dir, depth, state, done);
            });
    }

    _readBatch(enumerator, dir, depth, state, done) {
        enumerator.next_files_async(BATCH, GLib.PRIORITY_LOW, state.cancellable,
            (src, res) => {
                let infos;
                try {
                    infos = src.next_files_finish(res);
                } catch {
                    done();
                    return;
                }

                if (!infos.length) {
                    src.close_async(GLib.PRIORITY_LOW, null, (s, r) => {
                        try {
                            s.close_finish(r);
                        } catch {
                            // nothing useful to do
                        }
                    });
                    done();
                    return;
                }

                for (const info of infos) {
                    if (info.get_is_hidden())
                        continue;

                    const name = info.get_name();
                    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                        // Symlinked directories can loop back on themselves.
                        if (depth < state.maxDepth && !info.get_is_symlink())
                            state.queue.push({file: dir.get_child(name), depth: depth + 1});
                        continue;
                    }

                    if (!name.toLowerCase().endsWith('.gif'))
                        continue;

                    const path = GLib.build_filenamev([dir.get_path(), name]);
                    if (state.seen.has(path))
                        continue;
                    state.seen.add(path);
                    state.found.push({
                        path,
                        name,
                        size: info.get_size(),
                        mtime: info.get_modification_date_time()?.to_unix() ?? 0,
                    });
                }

                if (state.found.length >= state.maxResults) {
                    done();
                    return;
                }
                this._readBatch(enumerator, dir, depth, state, done);
            });
    }
}
