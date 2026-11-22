/**
 * Design Studio, DS-1b — the room's server client, public/product-design/pd-server.js.
 *
 * The one file of the room that talks to the API. What it may do is small and
 * is pinned here: it calls only the platform owner's design routes, only with
 * GET and POST, sends JSON with the session the way every owner room does, and
 * never throws — a failure is an answer the editor can show. Every path it
 * calls is a route the server actually has. The record it keeps in this browser
 * (which saved design the draft belongs to) is read strictly: a malformed or
 * tampered record is ignored, never trusted, and storage that throws is survived.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'public/product-design/pd-server.js');
const SRC = fs.readFileSync(FILE, 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const ROUTES = fs.readFileSync(path.join(ROOT, 'src/routes/product-design.routes.ts'), 'utf8');

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A fresh copy of the client against a fake window: its fetch and its storage are ours to inspect. */
function load(opts: { token?: string; storage?: Row | null; fetch?: (url: string, init: Row) => Promise<unknown> } = {}) {
  const calls: Array<{ url: string; init: Row }> = [];
  const store: Record<string, string> = {};
  const storage = opts.storage === null ? null : opts.storage ?? {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  };
  const win: Row = {
    localStorage: storage,
    fetch: (url: string, init: Row) => {
      calls.push({ url, init });
      return opts.fetch ? opts.fetch(url, init) : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: { ok: 1 } }) });
    },
  };
  if (opts.token) win.State = { token: opts.token };
  // eslint-disable-next-line no-new-func
  const factory = new Function('module', 'window', `${SRC}\nreturn module.exports;`);
  const mod = { exports: {} as Row };
  // The UMD wrapper takes `window` as its root when there is one; give it ours by evaluating with module present.
  const api = factory(mod, win);
  return { P: api as Row, calls, store, win };
}

describe('what it may call', () => {
  it('has one fetch, to the API base plus the design routes, and no other transport', () => {
    expect((CODE.match(/fetch\(/g) || []).length).toBe(1);
    expect(CODE).toContain("root.fetch(apiBase() + BASE + path, init)");
    expect(CODE).toContain("var BASE = '/system/product-design';");
    expect(CODE).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|\.submit\(|<form|document\.|innerHTML|eval\(/);
    const verbs = [...CODE.matchAll(/call\('([A-Z]+)'/g)].map((m) => m[1]);
    expect([...new Set(verbs)].sort()).toEqual(['GET', 'POST']);
  });

  it('sends JSON with the session as every owner room does, never cached', async () => {
    const { P, calls } = load({ token: 'tkn' });
    await P.api.saveRevision('11111111-1111-4111-8111-111111111111', 3, { name: 'x' });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('/api/v1/system/product-design/projects/11111111-1111-4111-8111-111111111111/revisions');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', cache: 'no-store' });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tkn', 'Content-Type': 'application/json', Accept: 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ baseRevision: 3, document: { name: 'x' } });
    await P.api.listProjects('archived');
    expect(calls[1].init.body).toBeUndefined();
    expect(calls[1].init.headers['Content-Type']).toBeUndefined();
  });

  it('every path it calls is a route the server has, with the verb the server has', async () => {
    const served = [...ROUTES.matchAll(/router\.(get|post)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort();
    const { P, calls } = load();
    const id = '11111111-1111-4111-8111-111111111111';
    await P.api.listProjects('active'); await P.api.createProject({}, 'EDITOR'); await P.api.openProject(id);
    await P.api.saveRevision(id, 1, {}); await P.api.listRevisions(id); await P.api.restoreRevision(id, 2, 5);
    await P.api.archive(id); await P.api.unarchive(id); await P.api.getRevision(id, 3);
    const used = calls.map((c) => `${c.init.method} ${c.url.replace('/api/v1/system/product-design', '').replace(/\?.*$/, '').replace(id, ':id').replace(/\/revisions\/2\//, '/revisions/:number/').replace(/\/revisions\/3$/, '/revisions/:number')}`).sort();
    // DS-1c: the room now calls every route, the single-version read included (the 3D comparison, read only).
    expect([...new Set(used)].sort()).toEqual(served);
    expect(calls[calls.length - 1].init).toMatchObject({ method: 'GET' });
    expect(calls[calls.length - 1].init.body).toBeUndefined();
  });

  it('names only an origin the server accepts, and refuses to send any other', async () => {
    const { P, calls } = load();
    await P.api.createProject({}, 'BROWSER_DRAFT');
    await P.api.createProject({}, 'SOMETHING_ELSE');
    expect(calls.map((c) => JSON.parse(c.init.body).origin)).toEqual(['BROWSER_DRAFT', 'EDITOR']);
    expect(ROUTES).toContain("origin: z.enum(['EDITOR', 'FILE_IMPORT', 'BROWSER_DRAFT'])");
  });
});

describe('it never throws: a failure is an answer', () => {
  it('a conflict carries its code and the head it lost to', async () => {
    const { P } = load({ fetch: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ success: false, code: 'DESIGN_REVISION_CONFLICT', message: 'm', data: { headRevision: 7 } }) }) });
    const r = await P.api.saveRevision('11111111-1111-4111-8111-111111111111', 6, {});
    expect(r).toEqual({ ok: false, status: 409, code: 'DESIGN_REVISION_CONFLICT', data: { headRevision: 7 }, message: 'm', errors: [] });
  });
  it('an unreachable server answers status 0 and NETWORK', async () => {
    const { P } = load({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    expect(await P.api.listProjects()).toMatchObject({ ok: false, status: 0, code: 'NETWORK', data: null });
  });
  it('a body that is not JSON, or a 200 that says success: false, is not taken for success', async () => {
    const html = load({ fetch: () => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError('html')) }) });
    expect(await html.P.api.listProjects()).toMatchObject({ ok: false, status: 502, code: null, data: null });
    const lying = load({ fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: false, data: { projects: [] } }) }) });
    expect((await lying.P.api.listProjects()).ok).toBe(false);
  });
  it('a project id is always encoded into the path, never spliced in raw', async () => {
    const { P, calls } = load();
    await P.api.openProject('../../auth/me?x=1');
    expect(calls[0].url).toBe('/api/v1/system/product-design/projects/..%2F..%2Fauth%2Fme%3Fx%3D1');
  });
});

describe('the record of which saved design the draft belongs to', () => {
  const good = { projectId: '11111111-1111-4111-8111-111111111111', revision: 4, fp: '0a1b2c3d' };

  it('round-trips a well-formed record and clears it', () => {
    const { P, store } = load();
    expect(P.readLink()).toBeNull();
    expect(P.writeLink(good)).toBe(true);
    expect(JSON.parse(store[P.LINK_KEY])).toEqual(good);
    expect(P.readLink()).toEqual(good);
    P.clearLink();
    expect(P.readLink()).toBeNull();
  });

  it.each([
    ['not JSON', '{oops'],
    ['not a uuid', JSON.stringify({ ...good, projectId: 'p1' })],
    ['a revision of 0', JSON.stringify({ ...good, revision: 0 })],
    ['a fractional revision', JSON.stringify({ ...good, revision: 1.5 })],
    ['a revision as text', JSON.stringify({ ...good, revision: '4' })],
    ['a fingerprint of the wrong shape', JSON.stringify({ ...good, fp: 'xyz' })],
    ['an array', '[1,2]'],
  ])('ignores %s', (_n, raw) => {
    const { P, store } = load();
    store[P.LINK_KEY] = raw;
    expect(P.readLink()).toBeNull();
  });

  it('keeps only the three fields it knows, whatever else was stored', () => {
    const { P, store } = load();
    store[P.LINK_KEY] = JSON.stringify({ ...good, ownerKind: 'CLUB', clubId: 'c1' });
    expect(P.readLink()).toEqual(good);
  });

  it('survives storage that is missing or throws', () => {
    expect(load({ storage: null }).P.readLink()).toBeNull();
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    const { P } = load({ storage: throwing });
    expect(P.readLink()).toBeNull();
    expect(P.writeLink(good)).toBe(false);
    expect(() => P.clearLink()).not.toThrow();
  });

  it('keeps its own key, separate from the DS-1a draft, which it never touches', () => {
    expect(CODE).toContain("var LINK_KEY = 'familista_product_design_link_v1';");
    expect(CODE).not.toContain('familista_product_design_draft_v1');
  });
});

describe('the fingerprint that tells saved from unsaved', () => {
  it('is eight hex digits, the same for the same text and different for a one-character change', () => {
    const { P } = load();
    const a = P.fingerprint('{"name":"Home kit"}\n');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(P.fingerprint('{"name":"Home kit"}\n')).toBe(a);
    expect(P.fingerprint('{"name":"Home kiT"}\n')).not.toBe(a);
    expect(P.fingerprint('')).toBe('811c9dc5');
  });
});
