// SPDX-FileCopyrightText: 2026 Steve Bushwa
// SPDX-License-Identifier: GPL-2.0-or-later

/* Small widget helpers shared by the tabs. */

import Clutter from 'gi://Clutter';
import St from 'gi://St';

export function scrollable(child) {
    const view = new St.ScrollView({
        style_class: 'winclip-scroll',
        x_expand: true,
        y_expand: true,
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
    });
    view.set_child(child);
    return view;
}

export function column() {
    return new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'winclip-list',
        x_expand: true,
    });
}

export function sectionHeader(text) {
    return new St.Label({style_class: 'winclip-section', text});
}

export function emptyNotice(text) {
    return new St.Label({style_class: 'winclip-empty', text});
}

/** Lays cells out in rows of `columns`, returning the container. */
export function gridOf(cells, columns, styleClass) {
    const grid = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: styleClass,
        x_expand: true,
    });
    for (let i = 0; i < cells.length; i += columns) {
        const row = new St.BoxLayout({style_class: 'winclip-grid-row', x_expand: true});
        for (const cell of cells.slice(i, i + columns))
            row.add_child(cell.actor);
        grid.add_child(row);
    }
    return grid;
}

export function matches(haystack, query) {
    return !query || haystack.toLowerCase().includes(query);
}
