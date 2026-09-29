#!/usr/bin/env bash
# Familista — restore a backup into an isolated, empty database (Step 10)
# ─────────────────────────────────────────────────────────────────────────────
# A thin wrapper around `node dist/scripts/backup.js drill <object key>`.
# Before a single byte reaches the target it verifies the manifest's
# signature, the backup's SHA-256 and size, and that the target is empty and
# is not the production database; the restore then runs in one transaction
# and is checked (schema head, tables, core row counts).
#
# It never restores over an existing database. A real recovery restores into
# a fresh database and then points the service at it — see
# docs/BACKUP_AND_RESTORE.md.
#
# Required: BACKUP_OBJECT, DRILL_DATABASE_URL, DRILL_CONFIRM_ISOLATED=yes,
#           BACKUP_ENCRYPTION_PRIVATE_KEY, BACKUP_SIGNING_PUBLIC_KEY,
#           and the same BACKUP_S3_* settings as the backup.

set -euo pipefail
: "${BACKUP_OBJECT:?BACKUP_OBJECT required (the .fbk object key)}"
cd "$(dirname "$0")/.."
exec node dist/scripts/backup.js drill "${BACKUP_OBJECT}"
