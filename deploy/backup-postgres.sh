#!/usr/bin/env sh
set -eu
: "${BACKUP_DIR:=/var/backups/tbg-bot}"
mkdir -p "$BACKUP_DIR"
umask 077
docker compose -f /opt/tbg-bot/compose.yml exec -T db pg_dump -U tbg -Fc tbg > "$BACKUP_DIR/tbg-$(date +%F-%H%M%S).dump"
find "$BACKUP_DIR" -type f -name 'tbg-*.dump' -mtime +14 -delete
# Copy encrypted backups off-droplet here only when OPTIONAL_BACKUP_DESTINATION is configured.

