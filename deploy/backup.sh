#!/usr/bin/env bash
# Nightly CoreKit Tracker backup — keeps 14 days of snapshots in /opt/corekit-backups.
# Install:  crontab -e  →  10 3 * * * /opt/corekit/deploy/backup.sh
set -euo pipefail

SRC=/opt/corekit/data
DEST=/opt/corekit-backups
STAMP=$(date +%Y%m%d-%H%M)

mkdir -p "$DEST"
# sqlite3 .backup gives a consistent snapshot even while the server is running
sqlite3 "$SRC/corekit.db" ".backup '$DEST/corekit-$STAMP.db'"
tar -czf "$DEST/files-$STAMP.tgz" -C "$SRC" files 2>/dev/null || true

# prune: keep 14 days
find "$DEST" -type f -mtime +14 -delete
echo "backup done: $STAMP"
