# WinClip

A Windows-style clipboard manager for GNOME Shell on Wayland. `Super+V` opens
an overlay at the pointer, on top of whatever window you are in.

- **Clipboard** — text and image history, with pinned entries kept at the top
- **GIF** — GIFs you have copied, favourites, and animated GIFs found in your
  Downloads and Pictures folders
- **Emoji** — 1,914 emoji searchable by name and keyword, with pins, recents
  and a skin-tone setting

Choosing an entry pastes it straight into the window underneath.

## Why an extension and not an app

Mutter does not implement the wlroots `data-control` protocol, so `wl-paste
--watch` and the standalone clipboard managers built on it cannot observe
clipboard changes under GNOME. Only code running inside the shell can, via
`MetaSelection::owner-changed`. Running in-process also allows the overlay to
be drawn over fullscreen windows and positioned at the pointer, and lets the
paste be synthesised through a Clutter virtual input device rather than
`ydotool` or raw `/dev/uinput` access.

## Requirements

GNOME Shell 50 on Wayland.

## Install

From [extensions.gnome.org](https://extensions.gnome.org), or from source:

```sh
make install
```

Then log out and back in — GNOME only scans for new extensions at startup.

## Keys

| Key | Action |
| --- | --- |
| `Super+V` | open / close |
| type | search the current tab |
| `↑ ↓ ← →` | move between entries |
| `Enter` | paste the selection |
| `Tab` / `Shift+Tab` | switch tab |
| `Ctrl+P` | pin / unpin |
| `Delete` | remove from history |
| `Esc` | close |

Arrow keys navigate while the search box is empty. Once you have typed
something, `←` and `→` edit the text and `Ctrl+←` / `Ctrl+→` navigate.

## Files

| Path | Contents |
| --- | --- |
| `~/.local/share/winclip/store.json` | history index |
| `~/.local/share/winclip/blobs/` | copied images, content-addressed |
| `~/.local/share/winclip/gifs/` | GIF favourites — drop `.gif` files here |

`store.json` holds whatever you have copied. It is created mode `600`, but
treat it as sensitive.

## Settings

- **Paste on selection** — turn off to only place the entry on the clipboard.
  If an app misses the paste, raise the paste delay.
- **Prefer text over image** — office suites advertise a picture alongside
  rich text; on (the default) those stay text, while screenshots and
  "Copy Image" still arrive as images.
- **History** — entry cap plus a total disk budget for stored images, since a
  hundred screenshots at the per-image limit would otherwise be gigabytes.
- **GIFs** — which folders to scan, how deep, and how many results to list.

Scanning is asynchronous, capped by depth and result count, and cached, so it
does not stall the shell on large folders. At most 12 GIFs animate at once;
whichever the pointer is over always gets a slot.

WinClip never deletes files it did not create. Unpinning a GIF found on disk
forgets the reference and leaves the file alone.

## Building

```sh
make pack      # dist/winclip@stevebushwa.github.io.shell-extension.zip
make install   # pack, then install locally
```

## Licence

GPL-2.0-or-later. See [LICENSE](LICENSE).
