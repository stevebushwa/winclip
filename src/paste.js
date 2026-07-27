// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

/* Synthetic Ctrl+V.
 *
 * Wayland clients cannot inject input into each other, but the compositor can:
 * Clutter hands the shell a virtual keyboard device on the default seat, which
 * is how this reproduces the Windows behaviour of pasting the moment you pick
 * an entry. No ydotool, no /dev/uinput.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

let virtualKeyboard = null;
let pendingSource = 0;

function device() {
    if (!virtualKeyboard) {
        const seat = Clutter.get_default_backend().get_default_seat();
        virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }
    return virtualKeyboard;
}

/** Drops the device and any paste still waiting to fire. */
export function releaseDevice() {
    if (pendingSource) {
        GLib.source_remove(pendingSource);
        pendingSource = 0;
    }
    virtualKeyboard = null;
}

/**
 * Presses Ctrl+V after `delayMs`, giving the compositor time to drop our modal
 * grab and hand focus back to the window underneath.
 */
export function sendPaste(delayMs = 90) {
    if (pendingSource)
        GLib.source_remove(pendingSource);

    pendingSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
        pendingSource = 0;
        try {
            const dev = device();
            const now = GLib.get_monotonic_time();
            dev.notify_keyval(now, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            dev.notify_keyval(now, Clutter.KEY_v, Clutter.KeyState.PRESSED);
            dev.notify_keyval(now, Clutter.KEY_v, Clutter.KeyState.RELEASED);
            dev.notify_keyval(now, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        } catch (e) {
            console.error('winclip: synthetic paste failed', e);
            virtualKeyboard = null;
        }
        return GLib.SOURCE_REMOVE;
    });
    return pendingSource;
}
