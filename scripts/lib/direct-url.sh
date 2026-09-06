# scripts/lib/direct-url.sh — the connection migrations run on
# ─────────────────────────────────────────────────────────────────────────────
# Sourced, not executed. Every script that runs a `prisma migrate` command
# sources this first, so the rule lives in one place rather than in each of them.
#
# Two endpoints, two jobs, and they are not interchangeable.
#
#   DATABASE_URL   Neon's POOLED endpoint (-pooler). The running API wants it:
#                  many short-lived queries across many workers, which is what a
#                  connection pooler is for. Nothing here changes it, and the
#                  application keeps using it exactly as it did.
#   DIRECT_URL     Neon's direct endpoint. Migrations want THIS one. A migration
#                  takes advisory locks and runs long DDL in one session, and a
#                  pooler in transaction mode can hand those statements to
#                  different backends — which is the P1002 that keeps coming
#                  back on deploy.
#
# prisma/schema.prisma declares `directUrl = env("DIRECT_URL")`, and Prisma
# refuses to run a migration when a declared variable is missing. So it is
# guaranteed here rather than assumed: where an operator has set it, it is used
# untouched; where nobody has yet, it falls back to DATABASE_URL, which is
# exactly what happened before this file existed. No deploy breaks for want of a
# variable, and setting it is an improvement rather than a prerequisite.
#
# The URL is never printed. Only its host, and only to say which host to set.

familista_resolve_direct_url() {
  if [ -z "${DIRECT_URL:-}" ]; then
    export DIRECT_URL="${DATABASE_URL:-}"
    echo "==> migrations will use: DATABASE_URL (DIRECT_URL is not set)"
  else
    export DIRECT_URL
    echo "==> migrations will use: DIRECT_URL"
  fi

  case "${DIRECT_URL:-}" in
    *-pooler.*)
      # Neon names the pooled host by inserting "-pooler" into the direct one,
      # so the host to set is mechanically obvious. It is SUGGESTED, never
      # applied: connecting somewhere nobody asked for is not a fix.
      _fam_direct_host="$(printf '%s' "${DIRECT_URL}" \
        | sed -n 's#^[a-zA-Z+]*://[^@]*@\([^/?]*\).*#\1#p' \
        | sed 's/-pooler\./\./')"
      echo "==> NOTE: migrations are pointed at Neon's POOLED endpoint."
      if [ -n "${_fam_direct_host}" ]; then
        echo "==>       Set DIRECT_URL to the same connection string with the host"
        echo "==>       changed to ${_fam_direct_host} (that is, \"-pooler\" removed)."
      else
        echo "==>       Set DIRECT_URL to the same connection string with \"-pooler\""
        echo "==>       removed from the host."
      fi
      echo "==>       The application keeps using the pooled DATABASE_URL —"
      echo "==>       only migrations change."
      unset _fam_direct_host
      ;;
  esac
}
