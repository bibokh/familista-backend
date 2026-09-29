#!/usr/bin/env bash
# Familista — database backup (Cyber Defense, Step 10)
# ─────────────────────────────────────────────────────────────────────────────
# A thin wrapper. The work is done by dist/scripts/backup.js, which:
#   pg_dump (custom format) → FBK1 encryption to an offline PUBLIC key
#   (X25519 + AES-256-GCM, every chunk authenticated) → Ed25519-signed
#   manifest → S3-compatible off-site bucket → BackupRecord.
#
# Plaintext never touches the disk, no password is placed on a command line,
# and no shell command is built from configuration. The decryption key must
# NOT be present here; the run refuses to start if it is.
#
# Required: DATABASE_URL (or BACKUP_DATABASE_URL), BACKUP_ENCRYPTION_PUBLIC_KEY,
#           BACKUP_SIGNING_PRIVATE_KEY, BACKUP_S3_BUCKET,
#           BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY
# Optional: BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_PREFIX,
#           BACKUP_S3_FORCE_PATH_STYLE, BACKUP_PG_DUMP
# See docs/BACKUP_AND_RESTORE.md.

set -euo pipefail
cd "$(dirname "$0")/.."
exec node dist/scripts/backup.js run
