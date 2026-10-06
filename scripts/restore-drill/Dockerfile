# Familista — the restore-drill runner (Cyber Defense, Step 10).
#
# PostgreSQL 18 client tools (pg_restore, psql) from the official postgres
# image, plus Node 20 from the official node image. Production backups are
# written by pg_dump 18, and only pg_restore 18 or newer can read them.
# Nothing is installed from a package repository, and the image holds no
# code and no secret: the repository is mounted read-only at run time and the
# credentials arrive as an --env-file. Used by scripts/restore-drill.ps1 on a
# workstation and by scripts/restore-drill-ci.js in GitHub Actions.
FROM node:20-bookworm AS node
FROM postgres:18-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
USER postgres
