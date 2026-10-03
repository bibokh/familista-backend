/**
 * tests/db-context.unit.test.ts
 *
 * Cyber Defense, R14 — the application side of the row-level security pilot,
 * without a database (tests/rls-pilot.integration.test.ts has one):
 *
 *   - DB_RLS_CONTEXT off (default) leaves the exported client the plain one
 *   - a context is per async flow, and the system path must be named
 *   - no context is never "system": it maps to settings the database refuses
 *   - observe mode passes queries through and reports a missing context once
 */

import {
  currentDbContext, dbSettings, RLS_PILOT_MODELS, rlsContextMode, runAsSystem, runInClubContext,
} from '../src/security/db-context';

describe('the mode switch', () => {
  it('is off unless explicitly observe or on', () => {
    expect(rlsContextMode({})).toBe('off');
    expect(rlsContextMode({ DB_RLS_CONTEXT: 'ON' })).toBe('on');
    expect(rlsContextMode({ DB_RLS_CONTEXT: ' observe ' })).toBe('observe');
    for (const v of ['true', '1', 'enforce', '']) expect(rlsContextMode({ DB_RLS_CONTEXT: v })).toBe('off');
  });

  const load = (value: string | undefined) => {
    let out: { prisma: unknown; base: unknown } = { prisma: null, base: null };
    jest.isolateModules(() => {
      const saved = process.env.DB_RLS_CONTEXT;
      if (value === undefined) delete process.env.DB_RLS_CONTEXT; else process.env.DB_RLS_CONTEXT = value;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { prisma } = require('../src/config/database');
        out = { prisma, base: (global as unknown as { __prisma: unknown }).__prisma };
      } finally {
        if (saved === undefined) delete process.env.DB_RLS_CONTEXT; else process.env.DB_RLS_CONTEXT = saved;
      }
    });
    return out;
  };

  it('with it off, the application client is the very same plain client — nothing changes', () => {
    const { prisma, base } = load(undefined);
    expect(base).toBeTruthy();
    expect(prisma).toBe(base);
  });

  it('with it on, the application client is the context-carrying wrapper around that client', () => {
    const { prisma, base } = load('on');
    expect(prisma).not.toBe(base);
    expect(typeof (prisma as { $transaction: unknown }).$transaction).toBe('function');
  });
});

describe('the context', () => {
  it('belongs to the async flow that set it, and is gone outside it', async () => {
    expect(currentDbContext()).toBeUndefined();
    const seen = await runInClubContext('club-a', 'user-a', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentDbContext();
    });
    expect(seen).toEqual({ mode: 'club', clubId: 'club-a', userId: 'user-a' });
    expect(currentDbContext()).toBeUndefined();
  });

  it('two concurrent requests do not see each other\'s club', async () => {
    const [a, b] = await Promise.all([
      runInClubContext('club-a', 'u1', async () => { await new Promise((r) => setTimeout(r, 5)); return currentDbContext(); }),
      runInClubContext('club-b', 'u2', async () => { await new Promise((r) => setTimeout(r, 1)); return currentDbContext(); }),
    ]);
    expect(a).toMatchObject({ clubId: 'club-a' });
    expect(b).toMatchObject({ clubId: 'club-b' });
  });

  it('the system path must be named with a literal reason', () => {
    expect(runAsSystem('transfer-settlement', () => currentDbContext())).toEqual({ mode: 'system', reason: 'transfer-settlement' });
    for (const bad of ['', 'x', 'Transfer Settlement', 'a'.repeat(80), '../x']) {
      expect(() => runAsSystem(bad, () => 0)).toThrow(/literal reason/);
    }
  });

  it('no context and a club without a club id map to settings the database refuses', () => {
    expect(dbSettings(undefined)).toEqual({ mode: '', clubId: '' });
    expect(dbSettings({ mode: 'club', clubId: null })).toEqual({ mode: 'club', clubId: '' });
    expect(dbSettings({ mode: 'club', clubId: 'c1' })).toEqual({ mode: 'club', clubId: 'c1' });
    expect(dbSettings({ mode: 'system', reason: 'video-transcode' })).toEqual({ mode: 'system', clubId: '' });
  });

  it('pilots exactly the four tables the migration protects', () => {
    expect([...RLS_PILOT_MODELS].sort()).toEqual(['Membership', 'Player', 'PlayerInjury', 'VideoAsset']);
  });
});

describe('observe mode', () => {
  it('passes every query through untouched and reports a missing context once per model and operation', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { withRlsContext } = require('../src/security/rls-client');
    const calls: string[] = [];
    const base = {
      $extends: (ext: { query: { $allModels: { $allOperations: (a: unknown) => Promise<unknown> } } }) => {
        const op = ext.query.$allModels.$allOperations;
        const model = (name: string) => ({ count: () => op({ model: name, operation: 'count', args: {}, query: async () => { calls.push(name); return 7; } }) });
        return { playerInjury: model('PlayerInjury'), team: model('Team') };
      },
      $transaction: () => { throw new Error('observe never opens a transaction'); },
    };
    const reported = jest.fn();
    const client = withRlsContext(base, 'observe', reported);
    expect(await client.playerInjury.count()).toBe(7);
    expect(await client.playerInjury.count()).toBe(7);
    expect(await client.team.count()).toBe(7);
    expect(await runInClubContext('c1', 'u1', async () => await client.playerInjury.count())).toBe(7);
    expect(calls).toEqual(['PlayerInjury', 'PlayerInjury', 'Team', 'PlayerInjury']);
    expect(reported).toHaveBeenCalledTimes(1);
    expect(reported).toHaveBeenCalledWith('PlayerInjury', 'count');
  });
});
