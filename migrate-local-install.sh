#!/usr/bin/env bash
# Switches this machine from the local build (winclip@kevin.local) to the
# published UUID (winclip@stevebushwa.github.io).
#
# Your clipboard history, pins and GIF favourites live in
# ~/.local/share/winclip, which is not keyed by UUID, so they carry over
# untouched. Requires a log out afterwards.

set -euo pipefail

OLD="winclip@kevin.local"
NEW="winclip@stevebushwa.github.io"
EXT="${HOME}/.local/share/gnome-shell/extensions"
ZIP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dist/${NEW}.shell-extension.zip"

[ -f "$ZIP" ] || { echo "build it first: make pack" >&2; exit 1; }

echo "Installing $NEW"
gnome-extensions install "$ZIP" --force

echo "Updating enabled-extensions"
python3 - "$OLD" "$NEW" <<'PY'
import subprocess, sys
old, new = sys.argv[1], sys.argv[2]
out = subprocess.run(['gsettings','get','org.gnome.shell','enabled-extensions'],
                     capture_output=True, text=True).stdout.strip()
items = [] if out in ('@as []','[]') else \
        [x.strip().strip("'\"") for x in out.strip('@as ').strip('[]').split(',') if x.strip()]
items = [x for x in items if x not in (old, new)] + [new]
subprocess.run(['gsettings','set','org.gnome.shell','enabled-extensions',
                '[' + ', '.join(f"'{x}'" for x in items) + ']'], check=True)
print(f"  enabled: {items}")
PY

if [ -d "$EXT/$OLD" ]; then
    mv "$EXT/$OLD" "$EXT/.${OLD}.bak"
    echo "  old build moved aside to $EXT/.${OLD}.bak"
fi

echo
echo "Done. Log out and back in."
echo "Your history in ~/.local/share/winclip is shared and untouched."
