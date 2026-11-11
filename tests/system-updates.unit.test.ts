/**
 * tests/system-updates.unit.test.ts
 *
 * Familista System Updates, and the Platform Owner navigation that reaches it.
 *
 *   1. The release record says only what it read: commits, a tag, the repository
 *      as "owner/name", and the deployment path as the repository's own lines.
 *      Never a remote URL (which can carry a credential), an e-mail, a body or an
 *      author; and "no history" is recorded as such, never invented.
 *   2. The view tells known from unknown: no record → NO_BUILD_RECORD; CI, the
 *      hosting provider and pull requests are NOT_CONNECTED, by design; approval
 *      counts are the registry's own.
 *   3. The API is owner-only on the server: anonymous 401, a club account 403,
 *      the owner 200 uncached and in contract; no verb but GET.
 *   4. The room keeps the owner-room rules: three catalogues with the same keys,
 *      every string it can show in them, no inline style or handler, nothing
 *      loaded from outside, only declared tokens, the escape hatch.
 *   5. The Platform Owner navigation is one list, drawn in the shell and in both
 *      rooms, owner-only, marking the open room, and hidden in a Club Workspace.
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://stub:stub@localhost:5432/stub';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);

const OWNER = {
  id: 'u-owner', email: 'owner@familista.test', role: 'SUPER_ADMIN', clubId: null, isActive: true,
  currentClubId: null, currentTeamId: null, tokenVersion: 0, platformAdmin: { isActive: true },
};
const MEMBER = {
  id: 'u-member', email: 'coach@club.test', role: 'COACH', clubId: 'c1', isActive: true,
  currentClubId: 'c1', currentTeamId: null, tokenVersion: 0, platformAdmin: null,
};
let CURRENT: typeof OWNER | typeof MEMBER = OWNER;

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$transaction') return async (fns: unknown) => (Array.isArray(fns) ? [] : (fns as (tx: unknown) => unknown)({}));
      if (k === '$connect' || k === '$disconnect') return async () => {};
      if (k === 'user') return { findFirst: async () => CURRENT, findUnique: async () => CURRENT, count: async () => 1 };
      return new Proxy({}, { get: (_x, op: string) => async () => (op === 'count' ? 0 : op === 'findFirst' || op === 'findUnique' ? null : []) });
    },
  }),
}));

import {
  composeReleaseRecord, repositorySlug, subjectOf, pullRequestOf, HISTORY_LIMIT, SUBJECT_LIMIT, DEPLOY_FILES,
  type GitReader,
} from '../src/platform/system-updates/release-record';
import { systemUpdates, loadReleaseRecord, resetReleaseRecordCache } from '../src/platform/system-updates/service';
import { DEPLOY_FACTS, UPDATE_REASONS, type ReleaseRecord } from '../src/platform/system-updates/model';
import { SystemUpdatesViewSchema } from '../src/contracts/owner-api.contracts';
import { algorithmsOverview } from '../src/algorithms/algorithms.service';
import { algorithmCandidates } from '../src/algorithms/candidates';
import { signToken } from '../src/security/jwt-tokens';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p: string) => JSON.parse(read(p));
const repoFile = (rel: string) => { try { return read(rel); } catch { return null; } };

const SHA = (c: string) => c.repeat(40).slice(0, 40);
const US = '\x1f', RS = '\x1e';
/** A git that answers like the real one, from a table; anything not in it fails, as a missing git would. */
function fakeGit(table: Record<string, string | null>): GitReader {
  return (args) => (Object.prototype.hasOwnProperty.call(table, args.join(' ')) ? table[args.join(' ')] : null);
}
const LOG = ['log', '-n', String(HISTORY_LIMIT), '--format=%H%x1f%cI%x1f%s%x1e', 'HEAD'].join(' ');
const historyOf = (rows: Array<[string, string, string]>) => rows.map((r) => r.join(US) + RS + '\n').join('');

describe('1. the release record says only what it read', () => {
  const git = fakeGit({
    'rev-parse HEAD': SHA('a') + '\n',
    [LOG]: historyOf([
      [SHA('a'), '2026-11-05T10:16:46+01:00', 'Client: a navigation\'s cancelled read is not a "Connection timeout" (#152)'],
      [SHA('b'), '2026-11-04T20:55:53+01:00', 'Twin, Phase 1 (#151)'],
      [SHA('c'), '2026-11-04T11:00:00+01:00', 'Fix by someone@example.com without a pull request'],
      ['not-a-sha', '2026-11-04T11:00:00+01:00', 'dropped: not a commit'],
    ]),
    'rev-parse --is-shallow-repository': 'true\n',
    'tag --points-at HEAD': '',
    'remote get-url origin': 'https://ci-user:not-a-real-credential@github.com/bibokh/familista-backend.git\n',
  });
  const r = composeReleaseRecord({ git, read: repoFile, env: {}, now: new Date('2026-11-05T10:20:00Z') });

  it('records the commit, the history with each pull request, and that the history is partial', () => {
    expect(r.commit).toBe(SHA('a'));
    expect(r.builtAt).toBe('2026-11-05T10:20:00.000Z');
    expect(r.history.state).toBe('RECORDED');
    if (r.history.state !== 'RECORDED') return;
    expect(r.history.shallow).toBe(true);
    expect(r.history.items.map((i) => [i.sha, i.pr])).toEqual([[SHA('a'), 152], [SHA('b'), 151], [SHA('c'), null]]);
    expect(r.history.items[0].date).toBe('2026-11-05T09:16:46.000Z');
  });
  it('keeps the repository as "owner/name" only: no URL, no credential', () => {
    expect(r.repository).toBe('bibokh/familista-backend');
    expect(JSON.stringify(r)).not.toMatch(/not-a-real-credential|ci-user|https?:\/\/|github\.com/);
    for (const [remote, want] of [
      ['git@github.com:bibokh/familista-backend.git', 'bibokh/familista-backend'],
      ['http://local_proxy@127.0.0.1:41093/git/bibokh/familista-backend', 'bibokh/familista-backend'],
      ['https://github.com/bibokh/familista-backend/', 'bibokh/familista-backend'],
      ['', null], [null, null], ['not a remote', null],
    ] as Array<[string | null, string | null]>) expect(repositorySlug(remote)).toBe(want);
  });
  it('masks an e-mail in a subject, keeps only the first line, and bounds its length', () => {
    if (r.history.state !== 'RECORDED') throw new Error('no history');
    expect(r.history.items[2].subject).toBe('Fix by … without a pull request');
    expect(JSON.stringify(r)).not.toMatch(/@example\.com/);
    expect(subjectOf('First line\n\nCo-Authored-By: A <a@b.co>')).toBe('First line');
    expect(subjectOf('x'.repeat(500)).length).toBe(SUBJECT_LIMIT);
    expect(pullRequestOf('Something (#12)')).toBe(12);
    expect(pullRequestOf('Something #12')).toBeNull();
  });
  it('reads the deployment path from this repository\'s own files, every fact with its line', () => {
    expect(r.deployPath.state).toBe('RECORDED');
    if (r.deployPath.state !== 'RECORDED') return;
    // the gate as configured today: a push deploys nothing; ci on main must succeed, for main's head; or a manual run
    expect(r.deployPath.facts.map((f) => f.fact).sort()).toEqual(
      ['AUTO_DEPLOY_OFF', 'DEPLOY_AFTER_CI', 'DEPLOY_MAIN_ONLY', 'DEPLOY_REQUIRES_HEAD', 'DEPLOY_REQUIRES_SUCCESS', 'MANUAL_DEPLOY']);
    for (const f of r.deployPath.facts) {
      const line = read(f.evidence.path).split(/\r?\n/)[f.evidence.line - 1];
      expect({ fact: f.fact, line: line.trim().length > 0 }).toEqual({ fact: f.fact, line: true });
    }
    expect(read(DEPLOY_FILES.render).split(/\r?\n/)[r.deployPath.facts.find((f) => f.fact === 'AUTO_DEPLOY_OFF')!.evidence.line - 1]).toMatch(/autoDeploy:\s*false/);
    expect(r.deployPath.files.map((f) => f.path)).toEqual(['render.yaml', '.github/workflows/deploy.yml']);
  });
  it('control: auto-deploy turned on is read as on, and a fact the file does not state is absent, never assumed', () => {
    const on = composeReleaseRecord({ git: fakeGit({}), read: (p) => (p === 'render.yaml' ? 'services:\n  - autoDeploy: true\n' : null), env: {} });
    expect(on.deployPath.state === 'RECORDED' && on.deployPath.facts.map((f) => f.fact)).toEqual(['AUTO_DEPLOY_ON']);
  });
  it('records "no history" and "no deploy configuration" as such, with no commit, when there is nothing to read', () => {
    const none = composeReleaseRecord({ git: fakeGit({}), read: () => null, env: {} });
    expect(none.commit).toBeNull();
    expect(none.tag).toBeNull();
    expect(none.repository).toBeNull();
    expect(none.history).toEqual({ state: 'UNAVAILABLE', reason: 'NO_REPOSITORY_HISTORY' });
    expect(none.deployPath).toEqual({ state: 'UNAVAILABLE', reason: 'NO_DEPLOY_CONFIGURATION' });
    // on Render the deployed commit and repository come from its own build environment
    const render = composeReleaseRecord({ git: fakeGit({}), read: () => null, env: { RENDER_GIT_COMMIT: SHA('d'), RENDER_GIT_REPO_SLUG: 'bibokh/familista-backend' } });
    expect([render.commit, render.repository]).toEqual([SHA('d'), 'bibokh/familista-backend']);
  });
  it('is written at build time by a script that never fails the build, and src runs no process', () => {
    expect(JSON.parse(read('package.json')).scripts.build).toMatch(/node scripts\/neural-twin-build\.js && node scripts\/system-updates-build\.js && /);
    const script = read('scripts/system-updates-build.js');
    expect(script).toMatch(/execFileSync\('git', args/);
    expect(script).toMatch(/catch \(_\) \{ return null; \}/);
    for (const f of ['src/platform/system-updates/release-record.ts', 'src/platform/system-updates/service.ts', 'src/platform/system-updates/model.ts', 'src/routes/system-updates.routes.ts'])
      expect(read(f)).not.toMatch(/child_process|execSync|execFile|spawn\(/);
  });
});

describe('2. the view tells known from unknown', () => {
  const record: ReleaseRecord = {
    schemaVersion: 1, builtAt: '2026-11-05T10:18:00.000Z', commit: SHA('a'), tag: null, repository: 'bibokh/familista-backend',
    history: { state: 'RECORDED', shallow: false, items: [{ sha: SHA('a'), date: '2026-11-05T09:16:46.000Z', subject: 'x (#152)', pr: 152 }] },
    deployPath: { state: 'RECORDED', facts: [{ fact: 'AUTO_DEPLOY_OFF', evidence: { path: 'render.yaml', line: 17 } }], files: [{ path: 'render.yaml', sha256: 'f'.repeat(64) }] },
  };
  const now = new Date('2026-11-05T12:00:00Z');

  it('on Render, with a record: the deployed commit, branch and start time, and the record as it was written', () => {
    const v = systemUpdates({ env: { NODE_ENV: 'production', RENDER_GIT_COMMIT: SHA('a'), RENDER_GIT_BRANCH: 'main' }, now, uptimeSec: 3600, record });
    expect(v.mode).toBe('READ_ONLY');
    expect(v.running).toMatchObject({ commit: SHA('a'), builtCommit: SHA('a'), branch: 'main', onRender: true, environment: 'production', builtAt: record.builtAt, record: 'PRESENT', reason: null, tag: null });
    expect(v.running.startedAt).toBe('2026-11-05T11:00:00.000Z');
    expect(v.changes).toBe(record.history);
    expect(v.deployPath).toBe(record.deployPath);
    expect(v.repository).toBe('bibokh/familista-backend');
    expect(SystemUpdatesViewSchema.safeParse(v).success).toBe(true);
  });
  it('without a record and off Render: every build figure is unknown, with its reason, and nothing is made up', () => {
    const v = systemUpdates({ env: { NODE_ENV: 'development' }, now, uptimeSec: 5, record: null });
    expect(v.running).toMatchObject({ commit: null, builtCommit: null, branch: null, onRender: false, builtAt: null, tag: null, record: 'ABSENT', reason: 'NO_BUILD_RECORD' });
    expect(v.changes).toEqual({ state: 'UNAVAILABLE', reason: 'NO_BUILD_RECORD' });
    expect(v.deployPath).toEqual({ state: 'UNAVAILABLE', reason: 'NO_BUILD_RECORD' });
    expect(v.repository).toBeNull();
    expect(SystemUpdatesViewSchema.safeParse(v).success).toBe(true);
  });
  it('CI, the hosting provider and pull requests are not connected: the server holds no credential for them', () => {
    const v = systemUpdates({ env: {}, now, record: null });
    expect([v.ci, v.provider, v.approvals.code]).toEqual([
      { state: 'NOT_CONNECTED', reason: 'NO_CI_CONNECTION' },
      { state: 'NOT_CONNECTED', reason: 'NO_PROVIDER_CONNECTION' },
      { state: 'NOT_CONNECTED', reason: 'NO_CODE_REVIEW_CONNECTION' },
    ]);
    const src = read('src/platform/system-updates/service.ts') + read('src/platform/system-updates/release-record.ts') + read('src/routes/system-updates.routes.ts');
    expect(src).not.toMatch(/GITHUB_TOKEN|RENDER_API|api\.github\.com|api\.render\.com|fetch\(|axios|https?\.request/);
  });
  it('the approval counts are the registry\'s own, at the human-approval stage', () => {
    const v = systemUpdates({ env: {}, now, record: null });
    const o = algorithmsOverview(), c = algorithmCandidates();
    expect(v.approvals.algorithms).toEqual({ state: 'AVAILABLE', awaiting: o.totals!.awaitingApproval, total: o.totals!.registered, reason: null });
    expect(v.approvals.candidates).toEqual({ state: 'AVAILABLE', awaiting: c.counts.awaitingApproval, total: c.counts.candidates, reason: null });
  });
  it('a malformed environment value is not passed on as a commit or a branch', () => {
    const v = systemUpdates({ env: { RENDER_GIT_COMMIT: 'abc; rm -rf /', RENDER_GIT_BRANCH: '<script>' }, now, record: null });
    expect([v.running.commit, v.running.branch, v.running.onRender]).toEqual([null, null, false]);
  });
  it('a record that is missing or not of this schema reads as no record', () => {
    resetReleaseRecordCache();
    expect(loadReleaseRecord(path.join(ROOT, 'does-not-exist.json'))).toBeNull();
    const tmp = path.join(require('os').tmpdir(), 'su-record-' + process.pid + '.json');
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 99, builtAt: 'x' }));
    expect(loadReleaseRecord(tmp)).toBeNull();
    fs.unlinkSync(tmp);
  });
  it('the contract is strict: a field the model does not have is refused', () => {
    const v = systemUpdates({ env: {}, now, record });
    expect(SystemUpdatesViewSchema.safeParse({ ...v, token: 'x' }).success).toBe(false);
    expect(SystemUpdatesViewSchema.safeParse({ ...v, ci: { state: 'CONNECTED', reason: null } }).success).toBe(false);
  });
  it('every reason and fact the server can send is one the room words', () => {
    const JS = read('public/system-updates/system-updates.js');
    const block = (name: string) => { const b = JS.slice(JS.indexOf('var ' + name + ' = {')); return b.slice(0, b.indexOf('};')); };
    for (const r of UPDATE_REASONS) expect(block('REASONS')).toContain('    ' + r + ': ');
    for (const f of DEPLOY_FACTS) expect(block('FACTS')).toContain('    ' + f + ': ');
  });
});

describe('3. the API: owner-only on the server, never cached, GET only', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createApp } = require('../src/app');
  const app = createApp();
  const token = (u: typeof OWNER | typeof MEMBER) => signToken('access', { sub: u.id, role: u.role }, { expiresIn: '10m' });
  beforeEach(() => { CURRENT = OWNER; });

  it('refuses a request without a session (401), and says nothing about the platform', async () => {
    const res = await request(app).get('/api/v1/system/updates');
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/running|approvals|deployPath/);
  });
  it('refuses a club account (403), and sends no part of the view', async () => {
    CURRENT = MEMBER;
    const res = await request(app).get('/api/v1/system/updates').set('Authorization', 'Bearer ' + token(MEMBER));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/running|approvals|deployPath|builtAt/);
  });
  it('control: serves the owner the view, uncached, in its contract', async () => {
    const res = await request(app).get('/api/v1/system/updates').set('Authorization', 'Bearer ' + token(OWNER));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(SystemUpdatesViewSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data.mode).toBe('READ_ONLY');
  });
  it('is read-only: no other verb is routed', async () => {
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[verb]('/api/v1/system/updates').set('Authorization', 'Bearer ' + token(OWNER));
      expect([404, 405]).toContain(res.status);
    }
  });
  it('is pinned owner-only in the posture policy, the coverage map and the control plane', () => {
    expect(json('src/cyber-defense/posture-policy.json').ownerRooms['system-updates.routes']).toEqual({ mount: '/system/updates' });
    expect(json('src/cyber-defense/coverage-map.json').components.routers['system-updates.routes']).toEqual([4, 5, 6, 7]);
    expect(read('src/cyber-defense/control-plane/registry.ts')).toMatch(/routers: \['infrastructure\.routes', 'neural-twin\.routes', 'system-updates\.routes'\]/);
    expect(read('src/routes/system-updates.routes.ts')).toMatch(/router\.use\(authenticate\);[\s\S]*assertPlatformOwner[\s\S]*no-store/);
    expect(read('src/routes/system-updates.routes.ts')).not.toMatch(/router\.(post|put|patch|delete)\(/);
  });
});

describe('4. the room keeps the owner-room rules', () => {
  const JS = read('public/system-updates/system-updates.js');
  const CSS = read('public/system-updates/system-updates.css');
  const cat = (l: string) => json('public/system-updates/i18n/' + l + '.json') as Record<string, string>;
  const keysAsked = () => {
    const keys = new Set<string>();
    for (const m of JS.matchAll(/\b(?:T|tf)\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
    for (const name of ['REASONS', 'FACTS']) {
      const b = JS.slice(JS.indexOf('var ' + name + ' = {'));
      for (const m of b.slice(0, b.indexOf('};')).matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]);
    }
    const rooms = JS.slice(JS.indexOf('var ROOMS = ['));
    for (const m of rooms.slice(0, rooms.indexOf('];')).matchAll(/(?:name|says):\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]);
    for (const m of JS.matchAll(/row\('([^']+)',[^,]+,\s*'([^']+)'/g)) { keys.add(m[1]); keys.add(m[2]); }
    keys.delete('');
    return keys;
  };

  it('has one catalogue per language with the same keys, English as itself, and every %d kept', () => {
    const en = cat('en'), de = cat('de'), ar = cat('ar');
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en)) {
      expect(en[k]).toBe(k);
      for (const t of [de[k], ar[k]]) { expect(t).not.toBe(''); expect((t.match(/%d/g) || []).length).toBe((k.match(/%d/g) || []).length); }
    }
  });
  it('every string the room can show is in the catalogue, and the catalogue holds nothing the room does not ask for', () => {
    const asked = keysAsked(), en = cat('en');
    expect([...asked].filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(en).filter((k) => !asked.has(k))).toEqual([]);
  });
  it('writes no inline style or handler, evaluates nothing, and links out only to GitHub, built from the validated repository', () => {
    expect(JS).not.toMatch(/style="/);
    expect(JS).not.toMatch(/\son[a-z]+="/);
    expect(JS).not.toMatch(/\beval\(|new Function\(/);
    expect([...JS.matchAll(/https?:\/\/[^'"\s]*/g)].map((m) => m[0])).toEqual(['https://github.com/']);
    expect(JS).toMatch(/function github\(repo, rest\) \{ return \/\^\[A-Za-z0-9-\]\+\\\/\[A-Za-z0-9\._-\]\+\$\/\.test\(repo \|\| ''\)/);
    expect(JS).toMatch(/target="_blank" rel="noopener noreferrer"/);
    // GET only, to its own endpoint
    expect([...JS.matchAll(/fetch\((.+?), \{/g)].map((m) => m[1].trim())).toEqual(["'/system-updates/i18n/' + tag + '.json'", 'apiBase() + path']);
    expect(JS).toMatch(/method: 'GET'/);
    expect(JS).not.toMatch(/method: '(POST|PUT|PATCH|DELETE)'/);
  });
  it('reads only declared design tokens, declares none, uses no raw colour, and keeps the escape hatch and a stable gutter', () => {
    const declared = new Set([...read('public/tokens/familista-tokens.css').matchAll(/(--fam-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(60);
    expect(used.filter((v) => !v.startsWith('--fam-') || !declared.has(v))).toEqual([]);
    expect(CSS).not.toMatch(/^\s*--[a-z0-9-]+\s*:/m);
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(CSS).toMatch(/@media \(max-width: 980px\), \(max-height: 620px\)/);
    expect(CSS).toMatch(/scrollbar-gutter: stable/);
    expect(read('tools/tokens/scripts/verify.mjs')).toMatch(/const CONSUMERS = \[[^\]]*'public\/system-updates\/'[^\]]*\];/);
    expect(read('tools/tokens/lib/production.mjs')).toContain("files: ['public/system-updates/system-updates.css']");
  });
  it('is wired into the shell like the other owner rooms, outside every Club Workspace, loaded only for the owner', () => {
    const APP = read('public/app.js');
    expect(APP).toMatch(/'system-updates': 1,/);
    expect(APP).toMatch(/function _famLoadOwnerRoom\(room, v, css, scripts, done\)[\s\S]*?_isPlatformOwner\(\)/);
    expect(APP).toMatch(/function _loadSystemUpdates\(done\) \{\s*_famLoadOwnerRoom\(_SU_ROOM, /);
    expect(APP).toMatch(/document\.body\.classList\.toggle\('su-room-open', page === 'system-updates'\)[\s\S]*?window\.teardownFamilistaSystemUpdates\(\)/);
    expect(APP).toMatch(/<div class="page" id="pg-system-updates" data-no-i18n data-fam-context="owner"><div id="su-root"><\/div><\/div>/);
    expect(read('public/index.html')).not.toMatch(/system-updates\.(js|css)/);   // never linked: loaded on demand
  });
});

describe('5. the Platform Owner navigation: one list, owner-only, marking the open room', () => {
  const APP = read('public/app.js');
  const HTML = read('public/index.html');
  const CSS = read('public/app.css');
  // the list and its drawing function, run as written
  const start = APP.indexOf('var OWNER_NAV = [');
  const code = APP.slice(start, APP.indexOf('/** Mark the page open now', start));
  const sandbox: Record<string, unknown> = { window: {}, _esc: (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;this.__nav = famOwnerNav; this.__list = OWNER_NAV;', sandbox);
  const nav = sandbox.__nav as (a: string | null, T?: (s: string) => string, p?: string) => string;

  it('holds exactly the three destinations, in order, each an owner room the shell knows', () => {
    expect((sandbox.__list as Array<{ page: string; label: string }>).map((i) => [i.page, i.label])).toEqual([['neural-twin', 'Neural Digital Twin'], ['system-updates', 'System Updates'], ['product-design', 'Design Studio']]);
    expect(APP).toMatch(/'neural-twin': 1,/);
    expect(APP).toMatch(/'system-updates': 1,/);
    expect(APP).toMatch(/'product-design': 1,/);
  });
  it('marks only the open room with aria-current="page", and every button keeps its name', () => {
    const html = nav('system-updates', undefined, 'su-ownernav');
    expect((html.match(/aria-current="page"/g) || []).length).toBe(1);
    expect(html).toMatch(/data-page="system-updates" data-owner-nav="system-updates" aria-current="page" title="System Updates">/);
    expect(html).toMatch(/data-page="neural-twin" data-owner-nav="neural-twin" title="Neural Digital Twin"><svg class="su-ownernav-ico"[^>]*aria-hidden="true"/);
    expect(nav(null)).not.toMatch(/aria-current/);
    expect(nav(null)).toMatch(/<span class="owner-nav-label">Neural Digital Twin<\/span>/);
  });
  it('words its labels with the surface\'s catalogue, escaped', () => {
    const html = nav('neural-twin', (s) => (s === 'System Updates' ? '<Systemaktualisierungen>' : s), 'nt-ownernav');
    expect(html).toContain('&lt;Systemaktualisierungen&gt;');
    expect(html).not.toContain('<Systemaktualisierungen>');
  });
  it('is drawn in the shell only once /system/whoami says owner, and hidden in a Club Workspace', () => {
    expect(APP).toMatch(/\.then\(function \(yes\) \{ if \(yes\) \{ try \{ _langSwitchShow\(\); \} catch \(_\) \{\} try \{ _ownerNavShow\(\); \} catch \(_\) \{\} \} return yes; \}\);/);
    expect([...HTML.matchAll(/<nav class="owner-nav[^"]*" id="[^"]+" aria-label="Platform owner" hidden><\/nav>/g)].length).toBe(2);
    expect(CSS).toMatch(/body\.club-theme \.owner-nav\[hidden\], body\.club-theme\.area-club \.owner-nav\{ display: none; \}/);
    expect(APP).toMatch(/try \{ _ownerNavSync\(page\); \} catch \(_\) \{\}/);
  });
  it('is drawn in both rooms, each marking itself, through the same list', () => {
    expect(read('public/neural-twin/neural-twin.js')).toMatch(/window\.famOwnerNav\('neural-twin', T, 'nt-ownernav'\)/);
    expect(read('public/system-updates/system-updates.js')).toMatch(/window\.famOwnerNav\('system-updates', T, 'su-ownernav'\)/);
    for (const l of ['en', 'de', 'ar']) {
      const twin = json('public/neural-twin/i18n/' + l + '.json');
      expect([typeof twin['System Updates'], typeof twin['Platform owner']]).toEqual(['string', 'string']);
    }
  });
  it('its words are in every locale of the platform catalogue', () => {
    const dir = path.join(ROOT, 'public/i18n/catalogue');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_') && x !== 'en-US.json')) {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const k of ['Neural Digital Twin', 'System Updates', 'Platform owner']) expect({ f, k, ok: typeof c[k] === 'string' && c[k].length > 0 }).toEqual({ f, k, ok: true });
    }
  });
});
