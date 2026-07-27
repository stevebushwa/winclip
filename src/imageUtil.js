// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

/* Turning image files into things the shell can draw.
 *
 * St has no animated-image widget, so GIFs are played by hand: one shared
 * ticker advances every visible GdkPixbufAnimation iterator and swaps the
 * actor's content. Registered actors unregister themselves on destroy, and the
 * ticker stops as soon as nothing is left to animate.
 */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import St from 'gi://St';

const TICK_MS = 40;
const MAX_ACTIVE = 12;

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

/* A folder scan can turn up dozens of GIFs, and every animated frame costs a
 * rescale plus a GPU upload. Only a handful play at once; whatever the pointer
 * is over always wins a slot, so the one you are actually looking at moves.
 */
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
        if (this._players.has(player))
            return;
        if (this._players.size >= MAX_ACTIVE) {
            const victim = [...this._players].find(p => !p.hovered);
            if (!victim)
                return;
            this._players.delete(victim);
        }
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

    setHovered(player, hovered) {
        player.hovered = hovered;
        if (hovered)
            this.activate(player);
    }

    remove(player) {
        this._players.delete(player);
    }

    stop() {
        this._players.clear();
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
                player.iter.advance(null);
                const frame = scaleToFit(player.iter.get_pixbuf(), player.maxW, player.maxH);
                const content = pixbufToContent(frame);
                if (content)
                    player.actor.set_content(content);
                const delay = player.iter.get_delay_time();
                player.dueAt = now + (delay > 0 ? delay : 100);
            } catch (e) {
                console.error('winclip: gif playback failed', e);
                this._players.delete(player);
            }
        }
    }
}

const ticker = new Ticker();

export function stopAllAnimations() {
    ticker.stop();
    // Module-scope state must not survive disable().
    warnedPaths.clear();
}

/** How many GIFs are currently animating; useful when diagnosing load. */
export function activeAnimationCount() {
    return ticker.activeCount;
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

function attachAnimation(actor, path, maxW, maxH) {
    let anim, iter;
    try {
        anim = GdkPixbuf.PixbufAnimation.new_from_file(path);
        if (anim.is_static_image())
            return;
        iter = anim.get_iter(null);
    } catch (e) {
        // Not fatal: the still frame is already on screen.
        console.error(`winclip: cannot animate ${path}`, e);
        return;
    }

    const player = {actor, iter, maxW, maxH, dueAt: 0, hovered: false};
    actor._winclipPlayer = player;
    ticker.request(player);
    actor.connect('destroy', () => ticker.remove(player));
}

/** Gives a thumbnail's animation priority while the pointer is over it. */
export function setThumbHovered(actor, hovered) {
    const player = actor?._winclipPlayer;
    if (player)
        ticker.setHovered(player, hovered);
}

/** Reads a file into GLib.Bytes, for putting images back on the clipboard. */
export function readFileBytes(path) {
    const [ok, contents] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error(`winclip: could not read ${path}`);
    return new GLib.Bytes(contents);
}
