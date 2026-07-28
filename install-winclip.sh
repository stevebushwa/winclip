#!/usr/bin/env bash
# WinClip installer.
#
# Fetches the latest release from GitHub and sets it up. Nothing else is
# needed alongside this file — copy it anywhere and run it.
#
#   https://github.com/stevebushwa/winclip
#
# Safe to re-run: it upgrades in place, and edits your existing keybindings and
# extension list rather than replacing them.

set -euo pipefail

UUID="winclip@stevebushwa.github.io"
REPO="stevebushwa/winclip"
ASSET="${UUID}.shell-extension.zip"
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
DATA_DIR="${HOME}/.local/share/winclip"
FORCE=0
UNINSTALL=0

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        --uninstall) UNINSTALL=1 ;;
        -h|--help)
            echo "usage: $0 [--force] [--uninstall]"
            echo "  --force      install even if the GNOME version looks wrong"
            echo "  --uninstall  remove the extension (clipboard data is kept)"
            exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

say()  { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------- uninstall

if [ "$UNINSTALL" = 1 ]; then
    step "Removing WinClip"
    python3 - "$UUID" <<'PY'
import subprocess, sys
uuid = sys.argv[1]
cur = subprocess.run(['gsettings','get','org.gnome.shell','enabled-extensions'],
                     capture_output=True, text=True).stdout.strip()
items = [] if cur in ('@as []','[]') else \
        [x.strip().strip("'\"") for x in cur.strip('@as ').strip('[]').split(',') if x.strip()]
items = [x for x in items if x and x != uuid]
subprocess.run(['gsettings','set','org.gnome.shell','enabled-extensions',
                '[' + ', '.join(f"'{x}'" for x in items) + ']'], check=True)
print(f"  removed {uuid} from enabled-extensions")
PY
    rm -rf "$EXT_DIR"
    say "deleted $EXT_DIR"
    say "kept your clipboard data in $DATA_DIR"
    say "restore the tray shortcut if you want it back:"
    say "  gsettings set org.gnome.shell.keybindings toggle-message-tray \"['<Super>m', '<Super>v']\""
    echo
    say "Log out and back in to finish."
    exit 0
fi

# ------------------------------------------------------------------ checks

step "Checking this machine"

for cmd in gnome-shell gsettings glib-compile-schemas python3 curl unzip; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "missing required command: $cmd" >&2; exit 1; }
done

SHELL_VER="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1)"
say "GNOME Shell ${SHELL_VER:-unknown}"

if [ "${SHELL_VER:-0}" != "50" ]; then
    if [ "$FORCE" = 1 ]; then
        warn "expected GNOME 50, continuing because --force was given"
    else
        warn "WinClip targets GNOME Shell 50; this is ${SHELL_VER:-unknown}."
        warn "It will not load. Re-run with --force only if you know it works."
        exit 1
    fi
fi

if [ "${XDG_SESSION_TYPE:-}" != "wayland" ]; then
    warn "session is '${XDG_SESSION_TYPE:-unknown}', not wayland — WinClip is only tested on Wayland"
fi

# --------------------------------------------------------------- fetch

step "Fetching the latest release"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "$URL"
if ! curl -fsSL "$URL" -o "$TMP/$ASSET"; then
    echo "download failed — check your connection, or grab the zip manually from" >&2
    echo "  https://github.com/${REPO}/releases/latest" >&2
    exit 1
fi
say "downloaded $(du -h "$TMP/$ASSET" | cut -f1)"

# Make sure it is what we expect before unpacking it into place.
if ! unzip -l "$TMP/$ASSET" | grep -q 'metadata.json'; then
    echo "the downloaded file does not look like an extension bundle" >&2
    exit 1
fi

# ----------------------------------------------------------------- install

step "Installing"
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions install "$TMP/$ASSET" --force
    say "installed to $EXT_DIR"
else
    mkdir -p "$EXT_DIR"
    unzip -oq "$TMP/$ASSET" -d "$EXT_DIR"
    say "unpacked to $EXT_DIR"
fi

glib-compile-schemas "$EXT_DIR/schemas/"
say "compiled schema"

mkdir -p "$DATA_DIR/blobs" "$DATA_DIR/gifs"
chmod 700 "$DATA_DIR"
say "clipboard data lives in $DATA_DIR"

# -------------------------------------------------------------- keybinding

step "Freeing Super+V"
python3 - "$UUID" <<'PY'
import subprocess, sys
uuid = sys.argv[1]

def get(schema, key):
    out = subprocess.run(['gsettings', 'get', schema, key],
                         capture_output=True, text=True).stdout.strip()
    if out in ('@as []', '[]'):
        return []
    return [x.strip().strip("'\"") for x in out.strip('@as ').strip('[]').split(',') if x.strip()]

def put(schema, key, values):
    subprocess.run(['gsettings', 'set', schema, key,
                    '[' + ', '.join(f"'{v}'" for v in values) + ']'], check=True)

tray = get('org.gnome.shell.keybindings', 'toggle-message-tray')
if '<Super>v' in tray:
    remaining = [b for b in tray if b != '<Super>v'] or ['<Super>m']
    put('org.gnome.shell.keybindings', 'toggle-message-tray', remaining)
    print(f"  message tray moved to {remaining} (was {tray})")
else:
    print(f"  message tray already clear of Super+V ({tray or 'unbound'})")

enabled = get('org.gnome.shell', 'enabled-extensions')
if uuid not in enabled:
    put('org.gnome.shell', 'enabled-extensions', enabled + [uuid])
    print("  added WinClip to enabled-extensions")
else:
    print("  WinClip already enabled")
PY

# ------------------------------------------------------------------- done

step "Done — one step left"
say "GNOME only scans for new extensions at startup, and Wayland cannot"
say "restart the shell in place, so:"
echo
say "    log out and back in, then press Super+V"
echo
say "Preferences:  gnome-extensions prefs $UUID"
say "Uninstall:    $0 --uninstall"
say "Source:       https://github.com/${REPO}"
