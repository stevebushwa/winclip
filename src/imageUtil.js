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
 *   3. Bound the frames retained. Frames materialise as the iterator advances
 *      and are kept, so long animations restart at a cap rather than
 *      accumulating.
 */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import St from 'gi://St';

const TICK_MS = 40;
const MAX_ACTIVE = 6;    // animations playing at once
const MAX_FRAMES = 60;   // frames cycled before a long GIF is restarted

// Files we have already complained about, so a broken image does not fill the
// journal. Cleared on disable along with the rest of this module's state.
const warnedPaths = new Set();

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
            if (!warnedPaths.has(path)) {
                warnedPaths.add(path);
                console.warn(`winclip: cannot read ${path}`, e);
            }
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
            if (!warnedPaths.has(path)) {
                warnedPaths.add(path);
                console.warn(`winclip: cannot animate ${path}`, e);
            }
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
        this._source = 0;
    }

    get activeCount() {
        return this._players.size;
    }

    /** Plays only if there is a free slot. */
    request(player) {
        if (this._players.size < MAX_ACTIVE)
            this.activate(player);
    }

    activate(player) {
        if (this._players.has(player) || player.failed || player.loading || player.dead)
            return;
        if (this._players.size >= MAX_ACTIVE) {
            const victim = [...this._players].find(p => !p.hovered);
            if (!victim)
                return;
            this._release(victim);
        }
        if (player.iter) {
            this._start(player);
            return;
        }

        /* Decoding happens here rather than when the thumbnail is built, so a
         * tab full of GIFs only decodes the few that actually play. */
        player.loading = true;
        loadScaledAnimation(player.path, player.maxW, player.maxH, animation => {
            player.loading = false;
            if (player.dead)
                return;
            if (!animation) {
                player.failed = true;
                return;
            }
            player.animation = animation;
            player.iter = animation.get_iter(null);
            player.frames = 0;
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
        player.frames = 0;
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
        warnedPaths.clear();
        if (this._source) {
            GLib.source_remove(this._source);
            this._source = 0;
        }
    }

    _tick() {
        const now = GLib.get_monotonic_time() / 1000;
        for (const player of [...this._players]) {
            try {
                if (now < player.dueAt)
                    continue;

                // Frames are retained as the iterator walks forward, so a very
                // long GIF restarts instead of accumulating without bound.
                if (++player.frames > MAX_FRAMES) {
                    player.iter = player.animation.get_iter(null);
                    player.frames = 0;
                }

                player.iter.advance(null);
                const frame = scaleToFit(player.iter.get_pixbuf(), player.maxW, player.maxH);
                const content = pixbufToContent(frame);
                if (content)
                    player.actor.set_content(content);
                const delay = player.iter.get_delay_time();
                player.dueAt = now + (delay > 0 ? delay : 100);
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
}

/** How many GIFs are currently animating; useful when diagnosing load. */
export function activeAnimationCount() {
    return ticker?.activeCount ?? 0;
}

/**
 * Builds an actor showing `path`, animating it if it is a playable GIF.
 * Returns null when the file cannot be decoded at all.
 */
export function createImageActor(path, maxW, maxH, {animate = true} = {}) {
    let still;
    try {
        still = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, maxW, maxH, true);
    } catch (e) {
        // Rows are rebuilt on every refresh, so complain once per file rather
        // than on every redraw.
        if (!warnedPaths.has(path)) {
            warnedPaths.add(path);
            console.warn(`winclip: cannot decode ${path}`, e);
        }
        return null;
    }

    const content = pixbufToContent(still);
    if (!content)
        return null;

    const actor = new St.Widget({
        style_class: 'winclip-thumb',
        content,
        width: still.get_width(),
        height: still.get_height(),
        content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });

    if (animate && path.toLowerCase().endsWith('.gif'))
        attachAnimation(actor, path, still.get_width(), still.get_height());

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
        frames: 0,
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
