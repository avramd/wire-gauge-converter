#!/usr/bin/env bash
#
# Deploy the drill-bit chart to a static host via scp.
#
# Config is read from the environment, or from a .env file next to this script:
#   HOSTNAME   (required)  ssh host to copy to
#   SITE_DIR   (required)  the site's root directory on that host
#   DEST_DIR   (optional)  subdirectory under SITE_DIR; omitted from the path when empty
#   FILE_NAME  (optional)  remote filename; defaults to index.html
#   SRC        (optional)  local file to upload; defaults to the chart html beside this script
#
# Result:  scp <SRC>  ->  HOSTNAME:SITE_DIR[/DEST_DIR]/FILE_NAME
#
# Note: bash pre-sets HOSTNAME to the local machine name, so always provide it via
# .env (or the environment) to point at the real target host.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env if present (KEY=VALUE lines), exporting each setting.
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/.env"
  set +a
fi

FILE_NAME="${FILE_NAME:-index.html}"
DEST_DIR="${DEST_DIR:-}"
SRC="${SRC:-$SCRIPT_DIR/wire-gauge-drill-chart.html}"

: "${HOSTNAME:?HOSTNAME is required (set it in .env or the environment)}"
: "${SITE_DIR:?SITE_DIR is required (set it in .env or the environment)}"

if [ ! -f "$SRC" ]; then
  echo "deploy: source file not found: $SRC" >&2
  exit 1
fi

# Build the remote path, dropping "DEST_DIR/" when DEST_DIR is empty.
if [ -n "$DEST_DIR" ]; then
  REMOTE="$SITE_DIR/$DEST_DIR/$FILE_NAME"
else
  REMOTE="$SITE_DIR/$FILE_NAME"
fi

echo "Deploying $SRC -> $HOSTNAME:$REMOTE"
scp "$SRC" "$HOSTNAME:$REMOTE"
echo "Done."
