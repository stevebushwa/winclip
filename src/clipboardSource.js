// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

/* Choosing what flavour an image goes onto the clipboard as.
 *
 * GNOME offers exactly one MIME type per clipboard offer. St.Clipboard takes a
 * single type, and advertising several by owning the selection with a custom
 * MetaSelectionSource is not possible either: GJS cannot implement a vfunc
 * that takes a callback, which read_async does.
 *
 * That matters for GIFs. Offered as image/gif they paste into almost nothing,
 * because nearly every application asks for image/png — which is why a copied
 * GIF appeared to do nothing at all. So a GIF is converted to PNG by default,
 * which pastes everywhere at the cost of the animation, and the format is a
 * setting for anyone who would rather keep it moving.
 */

import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

function fileBytes(path) {
    const [ok, contents] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error(`winclip: could not read ${path}`);
    return new GLib.Bytes(contents);
}

/** Renders the first frame of any image as PNG. */
function asPng(path) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
    if (!ok)
        throw new Error(`winclip: could not render ${path} as PNG`);
    return new GLib.Bytes(buffer);
}

/** A file:// URI, which file-aware apps treat as "a file was pasted". */
function asUriList(path) {
    const uri = `${GLib.filename_to_uri(path, null)}\r\n`;
    return new GLib.Bytes(new TextEncoder().encode(uri));
}

/**
 * Works out the single flavour to publish for an image file.
 *
 * `preference` only applies to animated formats; a PNG is always offered as
 * image/png. Returns {mime, bytes}, or null if nothing could be produced.
 */
export function imageFlavour(path, mime, preference = 'png') {
    const isGif = mime === 'image/gif';

    try {
        if (!isGif) {
            // Already a still. PNG is what paste targets ask for; anything
            // else gets converted so it lands rather than silently failing.
            return mime === 'image/png'
                ? {mime: 'image/png', bytes: fileBytes(path)}
                : {mime: 'image/png', bytes: asPng(path)};
        }

        switch (preference) {
        case 'gif':
            // Keeps the animation, but only apps that ask for image/gif
            // will see anything at all.
            return {mime: 'image/gif', bytes: fileBytes(path)};
        case 'uri':
            // Chat clients and file managers attach the real animated file.
            return {mime: 'text/uri-list', bytes: asUriList(path)};
        default:
            return {mime: 'image/png', bytes: asPng(path)};
        }
    } catch (e) {
        console.error(`winclip: could not prepare ${path} for the clipboard`, e);
        return null;
    }
}
