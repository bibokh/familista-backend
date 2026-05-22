#!/usr/bin/env bash
# Familista — Phase O DB restore
# ─────────────────────────────────────────────────────────────────────────────
# Decrypt (if needed) → gunzip → psql apply.  USE WITH CAUTION.
#
# Env vars:
#   DATABASE_URL         (target DB — should be EMPTY or a staging clone!)
#   BACKUP_FILE          (path to the .sql.gz or .sql.gz.enc file)
#   BACKUP_ENCRYPT_PASS  (set if BACKUP_FILE has .enc suffix)
#   CONFIRM=yes          (required to actually run — protects against accidents)
#
# Usage:
#   DATABASE_URL=... BACKUP_FILE=./backups/x.sql.gz CONFIRM=yes ./scripts/restore.sh

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL required}"
: "${BACKUP_FILE:?BACKUP_FILE required}"

if [ "${CONFIRM:-}" != "yes" ]; then
  echo "✘ CONFIRM=yes not set. Restore aborts."
  echo "  Re-run with CONFIRM=yes once you are sure the target DB is the right one."
  exit 2
fi

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "✘ BACKUP_FILE not found: ${BACKUP_FILE}"; exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

SRC="${BACKUP_FILE}"
case "${BACKUP_FILE}" in
  *.enc)
    : "${BACKUP_ENCRYPT_PASS:?BACKUP_ENCRYPT_PASS required for .enc file}"
    DEC="${WORK}/payload.sql.gz"
    echo "▶ Decrypting → ${DEC}"
    openssl enc -d -aes-256-cbc -pbkdf2 \
      -in  "${BACKUP_FILE}" \
      -out "${DEC}" \
      -pass env:BACKUP_ENCRYPT_PASS
    SRC="${DEC}"
    ;;
esac

echo "▶ Restoring from ${SRC} → DATABASE_URL"
gunzip -c "${SRC}" | psql "${DATABASE_URL}" --single-transaction -v ON_ERROR_STOP=1

echo "✔ Restore complete @ $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Next: run \`npx prisma migrate deploy\` if the dump pre-dates Phase O migrations."
