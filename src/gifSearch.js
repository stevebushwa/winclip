// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

/* Online GIF search.
 *
 * Off unless the user picks a provider and supplies their own API key: an key
 * shipped inside an open-source extension would be extracted within a day and
 * revoked for breaching the provider's terms, so there is nothing embedded
 * here. Nothing contacts the network until a provider is chosen, a key is
 * entered, and something is actually typed into the search box.
 *
 * Results are fetched as small preview GIFs for the grid; the full-size file
 * is only downloaded when an entry is chosen or pinned. Previews live in a
 * cache directory held to a size budget, and emptied when the extension is
 * disabled.
 *
 * Three things here exist to keep a run of searches from swamping the shell,
 * all of them measured rather than guessed:
 *
 *   - A search waits for a pause in typing. The grid refreshes on every
 *     keystroke, and firing a query from each one meant "buzz lightyear" was
 *     fourteen searches and fourteen sets of downloads, thirteen of which were
 *     thrown away.
 *   - Downloads run a few at a time and stream to disk. Reading each response
 *     into memory first meant a page of results could hold hundreds of
 *     megabytes at once, waiting on the garbage collector to let go.
 *   - The cache is pruned to a budget after every search. Wiping it on disable
 *     was the only cleanup, and that runs asynchronously as the session is
 *     ending, so it rarely finished: a real cache had grown to 1630 files.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const USER_AGENT = 'WinClip (GNOME Shell extension)';
const TIMEOUT_S = 15;
const MIN_QUERY = 2;
const TYPING_PAUSE_MS = 400;      // quiet time before a query is actually sent
const MAX_PARALLEL = 4;           // preview downloads in flight
const MAX_PREVIEW_MB = 8;
const MAX_FULL_MB = 32;

/* Rating is stored provider-independently and mapped per API. */
const RATINGS = {
    strict:   {giphy: 'g'},
    moderate: {giphy: 'pg-13'},
    off:      {giphy: 'r'},
};

function query(params) {
    return Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
}

/* Tenor is deliberately absent: Google stopped issuing keys on 13 January
 * 2026 and shut the public API down on 30 June, taking the GIF pickers in
 * Discord, WhatsApp, X and Bluesky with it. There is nothing left to talk to.
 */
class GiphyProvider {
    get id() {
        return 'giphy';
    }

    get label() {
        return 'Giphy';
    }

    url(q, key, limit, rating) {
        return `https://api.giphy.com/v1/gifs/search?${query({
            q,
            api_key: key,
            limit,
            rating: RATINGS[rating]?.giphy ?? 'pg-13',
            bundle: 'messaging_non_clips',
        })}`;
    }

    parse(json) {
        return (json?.data ?? []).map(r => ({
            id: `giphy-${r.id}`,
            title: r.title ?? '',
            preview: r.images?.fixed_width_small?.url ?? r.images?.preview_gif?.url,
            full: r.images?.downsized_medium?.url ?? r.images?.original?.url,
        }));
    }
}

const PROVIDERS = {
    giphy: new GiphyProvider(),
};

export function providerLabel(id) {
    return PROVIDERS[id]?.label ?? null;
}

export class GifSearch {
    constructor(settings) {
        this._settings = settings;
        this._session = null;
        this._cancellable = null;
        this._pendingTimer = 0;
        this._pendingTerm = '';
        this._pruned = false;
        this._downloadSeq = 0;

        this._results = [];
        this._query = '';
        this._searching = false;
        this._error = null;

        this._cacheDir = GLib.build_filenamev(
            [GLib.get_user_data_dir(), 'winclip', 'cache']);
    }

    get results() {
        return this._results;
    }

    get searching() {
        return this._searching;
    }

    get error() {
        return this._error;
    }

    get provider() {
        return PROVIDERS[this._settings.get_string('gif-search-provider')] ?? null;
    }

    get label() {
        return this.provider?.label ?? '';
    }

    /** True only when a provider is chosen and its key has been filled in. */
    get enabled() {
        const p = this.provider;
        return !!p && !!this._key(p);
    }

    _key(provider) {
        return this._settings.get_string(`gif-${provider.id}-key`).trim();
    }

    _session_() {
        if (!this._session) {
            this._session = new Soup.Session({user_agent: USER_AGENT});
            this._session.timeout = TIMEOUT_S;
        }
        return this._session;
    }

    destroy() {
        this.cancel();
        this._session?.abort();
        this._session = null;
        this._results = [];
        this._clearCache();
    }

    cancel() {
        if (this._pendingTimer) {
            GLib.source_remove(this._pendingTimer);
            this._pendingTimer = 0;
        }
        this._pendingTerm = '';
        this._cancellable?.cancel();
        this._cancellable = null;
        this._searching = false;
    }

    /** Clears results without touching the network. */
    reset() {
        this.cancel();
        this._results = [];
        this._query = '';
        this._error = null;
    }

    /**
     * Queues a search unless this exact query is already loaded or in flight.
     *
     * Called from every grid refresh, so most calls are a keystroke into a
     * half-typed word. Nothing is sent until the typing stops.
     */
    maybeSearch(q, onDone) {
        const term = (q ?? '').trim();
        if (!this.enabled || term.length < MIN_QUERY) {
            this.cancel();
            if (this._results.length || this._query) {
                this._results = [];
                this._query = '';
                this._error = null;
            }
            return;
        }
        if (term === this._query || term === this._pendingTerm)
            return;

        this._pendingTerm = term;
        // Reported as searching straight away, so the grid says so rather than
        // flashing "no results" during the pause.
        this._searching = true;
        if (this._pendingTimer)
            GLib.source_remove(this._pendingTimer);
        this._pendingTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, TYPING_PAUSE_MS, () => {
                this._pendingTimer = 0;
                const term_ = this._pendingTerm;
                this._pendingTerm = '';
                this.search(term_, onDone);
                return GLib.SOURCE_REMOVE;
            });
    }

    search(term, onDone) {
        this.cancel();

        const provider = this.provider;
        const key = this._key(provider);
        const limit = this._settings.get_int('gif-search-limit');
        const rating = this._settings.get_string('gif-search-rating');

        this._query = term;
        this._error = null;
        this._searching = true;
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        const finish = (results, error) => {
            if (cancellable.is_cancelled())
                return;
            this._results = results;
            this._error = error ?? null;
            this._searching = false;
            onDone?.();
        };

        const message = Soup.Message.new('GET', provider.url(term, key, limit, rating));
        this._session_().send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                let bytes;
                try {
                    bytes = session.send_and_read_finish(res);
                } catch (e) {
                    if (!cancellable.is_cancelled())
                        finish([], 'Could not reach the service.');
                    return;
                }

                const status = message.get_status();
                if (status !== Soup.Status.OK) {
                    finish([], status === Soup.Status.UNAUTHORIZED ||
                               status === Soup.Status.FORBIDDEN
                        ? 'The API key was rejected.'
                        : `Search failed (HTTP ${status}).`);
                    return;
                }

                let parsed;
                try {
                    parsed = provider.parse(
                        JSON.parse(new TextDecoder().decode(bytes.get_data())));
                } catch (e) {
                    console.error('winclip: could not parse search response', e);
                    finish([], 'Unexpected response from the service.');
                    return;
                }

                const usable = parsed.filter(r => r.preview && r.full);
                if (!usable.length) {
                    finish([], 'No results.');
                    return;
                }
                this._fetchPreviews(usable, cancellable, finish);
            });
    }

    /* Downloads the small previews a few at a time, then reports whatever
     * arrived. One bad result should not sink the whole grid, so failures are
     * simply dropped.
     */
    _fetchPreviews(items, cancellable, finish) {
        GLib.mkdir_with_parents(this._cacheDir, 0o700);

        const done = [];
        let started = 0;
        let active = 0;
        let settled = 0;

        const pump = () => {
            while (active < MAX_PARALLEL && started < items.length) {
                const item = items[started++];
                active++;
                this._download(item.preview, cancellable, path => {
                    if (path)
                        done.push({...item, path});
                    active--;
                    if (++settled === items.length) {
                        // Provider ordering, not completion order.
                        const rank = new Map(items.map((it, i) => [it.id, i]));
                        done.sort((a, b) => rank.get(a.id) - rank.get(b.id));
                        finish(done, done.length ? null : 'Could not download results.');
                        this.pruneCache();
                        return;
                    }
                    pump();
                }, '', MAX_PREVIEW_MB);
            }
        };
        pump();
    }

    _cachePath(url, suffix = '') {
        const digest = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1);
        return GLib.build_filenamev([this._cacheDir, `${digest}${suffix}.gif`]);
    }

    /**
     * Fetches `url` into the cache, reusing the file if already present.
     *
     * The body is spliced straight from the socket to the file instead of
     * being read into memory first, so a page of results costs a few buffers
     * rather than the sum of every file on it. It lands under a temporary name
     * and is renamed on success: a download cut short — by a cancelled search,
     * most often — must not leave a truncated file behind that every later
     * lookup would then treat as a valid cache hit.
     */
    _download(url, cancellable, callback, suffix = '', maxMb = MAX_FULL_MB) {
        const path = this._cachePath(url, suffix);
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            callback(path);
            return;
        }
        // Unique per attempt: two results can point at the same URL, and a
        // shared temporary file would have them writing over each other.
        const partial = Gio.File.new_for_path(`${path}.${++this._downloadSeq}.part`);
        const discard = () => partial.delete_async(GLib.PRIORITY_LOW, null, (f, r) => {
            try {
                f.delete_finish(r);
            } catch {
                // nothing was written
            }
        });

        const message = Soup.Message.new('GET', url);
        this._session_().send_async(
            message, GLib.PRIORITY_LOW, cancellable, (session, res) => {
                let input;
                try {
                    input = session.send_finish(res);
                } catch {
                    callback(null);
                    return;
                }
                const length = message.get_response_headers().get_content_length();
                if (message.get_status() !== Soup.Status.OK || length > maxMb * 1048576) {
                    input.close_async(GLib.PRIORITY_LOW, null, () => {});
                    callback(null);
                    return;
                }

                let output;
                try {
                    GLib.mkdir_with_parents(this._cacheDir, 0o700);
                    output = partial.replace(null, false, Gio.FileCreateFlags.PRIVATE, cancellable);
                } catch {
                    input.close_async(GLib.PRIORITY_LOW, null, () => {});
                    callback(null);
                    return;
                }

                output.splice_async(
                    input,
                    Gio.OutputStreamSpliceFlags.CLOSE_SOURCE |
                        Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
                    GLib.PRIORITY_LOW, cancellable, (out, sres) => {
                        let written = -1;
                        try {
                            written = out.splice_finish(sres);
                        } catch {
                            // cancelled, or the connection dropped
                        }
                        if (written <= 0) {
                            discard();
                            callback(null);
                            return;
                        }
                        try {
                            partial.move(Gio.File.new_for_path(path),
                                Gio.FileCopyFlags.OVERWRITE, null, null);
                            callback(path);
                        } catch {
                            discard();
                            callback(null);
                        }
                    });
            });
    }

    /**
     * Downloads the full-size GIF for a result. `callback` receives the path,
     * or null. Used when an entry is chosen or pinned, so the grid never pays
     * for full-resolution files it may not need.
     */
    fetchFull(result, callback) {
        const cancellable = new Gio.Cancellable();
        this._download(result.full, cancellable, callback, '-full');
    }

    /** Copies a fetched GIF into the favourites folder so it outlives the cache. */
    saveAsFavourite(result, path) {
        const gifDir = GLib.build_filenamev(
            [GLib.get_user_data_dir(), 'winclip', 'gifs']);
        GLib.mkdir_with_parents(gifDir, 0o700);
        const safe = result.id.replace(/[^A-Za-z0-9_-]/g, '');
        const dest = GLib.build_filenamev([gifDir, `${safe}.gif`]);
        try {
            Gio.File.new_for_path(path).copy(
                Gio.File.new_for_path(dest), Gio.FileCopyFlags.OVERWRITE, null, null);
            return dest;
        } catch (e) {
            console.error('winclip: could not save GIF to favourites', e);
            return null;
        }
    }

    /**
     * Holds the preview cache to its size budget, oldest first.
     *
     * Run after every search rather than only on disable. The disable-time
     * wipe is asynchronous and fires as the session is ending, so it usually
     * does not get to finish — which is how a cache reaches 1630 files without
     * anyone touching it.
     *
     * Evicting a file that is still on screen is harmless: the thumbnail is
     * already uploaded, and choosing the entry re-fetches it. Since the
     * current page of results is also the newest on disk, oldest-first
     * eviction reaches it last anyway.
     */
    /* Once per session, so a cache left oversized by an earlier run is brought
     * back into line even if the user never searches again. */
    pruneOnce() {
        if (this._pruned)
            return;
        this._pruned = true;
        this.pruneCache();
    }

    pruneCache() {
        const budget = this._settings.get_int('gif-cache-mb') * 1048576;
        Gio.File.new_for_path(this._cacheDir).enumerate_children_async(
            'standard::name,standard::size,time::modified', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, null, (dir, res) => {
                let enumerator;
                try {
                    enumerator = dir.enumerate_children_finish(res);
                } catch {
                    return;   // nothing cached yet
                }
                const files = [];
                let total = 0;
                const readMore = () => {
                    enumerator.next_files_async(64, GLib.PRIORITY_LOW, null, (src, r) => {
                        let infos;
                        try {
                            infos = src.next_files_finish(r);
                        } catch {
                            infos = [];
                        }
                        if (!infos.length) {
                            src.close_async(GLib.PRIORITY_LOW, null, () => {});
                            this._evict(files, total, budget);
                            return;
                        }
                        for (const info of infos) {
                            total += info.get_size();
                            files.push({
                                name: info.get_name(),
                                size: info.get_size(),
                                mtime: info.get_modification_date_time()?.to_unix() ?? 0,
                            });
                        }
                        readMore();
                    });
                };
                readMore();
            });
    }

    _evict(files, total, budget) {
        if (total <= budget)
            return;
        files.sort((a, b) => a.mtime - b.mtime);
        let over = total - budget;
        let dropped = 0;
        for (const file of files) {
            if (over <= 0)
                break;
            over -= file.size;
            dropped++;
            Gio.File.new_for_path(GLib.build_filenamev([this._cacheDir, file.name]))
                .delete_async(GLib.PRIORITY_LOW, null, (f, r) => {
                    try {
                        f.delete_finish(r);
                    } catch {
                        // already gone
                    }
                });
        }
        console.debug(`winclip: dropped ${dropped} cached previews to stay under ` +
            `${Math.round(budget / 1048576)} MB`);
    }

    /* Best effort and asynchronous: leftover preview files are harmless, and
     * this runs on disable where blocking the compositor is least welcome. */
    _clearCache() {
        Gio.File.new_for_path(this._cacheDir).enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, null, (file, res) => {
                let enumerator;
                try {
                    enumerator = file.enumerate_children_finish(res);
                } catch {
                    return;
                }
                const drain = () => {
                    enumerator.next_files_async(32, GLib.PRIORITY_LOW, null, (src, r) => {
                        let infos;
                        try {
                            infos = src.next_files_finish(r);
                        } catch {
                            infos = [];
                        }
                        if (!infos.length) {
                            src.close_async(GLib.PRIORITY_LOW, null, () => {});
                            return;
                        }
                        for (const info of infos) {
                            Gio.File.new_for_path(GLib.build_filenamev(
                                [this._cacheDir, info.get_name()]))
                                .delete_async(GLib.PRIORITY_LOW, null, (f, dr) => {
                                    try {
                                        f.delete_finish(dr);
                                    } catch {
                                        // best effort
                                    }
                                });
                        }
                        drain();
                    });
                };
                drain();
            });
    }
}
