#!/usr/bin/env bash
# Familista — Phase O DB backup
# ─────────────────────────────────────────────────────────────────────────────
# pg_dump → gzip → optional AES-256 envelope encryption → upload-target.
#
# Env vars expected:
#   DATABASE_URL          (postgres://… connection string)
#   BACKUP_DIR            (default ./backups)
#   BACKUP_ENCRYPT_PASS   (optional — if set, encrypts via openssl aes-256-cbc -pbkdf2)
#   BACKUP_UPLOAD_CMD     (optional — full command run with $1 = produced file)
#
# Each backup is recorded in the BackupRecord table after upload completes via
# POST /api/v1/phase-o/monitoring/backups (do this from your job runner).
#
# Usage:
#   DATABASE_URL=... ./scripts/backup.sh
#   DATABASE_URL=... BACKUP_ENCRYPT_PASS=... BACKUP_UPLOAD_CMD='aws s3 cp $1 s3://...' ./scripts/backup.sh

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
HOST_TAG="$(hostname | tr -dc 'A-Za-z0-9_-')"
OUT_RAW="${BACKUP_DIR}/familista_${HOST_TAG}_${STAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "▶ Dumping database → ${OUT_RAW}"
# --no-owner / --no-acl keeps the dump portable across environments.
pg_dump --no-owner --no-acl --format=plain "${DATABASE_URL}" \
  | gzip -9 > "${OUT_RAW}"

SHA="$(sha256sum "${OUT_RAW}" | awk '{print $1}')"
SIZE="$(stat -c%s "${OUT_RAW}" 2>/dev/null || stat -f%z "${OUT_RAW}")"
echo "✔ sha256=${SHA} sizeBytes=${SIZE}"

OUT_FINAL="${OUT_RAW}"
if [ -n "${BACKUP_ENCRYPT_PASS:-}" ]; then
  OUT_ENC="${OUT_RAW}.enc"
  echo "▶ Encrypting → ${OUT_ENC}"
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -in  "${OUT_RAW}" \
    -out "${OUT_ENC}" \
    -pass env:BACKUP_ENCRYPT_PASS
  rm -f "${OUT_RAW}"
  OUT_FINAL="${OUT_ENC}"
  SHA="$(sha256sum "${OUT_FINAL}" | awk '{print $1}')"
  SIZE="$(stat -c%s "${OUT_FINAL}" 2>/dev/null || stat -f%z "${OUT_FINAL}")"
  echo "✔ encrypted sha256=${SHA} sizeBytes=${SIZE}"
fi

if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  echo "▶ Uploading: ${BACKUP_UPLOAD_CMD}"
  # shellcheck disable=SC2086
  eval ${BACKUP_UPLOAD_CMD//\$1/$OUT_FINAL}
fi

cat <<JSON
{
  "ok": true,
  "file": "${OUT_FINAL}",
  "sha256": "${SHA}",
  "sizeBytes": ${SIZE},
  "finishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
