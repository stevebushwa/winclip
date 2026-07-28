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
 *
 * Reading is asynchronous throughout: this runs inside the compositor, and
 * blocking it on disk stalls the desktop.
 */

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** A file:// URI, which file-aware apps treat as "a file was pasted". */
function asUriList(path) {
    const uri = `${GLib.filename_to_uri(path, null)}\r\n`;
    return new GLib.Bytes(new TextEncoder().encode(uri));
}

/** Renders already-loaded image bytes as PNG (the first frame, for a GIF). */
function toPng(contents) {
    const loader = GdkPixbuf.PixbufLoader.new();
    try {
        loader.write(contents);
        loader.close();
    } catch (e) {
        try {
            loader.close();
        } catch {
            // already closed
        }
        throw e;
    }
    const pixbuf = loader.get_pixbuf();
    if (!pixbuf)
        throw new Error('winclip: could not decode image for PNG conversion');
    const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
    if (!ok)
        throw new Error('winclip: could not encode PNG');
    return new GLib.Bytes(buffer);
}

/**
 * Works out the single flavour to publish for an image file and hands it to
 * `callback` as {mime, bytes}, or null if nothing could be produced.
 *
 * `preference` only applies to animated formats; a still is always offered as
 * image/png, which is what paste targets ask for.
 */
export function imageFlavour(path, mime, preference, callback) {
    const isGif = mime === 'image/gif';

    // A URI needs no file contents at all.
    if (isGif && preference === 'uri') {
        try {
            callback({mime: 'text/uri-list', bytes: asUriList(path)});
        } catch (e) {
            console.error(`winclip: could not build a URI for ${path}`, e);
            callback(null);
        }
        return;
    }

    Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
        let contents;
        try {
            [, contents] = file.load_contents_finish(res);
        } catch (e) {
            console.error(`winclip: could not read ${path}`, e);
            callback(null);
            return;
        }

        try {
            if (isGif && preference === 'gif') {
                // Keeps the animation, but only apps that ask for image/gif
                // will see anything at all.
                callback({mime: 'image/gif', bytes: new GLib.Bytes(contents)});
                return;
            }
            if (!isGif && mime === 'image/png') {
                callback({mime: 'image/png', bytes: new GLib.Bytes(contents)});
                return;
            }
            callback({mime: 'image/png', bytes: toPng(contents)});
        } catch (e) {
            console.error(`winclip: could not prepare ${path} for the clipboard`, e);
            callback(null);
        }
    });
}
