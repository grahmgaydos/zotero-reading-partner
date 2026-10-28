#!/bin/zsh
# Point Zotero at this repo's addon/ folder instead of an installed .xpi, or
# undo that. Zotero must be quit first.
#
#   scripts/dev-link.sh link     # back up the installed .xpi, load addon/ live
#   scripts/dev-link.sh unlink   # remove the link, restore the backed-up .xpi
#
# Set ZOTERO_PROFILE to override the profile directory.

set -euo pipefail

ID="reading-partner@grahmgaydos.dev"
REPO="${0:A:h:h}"
ROOT="$HOME/Library/Application Support/Zotero"
PROFILE="${ZOTERO_PROFILE:-$ROOT/$(awk -F= '/^Path=/{print $2; exit}' "$ROOT/profiles.ini")}"
EXT="$PROFILE/extensions"
BACKUP="$PROFILE/$ID.xpi.bak"

if pgrep -xq zotero; then
  echo "Zotero is running. Quit it (Cmd-Q) and run this again." >&2
  exit 1
fi

# Zotero only rescans extensions when these are missing.
reset_scan() {
  sed -i '' '/extensions\.lastAppBuildId/d; /extensions\.lastAppVersion/d' "$PROFILE/prefs.js"
}

case "${1:-}" in
  link)
    [[ -f "$REPO/addon/content/index.js" ]] || { echo "Run npm run build first." >&2; exit 1; }
    if [[ -f "$EXT/$ID.xpi" ]]; then
      mv "$EXT/$ID.xpi" "$BACKUP"
      echo "Backed up installed plugin to $BACKUP"
    fi
    print -n "$REPO/addon/" > "$EXT/$ID"
    reset_scan
    echo "Linked $EXT/$ID -> $REPO/addon/"
    ;;
  unlink)
    rm -f "$EXT/$ID"
    if [[ -f "$BACKUP" ]]; then
      mv "$BACKUP" "$EXT/$ID.xpi"
      echo "Restored $EXT/$ID.xpi"
    fi
    reset_scan
    echo "Unlinked dev build"
    ;;
  *)
    echo "usage: $0 link|unlink" >&2
    exit 2
    ;;
esac
