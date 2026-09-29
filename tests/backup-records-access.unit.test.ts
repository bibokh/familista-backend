/**
 * tests/backup-records-access.unit.test.ts
 *
 * Cyber Defense, Step 10 — who may read and write backup records.
 *
 * A backup record describes the whole platform's database: where it went, how
 * big it was, whether it worked. Before Step 10 any club administrator could
 * write one (and so fake a successful backup) and any club manager could read
 * every club's. Both routes now take platform authority — the platform owner
 * or a SUPER_ADMIN account — and nothing a club grants.
 */

import type { Request, Response } from 'express';
import { requirePlatformAuthority } from '../src/middleware/platform-authority.middleware';
import { ForbiddenError, UnauthorizedError } from '../src/utils/errors';
import phaseORouter from '../src/routes/phase-o.routes';

type User = Record<string, unknown>;
function run(user: User | undefined): unknown {
  let passed: unknown = 'not-called';
  requirePlatformAuthority({ user } as unknown as Request, {} as Response, (err?: unknown) => { passed = err ?? null; });
  return passed;
}

describe('requirePlatformAuthority', () => {
  it('passes the platform owner, whatever their account role', () => {
    expect(run({ id: 'u1', role: 'PLAYER', isPlatformOwner: true })).toBeNull();
  });

  it('passes a SUPER_ADMIN account', () => {
    expect(run({ id: 'u2', role: 'SUPER_ADMIN' })).toBeNull();
  });

  it.each(['CLUB_ADMIN', 'MANAGER', 'HEAD_COACH', 'ANALYST', 'MEDICAL_STAFF', 'PLAYER'])('refuses %s with 403', (role) => {
    expect(run({ id: 'u3', role, isPlatformOwner: false })).toBeInstanceOf(ForbiddenError);
  });

  it('refuses a club role even when the flag is merely absent', () => {
    expect(run({ id: 'u4', role: 'CLUB_ADMIN' })).toBeInstanceOf(ForbiddenError);
  });

  it('refuses an unauthenticated request with 401', () => {
    expect(run(undefined)).toBeInstanceOf(UnauthorizedError);
  });
});

describe('/phase-o/monitoring/backups routes', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  const layers = (phaseORouter as unknown as { stack: Layer[] }).stack
    .filter((l) => l.route?.path === '/monitoring/backups');

  it.each(['post', 'get'])('%s is guarded by platform authority and nothing weaker', (method) => {
    const layer = layers.find((l) => l.route!.methods[method]);
    expect(layer).toBeDefined();
    const handles = layer!.route!.stack.map((s) => s.handle);
    expect(handles[0]).toBe(requirePlatformAuthority);
    expect(handles).toHaveLength(2);
  });

  it('declares each route exactly once', () => {
    expect(layers).toHaveLength(2);
  });
});
