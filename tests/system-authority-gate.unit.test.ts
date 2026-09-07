/**
 * tests/system-authority-gate.unit.test.ts
 *
 * Being refused, and being told why.
 *
 * A platform that refuses its own owner and cannot say what is missing sends
 * people hunting for a bug in the guard — which is the one place the bug is
 * least likely to be. So the refusal now carries its reasons: what the account
 * role is, whether a platform assignment exists, whether it is active, and what
 * would grant authority. All of it is a fact about the caller's own account.
 *
 * The other half is what a refused account SEES. Not the command centre with an
 * empty middle — a rail full of modules it cannot open and a search box that
 * searches nothing is a workspace pretending to load. It gets one page.
 *
 * What none of this does is widen the gate. Platform authority still has
 * exactly two sources, and a club role is neither of them.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const state = {
  users: [] as Row[],
  memberships: [] as Row[],
  platformAdmins: [] as Row[],
};

const db = {
  user: {
    findMany: async () => state.users,
    findUnique: async ({ where }: Row) => state.users.find((u) => u.id === where.id) ?? null,
  },
  membership: {
    findMany: async ({ where }: Row) =>
      state.memberships.filter((m) => Object.entries(where).every(([k, v]) => m[k] === v)),
  },
  platformAdmin: {
    findUnique: async ({ where }: Row) => state.platformAdmins.find((a) => a.userId === where.userId) ?? null,
  },
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { describeAuthority, diagnosePlatformAuthority, isPlatformOwner } from '../src/platform/access-levels';
import { assertPlatformOwner } from '../src/platform/system.service';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SYS_JS = read('public/system/system.js');
const SYS_CSS = read('public/system/system.css');
const APP = read('public/app.js');
const START = read('scripts/render-start.sh');
const CTRL = read('src/controllers/system.controller.ts');

const CLUB = 'club-harta-berlin';

beforeEach(() => {
  state.users = [
    { id: 'u-founder', email: 'founder@familista.app', role: 'CLUB_ADMIN', isActive: true },
    { id: 'u-super', email: 'super@familista.app', role: 'SUPER_ADMIN', isActive: true },
  ];
  state.memberships = [
    { userId: 'u-founder', clubId: CLUB, role: 'CLUB_OWNER', isActive: true },
  ];
  state.platformAdmins = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// The resolver, and the two sources of authority
// ─────────────────────────────────────────────────────────────────────────────

describe('platform authority has exactly two sources', () => {
  it('an active PlatformAdmin row grants it', async () => {
    const actor = { userId: 'u-founder', clubId: CLUB, role: 'CLUB_ADMIN' };
    expect(await isPlatformOwner(actor)).toBe(false);

    state.platformAdmins = [{ userId: 'u-founder', isActive: true, role: 'PLATFORM_OWNER' }];
    expect(await isPlatformOwner(actor)).toBe(true);
    expect(await describeAuthority(actor)).toMatchObject({ level: 'PLATFORM_OWNER', isPlatformOwner: true });
    await expect(assertPlatformOwner(actor)).resolves.toBeUndefined();
  });

  it('SUPER_ADMIN on the account grants it, with no row at all', async () => {
    const actor = { userId: 'u-super', clubId: null, role: 'SUPER_ADMIN' };
    expect(state.platformAdmins).toHaveLength(0);
    expect(await isPlatformOwner(actor)).toBe(true);
    await expect(assertPlatformOwner(actor)).resolves.toBeUndefined();
  });

  it('and a club role is neither of them, at any level', async () => {
    for (const role of ['CLUB_ADMIN', 'HEAD_COACH', 'ANALYST', 'MANAGER', 'PARENT', 'PLAYER']) {
      const actor = { userId: 'u-founder', clubId: CLUB, role };
      expect(`${role}:${await isPlatformOwner(actor)}`).toBe(`${role}:false`);
      await expect(assertPlatformOwner(actor)).rejects.toMatchObject({ statusCode: 403 });
    }
    // Being a club owner is not a step towards being the platform's.
    expect(await describeAuthority({ userId: 'u-founder', clubId: CLUB, role: 'CLUB_ADMIN' }))
      .toMatchObject({ level: 'CLUB_OWNER', isClubOwner: true, isPlatformOwner: false });
  });

  it('a retired platform assignment does not grant it', async () => {
    state.platformAdmins = [{ userId: 'u-founder', isActive: false, role: 'PLATFORM_OWNER' }];
    expect(await isPlatformOwner({ userId: 'u-founder', clubId: CLUB, role: 'CLUB_ADMIN' })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The diagnosis
// ─────────────────────────────────────────────────────────────────────────────

describe('a refusal explains itself', () => {
  it('names what is missing, and what would grant it', async () => {
    const d = await diagnosePlatformAuthority({ userId: 'u-founder', clubId: CLUB, role: 'CLUB_ADMIN' });
    expect(d).toMatchObject({
      accountRole: 'CLUB_ADMIN',
      accountRoleGrants: false,
      platformAdminRow: 'NONE',
      granted: false,
    });
    expect(d.remedy).toMatch(/PLATFORM_OWNER_BOOTSTRAP/);
    expect(d.remedy).toMatch(/never grants it/i);
  });

  it('distinguishes a missing assignment from a retired one', async () => {
    state.platformAdmins = [{ userId: 'u-founder', isActive: false, role: 'PLATFORM_OWNER' }];
    const d = await diagnosePlatformAuthority({ userId: 'u-founder', clubId: CLUB, role: 'CLUB_ADMIN' });
    expect(d.platformAdminRow).toBe('INACTIVE');
    expect(d.remedy).toMatch(/reactivates/i);
  });

  it('and says nothing when there is nothing to explain', async () => {
    state.platformAdmins = [{ userId: 'u-founder', isActive: true, role: 'PLATFORM_OWNER' }];
    const d = await diagnosePlatformAuthority({ userId: 'u-founder', clubId: CLUB, role: 'CLUB_ADMIN' });
    expect(d).toMatchObject({ granted: true, platformAdminRow: 'ACTIVE', remedy: null });
  });

  it('describes only the caller — no other account, no count, no credential', async () => {
    state.users.push({ id: 'u-other', email: 'someone@else.test', role: 'SUPER_ADMIN', isActive: true });
    state.platformAdmins = [{ userId: 'u-other', isActive: true, role: 'PLATFORM_OWNER' }];

    const d = await diagnosePlatformAuthority({ userId: 'u-founder', clubId: CLUB, role: 'CLUB_ADMIN' });
    const json = JSON.stringify(d);
    expect(json).not.toContain('someone@else.test');
    expect(json).not.toContain('u-other');
    expect(json.toLowerCase()).not.toMatch(/password|token|hash|secret/);
    // It answers for this account only: still refused, despite another owner existing.
    expect(d.granted).toBe(false);
  });

  it('is what /system/whoami returns, and whoami is the only route open to a refused account', () => {
    expect(CTRL).toContain('diagnosePlatformAuthority');
    expect(CTRL).toMatch(/whoAmI[\s\S]{0,600}platformAuthority: diagnosis/);
    // Every other handler asserts first.
    const handlers = [...CTRL.matchAll(/export async function (\w+)\(req: Request/g)].map((m) => m[1]);
    const open = handlers.filter((fn) => {
      const body = CTRL.slice(CTRL.indexOf(`export async function ${fn}(req: Request`));
      const next = body.indexOf('\nexport async function');
      const slice = next > 0 ? body.slice(0, next) : body;
      // A handler is guarded when it asserts, or when every call it makes is
      // to a service that does — system.*, onboarding.* and analytics.* all
      // assert platform ownership as their first statement.
      return !/assertPlatformOwner|system\.|onboarding\.|analytics\./.test(slice);
    });
    expect(open).toEqual(['whoAmI']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What a refused account sees
// ─────────────────────────────────────────────────────────────────────────────

describe('a refused account is not shown a workspace', () => {
  it('gets its own screen, drawn instead of the shell', () => {
    // The check comes first in paint, before any rail or top bar is built.
    const paint = SYS_JS.slice(SYS_JS.indexOf('function paint(host)'), SYS_JS.indexOf('function go(host, module)'));
    const denyAt = paint.indexOf("SY.who.isPlatformOwner === false");
    const railAt = paint.indexOf('railHtml()');
    expect(denyAt).toBeGreaterThan(-1);
    expect(denyAt).toBeLessThan(railAt);
    expect(paint).toContain('sy-shell--denied');

    // And the denied screen has no module navigation of any kind.
    const denied = SYS_JS.slice(SYS_JS.indexOf('function deniedHtml()'), SYS_JS.indexOf('function drawerHtml()'));
    expect(denied).not.toContain('data-sy-go=');
    expect(denied).not.toContain('sy-nav');
    expect(denied).not.toContain('sy-rail');
    expect(denied).toContain('data-sy-home');       // the way back, and only that
  });

  it('asks the server for nothing else once it has been refused', () => {
    const load = SYS_JS.slice(SYS_JS.indexOf('function load(module)'), SYS_JS.indexOf('function paint(host)'));
    // Whoami is settled first and short-circuits: a refused account issues no
    // overview, capabilities or signals request at all.
    expect(load).toMatch(/if \(!SY\.who\) \{[\s\S]{0,400}\/system\/whoami/);
    expect(load).toMatch(/if \(SY\.who && SY\.who\.isPlatformOwner === false\) return;/);
    expect(load.indexOf('/system/whoami')).toBeLessThan(load.indexOf('/system/capabilities'));
  });

  it('shows what the server resolved, so the refusal can be diagnosed', () => {
    const denied = SYS_JS.slice(SYS_JS.indexOf('function deniedHtml()'), SYS_JS.indexOf('function drawerHtml()'));
    for (const label of ['Access level', 'Account role', 'Platform assignment']) {
      expect(`${label}:${denied.includes(label)}`).toBe(`${label}:true`);
    }
    expect(denied).toContain('d.remedy');
    expect(SYS_CSS).toContain('.sy-shell--denied');
  });

  it('and the club shell does not offer a door it cannot open', () => {
    // This assertion used to pin the opposite mechanism: render the SYSTEM
    // card always, then set `hidden` on it once whoami answered. That never
    // hid anything — `body.club-theme .oh-card { display: flex }` is an author
    // rule and outranks the user agent's `[hidden] { display: none }` — so a
    // club president saw a door into a refusal. The landing page now decides
    // which of two layouts to build, and the club one has no SYSTEM card in it
    // at all. tests/landing-access-presentation.unit.test.ts covers the rest.
    expect(APP).toContain('function _isPlatformOwner()');
    expect(APP).toMatch(/_isPlatformOwner\(\)\.then\(\(yes\) => \{[\s\S]{0,240}\? _ownerHomeForPlatformOwner\(user, club\)[\s\S]{0,80}: _ownerHomeForClubMember\(user\);/);
    expect(APP).not.toMatch(/card\.hidden = !yes;/);
    // Not rendering it is a courtesy either way. The server still refuses.
    expect(APP).toMatch(/every SYSTEM route refuses a club account/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The operator's side
// ─────────────────────────────────────────────────────────────────────────────

describe('the deploy log answers "who owns this platform?"', () => {
  it('counts both sources on every boot, unconditionally', () => {
    const block = START.slice(START.indexOf('# ── 4 · who owns the platform'), START.indexOf('# ── 4a · platform owner, once'));
    expect(block).toContain('platformAdmin.findMany');
    expect(block).toContain("role: 'SUPER_ADMIN'");
    // No `if` around it: it runs whether or not a variable is set.
    expect(block).not.toMatch(/^if \[/m);
    // A zero names the fix rather than leaving it a mystery.
    expect(block).toContain('NOBODY owns this platform');
    expect(block).toContain('PLATFORM_OWNER_BOOTSTRAP');
    // It is a read, and it never stops the API. Matched against Prisma calls
    // rather than prose — the instructions it prints say "delete the variable",
    // which is advice to a human, not a write.
    expect(block).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|updateMany|deleteMany)/);
    expect(block).not.toMatch(/\$execute(Raw|RawUnsafe)/);
    expect(block).not.toContain('exit 1');
  });

  it('and the bootstrap is still the only way authority is granted', () => {
    const bootstrap = read('src/platform/owner-bootstrap.ts');
    expect(bootstrap).toContain('PlatformRole.PLATFORM_OWNER');
    // Nothing in this change added a second path: no HTTP route grants it.
    const routes = read('src/routes/system.routes.ts');
    expect(routes).not.toMatch(/platform-owner|grant-authority|promote/i);
  });
});
