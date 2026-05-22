// Familista — FC Familista seed CLI entry point.
//
// Usage:
//   FC_FAMILISTA_ADMIN_PASSWORD=… \
//   FC_FAMILISTA_DEFAULT_PASSWORD=… \
//   FC_FAMILISTA_ADMIN_EMAIL=admin@fcfamilista.local \
//   FC_FAMILISTA_SEED_CONFIRM=yes \
//   npx ts-node prisma/seeds/fc-familista.ts
//
// or via npm script:
//   npm run db:seed:fc-familista
//
// Re-running is idempotent: rows already present are left untouched.

import 'dotenv/config';
import { seedFcFamilista } from '../../src/launch/seed-fc-familista.service';
import { prisma } from '../../src/config/database';

async function main() {
  const t0 = Date.now();
  const report = await seedFcFamilista({});
  const elapsed = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, elapsedMs: elapsed, ...report }, null, 2));
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('SEED FAILED:', err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
