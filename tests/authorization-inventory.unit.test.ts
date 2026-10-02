/**
 * tests/authorization-inventory.unit.test.ts
 *
 * Cyber Defense, R11 — every handler's authorization is known, and the
 * platform-owner rooms stay owner-only.
 *
 * Before: nothing recorded which authorization a handler declared, so a route
 * added without a role check, or an owner room that lost its gate, would have
 * passed CI silently. And four writes to platform-wide device firmware — rows
 * that belong to no club and reach every club's devices of a model — were open
 * to any CLUB_ADMIN: publishing a firmware build (its sha256 and download URL),
 * a firmware manifest, an OTA release, and advancing that release's rollout.
 *
 * After: the scanner classifies all handlers (public, platform-owner, roles,
 * scoped, member); member-level handlers are a reviewed list; the six owner
 * rooms are pinned; the firmware writes require platform authority.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

const reached: string[] = [];

jest.mock('../src/config/database', () => {
  const model = (name: string) => new Proxy({}, {
    get: (_t, op: string) => async () => { reached.push(`${name}.${op}`); return op === 'findMany' ? [] : null; },
  });
  return { prisma: new Proxy({}, { get: (_t, name: string) => (name.startsWith('$') ? async () => [] : model(name)) }) };
});

jest.mock('../src/middleware/auth.middleware', () => {
  const actual = jest.requireActual('../src/middleware/auth.middleware');
  return {
    ...actual,
    authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      const role = String(req.headers['x-role'] ?? 'CLUB_ADMIN');
      (req as unknown as { user: unknown }).user = {
        id: 'u-1', email: 'u@test.invalid', role, clubId: 'club-a',
        isPlatformOwner: req.headers['x-owner'] === '1',
      };
      next();
    },
  };
});

function appWith(mount: string, mod: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require(`../src/routes/${mod}`).default as express.Router;
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  app.use((err: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ message: err.message });
  });
  return app;
}

const FIRMWARE_WRITES: Array<[string, string, string]> = [
  ['device-infra.routes', '/device-infra', '/firmware'],
  ['provisioning.routes', '/provisioning', '/firmware/manifests'],
  ['provisioning.routes', '/provisioning', '/firmware/releases'],
  ['provisioning.routes', '/provisioning', '/firmware/releases/rel-1/advance'],
];

beforeEach(() => { reached.length = 0; });

describe('platform-wide firmware is written by the platform only', () => {
  it.each(FIRMWARE_WRITES)('%s POST %s%s refuses a club administrator before anything is read or written', async (mod, mount, p) => {
    const res = await request(appWith(mount, mod)).post(`${mount}${p}`).set('x-role', 'CLUB_ADMIN').send({ rolloutPct: 100 });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/platform owner/);
    expect(reached).toEqual([]);
  });

  it.each(FIRMWARE_WRITES)('%s POST %s%s lets the platform authority through to the handler', async (mod, mount, p) => {
    for (const headers of [{ 'x-role': 'SUPER_ADMIN' }, { 'x-role': 'CLUB_ADMIN', 'x-owner': '1' }]) {
      const res = await request(appWith(mount, mod)).post(`${mount}${p}`).set(headers).send({});
      expect(res.status).not.toBe(403);
    }
  });

  it('reading firmware stays open to club members', async () => {
    const res = await request(appWith('/provisioning', 'provisioning.routes')).get('/provisioning/firmware/releases').set('x-role', 'HEAD_COACH');
    expect(res.status).not.toBe(403);
  });
});

describe('the authorization inventory (posture)', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/cyber-defense/generated/security-manifest.json'), 'utf8'));
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'src/cyber-defense/posture-policy.json'), 'utf8'));
  const a = manifest.apiSurface.authorization;

  it('classifies every mounted handler', () => {
    expect(a.handlers).toBe(manifest.apiSurface.handlers);
    expect(Object.keys(a.perHandler)).toHaveLength(a.handlers);
    for (const kind of Object.values(a.perHandler) as string[]) expect(kind).toMatch(/^(public|platform-owner|member|roles:.+|scoped:.+)$/);
  });

  it('public handlers are exactly the reviewed public routes', () => {
    const pub = Object.entries(a.perHandler).filter(([, k]) => k === 'public').map(([r]) => r).sort();
    expect(pub).toEqual([...manifest.apiSurface.publicRoutes.map((r: { route: string }) => r.route)].sort());
  });

  it('every member-level handler is in the reviewed list, and the list has nothing stale', () => {
    expect(a.memberUnreviewed).toEqual([]);
    expect(a.memberStale).toEqual([]);
  });

  it('the six owner rooms are pinned, and every handler in them is owner-only (whoami excepted, with a reason)', () => {
    expect(Object.keys(policy.ownerRooms).sort()).toEqual(
      ['data-pulse.routes', 'fabric.routes', 'infrastructure.routes', 'owner-trace.routes', 'sources.routes', 'system.routes']);
    expect(a.ownerRoomViolations).toEqual([]);
    const sys = Object.entries(a.perHandler).filter(([r]) => / \/system(\/|$)/.test(r));
    expect(sys.length).toBeGreaterThan(60);
    for (const [r, k] of sys) expect(`${r} ${k}`).toBe(`${r} ${r === 'GET /system/whoami' ? 'member' : 'platform-owner'}`);
  });

  it('the firmware writes are classified as platform-owner', () => {
    for (const r of ['POST /device-infra/firmware', 'POST /provisioning/firmware/manifests', 'POST /provisioning/firmware/releases',
      'POST /provisioning/firmware/releases/:releaseId/advance']) expect(a.perHandler[r]).toBe('platform-owner');
  });

  it('both controls are present and required', () => {
    for (const id of ['authz-declared-per-handler', 'owner-rooms-pinned']) {
      expect(manifest.controls.find((c: { id: string }) => c.id === id)?.status).toBe('PRESENT');
      expect(policy.requiredControls).toContain(id);
    }
  });
});
