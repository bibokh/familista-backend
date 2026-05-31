// ─────────────────────────────────────────────────────────────────────────────
// Prisma client self-heal — MUST be imported FIRST in server.ts, before any
// module that loads @prisma/client (e.g. ./config/database).
//
// Why this exists: the runtime Prisma Client can drift from prisma/schema.prisma
// because `npm prune`/`npm ci` reset node_modules/.prisma/client to the package
// default, and the platform's start command may bypass our `npm run start`
// (which regenerates). When that happens, queries selecting the Phase-R Club
// columns fail with "Unknown field `description`".
//
// This module checks the generated client's bundled schema for a Phase-R column
// and, only if it's missing, runs `prisma generate` SYNCHRONOUSLY before the
// client is ever required — so the server always boots with a client that
// matches the schema, regardless of how the image was built or started.
// It never throws: if generation fails, the server still boots and the
// /api/health probe surfaces the staleness.
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

function generatedClientHasPhaseR(): boolean {
  const candidates = [
    path.join(process.cwd(), 'node_modules', '.prisma', 'client', 'schema.prisma'),
    path.join(__dirname, '..', 'node_modules', '.prisma', 'client', 'schema.prisma'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const txt = readFileSync(p, 'utf8');
        // These columns only exist in the up-to-date Phase-R Club model.
        return /\baddressLine\b/.test(txt) && /\bsocialLinks\b/.test(txt);
      }
    } catch {
      /* ignore and try next candidate */
    }
  }
  return false; // can't confirm → regenerate to be safe
}

try {
  if (generatedClientHasPhaseR()) {
    // eslint-disable-next-line no-console
    console.log('[prisma-bootstrap] generated client already includes Phase-R Club fields — skipping generate.');
  } else {
    // eslint-disable-next-line no-console
    console.warn('[prisma-bootstrap] generated client is stale (missing Phase-R Club fields) — running prisma generate…');
    execSync('npx --no-install prisma generate --schema=prisma/schema.prisma', {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    // eslint-disable-next-line no-console
    console.warn('[prisma-bootstrap] prisma generate complete.');
  }
} catch (err) {
  // Non-fatal — never block boot.
  // eslint-disable-next-line no-console
  console.error('[prisma-bootstrap] prisma generate failed (continuing to boot):', (err as Error)?.message);
}
