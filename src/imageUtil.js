// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

/* Turning image files into things the shell can draw.
 *
 * St has no animated-image widget, so GIFs are played by hand. Three rules
 * keep that from eating the compositor, all learned from a folder of 68 GIFs
 * that decoded to 6.7 GB and hung the session:
 *
 *   1. Decode at thumbnail size. GdkPixbufAnimation.new_from_file decodes
 *      every frame at full resolution — a 0.2 MB file holding 1263 frames of
 *      772x673 becomes 2.6 GB. A PixbufLoader told to set_size during
 *      size-prepared yields the same animation for a few MB.
 *   2. Decode lazily, and only for what is playing. Building an animation for
 *      every visible thumbnail is what exhausted memory.
 *   3. Capture a short loop, then drop the decoder. The iterator is driven by
 *      wall-clock time, so playing straight from it keeps decoding new frames
 *      that the animation then holds on to, and every tick allocated a fresh
 *      texture besides — about 43 MB per GIF. A fixed number of frames is
 *      captured once and replayed as ready-made textures.
 *   4. Decode still frames off the main loop, and remember the result. On
 *      Ubuntu 26.04 gdk-pixbuf hands decoding to glycin, a sandboxed loader
 *      reached over D-Bus, so the "cheap" synchronous call is neither cheap
 *      nor local: a grid of 24 thumbnails blocked the compositor for over half
 *      a second, every time the grid was rebuilt. Since the grid is rebuilt on
 *      every keystroke, a few GIF searches in a row were seconds of freeze and
 *      a fresh decode of everything already on screen.
 */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import St from 'gi://St';

const TICK_MS = 40;
const MAX_ACTIVE = 6;      // animations playing at once
const MAX_FRAMES = 24;     // frames captured per GIF, then the source is dropped
const THUMB_CACHE_MAX = 160;   // decoded still frames kept for redraws

// Files we have already complained about, so a broken image does not fill the
// journal. Cleared on disable along with the rest of this module's state.
const warnedPaths = new Set();

function warnOnce(path, message, error) {
    if (warnedPaths.has(path))
        return;
    warnedPaths.add(path);
    console.warn(`winclip: ${message} ${path}`, error);
}

/* Decoded thumbnails, newest last, so the first key is the least recently
 * used. Every search rebuilds the grid from scratch and the same files keep
 * coming back — the folder scan, the favourites, the previous page of results
 * — so without this each keystroke re-decodes everything already on screen.
 * Entries are keyed by size as well as path, since the clipboard rows and the
 * GIF cells ask for different thumbnails of the same file.
 */
let thumbCache = null;

function thumbKey(path, maxW, maxH) {
    return `${maxW}x${maxH}|${path}`;
}

function thumbGet(key) {
    const hit = thumbCache?.get(key);
    if (hit) {
        thumbCache.delete(key);   // reinsert, so it counts as recently used
        thumbCache.set(key, hit);
    }
    return hit ?? null;
}

function thumbPut(key, entry) {
    thumbCache ??= new Map();
    thumbCache.set(key, entry);
    while (thumbCache.size > THUMB_CACHE_MAX)
        thumbCache.delete(thumbCache.keys().next().value);
}

/** Wraps a GdkPixbuf in content an St.Widget can display. */
export function pixbufToContent(pixbuf) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const content = St.ImageContent.new_with_preferred_size(width, height);
    try {
        // Fetched per call rather than cached: a cached context that went
        // stale would make every upload fail for the rest of the session.
        // Shell 50 takes the CoglContext as the first argument; earlier
        // releases did not have it.
        const ok = content.set_bytes(
            Clutter.get_default_backend().get_cogl_context(),
            pixbuf.read_pixel_bytes(),
            pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
            width, height,
            pixbuf.get_rowstride());
        if (!ok) {
            // Used to fail silently, which left a thumbnail blank with
            // nothing in the log to explain it.
            console.warn(`winclip: texture upload refused for ${width}x${height} ` +
                `alpha=${pixbuf.get_has_alpha()} rowstride=${pixbuf.get_rowstride()}`);
            return null;
        }
        return content;
    } catch (e) {
        console.error('winclip: could not upload image to the GPU', e);
        return null;
    }
}

function scaleToFit(pixbuf, maxW, maxH) {
    const w = pixbuf.get_width();
    const h = pixbuf.get_height();
    if (w <= maxW && h <= maxH)
        return pixbuf;
    const scale = Math.min(maxW / w, maxH / h);
    return pixbuf.scale_simple(
        Math.max(1, Math.round(w * scale)),
        Math.max(1, Math.round(h * scale)),
        GdkPixbuf.InterpType.BILINEAR) ?? pixbuf;
}

/**
 * Decodes an animation directly at thumbnail size.
 *
 * The size-prepared handler is the whole point: it makes gdk-pixbuf scale each
 * frame as it decodes, instead of building full-resolution frames we would
 * immediately throw away.
 */
function loadScaledAnimation(path, maxW, maxH, callback) {
    Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
        let contents;
        try {
            [, contents] = file.load_contents_finish(res);
        } catch (e) {
            warnOnce(path, 'cannot read', e);
            callback(null);
            return;
        }

        const loader = GdkPixbuf.PixbufLoader.new();
        loader.connect('size-prepared', (self, width, height) => {
            const scale = Math.min(maxW / width, maxH / height, 1);
            self.set_size(
                Math.max(1, Math.round(width * scale)),
                Math.max(1, Math.round(height * scale)));
        });

        try {
            loader.write(contents);
            loader.close();
        } catch (e) {
            try {
                loader.close();
            } catch {
                // already closed
            }
            warnOnce(path, 'cannot animate', e);
            callback(null);
            return;
        }

        const animation = loader.get_animation();
        callback(animation && !animation.is_static_image() ? animation : null);
    });
}

/* Only a handful play at once, and whatever the pointer is over always wins a
 * slot, so the one you are looking at moves. */
class Ticker {
    constructor() {
        this._players = new Set();
        this._loading = 0;
        this._source = 0;
    }

    get activeCount() {
        return this._players.size;
    }

    /* Decodes in flight count against the cap as well as decodes already
     * playing. Without that, a tab of GIFs would fire every decode at once —
     * they are all requested before any of them has finished loading, so the
     * playing count is still zero and the cap never bites. That is precisely
     * the condition that exhausted memory in the first place.
     */
    get _busy() {
        return this._players.size + this._loading;
    }

    /** Plays only if there is a free slot. */
    request(player) {
        if (this._busy < MAX_ACTIVE)
            this.activate(player);
    }

    activate(player) {
        if (this._players.has(player) || player.failed || player.loading || player.dead)
            return;
        if (this._busy >= MAX_ACTIVE) {
            const victim = [...this._players].find(p => !p.hovered);
            if (!victim)
                return;
            this._release(victim);
        }
        if (player.iter || player.cache.length) {
            this._start(player);
            return;
        }

        /* Decoding happens here rather than when the thumbnail is built, so a
         * tab full of GIFs only decodes the few that actually play. */
        player.loading = true;
        this._loading++;
        loadScaledAnimation(player.path, player.maxW, player.maxH, animation => {
            player.loading = false;
            this._loading--;
            if (player.dead)
                return;
            if (!animation) {
                player.failed = true;
                return;
            }
            player.animation = animation;
            player.iter = animation.get_iter(null);
            player.cache = [];
            player.index = 0;
            // The tab may have moved on while we were reading from disk.
            if (this._players.size < MAX_ACTIVE || player.hovered)
                this._start(player);
        });
    }

    _start(player) {
        this._players.add(player);
        if (!this._source) {
            this._source = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, TICK_MS, () => {
                this._tick();
                if (this._players.size === 0) {
                    this._source = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    /** Stops a player and lets its decoded frames go. */
    _release(player) {
        this._players.delete(player);
        player.iter = null;
        player.animation = null;
        player.cache = [];
        player.index = 0;
    }

    setHovered(player, hovered) {
        player.hovered = hovered;
        if (hovered)
            this.activate(player);
    }

    /* Marked dead so an in-flight decode does not resurrect a destroyed actor. */
    remove(player) {
        player.dead = true;
        this._release(player);
    }

    stop() {
        for (const player of [...this._players])
            this._release(player);
        this._players.clear();
        this._loading = 0;
        warnedPaths.clear();
        if (this._source) {
            GLib.source_remove(this._source);
            this._source = 0;
        }
    }

    /* Each GIF is captured once into a short loop of ready-made textures, and
     * the decoder is then thrown away. Playing straight from the animation
     * instead cost about 43 MB per GIF: the iterator is driven by wall-clock
     * time, so it keeps decoding new frames, the animation retains every one
     * of them, and each tick also allocated a fresh texture. Capturing a fixed
     * number of frames bounds both, and replaying them afterwards costs
     * nothing but a content swap.
     */
    _tick() {
        const now = GLib.get_monotonic_time() / 1000;
        for (const player of [...this._players]) {
            try {
                if (now < player.dueAt)
                    continue;

                if (player.iter) {
                    const frame = scaleToFit(
                        player.iter.get_pixbuf(), player.maxW, player.maxH);
                    const content = pixbufToContent(frame);
                    const delay = player.iter.get_delay_time();
                    const wait = delay > 0 ? delay : 100;

                    player.cache.push({content, delay: wait});
                    player.iter.advance(null);

                    if (player.cache.length >= MAX_FRAMES) {
                        // Captured enough: release the decoder and every frame
                        // it was holding on to.
                        player.iter = null;
                        player.animation = null;
                    }

                    if (content)
                        player.actor.set_content(content);
                    player.dueAt = now + wait;
                    continue;
                }

                // Replaying the captured loop: no decode, no allocation.
                const frame = player.cache[player.index];
                player.index = (player.index + 1) % player.cache.length;
                if (frame.content)
                    player.actor.set_content(frame.content);
                player.dueAt = now + frame.delay;
            } catch (e) {
                console.error('winclip: gif playback failed', e);
                this._release(player);
            }
        }
    }
}

/* Built on first use rather than at module scope: importing a module must not
 * create anything, since imports happen before enable() is called. Dropped on
 * disable so no module-level state outlives the extension.
 */
let ticker = null;

function getTicker() {
    if (!ticker)
        ticker = new Ticker();
    return ticker;
}

export function stopAllAnimations() {
    ticker?.stop();
    ticker = null;
    warnedPaths.clear();
    thumbCache = null;
}

/** How many GIFs are currently animating; useful when diagnosing load. */
export function activeAnimationCount() {
    return ticker?.activeCount ?? 0;
}

/* Decodes a still frame without blocking the main loop.
 *
 * The synchronous new_from_file_at_scale goes out to the glycin loader over
 * D-Bus and waits, which stops the compositor dead; the async form lets the
 * loop keep running while the sandboxed process works. It also fails more
 * gracefully: glycin caps its own memory, and a large GIF that would have
 * thrown "out of memory" mid-refresh now just reports back empty.
 */
function decodeScaledAsync(path, maxW, maxH, callback) {
    Gio.File.new_for_path(path).read_async(GLib.PRIORITY_DEFAULT_IDLE, null, (file, res) => {
        let stream;
        try {
            stream = file.read_finish(res);
        } catch (e) {
            warnOnce(path, 'cannot read', e);
            callback(null);
            return;
        }
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
            stream, maxW, maxH, true, null, (_source, r) => {
                let pixbuf = null;
                try {
                    pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(r);
                } catch (e) {
                    warnOnce(path, 'cannot decode', e);
                }
                stream.close_async(GLib.PRIORITY_LOW, null, () => {});
                callback(pixbuf);
            });
    });
}

/**
 * Builds an actor showing `path`, animating it if it is a playable GIF.
 *
 * The actor comes back straight away at its reserved size and fills in once
 * the file has been decoded, so a grid of them costs the compositor nothing
 * to build. A file that cannot be decoded shows a placeholder rather than
 * leaving a hole in the layout.
 */
export function createImageActor(path, maxW, maxH, {animate = true} = {}) {
    const actor = new St.Bin({
        style_class: 'winclip-thumb',
        width: maxW,
        height: maxH,
        content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const show = entry => {
        actor.set_content(entry.content);
        actor.set_size(entry.width, entry.height);
        if (animate && path.toLowerCase().endsWith('.gif'))
            attachAnimation(actor, path, entry.width, entry.height);
    };

    const key = thumbKey(path, maxW, maxH);
    const cached = thumbGet(key);
    if (cached) {
        show(cached);
        return actor;
    }

    // The grid is rebuilt as fast as the user types, so by the time a decode
    // lands its actor is often already gone.
    let alive = true;
    actor.connect('destroy', () => {
        alive = false;
    });

    decodeScaledAsync(path, maxW, maxH, pixbuf => {
        if (!alive)
            return;
        const content = pixbuf ? pixbufToContent(pixbuf) : null;
        if (!content) {
            actor.set_child(new St.Label({style_class: 'winclip-thumb-missing', text: '?'}));
            return;
        }
        const entry = {content, width: pixbuf.get_width(), height: pixbuf.get_height()};
        thumbPut(key, entry);
        show(entry);
    });

    return actor;
}

/* Registers a player without decoding anything: the still frame is already on
 * screen, and the animation is built only if the ticker gives it a slot. */
function attachAnimation(actor, path, maxW, maxH) {
    const player = {
        actor,
        path,
        maxW,
        maxH,
        animation: null,
        iter: null,
        cache: [],
        index: 0,
        failed: false,
        loading: false,
        dead: false,
        dueAt: 0,
        hovered: false,
    };
    actor._winclipPlayer = player;
    getTicker().request(player);
    actor.connect('destroy', () => ticker?.remove(player));
}

/** Gives a thumbnail's animation priority while the pointer is over it. */
export function setThumbHovered(actor, hovered) {
    const player = actor?._winclipPlayer;
    if (player)
        getTicker().setHovered(player, hovered);
}
