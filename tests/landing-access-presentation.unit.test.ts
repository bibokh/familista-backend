/**
 * tests/landing-access-presentation.unit.test.ts
 *
 * A door somebody cannot open should not be drawn.
 *
 * The backend was already right: a club president clicking SYSTEM got the
 * refusal, every time. What was wrong was that they were offered the door at
 * all — a landing page headed "FAMILISTA · OWNER CONTROL" with a SYSTEM card
 * on it, for somebody who is not the platform's owner and never will be by
 * virtue of owning a club.
 *
 * An earlier attempt drew the card and hid it with the `hidden` attribute.
 * That failed silently in production, and the reason is the whole lesson here:
 * `body.club-theme .oh-card { display: flex }` is an author rule and outranks
 * the user agent's `[hidden] { display: none }`, so the card stayed on screen
 * for everybody. Concealment is a thing that can quietly stop working;
 * deciding what to BUILD cannot.
 *
 * So the rule under test is stronger than "hidden": for a non-platform account
 * the SYSTEM entry point is never constructed. And the backend guard is
 * unchanged and re-proved, because visibility is a courtesy and the refusal is
 * the security.
 */

import fs from 'fs';
import path from 'path';
import { MembershipRole, UserRole } from '@prisma/client';

type Row = Record<string, any>;

const CLUB = 'club-mail-test';
const CLUB_B = 'club-second';

const state = {
  users: [] as Row[],
  memberships: [] as Row[],
  clubs: [] as Row[],
  platformAdmins: [] as Row[],
};

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) return row[k] !== v.not;
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
    }
    return row[k] === v;
  });

const db: Row = {
  user: {
    findUnique: async ({ where }: Row) => {
      const u = state.users.find((x) => (where.id ? x.id === where.id : x.email === where.email));
      if (!u) return null;
      const club = state.clubs.find((c) => c.id === u.currentClubId) ?? null;
      return { ...u, currentClub: club, currentTeam: null };
    },
  },
  membership: {
    findMany: async ({ where = {} }: Row = {}) => state.memberships
      .filter((m) => match(m, where))
      .map((m) => ({ ...m, club: state.clubs.find((c) => c.id === m.clubId), team: null })),
    findFirst: async ({ where }: Row) => state.memberships.find((m) => match(m, where)) ?? null,
    count: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)).length,
  },
  club: { findUnique: async ({ where }: Row) => state.clubs.find((c) => c.id === where.id) ?? null },
  platformAdmin: {
    findUnique: async ({ where }: Row) => state.platformAdmins.find((a) => a.userId === where.userId) ?? null,
  },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { getContext } from '../src/services/context.service';
import { isPlatformOwner, describeAuthority } from '../src/platform/access-levels';
import { assertPlatformOwner } from '../src/platform/system.service';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('public/app.js');
const CSS = read('public/app.css');

/**
 * The text between two anchors, or a failure that names the anchor that moved.
 *
 * A plain `slice(indexOf(a), indexOf(b))` answers the empty string when an
 * anchor has been renamed or when the two are the wrong way round, and an
 * assertion against the empty string passes for every rule that forbids
 * something. That is a test which stops testing without ever going red, so
 * this refuses instead.
 */
function between(source: string, from: string, to: string): string {
  const a = source.indexOf(from);
  const b = source.indexOf(to);
  if (a < 0) throw new Error(`anchor not found: ${from}`);
  if (b < 0) throw new Error(`anchor not found: ${to}`);
  if (b <= a) throw new Error(`anchors are out of order: ${from} … ${to}`);
  return source.slice(a, b);
}

const OWNER_HOME = between(APP, 'function _ownerHomeForPlatformOwner', '// ── CLUBS PICKER ──');
const PLATFORM_LAYOUT = between(APP, 'function _ownerHomeForPlatformOwner', 'function _ownerHomeForClubMember');
const CLUB_LAYOUT = between(APP, 'function _ownerHomeForClubMember', 'function renderOwnerHome() {');

/**
 * The same source with its prose removed.
 *
 * A rule that forbids a word must be asked of the code, not of the comment
 * explaining why the code does not contain it — otherwise the explanation
 * fails the test it documents.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const CLUB_LAYOUT_CODE = stripComments(CLUB_LAYOUT);

beforeEach(() => {
  state.clubs = [
    { id: CLUB, name: 'familista mail test', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC' },
    { id: CLUB_B, name: 'Second Club', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC' },
  ];
  state.users = [
    { id: 'u-president', email: 'president@mail.test', role: UserRole.CLUB_ADMIN, clubId: CLUB, currentClubId: CLUB, currentTeamId: null },
    { id: 'u-admin', email: 'admin@mail.test', role: UserRole.CLUB_ADMIN, clubId: CLUB, currentClubId: CLUB, currentTeamId: null },
    { id: 'u-coach', email: 'coach@mail.test', role: UserRole.HEAD_COACH, clubId: CLUB, currentClubId: CLUB, currentTeamId: null },
    { id: 'u-multi', email: 'multi@mail.test', role: UserRole.HEAD_COACH, clubId: CLUB, currentClubId: CLUB, currentTeamId: null },
    { id: 'u-platform', email: 'owner@familista.app', role: UserRole.CLUB_ADMIN, clubId: CLUB, currentClubId: CLUB, currentTeamId: null },
  ];
  state.memberships = [
    { id: 'm1', userId: 'u-president', clubId: CLUB, teamId: null, role: MembershipRole.CLUB_OWNER, isActive: true, status: 'ACTIVE' },
    { id: 'm2', userId: 'u-admin', clubId: CLUB, teamId: null, role: MembershipRole.CLUB_ADMIN, isActive: true, status: 'ACTIVE' },
    { id: 'm3', userId: 'u-coach', clubId: CLUB, teamId: null, role: MembershipRole.HEAD_COACH, isActive: true, status: 'ACTIVE' },
    { id: 'm4', userId: 'u-multi', clubId: CLUB, teamId: null, role: MembershipRole.ANALYST, isActive: true, status: 'ACTIVE' },
    { id: 'm5', userId: 'u-multi', clubId: CLUB_B, teamId: null, role: MembershipRole.HEAD_COACH, isActive: true, status: 'ACTIVE' },
    { id: 'm6', userId: 'u-platform', clubId: CLUB, teamId: null, role: MembershipRole.CLUB_OWNER, isActive: true, status: 'ACTIVE' },
  ];
  state.platformAdmins = [{ userId: 'u-platform', isActive: true, role: 'PLATFORM_OWNER' }];
});

// ─────────────────────────────────────────────────────────────────────────────
// Who the server says is what
// ─────────────────────────────────────────────────────────────────────────────

describe('platform authority is a separate assignment, and only that', () => {
  it('1 · the platform owner has it', async () => {
    const actor = { userId: 'u-platform', clubId: CLUB, role: 'CLUB_ADMIN' };
    expect(await isPlatformOwner(actor)).toBe(true);
    expect(await describeAuthority(actor)).toMatchObject({ level: 'PLATFORM_OWNER', isPlatformOwner: true });
    await expect(assertPlatformOwner(actor)).resolves.toBeUndefined();
  });

  it('7 · owning a club never creates it', async () => {
    // The president holds an identical CLUB_OWNER membership to the platform
    // owner's, in the same club, with the same account role. The only thing
    // that differs is the PlatformAdmin row, and that is the whole point.
    const president = { userId: 'u-president', clubId: CLUB, role: 'CLUB_ADMIN' };
    expect(await isPlatformOwner(president)).toBe(false);
    expect(await describeAuthority(president)).toMatchObject({
      level: 'CLUB_OWNER', isClubOwner: true, isPlatformOwner: false,
    });
    await expect(assertPlatformOwner(president)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('2, 3, 4 · and neither does any other club role', async () => {
    for (const [userId, role] of [
      ['u-president', 'CLUB_ADMIN'], ['u-admin', 'CLUB_ADMIN'], ['u-coach', 'HEAD_COACH'], ['u-multi', 'HEAD_COACH'],
    ] as const) {
      const actor = { userId, clubId: CLUB, role };
      expect(`${userId}: ${await isPlatformOwner(actor)}`).toBe(`${userId}: false`);
      await expect(assertPlatformOwner(actor)).rejects.toMatchObject({ statusCode: 403 });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The landing page is BUILT differently, not hidden differently
// ─────────────────────────────────────────────────────────────────────────────

describe('the SYSTEM entry point is not rendered for a club account', () => {
  it('2, 3, 4 · exists in the platform-owner layout and in no other', () => {
    expect(PLATFORM_LAYOUT).toContain('data-page="system"');
    expect(PLATFORM_LAYOUT).toContain('oh-card--system');

    // Not present in the club layout at all — not hidden, not disabled, not
    // greyed. Absent.
    for (const forbidden of [
      'data-page="system"', 'oh-card--system', 'SYSTEM',
      'Platform &amp; infrastructure', 'OWNER CONTROL',
      'People &amp; Access', 'Governance', 'Innovation Lab', 'Command Center',
    ]) {
      expect(`${forbidden}: ${CLUB_LAYOUT_CODE.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
  });

  it('and the whole application has exactly one SYSTEM entry point', () => {
    expect((APP.match(/data-page="system"/g) || []).length).toBe(1);
  });

  it('decides what to build rather than what to conceal', () => {
    // The bug this replaced: `hidden` was set on the card and cleared for a
    // platform owner, and an author rule outranked the UA stylesheet so the
    // attribute did nothing. Nothing is drawn and then hidden now.
    expect(OWNER_HOME).not.toMatch(/oh-card--system[^>]*hidden/);
    expect(OWNER_HOME).not.toMatch(/card\.hidden\s*=/);
    expect(CSS).toContain('body.club-theme .oh-card{');
    // The comment records why, so nobody reintroduces it.
    expect(APP).toMatch(/outranks the user agent's\s*\n\s*\* `\[hidden\] \{ display: none \}`/);
  });

  it('shows nothing platform-shaped while the answer is still outstanding', () => {
    const render = between(APP, 'function renderOwnerHome() {', '// ── CLUBS PICKER ──');
    // The placeholder cannot flash a SYSTEM card at somebody on a slow network.
    const placeholder = between(render, 'el.innerHTML = `', '_isPlatformOwner().then');
    expect(placeholder).not.toContain('system');
    expect(placeholder).not.toContain('OWNER CONTROL');
    expect(placeholder).toContain('Loading your access…');
    // And the layout is chosen only after the server has answered.
    expect(render).toMatch(/_isPlatformOwner\(\)\.then\(\(yes\) => \{[\s\S]{0,400}yes\s*\n?\s*\?\s*_ownerHomeForPlatformOwner/);
  });

  it('takes that answer from the server, never from a role in the client', () => {
    const resolver = between(APP, 'let _platformAuthority = null;', 'function _displayRole');
    expect(resolver).toContain("'/system/whoami'");
    expect(resolver).toContain('isPlatformOwner');
    // Not inferred from anything the client holds.
    expect(resolver).not.toMatch(/State\.user\.role|CLUB_OWNER|CLUB_ADMIN|memberships/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What a club member is shown instead
// ─────────────────────────────────────────────────────────────────────────────

describe('a club account lands on its clubs', () => {
  it('5 · one club gets a single-club landing, centred rather than half a grid', () => {
    expect(CLUB_LAYOUT).toContain('const one = clubs.length === 1;');
    expect(CLUB_LAYOUT).toContain("one ? 'Your club' : (clubs.length ? 'Your clubs'");
    expect(CLUB_LAYOUT).toContain("oh-cards--single");
    expect(CSS).toContain('body.club-theme .oh-cards--single{');
    // It opens the club through the path that already exists, not a second one.
    expect(CLUB_LAYOUT).toContain('data-action="openClub"');
    expect(APP).toContain('function openClub(clubId)');
  });

  it('6 · and lists exactly the clubs the server reported, with no others', async () => {
    const context = await getContext('u-multi');
    expect(context.availableClubs.map((c) => c.id).sort()).toEqual([CLUB_B, CLUB].sort());

    // The page reads that list and nothing else — never a club id on the user
    // record, never something inferred from a role.
    const reader = between(APP, 'function _accessibleClubs', 'function _clubRoleLabel');
    expect(reader).toContain('State.context && State.context.availableClubs');
    expect(reader).not.toMatch(/State\.user\.clubId|legacyClubId/);
  });

  it('and an account with no membership is told so, rather than shown a club', async () => {
    state.memberships = [];
    state.users.find((u) => u.id === 'u-coach')!.clubId = null;
    const context = await getContext('u-coach');
    expect(context.availableClubs).toEqual([]);
    expect(CLUB_LAYOUT).toContain('No club yet');
  });

  it('keeps the account controls a person needs to sign out', () => {
    // The landing page is not a dead end: the sidebar and its account controls
    // are the application's, and this page does not remove them.
    expect(CLUB_LAYOUT).toContain('oh-footer');
    expect(APP).toContain('function doLogout');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The role that is printed
// ─────────────────────────────────────────────────────────────────────────────

describe('8 · a president is named president, not administrator', () => {
  it('reports the authoritative membership role per club', async () => {
    const context = await getContext('u-president');
    // The account-level field says CLUB_ADMIN, and it is reported honestly as
    // the legacy value it is.
    expect(context.legacyRole).toBe(UserRole.CLUB_ADMIN);
    // The membership — the authority — says CLUB_OWNER, and that is the one
    // the interface is given to display.
    expect(context.currentClubRole).toBe(MembershipRole.CLUB_OWNER);
    expect(context.availableClubs[0].roles).toEqual([MembershipRole.CLUB_OWNER]);
  });

  it('picks the strongest role when somebody holds several in one club', async () => {
    state.memberships.push({
      id: 'm7', userId: 'u-president', clubId: CLUB, teamId: null,
      role: MembershipRole.HEAD_COACH, isActive: true, status: 'ACTIVE',
    });
    const context = await getContext('u-president');
    // A president who also coaches is a president.
    expect(context.currentClubRole).toBe(MembershipRole.CLUB_OWNER);
    expect(context.availableClubs[0].roles.sort()).toEqual([MembershipRole.CLUB_OWNER, MembershipRole.HEAD_COACH].sort());
  });

  it('and the interface prints that, falling back only for a legacy account', () => {
    expect(APP).toContain('function _displayRole()');
    const display = between(APP, '* The role to PRINT', 'const _ROLE_RANK');
    expect(display).toContain('ctx.currentClubRole');
    expect(display).toContain('_roleLabel(ctx.currentClubRole)');
    // The account field exists as a fallback, and it is the LAST of the three.
    expect(display.indexOf('currentClubRole')).toBeLessThan(display.indexOf('ctx.availableClubs'));
    expect(display.indexOf('ctx.availableClubs')).toBeLessThan(display.indexOf('State.user.role'));
    expect(APP).toContain("CLUB_OWNER: 'President'");
    // It is used where the role is WRITTEN, and nowhere a decision is made.
    expect(APP).toContain('el.textContent = _displayRole();');
  });

  it('CLUB_OWNER is never rendered as CLUB ADMIN, in any of the three sources', () => {
    // The reported symptom, pinned at the level it actually failed: the label.
    const app = new Function(`
      ${between(APP, 'function _displayRole()', 'function _accessibleClubs()')}
      return { _displayRole, _strongestRole, _roleLabel };
    `)() as {
      _displayRole: () => string;
      _strongestRole: (r: string[] | null | undefined) => string | null;
      _roleLabel: (r: string) => string;
    };

    const withState = (context: any, user: any) => {
      (global as any).window = { State: { context, user } };
      (global as any).State = (global as any).window.State;
      try { return app._displayRole(); } finally {
        delete (global as any).window; delete (global as any).State;
      }
    };

    // 1 · the server named the membership for the open club.
    expect(withState(
      { currentClubRole: 'CLUB_OWNER', clubId: CLUB, availableClubs: [] },
      { role: 'CLUB_ADMIN' },
    )).toBe('President');

    // 2 · it did not, because the president has never switched context and the
    //     user row carries no current club — the club on screen still answers.
    expect(withState(
      { currentClubRole: null, clubId: CLUB, availableClubs: [{ id: CLUB, roles: ['CLUB_OWNER'] }] },
      { role: 'CLUB_ADMIN' },
    )).toBe('President');

    // 3 · not even the club id is settled yet, but there is exactly one club.
    expect(withState(
      { currentClubRole: null, clubId: null, availableClubs: [{ id: CLUB, roles: ['CLUB_OWNER'] }] },
      { role: 'CLUB_ADMIN' },
    )).toBe('President');

    // A president who also coaches is still a president.
    expect(withState(
      { currentClubRole: null, clubId: CLUB, availableClubs: [{ id: CLUB, roles: ['HEAD_COACH', 'CLUB_OWNER'] }] },
      { role: 'CLUB_ADMIN' },
    )).toBe('President');

    // 7 · every other role still reads correctly — this is not a special case
    //     for presidents bolted onto a broken function.
    for (const [role, label] of [
      ['CLUB_ADMIN', 'Club administrator'], ['HEAD_COACH', 'Head coach'],
      ['MANAGER', 'Manager'], ['ANALYST', 'Analyst'], ['SCOUT', 'Scout'],
      ['MEDICAL_STAFF', 'Medical staff'], ['PLAYER', 'Player'], ['PARENT', 'Parent'],
    ] as const) {
      expect(`${role} → ${withState({ currentClubRole: role, availableClubs: [] }, { role: 'PLAYER' })}`)
        .toBe(`${role} → ${label}`);
    }

    // And a genuinely legacy account, with no membership anywhere, still gets
    // the account field rather than a blank chip.
    expect(withState({ currentClubRole: null, clubId: null, availableClubs: [] }, { role: 'CLUB_ADMIN' }))
      .toBe('CLUB ADMIN');
  });

  it('repaints the label once the authoritative answer lands', () => {
    // The first fix set the text from _displayRole() but ran at boot, before
    // /me/context had answered — so it could only ever reach the account field
    // and the label stayed "CLUB ADMIN". Every place that learns the context
    // now rewrites it.
    expect(APP).toContain('function _paintUserRole()');
    const boot = between(APP, 'async function bootApp()', 'try { await AppContext.load(); }');
    expect(boot).toContain('_paintUserRole();');
    // The load, the club switch and the team switch: three context writes,
    // three repaints, plus the one at boot.
    expect(APP.split('_paintUserRole();').length - 1).toBe(4);
    // Each assignment of State.context is followed by a repaint before the
    // next one begins.
    const writes = APP.split('currentClubRole:').slice(1);
    expect(writes.length).toBe(3);
    for (const w of writes) {
      expect(w.slice(0, 400)).toContain('_paintUserRole();');
    }
  });

  it('changes no authorization gate — this is a label, not a permission', () => {
    // The client-side convenience gates still read the account role exactly as
    // they did; changing them would alter behaviour, and the server is what
    // enforces any of it in any case.
    expect(APP).toContain("['CLUB_ADMIN','HEAD_COACH','SUPER_ADMIN'].includes(State.user && State.user.role)");
    const display = between(APP, '* The role to PRINT', 'const _ROLE_RANK');
    expect(display).toMatch(/None of them decides what anybody may do/);
    // _displayRole, _strongestRole and _paintUserRole write text and nothing
    // else — no fetch, no navigation, no permission check downstream.
    const block = between(APP, '* The role to PRINT', 'function _accessibleClubs');
    expect(block).not.toMatch(/fetch\(|FamilistaAPI\.|navTo|location\./);
  });

  it('and follows the club when the club is switched, not the account', () => {
    // Switching club switches which membership is authoritative.
    expect(APP).toMatch(/currentClubRole: \(_ctx && _ctx\.currentClubRole\) \|\| null,/);
    // Switching TEAM does not change the club, so the role is carried forward
    // rather than blanked.
    expect(APP).toMatch(/currentClubRole: \(_ctx && _ctx\.currentClubRole\)\s*\n\s*\|\| \(State\.context && State\.context\.currentClubRole\) \|\| null,/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Defence in depth
// ─────────────────────────────────────────────────────────────────────────────

describe('9 · the guard is unchanged, and the platform owner is unaffected', () => {
  it('2 · a club account reaching SYSTEM by URL is still refused by the server', async () => {
    // Not rendering the door does not replace the lock.
    for (const userId of ['u-president', 'u-admin', 'u-coach', 'u-multi']) {
      await expect(assertPlatformOwner({ userId, clubId: CLUB, role: 'CLUB_ADMIN' }))
        .rejects.toMatchObject({ statusCode: 403 });
    }
    // And the SYSTEM page itself still draws its own refusal for them.
    const system = read('public/system/system.js');
    expect(system).toContain("SY.who.isPlatformOwner === false");
    expect(system).toContain('sy-shell--denied');
  });

  it('9 · the platform owner still gets both doors, unchanged', () => {
    expect(PLATFORM_LAYOUT).toContain('FAMILISTA · OWNER CONTROL');
    expect(PLATFORM_LAYOUT).toContain('<div class="oh-card-title">SYSTEM</div>');
    expect(PLATFORM_LAYOUT).toContain('<div class="oh-card-title">CLUBS</div>');
    expect(PLATFORM_LAYOUT).toContain('data-page="clubs"');
    expect(PLATFORM_LAYOUT).toContain('Enter system area');
  });

  it('and nothing about the SYSTEM routes moved', () => {
    const routes = read('src/routes/system.routes.ts');
    expect(routes).toContain('router.use(authenticate)');
    const service = read('src/platform/system.service.ts');
    expect(service).toContain("throw new ForbiddenError('SYSTEM is the platform owner\\'s. A club membership does not reach it.')");
  });
});
