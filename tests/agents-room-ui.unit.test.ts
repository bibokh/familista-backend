/**
 * The AI Agents Operations Room — the screen
 *
 * The Platform Owner's global room for the Agent Registry (public/agents-room/). What Jest can prove:
 *   - it is wired as an owner-only room of its own, loaded on demand, reached from SYSTEM → AI Agent Control, outside
 *     every Club Workspace and with no Owner Home card;
 *   - it is read-only by construction: one GET-only reader, two endpoints, no verb that writes, no kill-switch call;
 *   - it discovers what it draws: rendered against the real registry it draws every agent and every domain, and a
 *     domain and an agent added to the registry appear with no change to the room;
 *   - it prints whatever the registry holds as text, and says so when the registry does not answer as its contract says;
 *   - its source is CSP-safe and its stylesheet reads only tokens that exist and keeps the owner rooms' layout rules;
 *   - its English, German and Arabic catalogues cover everything it says, the manifests' own titles and purposes too.
 * What it cannot prove (real pointer and keyboard input, layout, hit-testing, focus, CSP in a browser, axe) is proved by
 * sections 16 and 16a of tools/components/lab-browser-proof.cjs.
 */
import fs from 'fs';
import path from 'path';
import { operationsRoomAgent, operationsRoomOverview } from '../src/platform/agents/operations-room.service';
import { platformAgentRegistry } from '../src/platform/agents/catalog';
import { OWNER_API_CONTRACTS } from '../src/contracts/owner-api.contracts';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const json = (f: string) => JSON.parse(read(f));

const JS = read('public/agents-room/agents-room.js');
const CSS = read('public/agents-room/agents-room.css');
const APP = read('public/app.js');
const INDEX = read('public/index.html');
const SYSTEM_JS = read('public/system/system.js');
const TOKENS_CSS = read('public/tokens/familista-tokens.css');
const declared = new Set([...TOKENS_CSS.matchAll(/(--fam-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
/** The source without its comments, so a word in a comment never satisfies or breaks a pin. */
const CODE = JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The text of a `var NAME = { … };` literal in the room's source. */
function objectLiteral(src: string, name: string): string {
  const at = src.indexOf(`var ${name} = {`);
  if (at < 0) throw new Error(`${name} not found`);
  return src.slice(at, src.indexOf('};', at));
}

// ─────────────────────────────────────────────────────────────────────────────
describe('a room of its own, for the platform owner, outside every Club Workspace', () => {
  const loader = APP.slice(APP.indexOf('function _loadAgentsRoom('), APP.indexOf('// ── NAVIGATION ──'));

  it('is loaded on demand, only once /system/whoami names the platform owner, under one version', () => {
    expect(loader).toContain('_isPlatformOwner()');
    expect(loader).toContain("if (!yes) { finish(false); return; }");
    expect(loader).toMatch(/var v = '20\d{6}-agents-room-\d+';/);
    expect(loader).toContain("link.href = '/agents-room/agents-room.css?v=' + v;");
    expect(loader).toContain("script.src = '/agents-room/agents-room.js?v=' + v;");
    // Never linked from the page, so no other session pays for it or can read it before the owner check.
    expect(INDEX).not.toContain('/agents-room/');
    const eager = APP.slice(APP.indexOf('_EAGER_PAGES'), APP.indexOf(']', APP.indexOf('_EAGER_PAGES')));
    expect(eager).not.toContain('agents-room');
  });

  it('is routed like the other owner rooms: held until loaded, allow-listed, its own template, shell and teardown', () => {
    expect(APP).toContain("if (page === 'agents-room' && !(_AR_ROOM && _AR_ROOM.state === 'ready')) {");
    expect(APP).toMatch(/'agents-room': 1,/);
    expect(APP).toContain("'agents-room':                 renderAgentsRoomHTML,");
    expect(APP).toContain('<div class="page" id="pg-agents-room" data-no-i18n data-fam-context="owner"><div id="ar-root"></div></div>');
    expect(APP).toContain("document.body.classList.toggle('ar-agents-open', page === 'agents-room');");
    expect(APP).toContain("if (_wasAgents && page !== 'agents-room' && typeof window.teardownFamilistaAgentsRoom === 'function') {");
    expect(APP).toContain("&& _arRoot && (_leaving !== 'pg-agents-room' || !_arRoot.__famDrawn)) {");
  });

  it('is reached from SYSTEM → AI Agent Control, and is not a card on Owner Home', () => {
    expect(SYSTEM_JS).toContain('data-sy-room="agents-room"');
    expect(SYSTEM_JS).toContain("return moduleHeader('agents') + agentsRoomLink()");
    expect(SYSTEM_JS).toContain("if (room) { ev.preventDefault(); try { navTo(room.getAttribute('data-sy-room')); } catch (_) {} return; }");
    const home = APP.slice(APP.indexOf('function _ownerHomeForPlatformOwner('), APP.indexOf('function renderOwnerHome('));
    expect(home.length).toBeGreaterThan(1000);
    expect(home).not.toContain('agents-room');
    // The room comes back to SYSTEM, where it was opened from.
    expect(CODE).toContain("if (t.closest('[data-ar-back]')) { try { window.navTo('system'); } catch (_) {} return; }");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('read-only by construction', () => {
  it('has one reader, and it only ever sends GET', () => {
    expect(CODE.match(/\bfetch\(/g)).toHaveLength(2); // the reader, and the room's own catalogue
    expect(CODE).toContain("method: 'GET',");
    expect(CODE).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/i);
    expect(CODE).not.toMatch(/\b(XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b/);
  });

  it('asks for the registry and one manifest, and for nothing else', () => {
    const calls = [...CODE.matchAll(/\bapi\(('[^']*'(?: \+ encodeURIComponent\(id\))?|[a-z]+)\)/g)].map((m) => m[1]).filter((a) => a !== 'path');
    expect(CODE.match(/\bapi\(/g)).toHaveLength(calls.length + 1); // + its definition: no other call reaches the reader
    expect(calls.sort()).toEqual(["'/system/agents'", "'/system/agents/' + encodeURIComponent(id)"].sort());
    expect(CODE).not.toContain('kill-switch');
    expect(CODE).not.toMatch(/data-ar-(kill|engage|activate|start|stop|run)/);
  });

  it('draws the kill switch as a state only, as the registry endpoint reports it', () => {
    expect(CODE).toContain("ks.engaged === true ? 'warn' : 'none'");
    expect(CODE).toContain("T('State only. It is changed in SYSTEM → AI Agent Control.')");
  });

  it('is covered by the owner API contract, in both directions', () => {
    const mine = OWNER_API_CONTRACTS.filter((c) => c.consumer === 'public/agents-room/agents-room.js').map((c) => c.endpoint);
    expect(mine).toEqual(['/system/agents', '/system/agents/club.tactical']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The room drawn by its real source, in a sandbox, against the registry the server builds.

const PAYLOAD = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
/* eslint-disable @typescript-eslint/no-explicit-any */
type Room = { html: () => string; click: (target: any) => Promise<void>; insp: () => string };

function runRoom(overview: unknown, detail?: (id: string) => unknown, locale?: Record<string, string>): Promise<Room> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vm = require('vm');
  const html: string[] = [];
  const inspHtml: string[] = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  const insp: any = {
    set innerHTML(v: string) { inspHtml.push(v); }, get innerHTML() { return inspHtml[inspHtml.length - 1] || ''; },
    classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, querySelector: () => null,
  };
  const host: any = {
    set innerHTML(v: string) { html.push(v); }, get innerHTML() { return html[html.length - 1] || ''; },
    setAttribute() {}, querySelector: (s: string) => (s === '#ar-insp' ? insp : null), querySelectorAll: () => [], contains: () => false,
    addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; },
  };
  const reply = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: body }) });
  const sandbox: any = {
    document: { getElementById: () => host },
    localStorage: { getItem: () => (locale ? 'de' : null), setItem: () => {} },
    fetch: (u: string) => {
      if (String(u).includes('/i18n/')) return Promise.resolve({ ok: true, json: () => Promise.resolve(locale || {}) });
      const m = /\/system\/agents\/(.+)$/.exec(String(u));
      return m ? reply(detail ? detail(decodeURIComponent(m[1])) : null) : reply(overview);
    },
    Intl, console, Promise, Object, Array, String, Number, Date, Math, JSON, isFinite, encodeURIComponent, decodeURIComponent,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(JS, sandbox);
  sandbox.renderFamilistaAgentsRoom(host);
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
  return settle().then(() => ({
    html: () => html[html.length - 1] || '',
    insp: () => inspHtml[inspHtml.length - 1] || '',
    click: (target: any) => { listeners.click({ target }); return settle(); },
  }));
}
/** A click target that answers `closest` for one selector only, as a delegated click on that element would. */
const on = (selector: string, attrs: Record<string, string>) => ({
  closest: (s: string) => (s.split(',').map((x) => x.trim()).includes(selector) ? { getAttribute: (k: string) => attrs[k] ?? null, closest: () => null, hasAttribute: (k: string) => k in attrs } : null),
});
const real = () => JSON.parse(JSON.stringify(operationsRoomOverview()));
const nodes = (h: string) => [...h.matchAll(/<g class="ar-node ar-node--[a-z]+[^"]*"[^>]*data-ar-agent="([^"]+)"/g)].map((m) => m[1]);
const sectors = (h: string) => [...h.matchAll(/data-ar-sector="([^"]+)"/g)].map((m) => m[1]);

describe('it draws what the registry holds — every agent, every domain — and nothing it does not', () => {
  it('draws every agent and every domain of the real registry, and its digest', async () => {
    const o = real();
    const room = await runRoom(o);
    const h = room.html();
    expect(nodes(h).sort()).toEqual(o.agents.map((a: { id: string }) => a.id).sort());
    expect(sectors(h)).toEqual(Object.keys(o.registry.byDomain));
    expect(h).toContain(o.registry.digest.slice(0, 16));
    expect(h).toContain('Every invariant holds');
    // Each running agent is drawn as running: the lifecycle is the manifest's, the outline says it.
    expect(h.match(/<g class="ar-node ar-node--running[^"]*"[^>]*data-ar-agent=/g)).toHaveLength(o.agents.filter((a: { lifecycle: string }) => a.lifecycle === 'RUNNING').length);
  });

  it('assumes nothing about how many: a domain and an agent added to the registry appear with no change to the room', async () => {
    const o = real();
    const n = Object.keys(o.registry.byDomain).length;
    o.registry.byDomain.SPACE_OPERATIONS = 1;
    o.registry.agents += 1;
    o.registry.byScope.PLATFORM += 1;
    o.registry.byLifecycle.LAB += 1;
    o.agents.push({ ...o.agents[0], id: 'platform.synthetic-proof', title: 'Synthetic proof agent', domain: 'SPACE_OPERATIONS', scope: 'PLATFORM', lifecycle: 'LAB', runtimeAgent: null });
    const h = (await runRoom(o)).html();
    expect(sectors(h)).toHaveLength(n + 1);
    expect(nodes(h)).toContain('platform.synthetic-proof');
    expect(h).toContain('class="ar-node ar-node--lab');
    // A token the room has no label for is drawn readable, not dropped and not raw.
    expect(h).toContain('Space operations');
    expect(h).not.toContain('>SPACE_OPERATIONS<');
  });

  it('holds no list of agents, ids or domain counts of its own', () => {
    for (const a of platformAgentRegistry().list()) expect(`${a.id}:${CODE.includes(a.id)}`).toBe(`${a.id}:false`);
    // The sector count is the registry's: 360 degrees over however many domains it reports.
    expect(CODE).toContain('var step = 360 / n;');
    expect(CODE).toContain('var n = Math.max(1, doms.length);');
    expect(CODE).toContain("var out = keysOf(reg && reg.byDomain);");
  });

  it('draws an empty registry as an empty state that says how an agent arrives', async () => {
    const o = real();
    o.agents = []; o.registry.agents = 0;
    const h = (await runRoom(o)).html();
    expect(h).toContain('The registry describes no agent');
    expect(h).toContain('reviewed pull request');
    expect(nodes(h)).toEqual([]);
  });

  it('says CONTRACT ERROR, and names the field, when the registry does not answer as its contract says', async () => {
    const o = real();
    delete o.invariants;
    const h = (await runRoom(o)).html();
    expect(h).toContain('CONTRACT ERROR');
    expect(h).toContain('/system/agents');
    expect(h).toContain('invariants');
    expect(nodes(h)).toEqual([]);
  });

  it('draws the kill switch as the registry reports it, and a failing invariant as a failure', async () => {
    const o = real();
    o.killSwitch.engaged = true;
    o.invariants[2] = { ...o.invariants[2], holds: false, detail: 'Tools or data class differ from the egress profile: club.tactical' };
    const h = (await runRoom(o)).html();
    expect(h).toContain('Engaged: autonomous actions stopped');
    expect(h).toContain('1 of 8 invariants fail');
    expect(h).toContain('ar-inv-i--crit');
    expect(h).toContain('ar-core-ring--crit');
  });

  it('opens one manifest in full: tools, data, outputs, who may read them, who answers for it', async () => {
    const room = await runRoom(real(), (id) => operationsRoomAgent(id));
    await room.click(on('[data-ar-agent]', { 'data-ar-agent': 'club.medical' }));
    const i = room.insp();
    expect(i).toContain('id="ar-insp-title"');
    expect(i).toContain('Injury-risk screening');
    expect(i).toContain('issueMedicalRecommendation');
    expect(i).toContain('INJURY_RISK');
    expect(i).toContain('Medical staff');
    expect(i).toContain('MEDICAL');            // the runtime binding, as an identifier
    expect(i).toContain('The manifest validates');
    expect(i).toMatch(/[0-9a-f]{64}/);          // the manifest's own digest, in full
  });

  it('switches to the catalogue: one row per agent, each opening its manifest', async () => {
    const o = real();
    const room = await runRoom(o);
    await room.click(on('[data-ar-view]', { 'data-ar-view': 'catalogue' }));
    const h = room.html();
    expect(h).toContain('class="ar-table"');
    expect([...h.matchAll(/<tr class="ar-row[^"]*" data-ar-agent="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(o.agents.map((a: { id: string }) => a.id).sort());
    expect(h).toContain(`Showing ${o.agents.length} of ${o.agents.length} agents`);
  });

  it('prints hostile strings as text everywhere the registry reaches the page', async () => {
    const o = real();
    Object.assign(o.agents[0], { id: PAYLOAD, title: PAYLOAD, domain: PAYLOAD, supervisor: PAYLOAD, autonomyCeiling: PAYLOAD, dataCeiling: PAYLOAD, version: PAYLOAD });
    o.registry.byDomain[PAYLOAD] = 1;
    o.invariants[0] = { id: PAYLOAD, holds: false, detail: PAYLOAD };
    o.registry.digest = PAYLOAD;
    const room = await runRoom(o, () => {
      const d = JSON.parse(JSON.stringify(operationsRoomAgent('club.medical')));
      d.agent.purpose = PAYLOAD; d.agent.digest = PAYLOAD; d.tools[0].key = PAYLOAD; d.outputs[0].kind = PAYLOAD; d.outputs[0].readableBy = [PAYLOAD];
      d.issues = [{ code: PAYLOAD, message: PAYLOAD }];
      return d;
    });
    await room.click(on('[data-ar-view]', { 'data-ar-view': 'catalogue' }));
    await room.click(on('[data-ar-agent]', { 'data-ar-agent': PAYLOAD }));
    for (const out of [room.html(), room.insp()]) {
      expect(out.length).toBeGreaterThan(1000);
      expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(out).not.toMatch(/<(img|script)\b/);
      expect(out).not.toContain(PAYLOAD);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('safe by construction, and laid out as the owner rooms are', () => {
  it('writes no inline style, no inline handler, no script and no eval', () => {
    expect(CODE).not.toMatch(/style="/);
    expect(CODE).not.toMatch(/\.style\b/);
    expect(CODE).not.toMatch(/\son[a-z]+=/i);
    expect(CODE).not.toMatch(/<script|\beval\(|new Function\(/);
    // Its markup carries the boundary every owner room keeps; identifiers are marked so no translator touches them.
    expect(CODE).toContain("function code(v) { return '<code data-no-i18n>' + esc(v) + '</code>'; }");
  });

  it('positions every node by its own centre, never by a transform on its group (a hovered group would be hit-tested at the origin)', () => {
    expect(CODE).not.toContain('transform="translate(');
    expect(CODE).toContain("var at = ' cx=\"' + f1(p.x) + '\" cy=\"' + f1(p.y) + '\"';");
  });

  it('reads only tokens that exist, and declares none of its own', () => {
    const used = [...CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(100);
    expect(used.filter((v) => !v.startsWith('--fam-') || !declared.has(v))).toEqual([]);
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/(^|[;{\s])--[a-z0-9-]+\s*:/);
    expect(read('tools/tokens/scripts/verify.mjs')).toContain("const CONSUMERS = ['public/design-system/', 'public/design-studio/', 'public/agents-room/'];");
    expect(read('tools/tokens/lib/production.mjs')).toContain("files: ['public/agents-room/agents-room.css']");
  });

  it('keeps the workspace rules: a fixed shell whose regions scroll inside themselves, and the escape hatch', () => {
    expect(CSS).toContain('.ar-shell { display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden; }');
    for (const sel of ['.ar-view {', '.ar-side {', '.ar-insp-body {']) {
      const rule = CSS.slice(CSS.indexOf(sel), CSS.indexOf('}', CSS.indexOf(sel)));
      expect(`${sel} ${rule.includes('scrollbar-gutter: stable')}`).toBe(`${sel} true`);
    }
    expect(CSS).toContain('@media (max-width: 980px), (max-height: 620px) {');
    expect(CSS).not.toMatch(/@keyframes|animation:/);
  });

  it('floats the inspector, and animates it on opacity and transform only', () => {
    const rule = CSS.slice(CSS.indexOf('.ar-insp {'), CSS.indexOf('}', CSS.indexOf('.ar-insp {')));
    expect(rule).toContain('position: fixed;');
    const transitions = [...CSS.matchAll(/transition:([^;]+);/g)].flatMap((m) => m[1].split(',').map((t) => t.trim().split(/\s+/)[0]));
    expect([...new Set(transitions)].sort()).toEqual(['opacity', 'transform', 'visibility']);
  });

  it('gives every colour a meaning: green and red for invariants, amber for identity, outlines for lifecycles', () => {
    expect(CSS).toContain('.ar-inv-i--ok .ar-inv-mark { color: var(--fam-status-success); }');
    expect(CSS).toContain('.ar-inv-i--crit .ar-inv-mark { color: var(--fam-status-critical); }');
    // A lifecycle is a declaration: never painted with a result colour.
    const lc = CSS.split('\n').filter((l) => /ar-chip--lc-|ar-node--(lab|draft|retired|running)/.test(l)).join('\n');
    expect(lc).not.toMatch(/status-(success|critical)/);
    // Nothing on the map pulses: there is no live state to show.
    expect(CSS).not.toMatch(/\.ar-node[^{]*\{[^}]*(animation|transition)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('English, German and Arabic — one catalogue each, in step', () => {
  const dict = (t: string) => json(`public/agents-room/i18n/${t}.json`) as Record<string, string>;
  const en = dict('en'); const de = dict('de'); const ar = dict('ar');
  const slots = (s: string) => (s.match(/%d/g) || []).length;
  // Identifiers and words that are the same in the target language.
  const SAME = new Set(['LAB', 'Agent', 'Analyst', 'Big Data', 'Governance', 'Manager', 'Scout', 'Scouting', 'Training', 'Version', 'Vision']);

  it('has the same keys in all three, and English maps each key to itself', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(en)) expect(v).toBe(k);
    expect(fs.readdirSync(path.join(ROOT, 'public/agents-room/i18n')).sort()).toEqual(['ar.json', 'de.json', 'en.json']);
    expect(JS).toContain("var AR_LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']];");
  });

  it('translates every key: no blank, no English left behind, every %d slot kept, Arabic in Arabic script', () => {
    for (const k of Object.keys(en)) {
      for (const d of [de, ar]) {
        expect(d[k].trim().length).toBeGreaterThan(0);
        expect(`${k} → ${slots(d[k])}`).toBe(`${k} → ${slots(k)}`);
      }
      if (!SAME.has(k)) expect(`${k} → ${de[k]}`).not.toBe(`${k} → ${k}`);
      expect(`${k} → ${ar[k] !== k}`).toBe(`${k} → true`);
      expect(`${k} → ${/[؀-ۿ]/.test(ar[k])}`).toBe(`${k} → true`);
    }
  });

  it('covers every literal the room passes through T(), tf() and its helpers', () => {
    const calls = [...CODE.matchAll(/\b(?:T|tf|panel|kv|emptyState|cell|th|td|chip\([^,]+,)\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
    const pairs = [...CODE.matchAll(/\b(?:tab|select)\('[^']+',\s*'((?:[^'\\]|\\.)*)'(?:,\s*'((?:[^'\\]|\\.)*)')?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean) as string[];
    const ternary = [...CODE.matchAll(/\bT\([^()']*\?\s*'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'\)/g)].flatMap((m) => [m[1], m[2]]);
    const keys = [...new Set([...calls, ...pairs, ...ternary])].filter((k) => /[A-Za-z]{2}/.test(k));
    expect(keys.length).toBeGreaterThan(100);
    expect(ternary).toEqual(expect.arrayContaining(['Reading…', 'Refresh']));
    expect(keys.filter((k) => !(k in en))).toEqual([]);
  });

  it('covers every label and meaning held in the room’s vocabulary maps', () => {
    const names = ['DOMAIN_LABEL', 'SCOPE_LABEL', 'SCOPE_MEANING', 'LIFECYCLE_LABEL', 'LIFECYCLE_MEANING', 'ENV_LABEL', 'CLASS_LABEL',
      'RECORD_CLASS_LABEL', 'RECORD_TYPE_LABEL', 'EFFECT_LABEL', 'AUTONOMY_LABEL', 'ROLE_LABEL', 'INVARIANT_LABEL'];
    const values = names.flatMap((n) => [...objectLiteral(JS, n).matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\'/g, "'")));
    expect(values.length).toBeGreaterThan(70);
    expect(values.filter((v) => !(v in en))).toEqual([]);
  });

  it('covers every title and purpose the registry’s manifests carry, so a new agent arrives translated', () => {
    const fromManifests = platformAgentRegistry().list().flatMap((a) => [a.title, a.purpose]);
    expect(fromManifests.filter((k) => !(k in en))).toEqual([]);
  });

  it('covers every sentence the server writes into an invariant, holding or failing', () => {
    const holding = operationsRoomOverview().invariants.map((i) => i.detail.replace(/\d+/g, '%d'));
    expect(holding.filter((k) => !(k in en))).toEqual([]);
    const svc = read('src/platform/agents/operations-room.service.ts');
    const prefixes = [...svc.matchAll(/`([^`$:]+): \$\{names\(/g)].map((m) => m[1]);
    expect(prefixes.length).toBe(8);
    expect(prefixes.filter((k) => !(k in en))).toEqual([]);
  });

  it('prints hostile server text as text in a German session too, where what the catalogue does not hold is shown as English', async () => {
    const o = real();
    Object.assign(o.agents[0], { title: PAYLOAD });
    o.invariants[0] = { ...o.invariants[0], detail: PAYLOAD };
    o.invariants[1] = { ...o.invariants[1], holds: false, detail: 'Not valid: ' + PAYLOAD };
    const h = (await runRoom(o, undefined, de)).html();
    expect(h).toContain('<span lang="en" dir="ltr">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(h).toContain(de['Not valid'] + ': <bdi dir="ltr" data-no-i18n>&quot;&gt;&lt;img');
    expect(h).not.toMatch(/<(img|script)\b/);
    expect(h).not.toContain(PAYLOAD);
  });

  it('translates on the way in: German labels in a German session, identifiers left as they are', async () => {
    const room = await runRoom(real(), undefined, de);
    const h = room.html();
    expect(h).toContain(de['AI Agents Operations Room']);
    expect(h).toContain(de['Every invariant holds']);
    expect(h).toContain(de['Club operations']);
    expect(h).not.toContain('>Club operations<');
  });
});
