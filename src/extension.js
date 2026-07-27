// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClipboardMonitor} from './clipboardMonitor.js';
import {Overlay} from './overlay.js';
import {Store} from './store.js';
import {releaseDevice} from './paste.js';
import {stopAllAnimations} from './imageUtil.js';

export default class WinClipExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._store = new Store();
        this._store.setMaxBlobMb(this._settings.get_int('max-blob-mb'));
        this._store.setHistorySize(this._settings.get_int('history-size'));
        this._historySizeId = this._settings.connect('changed::history-size', () => {
            this._store.setHistorySize(this._settings.get_int('history-size'));
        });
        this._blobBudgetId = this._settings.connect('changed::max-blob-mb', () => {
            this._store.setMaxBlobMb(this._settings.get_int('max-blob-mb'));
        });

        this._monitor = new ClipboardMonitor(this._store, this._settings);
        this._monitor.enable();

        this._overlay = new Overlay({
            settings: this._settings,
            store: this._store,
            monitor: this._monitor,
            openPrefs: () => this.openPreferences(),
        });

        // Keep an open panel in step with clipboard activity.
        this._storeCb = this._store.connectChanged(() => {
            if (this._overlay?.isOpen)
                this._overlay.refresh();
        });

        Main.wm.addKeybinding(
            'toggle-overlay',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._overlay.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-overlay');

        this._overlay?.destroy();
        this._overlay = null;

        this._monitor?.disable();
        this._monitor = null;

        if (this._storeCb) {
            this._store?.disconnectChanged(this._storeCb);
            this._storeCb = null;
        }
        if (this._historySizeId) {
            this._settings.disconnect(this._historySizeId);
            this._historySizeId = 0;
        }
        if (this._blobBudgetId) {
            this._settings.disconnect(this._blobBudgetId);
            this._blobBudgetId = 0;
        }

        this._store?.destroy();
        this._store = null;

        stopAllAnimations();
        releaseDevice();

        this._settings = null;
    }
}
