# Familista — the restore-drill runner (Cyber Defense, Step 10).
#
# PostgreSQL 18 client tools (pg_restore, psql) from the official postgres
# image, plus Node 20 from the official node image. Production backups are
# written by pg_dump 18, and only pg_restore 18 or newer can read them.
# Nothing is installed from a package repository, and the image holds no
# code and no secret: the repository is mounted read-only at run time and the
# credentials arrive as an --env-file. Used by scripts/restore-drill.ps1 on a
# workstation and by scripts/restore-drill-ci.js in GitHub Actions.
#
# Both bases are pinned to an immutable digest — the image's multi-platform
# index — so a tag that moves cannot change what the drill runs; the tag stays
# for the reader. scripts/restore-drill-ci.js starts its throwaway server from
# this same postgres reference. To update: resolve the tag's current index
# digest from the registry, replace it here, and let the pull request's
# restore-drill self-test prove the new images.
#   node:20-bookworm      Node 20.20.2       (resolved 2026-10-06)
#   postgres:18-bookworm  PostgreSQL 18.6    (resolved 2026-10-06)
FROM node:20-bookworm@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5 AS node
FROM postgres:18-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c
COPY --from=node /usr/local/bin/node /usr/local/bin/node
USER postgres
