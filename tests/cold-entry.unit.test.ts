/**
 * tests/cold-entry.unit.test.ts
 *
 * A fresh session: login → Clubs → a club → Coach Market as the first module
 * opened. Two separate faults made that path worse than the same path walked
 * second, and both are pinned here.
 *
 * The 500. The HTTP server starts listening before connectDatabase() resolves,
 * so Render's port scan passes without waiting on the database. A request
 * landing inside that gap throws a Prisma initialization error, or a P2024 when
 * the pool has not filled yet. The error handler mapped only P2002 and P2025,
 * so everything else fell through to the catch-all and the login screen was
 * told the server had failed. It has not failed; it is not ready. That is a
 * 503, and the status is the fix — not a retry wrapped around a fault.
 *
 * The cold board. Opening a club fires the whole workspace's hydration, and
 * Coach Market's population read used to start only on the click, joining the
 * back of that queue. It now starts when the club context lands, and the
 * module's own load is split: A paints the board, B fills the intelligence
 * around it as each part arrives.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import type { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../src/middleware/error.middleware';

const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');

function appFn(name: string, until: string) {
  return APP.slice(APP.indexOf(`function ${name}`), APP.indexOf(`function ${until}`));
}

function mockRes() {
  const r: Record<string, unknown> = {};
  const sent: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
  r.status = (s: number) => { sent.status = s; return r; };
  r.header = (k: string, v: string) => { sent.headers[k] = v; return r; };
  r.json = (b: unknown) => { sent.body = b; return r; };
  return { res: r as unknown as Response, sent };
}

const REQ = { path: '/api/v1/auth/login', method: 'POST' } as unknown as Request;
const NEXT = (() => undefined) as unknown as NextFunction;

describe('a request that lands before the database is reachable', () => {
  it('is answered 503, not 500, when Prisma has not initialised', () => {
    const err = new Prisma.PrismaClientInitializationError(
      "Can't reach database server at db:5432", '5.22.0', 'P1001'
    );
    const { res, sent } = mockRes();
    errorHandler(err as unknown as Error, REQ, res, NEXT);
    expect(sent.status).toBe(503);
    expect(sent.headers['Retry-After']).toBe('2');
  });

  it('and 503 when the connection pool has not filled yet', () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      'Timed out fetching a new connection from the connection pool',
      { code: 'P2024', clientVersion: '5.22.0' }
    );
    const { res, sent } = mockRes();
    errorHandler(err as unknown as Error, REQ, res, NEXT);
    expect(sent.status).toBe(503);
    expect(sent.headers['X-Error-Code']).toBe('P2024');
  });

  it('every unreachable-database code is covered, not just the one seen', () => {
    ['P1000', 'P1001', 'P1002', 'P1008', 'P1017', 'P2024'].forEach((code) => {
      const err = new Prisma.PrismaClientKnownRequestError('down', { code, clientVersion: '5.22.0' });
      const { res, sent } = mockRes();
      errorHandler(err as unknown as Error, REQ, res, NEXT);
      expect(sent.status).toBe(503);
    });
  });

  it('but a genuine fault is still a 500 — the mapping is narrow', () => {
    const { res, sent } = mockRes();
    errorHandler(new TypeError('x is not a function'), REQ, res, NEXT);
    expect(sent.status).toBe(500);
  });

  it('and the errors that already had a status keep it', () => {
    const dup = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5.22.0' });
    const { res: r1, sent: s1 } = mockRes();
    errorHandler(dup as unknown as Error, REQ, r1, NEXT);
    expect(s1.status).toBe(409);

    const gone = new Prisma.PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: '5.22.0' });
    const { res: r2, sent: s2 } = mockRes();
    errorHandler(gone as unknown as Error, REQ, r2, NEXT);
    expect(s2.status).toBe(404);
  });

  it('the 503 body says what is true and the password never reaches the log', () => {
    const err = new Prisma.PrismaClientInitializationError('down', '5.22.0', 'P1001');
    const { res, sent } = mockRes();
    errorHandler(err as unknown as Error, REQ, res, NEXT);
    expect(sent.body).toMatchObject({ success: false });
    expect(String((sent.body as { message: string }).message)).toMatch(/starting up/i);
    const h = readFileSync(join(__dirname, '..', 'src', 'middleware', 'error.middleware.ts'), 'utf8');
    expect(h).not.toContain('body: req.body');
  });
});

describe('the Clubs picker offers only clubs that exist', () => {
  const picker = APP.slice(APP.indexOf('function renderClubs()'), APP.indexOf('function renderClubHomeHTML'));

  it('it never invents one while the context is still loading', () => {
    // the literal id that used to be handed out, and the 400 that followed it
    expect(picker).not.toMatch(/id:\s*\(?\s*club\.id\s*\|\|\s*'fc-familista'/);
    expect(picker).not.toMatch(/name:\s*club\.name\s*\|\|\s*'FC Familista'/);
    // a card is drawn from availableClubs, or from a club that has a real id
    expect(picker).toContain('const clubs = available.length');
    expect(picker).toContain('club && club.id');
    expect(picker).toContain(': []);');
  });

  it('and says so, rather than showing an empty grid as if there were none', () => {
    expect(picker).toContain('!clubs.length && !hydrated');
    expect(picker).toContain('cp-pending');
    expect(CSS).toContain('.cp-pending');
  });

  it('and repaints itself the moment the context answers', () => {
    const l = APP.slice(APP.indexOf('async function load()'), APP.indexOf('async function loadTeams()'));
    expect(l).toContain("document.getElementById('clubs-picker-content')");
    expect(l).toContain('renderClubs()');
  });

  it('entering a club refuses an id the server never issued', () => {
    const f = APP.slice(APP.indexOf('function openClub(clubId)'), APP.indexOf('function openClub(clubId)') + 1800);
    expect(f).toMatch(/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
    // and it refuses before it rewrites the session's scope
    expect(f.search(/\[0-9a-f\]\{8\}/)).toBeLessThan(f.indexOf('State.context.clubId = clubId'));
  });
});

describe('the club a module reads against is the club that was picked', () => {
  it('the readiness promise is published before the server is asked', () => {
    // The gate moved out of switchClub and into the shared club shell, where it
    // is opened as the club is picked — earlier than this, and shared with the
    // rest of the workspace. See tests/workspace-hydration.unit.test.ts.
    const s = APP.slice(APP.indexOf('async function switchClub('), APP.indexOf('async function switchTeam('));
    expect(s).toContain('_famClubSwitchBegin(clubId);');
    expect(s.indexOf('_famClubSwitchBegin')).toBeLessThan(s.indexOf("post('/me/context'"));
    // closed once the server is answering as the new club, and on failure too,
    // so nothing waiting on it can hang
    expect(s.indexOf('_famClubSwitchEnd(true)')).toBeGreaterThan(s.indexOf("post('/me/context'"));
    expect(s).toContain('_famClubSwitchEnd(false)');
    const b = APP.slice(APP.indexOf('function _famClubSwitchBegin('), APP.indexOf('function _famClubSwitchEnd('));
    expect(b).toContain('window.__famClubReady = new Promise(');
    expect(b).toContain('window.__famClubReadyFor = clubId;');
  });

  it('and Coach Market awaits it instead of racing it', () => {
    const f = appFn('_famClubReady', '_famClubSwitchBegin');
    expect(f).toContain('w.__famClubReadyFor === want');
    // no club switch in flight is not a reason to wait
    expect(f).toContain('return Promise.resolve(true);');
    // and the module reads that one gate rather than keeping its own copy
    expect(APP.slice(APP.indexOf('function _stClubReady()'),
                     APP.indexOf('function _stClubReady()') + 120)).toContain('_famClubReady()');
  });
});

describe('the cold board paints from what is already in flight', () => {
  it('the club switch starts the population read, not the click', () => {
    const s = APP.slice(APP.indexOf('async function switchClub('), APP.indexOf('async function switchClub(') + 8000);
    const started = s.indexOf('_stPrefetch()');
    expect(started).toBeGreaterThan(-1);
    // before the roster, not after the workspace's forty requests
    expect(started).toBeLessThan(s.indexOf('await loadTeams()'));
  });

  it('the prefetch takes its own slot so the module still loads its own tiers', () => {
    const p = appFn('_stPrefetch', '_stRevalidate');
    expect(p).toContain('if (_stCacheWarm() || _ST_CACHE.inflight || _ST_CACHE.pre) return;');
    expect(p).toContain('_ST_CACHE.pre =');
    // it must not occupy inflight — _stSyncAll would join it and never load B
    expect(p).not.toContain('_ST_CACHE.inflight =');
    // a switch that happened while it was open throws the answer away
    expect(p).toContain('if (gen !== _stGen) return;');
    // one request
    expect((p.match(/_stApi\(/g) || []).length).toBe(1);
  });

  it('and the module joins that read rather than repeating it', () => {
    const s = appFn('_stSyncAll', '_stRevalidate');
    expect(s).toContain('_ST_CACHE.pre.then(paint)');
    expect(s).toContain('if (_stCacheWarm()) { paint(); return; }');
  });

  it('A paints the board and B repaints as each part lands', () => {
    const s = appFn('_stSyncAll', '_stRevalidate');
    // B is five reads, each painting on arrival and each surviving its own failure
    ['_stLoadClubs()', '_stLoadNeeds()', '_stLoadActivity()', '_stLoadShortlist()', '_stLoadGap()']
      .forEach((q) => expect(s).toContain(q));
    expect(s).toContain('.map(function (q) { return q.then(paint, function () {}); })');
    // the board is never waited on behind B
    expect(s.indexOf('_stLoadPopulation()')).toBeLessThan(s.indexOf('_stLoadClubs()'));
    // and nothing paints into a module that is not open
    expect(s).toContain("if (!document.getElementById('cm-board')) return;");
  });

  it('leaving a club drops the prefetch with the rest of the club-scoped state', () => {
    const f = appFn('_stResetClubScoped', '_thResetRoster');
    expect(f).toContain('_ST_CACHE.pre = null;');
  });
});

describe('no module loads another module\'s data', () => {
  it('the player market no longer reads the staff market on the way past', () => {
    const f = APP.slice(APP.indexOf('async function _tfSyncAllNow()'), APP.indexOf('window._tfSyncAll'));
    expect(f).not.toContain('_stSyncAll()');
    // and the player market's own reads are untouched
    ['_tfSyncServerMarket()', '_tfSyncMyListings()', '_tfSyncBalance()', '_tfNotifLoad()',
     '_tfScoutLoadShortlist()', '_tfDeskLoad()', '_tfNegLoadNeeds()', '_tfNegLoadActivity()', '_tfAucLoad()']
      .forEach((q) => expect(f).toContain(q));
  });

  it('and nothing the Transfers page draws came from the staff market', () => {
    // This is the load-bearing check for the line above: if any Transfers
    // renderer read the staff market's state, dropping that read would have
    // emptied the Transfers page. Every _tf* function is walked; the only one
    // allowed to touch _TF_ST is the delegated click handler both boards share.
    const touching: string[] = [];
    const re = /function (_tf\w+|renderTransfersPage)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(APP))) {
      let i = APP.indexOf('{', m.index + m[0].length - 1);
      let depth = 0, j = i;
      for (; j < APP.length; j++) {
        if (APP[j] === '{') depth++;
        else if (APP[j] === '}' && --depth === 0) break;
      }
      if (APP.slice(i, j).includes('_TF_ST')) touching.push(m[1]);
    }
    expect(touching).toEqual(['_tfWire']);
  });
});

describe('no module calls another origin', () => {
  it('the squad reads the API this page was served from', () => {
    const line = APP.slice(APP.indexOf('const SQUAD_API_BASE ='), APP.indexOf('const SQUAD_API_BASE =') + 200);
    expect(line).toContain('FAM_CONFIG.API_BASE');
    expect(line).not.toContain('onrender.com');
  });

  it('and every API base is derived from the one config, never written flat', () => {
    // A host written straight into a base means that module talks to production
    // from wherever it is served — which is what made 30 requests per club entry
    // fail cross-origin. A host inside FAM_CONFIG's own inference, or as the
    // fallback when FAM_CONFIG is not there yet, is that config doing its job.
    const bases = APP.match(/const [A-Z_]*API_BASE\s*=[\s\S]{0,220}?;/g) || [];
    expect(bases.length).toBeGreaterThan(0);
    bases.forEach((b) => {
      expect(b).toContain('FAM_CONFIG');
      expect(b).not.toMatch(/=\s*'https:\/\//);
    });
  });
});
