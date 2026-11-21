#!/usr/bin/env bash
# Build the workbench UI and publish the output into the sd-webui-mobile-plus
# extension's workbench/ folder (built assets only — the extension never
# carries this project's sources).
#
# Usage: scripts/publish.sh [extension-repo-path]
# Default extension path: ../sd-webui-mobile-plus (sibling checkout).
set -euo pipefail

cd "$(dirname "$0")/.."
EXT_DIR="${1:-../sd-webui-mobile-plus}"
TARGET="$EXT_DIR/workbench"

if [ ! -d "$EXT_DIR" ]; then
  echo "extension repo not found: $EXT_DIR" >&2
  exit 1
fi

bun run build

STAMP="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  STAMP="$STAMP-dirty"
fi
STAMP="$STAMP $(date '+%Y-%m-%d %H:%M %Z')"

mkdir -p "$TARGET"
rm -rf "$TARGET/assets"
cp dist/index.html "$TARGET/index.html"
cp -r dist/assets "$TARGET/assets"
printf '%s\n' "$STAMP" > "$TARGET/VERSION"

echo "published $STAMP -> $TARGET"
