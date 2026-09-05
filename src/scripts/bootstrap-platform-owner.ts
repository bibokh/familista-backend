#!/usr/bin/env node
// Establish the platform's owner — once, for one named account
// ─────────────────────────────────────────────────────────────────────────────
//   node dist/scripts/bootstrap-platform-owner.js --email=me@example.com --dry-run
//   node dist/scripts/bootstrap-platform-owner.js --email=me@example.com
//   node dist/scripts/bootstrap-platform-owner.js --user-id=<uuid>
//   node dist/scripts/bootstrap-platform-owner.js --list
//
// A thin front for `platform/owner-bootstrap.ts`, which holds every rule: one
// account or none, no ambiguous match, no demo or test address, idempotent,
// audited. This file adds argument parsing and a report — no policy of its own.
//
// It prints an id, an address and a name. It never prints a password, a hash,
// a token or any other secret, and it has no code that could.

import { bootstrapPlatformOwner, currentPlatformOwners } from '../platform/owner-bootstrap';

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  Familista — platform owner bootstrap');
  console.log('════════════════════════════════════════════════════════════');

  const owners = await currentPlatformOwners();
  console.log(`  platform authority today       ${owners.length} account(s)`);
  for (const o of owners) console.log(`    · ${o.email || o.userId}  ${o.role}`);

  if (flag('list')) {
    console.log('');
    return 0;
  }

  const email = arg('email');
  const userId = arg('user-id') ?? arg('userId');
  const dryRun = flag('dry-run');

  const result = await bootstrapPlatformOwner({
    email,
    userId,
    dryRun,
    performedBy: arg('by') ?? 'bootstrap-platform-owner script',
  });

  console.log('');
  console.log(`  mode                           ${dryRun ? 'DRY RUN — nothing was written' : 'WRITE'}`);
  console.log(`  outcome                        ${result.outcome}`);
  if (result.user) {
    console.log(`  account                        ${result.user.email}`);
    console.log(`  user id                        ${result.user.id}`);
    console.log(`  name                           ${result.user.name}`);
    console.log(`  club memberships preserved     ${result.membershipsPreserved}`);
  }
  console.log(`  reason                         ${result.reason}`);
  console.log('');
  console.log('  Untouched by this run: passwords, memberships, clubs, teams, User.role.');
  console.log('  Platform ownership is a PlatformAdmin row; club ownership is a Membership.');
  console.log('  Neither implies the other, and this run did not make it so.');
  console.log('');

  if (result.outcome === 'REFUSED') {
    console.log('❌ REFUSED — nothing was written.');
    return 1;
  }
  console.log(dryRun ? '✅ DRY RUN COMPLETE — re-run without --dry-run to apply.' : '✅ PLATFORM OWNER ESTABLISHED');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('bootstrap-platform-owner failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
