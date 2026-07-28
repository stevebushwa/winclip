// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

/* Watches the clipboard.
 *
 * Mutter does not implement wlr-data-control, so wl-paste --watch and friends
 * cannot see clipboard changes on GNOME. Inside the shell we get the real
 * thing: MetaSelection emits owner-changed whenever any client takes the
 * clipboard, and St.Clipboard reads the offered flavours back.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {imageFlavour} from './clipboardSource.js';

// Most specific first: a GIF offered alongside a PNG is still a GIF.
const IMAGE_MIMES = ['image/gif', 'image/webp', 'image/png', 'image/jpeg', 'image/bmp'];
const TEXT_MIMES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING'];

// Apps often advertise flavours in bursts; let the offer settle before reading.
const SETTLE_MS = 60;

export class ClipboardMonitor {
    constructor(store, settings) {
        this._store = store;
        this._settings = settings;
        this._clipboard = St.Clipboard.get_default();
        this._selection = null;
        this._ownerChangedId = 0;
        this._settleSource = 0;
        this._selfWriteSource = 0;
        // Set while we push our own pick onto the clipboard, so the resulting
        // owner-changed does not bounce the entry back to the top.
        this._selfWrite = false;
    }

    enable() {
        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed',
            (_sel, type) => {
                if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
                    return;
                if (this._selfWrite)
                    return;
                this._scheduleRead();
            });
    }

    disable() {
        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = 0;
        }
        this._selection = null;
        if (this._settleSource) {
            GLib.source_remove(this._settleSource);
            this._settleSource = 0;
        }
        if (this._selfWriteSource) {
            GLib.source_remove(this._selfWriteSource);
            this._selfWriteSource = 0;
        }
        this._selfWrite = false;
    }

    /** Suppresses capture while `fn` puts something on the clipboard. */
    withSelfWrite(fn) {
        this._selfWrite = true;
        try {
            fn();
        } finally {
            // Release after the owner-changed for our own write has landed.
            if (this._selfWriteSource)
                GLib.source_remove(this._selfWriteSource);
            this._selfWriteSource = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, SETTLE_MS * 2, () => {
                    this._selfWrite = false;
                    this._selfWriteSource = 0;
                    return GLib.SOURCE_REMOVE;
                });
        }
    }

    _scheduleRead() {
        if (this._settleSource)
            GLib.source_remove(this._settleSource);
        this._settleSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._settleSource = 0;
            this._read();
            return GLib.SOURCE_REMOVE;
        });
    }

    _read() {
        let mimetypes;
        try {
            mimetypes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) || [];
        } catch (e) {
            console.error('winclip: could not list clipboard flavours', e);
            return;
        }

        const hasText = TEXT_MIMES.some(m => mimetypes.includes(m));
        const imageMime = this._settings.get_boolean('capture-images')
            ? IMAGE_MIMES.find(m => mimetypes.includes(m))
            : null;

        // Office suites advertise image/png for rich-text copies. When plain
        // text is on offer too, that is what the user meant to copy.
        const preferText = this._settings.get_boolean('prefer-text-when-both');
        if (imageMime && !(hasText && preferText)) {
            this._readImage(imageMime);
            return;
        }
        if (hasText)
            this._readText();
    }

    _readText() {
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
            if (text)
                this._store.addText(text);
        });
    }

    _readImage(mime) {
        const maxBytes = this._settings.get_int('max-image-mb') * 1024 * 1024;
        this._clipboard.get_content(St.ClipboardType.CLIPBOARD, mime, (_cb, bytes) => {
            if (!bytes || bytes.get_size() === 0)
                return;
            if (bytes.get_size() > maxBytes) {
                console.warn(`winclip: skipping ${Math.round(bytes.get_size() / 1048576)}MB clipboard image (limit ${maxBytes / 1048576}MB)`);
                return;
            }
            this._store.addImage(bytes, mime);
        });
    }

    // ------------------------------------------------------------ outbound

    setText(text) {
        this.withSelfWrite(() => {
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        });
    }

    setImage(bytes, mime) {
        this.withSelfWrite(() => {
            this._clipboard.set_content(St.ClipboardType.CLIPBOARD, mime, bytes);
        });
    }

    /**
     * Puts an image file on the clipboard in whichever single flavour is most
     * likely to be accepted. Preferred over setImage, which publishes the
     * file's own type verbatim — an image/gif offer pastes into almost
     * nothing, because applications ask for image/png.
     */
    setImageFile(path, mime) {
        return new Promise(resolve => {
            imageFlavour(path, mime, this._settings.get_string('gif-paste-format'),
                flavour => {
                    if (!flavour) {
                        resolve(false);
                        return;
                    }
                    this.withSelfWrite(() => {
                        this._clipboard.set_content(
                            St.ClipboardType.CLIPBOARD, flavour.mime, flavour.bytes);
                    });
                    resolve(true);
                });
        });
    }
}
