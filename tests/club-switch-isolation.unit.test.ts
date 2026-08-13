/**
 * tests/club-switch-isolation.unit.test.ts
 *
 * After a club switch, the previous club's data must not remain on screen —
 * not even when hydration of the new club fails.
 *
 * The switch path lives in public/app.js, the served SPA. The pieces that carry
 * this invariant are top-level functions there, so they are read out of the
 * file and exercised directly with injected globals — the same technique the
 * repository already uses to check built output, run under the existing jest
 * config with no new runner and no new dependency.
 */

import fs from 'fs';
import path from 'path';

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/** Pull one top-level `function name(...) { ... }` out of the SPA by brace matching. */
function extractFunction(name: string): string {
  const start = APP_JS.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in public/app.js`);
  let depth = 0, i = APP_JS.indexOf('{', start);
  const from = i;
  for (; i < APP_JS.length; i++) {
    if (APP_JS[i] === '{') depth++;
    else if (APP_JS[i] === '}') { depth--; if (depth === 0) break; }
  }
  return APP_JS.slice(start, i + 1) + `\n;return ${name};`;
}

type Bag = Record<string, unknown>;

/**
 * Run extracted functions against a State/_TH pair we control. `deps` are
 * defined in the same scope, because these functions call each other.
 */
function load(name: string, ctx: { State: Bag; _TH: Bag }, deps: string[] = []) {
  const src = deps.concat(name).map((n) => extractFunction(n).replace(/\n;return \w+;$/, '')).join('\n')
    + `\n;return ${name};`;
  const factory = new Function('State', '_TH', 'window', src);
  return factory(ctx.State, ctx._TH, { State: ctx.State }) as (...a: unknown[]) => unknown;
}

const CLUB_A = 'club-a';
const CLUB_B = 'club-b';

function stateForClubA(): Bag {
  return {
    // club-scoped — must not survive a switch
    players:      [{ id: 'p-a1', clubId: CLUB_A }, { id: 'p-a2', clubId: CLUB_A }],
    matches:      [{ id: 'm-a1' }],
    analytics:    { overview: { playerCount: 2 } },
    training:     [{ id: 't-a1' }],
    trainingForm: { form: 'A' },
    performanceTrend: [{ week: 1 }],
    // NOT club-scoped — must survive
    token:            'access-token',
    user:             { id: 'user-1', email: 'coach@example.test' },
    isDark:           true,
    sidebarCollapsed: true,
    backendHealthy:   true,
    context:          { clubId: CLUB_B, teamId: null, availableClubs: [{ id: CLUB_A }, { id: CLUB_B }] },
  };
}

function thForClubA(): Bag {
  return {
    state: 'ready',
    clubId: CLUB_A,
    teams: [{ id: 'team-a', clubId: CLUB_A }],
    byTeam: { 'team-a': [{ id: 'p-a1' }, { id: 'p-a2' }] },
    legacy: { 'sq-1': 'p-a1' },
  };
}

describe('club-scoped state is invalidated on switch', () => {
  it('clears every club-scoped field', () => {
    const ctx = { State: stateForClubA(), _TH: thForClubA() };
    load('_famClearClubScopedState', ctx, ['_thResetRoster'])();

    expect(ctx.State.players).toEqual([]);
    expect(ctx.State.matches).toEqual([]);
    expect(ctx.State.training).toEqual([]);
    expect(ctx.State.analytics).toBeNull();
    expect(ctx.State.trainingForm).toBeNull();
    expect(ctx.State.performanceTrend).toBeNull();
  });

  it('keeps identity, session and preferences', () => {
    const ctx = { State: stateForClubA(), _TH: thForClubA() };
    load('_famClearClubScopedState', ctx, ['_thResetRoster'])();

    expect(ctx.State.token).toBe('access-token');
    expect(ctx.State.user).toEqual({ id: 'user-1', email: 'coach@example.test' });
    expect(ctx.State.isDark).toBe(true);
    expect(ctx.State.sidebarCollapsed).toBe(true);
    expect(ctx.State.backendHealthy).toBe(true);
    expect((ctx.State.context as Bag).clubId).toBe(CLUB_B);
  });

  it('drops the previous club roster index as well', () => {
    const ctx = { State: stateForClubA(), _TH: thForClubA() };
    load('_famClearClubScopedState', ctx, ['_thResetRoster'])();

    expect(ctx._TH.byTeam).toEqual({});
    expect(ctx._TH.legacy).toEqual({});
    expect(ctx._TH.teams).toEqual([]);
    expect(ctx._TH.clubId).toBeNull();
  });

  it('leaves no club-A player reachable after the switch', () => {
    const ctx = { State: stateForClubA(), _TH: thForClubA() };
    load('_famClearClubScopedState', ctx, ['_thResetRoster'])();

    const everything = JSON.stringify({ State: ctx.State, _TH: ctx._TH });
    expect(everything).not.toContain('p-a1');
    expect(everything).not.toContain('p-a2');
    expect(everything).not.toContain('team-a');
  });
});

describe('a failed hydration cannot leave the previous club behind', () => {
  it('resets the roster index and does not claim the new club', () => {
    const ctx = { State: stateForClubA(), _TH: thForClubA() };
    (ctx.State as Bag).context = { clubId: CLUB_B };

    load('_thResetRoster', ctx)();

    expect(ctx._TH.byTeam).toEqual({});
    expect(ctx._TH.legacy).toEqual({});
    // The dangerous combination is the NEW clubId stamped on the OLD roster.
    expect(ctx._TH.clubId).not.toBe(CLUB_A);
    expect(JSON.stringify(ctx._TH)).not.toContain('p-a1');
  });
});

describe('required vs optional hydration', () => {
  const required = (settled: Array<{ status: string }>, trendOk: boolean) => {
    const ctx = { State: {} as Bag, _TH: {} as Bag };
    const fn = load('_famHydrationOutcome', ctx) as (s: unknown, t: unknown) => { ok: boolean; failed: string[] };
    return fn(settled, trendOk);
  };
  const OK = { status: 'fulfilled' }, BAD = { status: 'rejected' };

  it('is satisfied when the roster loaded', () => {
    // order: analytics, players, matches, tourns, training
    const out = required([OK, OK, OK, OK, OK], true);
    expect(out.ok).toBe(true);
    expect(out.failed).toEqual([]);
  });

  it('fails when the roster did not load', () => {
    const out = required([OK, BAD, OK, OK, OK], true);
    expect(out.ok).toBe(false);
    expect(out.failed).toContain('players');
  });

  it('treats analytics, training and the trend as optional', () => {
    const out = required([BAD, OK, OK, BAD, BAD], false);
    expect(out.ok).toBe(true);
    expect(out.failed).toEqual(expect.arrayContaining(['analytics', 'training', 'performance trend']));
  });
});
