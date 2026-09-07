/**
 * tests/team-scoped-coach-surfaces.unit.test.ts
 *
 * A head coach hired for one team is offered one team, and nothing owner-shaped.
 *
 * The invited HEAD_COACH was created correctly — one club, one team, no platform
 * authority — and the landing page said so. Then they entered the club and found
 * three things that were not theirs:
 *
 *   1 · a Clubs page headed "Owner Home", reachable from the topbar's back
 *       button, which for a single-club account leads to a picker with one card
 *       on it and the owner's chrome around it;
 *   2 · "Onboard a new club" on that page — and behind it POST /api/v1/clubs,
 *       which had NO authorization at all and grants the caller a CLUB_OWNER
 *       membership in the club it creates. That is the serious one: a
 *       team-scoped coach could mint themselves a club they owned, with one
 *       request, no interface required;
 *   3 · a team selector offering "All teams" and every team in the club,
 *       because it was built from GET /teams — which is unfiltered by design,
 *       since a team's own row is club-shell information — and never asked what
 *       this person may actually work with.
 *
 * The first and third were the interface offering what the server would refuse.
 * The second was the server not refusing. Both halves are pinned here.
 */

import fs from 'fs';
import path from 'path';
import { MembershipRole, MembershipStatus, UserRole } from '@prisma/client';

type Row = Record<string, any>;

const CLUB = 'club-mail-test';
const OTHER_CLUB = 'club-elsewhere';
const T_FIRST = 'team-first';
const T_U13 = 'team-u13';
const T_U23 = 'team-u23';

const state = {
  users: [] as Row[],
  memberships: [] as Row[],
  clubs: [] as Row[],
  teams: [] as Row[],
  platformAdmins: [] as Row[],
  audits: [] as Row[],
};

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) return row[k] !== (v as Row).not;
      if ('in' in v) return ((v as Row).in as unknown[]).includes(row[k]);
    }
    return row[k] === v;
  });

const clubOf = (id: string) => state.clubs.find((c) => c.id === id) ?? null;

const db: Row = {
  user: {
    findUnique: async ({ where }: Row) => {
      const u = state.users.find((x) => (where.id ? x.id === where.id : x.email === where.email));
      return u ? { ...u, currentClub: clubOf(u.currentClubId), currentTeam: null } : null;
    },
    update: async ({ where, data }: Row) => {
      const u = state.users.find((x) => x.id === where.id)!;
      Object.assign(u, data);
      return u;
    },
  },
  membership: {
    findMany: async ({ where = {} }: Row = {}) => state.memberships
      .filter((m) => match(m, where))
      .map((m) => ({ ...m, club: clubOf(m.clubId), team: state.teams.find((t) => t.id === m.teamId) ?? null })),
    findFirst: async ({ where = {} }: Row = {}) => state.memberships.find((m) => match(m, where)) ?? null,
    count: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)).length,
  },
  club: { findUnique: async ({ where }: Row) => clubOf(where.id) },
  team: {
    findUnique: async ({ where }: Row) => state.teams.find((t) => t.id === where.id) ?? null,
    findMany: async ({ where = {} }: Row = {}) => {
      const ids: string[] | null = where.id && where.id.in ? where.id.in : null;
      return state.teams.filter((t) => (!ids || ids.includes(t.id)) && (!where.clubId || t.clubId === where.clubId));
    },
  },
  player: { groupBy: async () => [] },
  platformAdmin: {
    findUnique: async ({ where }: Row) => state.platformAdmins.find((a) => a.userId === where.userId) ?? null,
  },
  membershipAuditLog: { create: async ({ data }: Row) => { state.audits.push(data); return data; } },
  refreshToken: { deleteMany: async () => ({ count: 0 }) },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { getContext, switchContext } from '../src/services/context.service';
import * as teamAccess from '../src/identity/team-access.service';
import { isPlatformOwner } from '../src/platform/access-levels';
import { assertPlatformOwner } from '../src/platform/system.service';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('public/app.js');

const COACH = 'u-coach';
const PRESIDENT = 'u-president';
const OWNER = 'u-platform-owner';

beforeEach(() => {
  state.clubs = [
    { id: CLUB, name: 'familista mail test', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC' },
    { id: OTHER_CLUB, name: 'Another Club', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC' },
  ];
  state.teams = [
    { id: T_FIRST, clubId: CLUB, name: 'First Team', shortName: null, kind: 'FIRST_TEAM', isActive: true },
    { id: T_U13, clubId: CLUB, name: 'U13', shortName: null, kind: 'ACADEMY', isActive: true },
    { id: T_U23, clubId: CLUB, name: 'U23', shortName: null, kind: 'ACADEMY', isActive: true },
  ];
  state.users = [
    { id: COACH, email: 'coach@example.com', role: UserRole.HEAD_COACH, clubId: CLUB, currentClubId: CLUB, currentTeamId: null },
    { id: PRESIDENT, email: 'president@familista.test', role: UserRole.CLUB_ADMIN, clubId: CLUB, currentClubId: CLUB, currentTeamId: null },
    { id: OWNER, email: 'owner@familista.io', role: UserRole.CLUB_ADMIN, clubId: CLUB, currentClubId: CLUB, currentTeamId: null },
  ];
  state.memberships = [
    { id: 'm-coach', userId: COACH, clubId: CLUB, teamId: T_FIRST, role: MembershipRole.HEAD_COACH, isActive: true, status: MembershipStatus.ACTIVE, joinedAt: new Date(), leftAt: null },
    { id: 'm-president', userId: PRESIDENT, clubId: CLUB, teamId: null, role: MembershipRole.CLUB_OWNER, isActive: true, status: MembershipStatus.ACTIVE, joinedAt: new Date(), leftAt: null },
  ];
  state.platformAdmins = [{ userId: OWNER, isActive: true, role: 'OWNER' }];
  state.audits = [];
});

const asCoach = () => ({ userId: COACH, clubId: CLUB, role: UserRole.HEAD_COACH });

// ─────────────────────────────────────────────────────────────────────────────
describe('the team context offered is the team access held', () => {
  it('a coach assigned to one team is scoped to exactly that team', async () => {
    const ctx = await getContext(COACH);
    expect(ctx.currentTeamScope.unrestricted).toBe(false);
    expect(ctx.currentTeamScope.teams.map((t: Row) => t.id)).toEqual([T_FIRST]);
    expect(ctx.currentTeamScope.teams[0].name).toBe('First Team');
  });

  it('and is offered no all-teams scope, because they do not have one', async () => {
    const ctx = await getContext(COACH);
    expect(ctx.currentTeamScope.unrestricted).toBe(false);
    // The academy sides exist in the club and are not in what they may pick.
    const offered = ctx.currentTeamScope.teams.map((t: Row) => t.id);
    for (const other of [T_U13, T_U23]) {
      expect(`${other} offered: ${offered.includes(other)}`).toBe(`${other} offered: false`);
    }
  });

  it('multi-team staff are offered exactly their teams, and still not all', async () => {
    state.memberships.push({
      id: 'm-coach-2', userId: COACH, clubId: CLUB, teamId: T_U23,
      role: MembershipRole.ANALYST, isActive: true, status: MembershipStatus.ACTIVE,
      joinedAt: new Date(), leftAt: null,
    });
    const ctx = await getContext(COACH);
    expect(ctx.currentTeamScope.unrestricted).toBe(false);
    expect(ctx.currentTeamScope.teams.map((t: Row) => t.id).sort()).toEqual([T_FIRST, T_U23].sort());
    expect(ctx.currentTeamScope.teams.map((t: Row) => t.id)).not.toContain(T_U13);
  });

  it('and a president, whose membership is club-wide, keeps every team', async () => {
    const ctx = await getContext(PRESIDENT);
    expect(ctx.currentTeamScope.unrestricted).toBe(true);
  });

  it('the scope comes from the same service that gates private reads', async () => {
    // Not a second opinion computed beside the guard: the same one.
    const scope = await teamAccess.privateTeamScope(asCoach());
    const ctx = await getContext(COACH);
    expect(ctx.currentTeamScope.unrestricted).toBe(scope.unrestricted);
    expect(ctx.currentTeamScope.teams.map((t: Row) => t.id)).toEqual(scope.teamIds);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('and the selector is built from that scope, not from every club team', () => {
  const SWITCHER = APP.slice(APP.indexOf('function renderSwitcher'), APP.indexOf('async function switchClub'));

  it('offers "All teams" only where the access truly covers them', () => {
    expect(SWITCHER).toContain('_ctx.currentTeamScope');
    expect(SWITCHER).toMatch(/unrestricted \? '<option value="">All teams<\/option>' : ''/);
  });

  it('and lists the scope\'s teams when it is restricted', () => {
    expect(SWITCHER).toMatch(/var allowed = unrestricted\s*\n\s*\? _teams\s*\n\s*: \(scope && Array\.isArray\(scope\.teams\) \? scope\.teams : \[\]\)/);
    // Never the raw club list for a restricted person — that was the bug.
    const restricted = SWITCHER.slice(SWITCHER.indexOf('var allowed'), SWITCHER.indexOf('ts.innerHTML'));
    expect(restricted).toContain('scope.teams');
  });

  it('and does not pretend to offer a choice that does not exist', () => {
    expect(SWITCHER).toContain('ts.disabled = (!unrestricted && allowed.length <= 1);');
  });

  it('while the answer is outstanding it offers nothing rather than everything', () => {
    // `unrestricted` defaults to false when the scope has not arrived, so an
    // unanswered context is treated as the narrow case, never the broad one.
    expect(SWITCHER).toContain('var unrestricted = scope ? !!scope.unrestricted : false;');
  });

  it('and, run for real, offers exactly what each person holds', () => {
    // The assertions above read the source; this one executes it. The function
    // is lifted out with its two closure variables supplied, so what is under
    // test is the code that ships rather than a description of it.
    const body = APP.slice(APP.indexOf('function renderSwitcher'), APP.indexOf('  // `opts.isCurrent()` says whether'));
    const teams = [
      { id: T_FIRST, name: 'First Team', shortName: null },
      { id: T_U13, name: 'U13', shortName: null },
      { id: T_U23, name: 'U23', shortName: null },
    ];
    const offer = (scope: Row | null, currentTeamId: string | null) => {
      const stub = () => ({ innerHTML: '', options: [{}], style: {}, disabled: false, setAttribute() {} });
      const nodes: Row = { 'ctx-switcher': stub(), 'ctx-club': stub(), 'ctx-team': stub() };
      const doc = { getElementById: (id: string) => nodes[id] ?? null };
      const ctx = { availableClubs: [{ id: CLUB, name: 'Club' }], currentClubId: CLUB, currentTeamId, currentTeamScope: scope };
      // eslint-disable-next-line no-new-func
      new Function('document', '_ctx', '_teams', `${body}\nreturn renderSwitcher;`)(doc, ctx, teams)();
      const html: string = nodes['ctx-team'].innerHTML;
      return {
        names: [...html.matchAll(/<option value="[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]),
        hasAll: html.includes('>All teams<'),
        disabled: nodes['ctx-team'].disabled,
      };
    };

    // The president's club-wide membership genuinely covers every team.
    expect(offer({ unrestricted: true, teams: [] }, null))
      .toEqual({ names: ['All teams', 'First Team', 'U13', 'U23'], hasAll: true, disabled: false });

    // The reported case: one team, named, with no all-teams scope to pick.
    expect(offer({ unrestricted: false, teams: [{ id: T_FIRST, name: 'First Team' }] }, T_FIRST))
      .toEqual({ names: ['First Team'], hasAll: false, disabled: true });

    // Multi-team staff: their teams, and nothing else in the club.
    expect(offer({ unrestricted: false, teams: [{ id: T_FIRST, name: 'First Team' }, { id: T_U23, name: 'U23' }] }, T_FIRST))
      .toEqual({ names: ['First Team', 'U23'], hasAll: false, disabled: false });

    // And before the server has answered it fails closed, not open.
    expect(offer(null, null)).toEqual({ names: [], hasAll: false, disabled: true });
  });

  it('and a one-team person is settled on that team rather than left club-wide', () => {
    const settle = APP.slice(APP.indexOf('async function _settleScopedTeam'), APP.indexOf('async function load()'));
    expect(settle).toContain('if (!scope || scope.unrestricted) return;');
    expect(settle).toContain('if (teams.length !== 1) return;');
    // Called on boot and on entering a club — the two moments teamId is null.
    expect((APP.match(/await _settleScopedTeam\(\);/g) || []).length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('creating a club is the platform owner\'s, and was not', () => {
  const CLUB_CTRL = read('src/controllers/club.controller.ts');

  it('POST /clubs now refuses a club account', () => {
    const create = CLUB_CTRL.slice(CLUB_CTRL.indexOf('export async function createClub'), CLUB_CTRL.indexOf('export async function getCurrentClub'));
    expect(create).toContain('await assertPlatformOwner(');
    // Before the body is parsed: a refusal must not depend on a well-formed
    // payload, or the shape of the error tells the caller what was validated.
    expect(create.indexOf('assertPlatformOwner')).toBeLessThan(create.indexOf('createSchema.safeParse'));
  });

  it('and the guard is the same one every SYSTEM route uses', async () => {
    // A head coach.
    await expect(assertPlatformOwner({ userId: COACH, clubId: CLUB, role: UserRole.HEAD_COACH })).rejects.toThrow();
    // A president. Owning a club is not owning Familista.
    await expect(assertPlatformOwner({ userId: PRESIDENT, clubId: CLUB, role: UserRole.CLUB_ADMIN })).rejects.toThrow();
    // The platform owner.
    await expect(assertPlatformOwner({ userId: OWNER, clubId: CLUB, role: UserRole.CLUB_ADMIN })).resolves.toBeUndefined();
  });

  it('and no club role has ever been platform authority', async () => {
    for (const role of [MembershipRole.CLUB_OWNER, MembershipRole.CLUB_ADMIN, MembershipRole.HEAD_COACH]) {
      state.memberships.push({
        id: `m-${role}`, userId: COACH, clubId: CLUB, teamId: null, role,
        isActive: true, status: MembershipStatus.ACTIVE, joinedAt: new Date(), leftAt: null,
      });
      expect(`${role}: ${await isPlatformOwner({ userId: COACH, role: UserRole.CLUB_ADMIN })}`)
        .toBe(`${role}: false`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('and the owner-only surfaces are not drawn for a club account', () => {
  const PICKER = APP.slice(APP.indexOf('function renderClubs()'), APP.indexOf('// ── CLUB HOME v2'));

  it('the Clubs picker draws its owner chrome only for the owner', () => {
    expect(PICKER).toContain('const ownerChrome = !!_platformAuthorityKnown;');
    // Both controls are inside the same condition.
    expect(PICKER).toMatch(/ownerChrome \? '<button class="cp-back"[^\n]*Owner Home/);
    expect(PICKER).toMatch(/\$\{ownerChrome \? `\s*\n\s*<button class="cp-card cp-card--add"/);
  });

  it('and "not yet known" reads as "no", so nothing flashes past', () => {
    // The latch starts false and only ever goes true, so a page painted before
    // whoami answers is painted WITHOUT the owner controls.
    expect(APP).toContain('let _platformAuthorityKnown = false;');
    expect(APP).not.toMatch(/_platformAuthorityKnown\s*=\s*false;\s*\n[^\n]*renderClubs/);
    // And it repaints once the answer lands, so an owner is not left short.
    expect(PICKER).toContain('_platformAuthorityKnown = true;');
    expect(PICKER).toContain('renderClubs();');
  });

  it('the onboarding modal refuses to open for anybody else', () => {
    const modal = APP.slice(APP.indexOf('function openOnboardClubModal'), APP.indexOf('function closeOnboardClubModal'));
    expect(modal).toContain('if (!_platformAuthorityKnown) {');
    expect(modal).toContain('platform-owner action');
  });

  it('and the topbar sends a single-club member home, not to a picker', () => {
    const back = APP.slice(APP.indexOf('function _updateTopbarBack'), APP.indexOf('// ── Browser back/forward'));
    expect(back).toContain('var manyClubs = _accessibleClubs().length > 1;');
    expect(back).toMatch(/manyClubs \? 'clubs' : 'owner-home'/);
    // And the handler honours what the label promised.
    const handler = APP.slice(APP.indexOf("case 'topbarBack':"), APP.indexOf("case 'topbarBack':") + 700);
    expect(handler).toContain("_btn.getAttribute('data-back-to')");
    expect(handler).not.toMatch(/_area === 'club'\s*\)\s*\?\s*'clubs'/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('and the server refuses what the screen no longer offers', () => {
  it('the coach cannot switch context into a team they were not given', async () => {
    await expect(switchContext({ userId: COACH }, CLUB, T_U13)).rejects.toThrow(/No membership covers that team/i);
    await expect(switchContext({ userId: COACH }, CLUB, T_U23)).rejects.toThrow();
    await expect(switchContext({ userId: COACH }, CLUB, T_FIRST)).resolves.toBeTruthy();
  });

  it('nor into another club', async () => {
    await expect(switchContext({ userId: COACH }, OTHER_CLUB, null)).rejects.toThrow();
  });

  it('and reaches no other team\'s private content, whatever the client sends', async () => {
    expect((await teamAccess.accessForTeam(asCoach(), T_FIRST)).canViewPrivate).toBe(true);
    for (const other of [T_U13, T_U23]) {
      const a = await teamAccess.accessForTeam(asCoach(), other);
      expect(`${other}: ${a.canViewPrivate}`).toBe(`${other}: false`);
      await expect(teamAccess.assertCanViewTeamPrivate(asCoach(), other)).rejects.toThrow();
    }
  });

  it('and can still do their job on the team they were hired for', async () => {
    const a = await teamAccess.accessForTeam(asCoach(), T_FIRST);
    expect(a.canManage).toBe(true);
    expect(a.reason).toBe('TEAM_ASSIGNMENT');
    await expect(teamAccess.assertCanManageTeam(asCoach(), T_FIRST)).resolves.toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('and nothing that worked stopped working', () => {
  it('the platform owner still gets SYSTEM, and both landing doors', async () => {
    expect(await isPlatformOwner({ userId: OWNER, role: UserRole.CLUB_ADMIN })).toBe(true);
    expect(APP).toContain('function _ownerHomeForPlatformOwner');
    expect(APP).toContain('data-page="system"');
  });

  it('the president still enters their club, and still sees no SYSTEM', async () => {
    const ctx = await getContext(PRESIDENT);
    expect(ctx.availableClubs.map((c: Row) => c.id)).toEqual([CLUB]);
    expect(ctx.currentClubRole).toBe(MembershipRole.CLUB_OWNER);
    expect(await isPlatformOwner({ userId: PRESIDENT, role: UserRole.CLUB_ADMIN })).toBe(false);
  });

  it('and the coach still enters the club they were invited to', async () => {
    const ctx = await getContext(COACH);
    expect(ctx.availableClubs.map((c: Row) => c.id)).toEqual([CLUB]);
    expect(ctx.currentClubRole).toBe(MembershipRole.HEAD_COACH);
  });
});
