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
      return opts.fetch ? opts.fetch(url, init) : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: { ok: 1 } }), blob: () => Promise.resolve('') });
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
    expect(CODE).toContain("root.fetch(apiBase() + base + path, init)");
    expect(CODE).toContain("var BASE = '/system/product-design';");
    expect(CODE).toContain("var CLUB_BASE = '/club-design';");
    expect(CODE).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|\.submit\(|<form|document\.|innerHTML|eval\(/);
    const verbs = [...CODE.matchAll(/call\('([A-Z]+)'/g)].map((m) => m[1]);
    // PUT is a club's brand colours (M2c), a roster's save (M3a) and a collection's (M3b); DELETE erases a roster or a
    // collection, and nothing else.
    expect([...new Set(verbs)].sort()).toEqual(['DELETE', 'GET', 'POST', 'PUT']);
    // M4: the Platform Owner's console saves a supplier (PUT) and discards a draft quotation (DELETE).
    expect([...CODE.matchAll(/call\('PUT', '([^']+)'/g)].map((m) => m[1])).toEqual(['/privacy/retention', '/rollout/', '/brand-kit/colours', '/rosters/', '/collections/', '/suppliers/']);
    expect([...CODE.matchAll(/call\('DELETE', '([^']+)'/g)].map((m) => m[1])).toEqual(['/rosters/', '/collections/', '/requests/']);
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
    const served = [...ROUTES.matchAll(/router\.(get|post|put)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort();
    const { P, calls } = load();
    const id = '11111111-1111-4111-8111-111111111111';
    await P.api.listProjects('active'); await P.api.createProject({}, 'EDITOR'); await P.api.openProject(id);
    await P.api.saveRevision(id, 1, {}); await P.api.listRevisions(id); await P.api.restoreRevision(id, 2, 5);
    // M8a: the Owner's rollout control, on the platform's client alone; a club id that is not one is never sent.
    await P.api.rollout(); await P.api.setRollout('club-1', { studio: 'on' });
    // P1: the retention rules, none set by default.
    await P.api.retention(); await P.api.setRetention('DesignReviewComment', 30); await P.api.applyRetention(true);
    // P2: the Creator Studio's accounts and the invitations that are the only way in.
    await P.api.creators(); await P.api.creatorInvites(); await P.api.createCreatorInvite({ email: 'a@example.com' }); await P.api.revokeCreatorInvite(id);
    expect((await P.api.setRollout('../x', { studio: 'on' })).code).toBe('BAD_CLUB');
    expect(P.forWorkspace({ kind: 'CLUB', clubId: 'club-1' }).api.rollout).toBeUndefined();
    await P.api.archive(id); await P.api.unarchive(id); await P.api.getRevision(id, 3);
    const used = calls.map((c) => `${c.init.method} ${c.url.replace('/api/v1/system/product-design', '').replace(/\?.*$/, '').replace('/rollout/club-1', '/rollout/:clubId').replace(id, ':id').replace(/\/revisions\/2\//, '/revisions/:number/').replace(/\/revisions\/3$/, '/revisions/:number').replace(/\/invites\/:id\//, '/invites/:inviteId/')}`).sort();
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
    // The schema is the handlers' own, shared by the platform's mount and a club's (src/platform/product-design/http.ts).
    expect(fs.readFileSync(path.join(ROOT, 'src/platform/product-design/http.ts'), 'utf8')).toContain("origin: z.enum(['EDITOR', 'FILE_IMPORT', 'BROWSER_DRAFT'])");
  });
});

describe('in a club (M2): the club’s own routes, and a record of its own', () => {
  const CLUB_ROUTES = fs.readFileSync(path.join(ROOT, 'src/routes/club-design.routes.ts'), 'utf8');
  const id = '11111111-1111-4111-8111-111111111111';

  it('calls the club mount, every path a route it serves with its verb, and names no club in any request', async () => {
    const served = [...CLUB_ROUTES.matchAll(/router\.(get|post|put|delete)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort();
    const { P, calls } = load({ token: 'tkn' });
    const C = P.forWorkspace({ kind: 'CLUB', clubId: 'club-1' });
    await C.api.listProjects('active'); await C.api.createProject({}, 'EDITOR'); await C.api.openProject(id);
    await C.api.saveRevision(id, 1, {}); await C.api.listRevisions(id); await C.api.restoreRevision(id, 2, 5);
    await C.api.archive(id); await C.api.unarchive(id); await C.api.getRevision(id, 3);
    // M2c: the brand kit, every route of it.
    await C.api.brandKit('active'); await C.api.saveBrandColours([]); await C.api.uploadBrandAsset('CREST', 'Home crest', { type: 'image/png' });
    await C.api.brandAssetImage(id); await C.api.archiveBrandAsset(id); await C.api.unarchiveBrandAsset(id);
    // M3: the team rosters and the squad's names, every route of them.
    await C.api.listRosters('active'); await C.api.createRoster('First team', []); await C.api.openRoster(id);
    await C.api.saveRoster(id, 3, 'First team', []); await C.api.archiveRoster(id); await C.api.unarchiveRoster(id);
    await C.api.deleteRoster(id); await C.api.squadNames();
    // P1: a club administrator erases a person's name (previewed unless confirmed).
    await C.api.erasePerson('A Name', false);
    // M3b: the collections and their order sheet, every route of them.
    const kit = { name: 'Home kit', season: null, rosterId: null, items: [] };
    await C.api.listCollections('active'); await C.api.createCollection(kit); await C.api.openCollection(id);
    await C.api.saveCollection(id, 2, kit); await C.api.archiveCollection(id); await C.api.unarchiveCollection(id);
    await C.api.deleteCollection(id); await C.api.orderSheet(id, id);
    // M4: the club's requests for quotation, every route of them.
    await C.api.submitRequest(id, { rosterId: null }); await C.api.listRequests(); await C.api.openRequest(id);
    await C.api.cancelRequest(id); await C.api.declineQuotes(id); await C.api.confirmDelivery(id); await C.api.acceptQuote(id, id);
    // M7b: a design's review, every route of it (the comment id is another id, so its place in the path is checked).
    const cid = '22222222-2222-4222-8222-222222222222';
    await C.api.readReview(id); await C.api.commentOnDesign(id, { revision: 1, surface: 'back', body: 'Taller' });
    await C.api.resolveComment(id, cid); await C.api.reopenComment(id, cid); await C.api.decideOnDesign(id, { revision: 1, decision: 'APPROVED', note: null });
    expect(calls.every((c) => c.url.startsWith('/api/v1/club-design/'))).toBe(true);
    const used = calls.map((c) => `${c.init.method} ${c.url.replace('/api/v1/club-design', '').replace(/\?.*$/, '').replace(`/assets/${id}`, '/assets/:assetId').replace(`/rosters/${id}`, '/rosters/:rosterId').replace(`/collections/${id}`, '/collections/:collectionId').replace(`/requests/${id}/quotes/${id}`, '/requests/:requestId/quotes/:quoteId').replace(`/requests/${id}`, '/requests/:requestId').replace(`/comments/${cid}`, '/comments/:commentId').replace(id, ':id').replace(/\/revisions\/2\//, '/revisions/:number/').replace(/\/revisions\/3$/, '/revisions/:number')}`).sort();
    expect([...new Set(used)].sort()).toEqual(served);
    expect(calls.some((c) => c.url.includes('club-1') || String(c.init.body || '').includes('club-1'))).toBe(false);
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer tkn' });
  });

  it('the Platform Owner’s manufacturing console (M4) calls its own mount only, every path a route it serves with its verb', async () => {
    const MFG_ROUTES = fs.readFileSync(path.join(ROOT, 'src/routes/manufacturing.routes.ts'), 'utf8');
    const served = [...MFG_ROUTES.matchAll(/router\.(get|post|put|delete)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort();
    const { P, calls } = load({ token: 'tkn' });
    const M = P.manufacturing();
    expect(P.manufacturing()).toBe(M); // made once
    await M.listSuppliers(); await M.createSupplier({ name: 'X' }); await M.openSupplier(id); await M.saveSupplier(id, { version: 1 }); await M.setSupplierStatus(id, 'VERIFIED', 'checked it');
    await M.listRequests(); await M.listRequests('QUOTED'); await M.openRequest(id);
    for (const step of ['review', 'refuse', 'order', 'produce', 'ship', 'deliver']) await M.step(id, step, 'note');
    expect(await M.step(id, 'pay', 'note')).toMatchObject({ ok: false, code: 'BAD_STEP' }); // a step the server has no route for is never sent
    await M.recordQuote(id, {}); await M.publishQuote(id, id); await M.withdrawQuote(id, id, 'why'); await M.discardDraft(id, id); await M.specDesign(id, id); await M.requestFit(id);
    await M.productionSheet(id); await M.eraseNames(id, 'closed');
    expect(calls.every((c) => c.url.startsWith('/api/v1/system/manufacturing/'))).toBe(true);
    const used = calls.map((c) => `${c.init.method} ${c.url.replace('/api/v1/system/manufacturing', '').replace(/\?.*$/, '')
      .replace(`/quotes/${id}`, '/quotes/:quoteId').replace(`/designs/${id}`, '/designs/:projectId').replace(`/requests/${id}`, '/requests/:requestId').replace(`/suppliers/${id}`, '/suppliers/:supplierId')}`);
    expect([...new Set(used)].sort()).toEqual(served);
    // and the club's and the platform's design clients have none of it
    expect(P.api.listSuppliers).toBeUndefined();
    expect(P.forWorkspace({ kind: 'CLUB', clubId: 'club-1' }).api.recordQuote).toBeUndefined();
  });

  it('keeps each workspace’s record apart: the platform’s, this club’s and another club’s never overwrite each other', () => {
    const { P } = load();
    const A = P.forWorkspace({ kind: 'CLUB', clubId: 'club-1' }), B = P.forWorkspace({ kind: 'CLUB', clubId: 'club-2' });
    expect(new Set([P.LINK_KEY, A.LINK_KEY, B.LINK_KEY]).size).toBe(3);
    expect(P.forWorkspace({ kind: 'PLATFORM' })).toBe(P.forWorkspace(null));
    A.writeLink({ projectId: id, revision: 2, fp: '0123abcd' });
    expect(A.readLink()).toEqual({ projectId: id, revision: 2, fp: '0123abcd' });
    expect(B.readLink()).toBeNull();
    expect(P.readLink()).toBeNull();
    B.clearLink();
    expect(A.readLink()).not.toBeNull();
  });

  it('sends a logo as its own bytes with its image type, reads an image as bytes, and offers the brand kit to clubs alone', async () => {
    const { P, calls } = load({ token: 'tkn', fetch: (url: string) => Promise.resolve(url.endsWith('/image')
      ? { ok: true, status: 200, blob: () => Promise.resolve('PNG-BYTES'), json: () => Promise.reject(new Error('not json')) }
      : { ok: true, status: 201, json: () => Promise.resolve({ success: true, data: { asset: { id } } }) }) });
    const C = P.forWorkspace({ kind: 'CLUB', clubId: 'club-1' });
    const file = { type: 'image/jpeg', name: 'crest.jpg' };
    await C.api.uploadBrandAsset('CREST', 'Home & Away / crest', file);
    expect(calls[0].url).toBe('/api/v1/club-design/brand-kit/assets?kind=CREST&name=Home%20%26%20Away%20%2F%20crest');
    expect(calls[0].init.body).toBe(file);
    expect(calls[0].init.headers['Content-Type']).toBe('image/jpeg');
    await C.api.uploadBrandAsset('CREST', 'x', { type: 'image/svg+xml' });
    expect(calls[1].init.headers['Content-Type']).toBe('application/octet-stream'); // never an SVG type, whatever the file says
    const img = await C.api.brandAssetImage(id);
    expect(img).toMatchObject({ ok: true, blob: 'PNG-BYTES' });
    expect(calls[2].init.headers.Accept).toBe('image/png');
    expect(P.api.brandKit).toBeUndefined();
    expect(P.api.uploadBrandAsset).toBeUndefined();
  });

  it('refuses a workspace it does not know, rather than guess one', () => {
    const { P } = load();
    for (const w of [{ kind: 'CLUB' }, { kind: 'CLUB', clubId: '' }, { kind: 'CLUB', clubId: '../system' }, { kind: 'CLUB', clubId: 'a b' }, { kind: 'PERSONAL', userId: 'u' }]) {
      expect([w, P.forWorkspace(w)]).toEqual([w, null]);
    }
  });
});

describe('it never throws: a failure is an answer', () => {
  it('a conflict carries its code and the head it lost to', async () => {
    const { P } = load({ fetch: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ success: false, code: 'DESIGN_REVISION_CONFLICT', message: 'm', data: { headRevision: 7 } }) }) });
    const r = await P.api.saveRevision('11111111-1111-4111-8111-111111111111', 6, {});
    expect(r).toEqual({ ok: false, status: 409, code: 'DESIGN_REVISION_CONFLICT', data: { headRevision: 7 }, message: 'm', errors: [], reason: null });
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
