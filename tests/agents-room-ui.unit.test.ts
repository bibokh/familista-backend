/**
 * The AI Agents Operations Room — the screen
 *
 * The Platform Owner's global room for the Agent Registry (public/agents-room/). What Jest can prove:
 *   - it is wired as an owner-only room of its own, loaded on demand, reached from SYSTEM → AI Agent Control, outside
 *     every Club Workspace and with no Owner Home card;
 *   - it is read-only by construction: one GET-only reader, three endpoints, no verb that writes, no kill-switch call;
 *   - it discovers what it draws: rendered against the real registry it draws every agent and every domain, and a
 *     domain and an agent added to the registry appear with no change to the room;
 *   - it prints whatever the registry holds as text, and says so when the registry does not answer as its contract says;
 *   - its source is CSP-safe and its stylesheet reads only tokens that exist and keeps the owner rooms' layout rules;
 *   - its English, German and Arabic catalogues cover everything it says, the manifests' own titles and purposes too;
 *   - its LAB workflows (AI-0.3) draw only what the server verified: every run, task and handoff of the published
 *     evidence, each state as its own kind, nothing at all when the evidence is missing or did not verify;
 *   - its approved LAB executions (AI-0.5) are drawn only as the server verified them: every outcome, the stop, every
 *     governance decision, the execution log and the checks, and nothing at all of a reply that is not VERIFIED.
 * What it cannot prove (real pointer and keyboard input, layout, hit-testing, focus, CSP in a browser, axe) is proved by
 * sections 16 and 16a of tools/components/lab-browser-proof.cjs.
 */
import fs from 'fs';
import path from 'path';
import { operationsRoomAgent, operationsRoomOverview } from '../src/platform/agents/operations-room.service';
import { platformAgentRegistry } from '../src/platform/agents/catalog';
import { OWNER_API_CONTRACTS } from '../src/contracts/owner-api.contracts';
import { orchestrationRoomView, ORCHESTRATION_EVIDENCE_NOTICE } from '../src/platform/agents/orchestration-evidence';
import { publicationsRoomView, APPROVAL_RULE, EXECUTION_EVIDENCE_NOTICE } from '../src/platform/agents/execution-evidence';
import { RUNTIME_AGENTS, runtimeRegistryState } from '../src/platform/intelligence/agent-jobs';

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

  it('asks for the registry, one manifest, the LAB evidence and the approved executions, and for nothing else', () => {
    const calls = [...CODE.matchAll(/\bapi\(('[^']*'(?: \+ encodeURIComponent\(id\))?|[a-z]+)\)/g)].map((m) => m[1]).filter((a) => a !== 'path');
    expect(CODE.match(/\bapi\(/g)).toHaveLength(calls.length + 1); // + its definition: no other call reaches the reader
    expect(calls.sort()).toEqual(["'/system/agents'", "'/system/agents/' + encodeURIComponent(id)", "'/system/agents/orchestration'", "'/system/agents/publications'", "'/system/agents/runtime'"].sort());
    expect(CODE).not.toContain('kill-switch');
    expect(CODE).not.toMatch(/data-ar-(kill|engage|activate|start|stop|run|approve|publish|prepare|merge)/);
  });

  it('draws the kill switch as a state only, as the registry endpoint reports it', () => {
    expect(CODE).toContain("ks.engaged === true ? 'warn' : 'none'");
    expect(CODE).toContain("T('State only. It is changed in SYSTEM → AI Agent Control.')");
  });

  it('is covered by the owner API contract, in both directions', () => {
    const mine = OWNER_API_CONTRACTS.filter((c) => c.consumer === 'public/agents-room/agents-room.js').map((c) => c.endpoint);
    expect(mine).toEqual(['/system/agents', '/system/agents/runtime', '/system/agents/club.tactical', '/system/agents/orchestration', '/system/agents/publications']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The room drawn by its real source, in a sandbox, against the registry the server builds.

const PAYLOAD = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
/* eslint-disable @typescript-eslint/no-explicit-any */
type Room = {
  html: () => string; click: (target: any) => Promise<void>; insp: () => string;
  /** The latest HTML of one repainted region, and how many times it was painted (with `regions`). */
  region: (sel: string) => string; paints: (sel: string) => number;
  calls: string[]; missing: () => string[];
};
/**
 * `orch` answers /system/agents/orchestration and `pub` /system/agents/publications (by default what this build
 * ships: verified, and empty); `regions` gives the room the view and workflow regions it repaints in place.
 */
type RoomOpts = { orch?: unknown; pub?: unknown; regions?: boolean; lang?: string };

function runRoom(overview: unknown, detail?: (id: string) => unknown, locale?: Record<string, string>, opts: RoomOpts = {}): Promise<Room> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vm = require('vm');
  const html: string[] = [];
  const inspHtml: string[] = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  const insp: any = {
    set innerHTML(v: string) { inspHtml.push(v); }, get innerHTML() { return inspHtml[inspHtml.length - 1] || ''; },
    classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, querySelector: () => null,
  };
  const painted: Record<string, string[]> = {};
  const regions: Record<string, any> = {};
  const region = (sel: string): any => ({
    set innerHTML(v: string) { (painted[sel] = painted[sel] || []).push(v); }, get innerHTML() { const r = painted[sel]; return r ? r[r.length - 1] : ''; },
    setAttribute() {}, removeAttribute() {}, classList: { add() {}, remove() {}, toggle() {} }, scrollTop: 0, textContent: '',
  });
  const REGIONS = ['#ar-view', '#ar-count', '#ar-wf-detail', '#ar-wf-trace', '#ar-rt'];
  const calls: string[] = [];
  const host: any = {
    set innerHTML(v: string) { html.push(v); }, get innerHTML() { return html[html.length - 1] || ''; },
    setAttribute() {}, contains: () => false, querySelectorAll: () => [],
    querySelector: (s: string) => (s === '#ar-insp' ? insp : opts.regions && REGIONS.includes(s) ? (regions[s] = regions[s] || region(s)) : null),
    addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; },
  };
  const reply = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: body }) });
  const sandbox: any = {
    document: { getElementById: () => host },
    localStorage: { getItem: () => opts.lang || (locale ? 'de' : null), setItem: () => {} },
    fetch: (u: string) => {
      if (String(u).includes('/i18n/')) return Promise.resolve({ ok: true, json: () => Promise.resolve(locale || {}) });
      calls.push(String(u).replace(/^.*\/system\//, '/system/'));
      const m = /\/system\/agents\/(.+)$/.exec(String(u));
      if (m && m[1] === 'runtime') {
        if (RT === 'HOLD') return new Promise(() => undefined);
        return RT === 'FAIL' ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }) : reply(RT === undefined ? rtView() : RT);
      }
      if (m && m[1] === 'orchestration') return reply(opts.orch ?? null);
      if (m && m[1] === 'publications') return reply(opts.pub === undefined ? JSON.parse(JSON.stringify(publicationsRoomView(platformAgentRegistry()))) : opts.pub);
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
    region: (sel: string) => { const r = painted[sel]; return r ? r[r.length - 1] : ''; },
    paints: (sel: string) => (painted[sel] || []).length,
    calls, missing: () => sandbox.__familistaAgentsRoomMissing(),
    click: (target: any) => { listeners.click({ target }); return settle(); },
  }));
}
/** A click target that answers `closest` for one selector only, as a delegated click on that element would. */
const on = (selector: string, attrs: Record<string, string>) => ({
  closest: (s: string) => (s.split(',').map((x) => x.trim()).includes(selector) ? { getAttribute: (k: string) => attrs[k] ?? null, closest: () => null, hasAttribute: (k: string) => k in attrs } : null),
});
const real = () => JSON.parse(JSON.stringify(operationsRoomOverview()));
/** What GET /system/agents/runtime answers in a room under test: `RT` when a test sets it, a quiet day otherwise; 'FAIL' answers HTTP 500 and 'HOLD' never answers. */
let RT: unknown;
const zeroKinds = () => ({ registry: 0, authorization: 0, approval: 0, stalled: 0, execution: 0 });
function rtView(over: Record<string, unknown> = {}) {
  return JSON.parse(JSON.stringify({
    generatedAt: '2026-10-29T12:00:00.000Z', windowHours: 24, registry: runtimeRegistryState(), killSwitch: { engaged: false },
    queue: { pending: 0, oldestPendingSeconds: null, running: 0, stalled: 0, state: 'CLEAR' },
    agents: RUNTIME_AGENTS.map((agent) => ({ agent, runs: true, refusedCode: null, queued: 0, succeeded: 0, failed: 0, cancelled: 0, inFlight: 0, failures: zeroKinds(), approvalsPending: 0, lastSucceededAt: null })),
    totals: { queued: 0, succeeded: 0, failed: 0, cancelled: 0, inFlight: 0, approvalsPending: 0, failures: zeroKinds() },
    failureSample: { read: 0, limit: 2000, complete: true }, unavailable: null,
    ...over,
  }));
}
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
describe('the Runtime panel: what the registry’s agents actually did', () => {
  afterEach(() => { RT = undefined; });
  const busy = () => rtView({
    queue: { pending: 3, oldestPendingSeconds: 125, running: 1, stalled: 0, state: 'DRAINING' },
    agents: RUNTIME_AGENTS.map((agent) => ({
      agent, runs: true, refusedCode: null, queued: agent === 'COMMS' ? 12 : 0, succeeded: agent === 'COMMS' ? 7 : 0,
      failed: agent === 'COMMS' ? 3 : 0, cancelled: 0, inFlight: agent === 'COMMS' ? 2 : 0,
      failures: agent === 'COMMS' ? { registry: 0, authorization: 1, approval: 1, stalled: 0, execution: 1 } : zeroKinds(),
      approvalsPending: agent === 'COMMS' ? 2 : 0, lastSucceededAt: agent === 'COMMS' ? '2026-10-29T11:00:00.000Z' : null,
    })),
    totals: { queued: 12, succeeded: 7, failed: 3, cancelled: 0, inFlight: 2, approvalsPending: 2, failures: { registry: 0, authorization: 1, approval: 1, stalled: 0, execution: 1 } },
    failureSample: { read: 3, limit: 2000, complete: true },
  });
  const panelOf = (h: string) => h.slice(h.indexOf('<div id="ar-rt">'), h.indexOf('</section></div>', h.indexOf('<div id="ar-rt">')) + 16);

  it('reads the runtime beside the registry, after it, once', async () => {
    const room = await runRoom(real());
    expect(room.calls).toEqual(['/system/agents', '/system/agents/runtime']);
  });

  it('shows the registry the runtime enforces, the queue, the day’s totals, why jobs failed and each agent, titled by its manifest', async () => {
    RT = busy();
    const o = real();
    const h = panelOf((await runRoom(o)).html());
    expect(h).toContain('The runtime enforces this registry');
    expect(h).toContain(o.registry.digest.slice(0, 16));
    expect(h).toContain('All 10 runtime agents may run');
    expect(h).toContain('Jobs waiting: 3');
    expect(h).toContain('The oldest has waited 2 min');
    expect(h).toContain('No job is stalled');
    expect(h).toContain('Last 24 hours');
    for (const [k, v] of [['Queued', '12'], ['Succeeded', '7'], ['Failed', '3'], ['Cancelled', '0'], ['Still in flight', '2'], ['Waiting on a person', '2']]) {
      expect(h).toMatch(new RegExp(`<div class="ar-kv-k">${k}</div><div class="ar-kv-v">${v}</div>`));
    }
    for (const k of ['Refused by the registry', 'Refused before running', 'Approval rejected or expired', 'Stalled', 'Failed while running']) expect(h).toContain(k);
    // One row per runtime agent, named by the manifest the registry binds to it.
    const rows = [...h.matchAll(/<tr><th scope="row"><span class="ar-rt-agent"[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(rows).toEqual(RUNTIME_AGENTS.map((a) => o.agents.find((x: { runtimeAgent: string }) => x.runtimeAgent === a).title));
    expect(h).toContain('Last success');
    expect(h).toContain('No success in 30 days');
  });

  it('a measured zero is drawn as 0; a history the server could not read is said so, never drawn as 0', async () => {
    RT = rtView();
    const quiet = panelOf((await runRoom(real())).html());
    expect(quiet).toContain('No job is waiting');
    expect(quiet).toContain('Nothing has waited.');
    expect(quiet).toContain('Nothing is running.');
    // Every kind of failure is drawn, each with its measured 0.
    expect([...quiet.matchAll(/<span class="ar-bar-n">([^<]*)<\/span>/g)].map((m) => m[1])).toEqual(['0', '0', '0', '0', '0']);
    expect(quiet).toMatch(/<div class="ar-kv-k">Queued<\/div><div class="ar-kv-v">0<\/div>/);
    RT = rtView({ queue: null, agents: null, totals: null, failureSample: null, unavailable: 'Agent job history is not readable in this deployment.' });
    const unread = panelOf((await runRoom(real())).html());
    expect(unread).toContain('The runtime enforces this registry');
    expect(unread).toMatch(/ar-inv-i--crit[\s\S]*The queue could not be read[\s\S]*ar-inv-i--crit[\s\S]*Stalled jobs could not be read[\s\S]*Every figure below is unknown, not zero\./);
    expect(unread).toContain('Failed jobs could not be read.');
    // The same shape as a read day, and not one figure in it is a 0: each is —.
    const figures = [
      ...[...unread.matchAll(/<div class="ar-kv-v">([^<]*)<\/div>/g)].map((m) => m[1]),
      ...[...unread.matchAll(/<span class="ar-bar-n">([^<]*)<\/span>/g)].map((m) => m[1]),
      ...[...unread.matchAll(/<td class="ar-num">([^<]*)<\/td>/g)].map((m) => m[1]),
    ];
    expect(figures).toHaveLength(6 + 5 + 3 * RUNTIME_AGENTS.length);
    expect(new Set(figures)).toEqual(new Set(['—']));
  });

  it('a backlog, a stalled job, a refused agent, an invalid or a different registry are failing checks', async () => {
    RT = rtView({ queue: { pending: 9, oldestPendingSeconds: 900, running: 2, stalled: 1, state: 'BACKLOG' } });
    const slow = panelOf((await runRoom(real())).html());
    expect(slow).toMatch(/ar-inv-i--crit[\s\S]*Jobs waiting: 9[\s\S]*the queue is not draining/);
    expect(slow).toMatch(/ar-inv-i--crit[\s\S]*Jobs stalled: 1/);
    RT = rtView({ registry: { ...runtimeRegistryState(), refused: [{ agent: 'TACTICAL', code: 'NOT_RUNNING' }] } });
    expect(panelOf((await runRoom(real())).html())).toMatch(/ar-inv-i--crit[\s\S]*Agents that may not run: 1[\s\S]*Not RUNNING in the registry/);
    RT = rtView({ registry: { state: 'INVALID', digest: null, running: [], refused: [], failure: 'Agent manifest "club.x" is not valid: <img src=x onerror=alert(1)>' } });
    const invalid = panelOf((await runRoom(real())).html());
    expect(invalid).toMatch(/ar-inv-i--crit[\s\S]*The registry did not validate/);
    expect(invalid).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(invalid).not.toContain('<img');
    RT = rtView({ registry: { ...runtimeRegistryState(), digest: 'f'.repeat(64) } });
    expect(panelOf((await runRoom(real())).html())).toMatch(/ar-inv-i--crit[\s\S]*The runtime enforces a different registry[\s\S]*ffffffffffffffff/);
  });

  it('a runtime that cannot be read leaves the room drawn and offers to try again; a reply missing its fields is a contract error', async () => {
    RT = 'FAIL';
    const down = await runRoom(real());
    expect(nodes(down.html()).length).toBe(real().agents.length);
    expect(panelOf(down.html())).toMatch(/The runtime could not be read[\s\S]*The platform answered HTTP 500\.[\s\S]*data-ar-rt-retry/);
    RT = { windowHours: 24 };
    expect(panelOf((await runRoom(real())).html())).toMatch(/CONTRACT ERROR · \/system\/agents\/runtime · the response did not carry: registry, queue, agents, totals, failureSample, unavailable/);
  });

  it('repaints only its own region when the runtime arrives or is retried', async () => {
    RT = 'FAIL';
    const room = await runRoom(real(), undefined, undefined, { regions: true });
    RT = busy();
    const before = room.paints('#ar-rt');
    await room.click(on('[data-ar-rt-retry]', {}));
    expect(room.paints('#ar-rt')).toBeGreaterThan(before);
    expect(room.region('#ar-rt')).toContain('Jobs waiting: 3');
    expect(room.calls.filter((c) => c === '/system/agents/runtime')).toHaveLength(2);
    expect(room.calls.filter((c) => c === '/system/agents')).toHaveLength(1);
  });

  it('in German and Arabic every sentence it draws is translated, and its label maps are in all three catalogues', async () => {
    RT = busy();
    for (const tag of ['de', 'ar']) {
      const room = await runRoom(real(), undefined, json(`public/agents-room/i18n/${tag}.json`) as Record<string, string>, { lang: tag });
      expect([tag, room.missing()]).toEqual([tag, []]);
    }
    const en = json('public/agents-room/i18n/en.json') as Record<string, string>;
    const values = ['FAILURE_LABEL', 'REFUSAL_LABEL_RT'].flatMap((n) => [...objectLiteral(JS, n).matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]));
    expect(values).toHaveLength(8);
    expect(values.filter((v) => !(v in en))).toEqual([]);
  });

  it('its skeleton has the shape of what it stands in for, so the panels below it do not move when it arrives', async () => {
    const shape = (h: string) => ({
      checks: (h.match(/<li class="ar-inv-i/g) || []).length,
      totals: [...h.matchAll(/<div class="ar-kv-k">([^<]+)<\/div>/g)].map((m) => m[1]),
      bars: (h.match(/<li class="ar-bar">/g) || []).length,
      rows: (h.match(/<tr><th scope="row">/g) || []).length,
      subs: [...h.matchAll(/<div class="ar-sub">([^<]+)<\/div>/g)].map((m) => m[1]),
    });
    RT = 'HOLD';
    const waiting = panelOf((await runRoom(real())).html());
    expect(waiting).toContain('ar-rt-skel');
    for (const view of [rtView(), busy(), rtView({ queue: null, agents: null, totals: null, failureSample: null, unavailable: 'Agent job history is not readable in this deployment.' })]) {
      RT = view;
      expect(shape(waiting)).toEqual(shape(panelOf((await runRoom(real())).html())));
    }
    expect(shape(waiting)).toMatchObject({ checks: 4, bars: 5, rows: RUNTIME_AGENTS.length });
  });

  it('draws only what the server counted: it reads no club, no person, no job and offers no control', () => {
    const start = JS.indexOf('function loadRuntime()');
    const fn = JS.slice(start, JS.indexOf("+ totals + kinds + rtTable(rows);", start));
    expect(fn.length).toBeGreaterThan(2000);
    expect(fn).not.toMatch(/clubId|teamId|triggeredBy|\.input\b|\.output\b|\.error\b/);
    expect(fn).not.toMatch(/data-ar-(kill|engage|activate|start|stop|run|approve|cancel|retry-job|requeue)/);
  });
});

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
    const calls = [...CODE.matchAll(/\b(?:T|tf|panel|kv|emptyState|groupNote|cell|th|td|chip\([^,]+,)\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
    const pairs = [...CODE.matchAll(/\b(?:tab|select)\('[^']+',\s*'((?:[^'\\]|\\.)*)'(?:,\s*'((?:[^'\\]|\\.)*)')?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean) as string[];
    const ternary = [...CODE.matchAll(/\bT\([^()']*\?\s*'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'\)/g)].flatMap((m) => [m[1], m[2]]);
    const keys = [...new Set([...calls, ...pairs, ...ternary])].filter((k) => /[A-Za-z]{2}/.test(k));
    expect(keys.length).toBeGreaterThan(100);
    expect(ternary).toEqual(expect.arrayContaining(['Reading…', 'Refresh']));
    expect(keys.filter((k) => !(k in en))).toEqual([]);
  });

  it('covers every label and meaning held in the room’s vocabulary maps', () => {
    const names = ['DOMAIN_LABEL', 'SCOPE_LABEL', 'SCOPE_MEANING', 'LIFECYCLE_LABEL', 'LIFECYCLE_MEANING', 'ENV_LABEL', 'CLASS_LABEL',
      'RECORD_CLASS_LABEL', 'RECORD_TYPE_LABEL', 'EFFECT_LABEL', 'AUTONOMY_LABEL', 'ROLE_LABEL', 'INVARIANT_LABEL',
      'STATE_LABEL', 'STATE_MEANING', 'OUTCOME_LABEL', 'TRACE_LABEL', 'CODE_LABEL', 'LOG_LABEL', 'CHECK_LABEL'];
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

// ─────────────────────────────────────────────────────────────────────────────
describe('LAB workflows (AI-0.3): what the LAB orchestrator decided, drawn only from verified evidence', () => {
  const en = json('public/agents-room/i18n/en.json') as Record<string, string>;
  const verified = () => JSON.parse(JSON.stringify(orchestrationRoomView(platformAgentRegistry())));
  /** How the room draws each task state: a kind of its own for each, so none is told apart by colour alone. */
  const KIND: Record<string, string> = { SUCCEEDED: 'done', AWAITING_APPROVAL: 'approval', PENDING: 'waiting', REJECTED: 'rejected', FAILED: 'failed', SKIPPED: 'skipped', REFUSED: 'blocked' };
  const taskNodes = (h: string) => [...h.matchAll(/<g class="ar-wf-node ar-wf-node--([a-z]+)[^"]*"[^>]*data-ar-task="([^"]+)"/g)].map((m) => ({ kind: m[1], id: m[2] }));
  const runButtons = (h: string) => [...h.matchAll(/data-ar-wf="([0-9a-f]{64})"/g)].map((m) => m[1]);
  const edges = (h: string) => [...h.matchAll(/<path class="ar-wf-edge ar-wf-edge--([a-z]+)"/g)].map((m) => m[1]);
  const open = async (orch: unknown, locale?: Record<string, string>, lang?: string) => {
    const room = await runRoom(real(), (id) => operationsRoomAgent(id), locale, { orch, regions: true, lang });
    await room.click(on('[data-ar-view]', { 'data-ar-view': 'workflows' }));
    return room;
  };

  it('reads the LAB evidence only when the workflows are opened', async () => {
    const room = await runRoom(real(), undefined, undefined, { orch: verified(), regions: true });
    expect(room.calls).toEqual(['/system/agents', '/system/agents/runtime']);
    await room.click(on('[data-ar-view]', { 'data-ar-view': 'workflows' }));
    expect(room.calls).toEqual(['/system/agents', '/system/agents/runtime', '/system/agents/orchestration', '/system/agents/publications']);
  });

  it('lists every published run, and draws every task of the first as a node and every dependency as an edge', async () => {
    const orch = verified();
    const room = await open(orch);
    const h = room.region('#ar-view');
    expect([...new Set(runButtons(h))]).toEqual(orch.runs.map((r: { id: string }) => r.id));
    const first = orch.runs[0];
    expect(taskNodes(h).map((n) => n.id)).toEqual(first.tasks.map((t: { id: string }) => t.id));
    expect(edges(h)).toHaveLength(first.tasks.reduce((n: number, t: { dependsOn: string[] }) => n + t.dependsOn.length, 0));
    expect(h).toContain(orch.evidenceDigest.slice(0, 16));
    expect(h).toContain('Hash chain verified by the server');
    expect(h).toContain(ORCHESTRATION_EVIDENCE_NOTICE);
  });

  it('draws each state as its own kind across the runs: completed, awaiting approval, rejected, failed, skipped, blocked', async () => {
    const orch = verified();
    const room = await open(orch);
    const seen = new Set<string>();
    for (const r of orch.runs) {
      await room.click(on('[data-ar-wf]', { 'data-ar-wf': r.id }));
      const h = room.region('#ar-view');
      const drawn = taskNodes(h);
      expect([r.scenario, drawn.map((n) => `${n.id}:${n.kind}`)]).toEqual([r.scenario, r.tasks.map((t: { id: string; state: string }) => `${t.id}:${KIND[t.state]}`)]);
      drawn.forEach((n) => seen.add(n.kind));
      // A handoff is drawn as the evidence recorded it: accepted, blocked, or never reached.
      const want = r.tasks.flatMap((t: { dependsOn: string[]; inputs: Array<{ from: string; status: string }> }) =>
        t.dependsOn.map((d) => { const i = t.inputs.find((x) => x.from === d); return i ? i.status.toLowerCase() : 'unreached'; })).sort();
      expect([r.scenario, edges(h).sort()]).toEqual([r.scenario, want]);
      if (r.refusal) expect(h).toContain('The plan was refused before anything was routed or ran');
    }
    expect([...seen].sort()).toEqual(['approval', 'blocked', 'done', 'failed', 'rejected', 'skipped']);
  });

  it('a task chosen repaints its detail and the trace only; the canvas is not redrawn', async () => {
    const orch = verified();
    const med = orch.runs.find((r: { scenario: string }) => r.scenario === 'medical-boundary');
    const room = await open(orch);
    await room.click(on('[data-ar-wf]', { 'data-ar-wf': med.id }));
    const views = room.paints('#ar-view');
    await room.click(on('[data-ar-task]', { 'data-ar-task': 'recommendation' }));
    expect(room.paints('#ar-view')).toBe(views);
    const d = room.region('#ar-wf-detail');
    expect(d).toContain('No approver role may read');
    expect(d).toContain('data-ar-agent="club.medical"');
    expect(room.region('#ar-wf-trace')).toContain('is-task');
  });

  it.each([
    ['NOT_GENERATED', 'No LAB evidence has been published'],
    ['INVALID', 'The LAB evidence did not verify, so none of it is shown'],
  ] as const)('negative: %s evidence is an empty state, and not one run, node or edge', async (state, title) => {
    const orch = orchestrationRoomView(platformAgentRegistry(), { state, reason: 'integrity: run x: the trace chain breaks at event 2' });
    const h = (await open(orch)).region('#ar-view');
    expect(h).toContain(title);
    expect(runButtons(h)).toEqual([]);
    expect(taskNodes(h)).toEqual([]);
    expect(edges(h)).toEqual([]);
  });

  it('negative: even if a reply that is not VERIFIED carried runs, none is drawn', async () => {
    const orch = { ...verified(), state: 'INVALID', reason: 'integrity: tampered' };
    const h = (await open(orch)).region('#ar-view');
    expect(taskNodes(h)).toEqual([]);
    expect(runButtons(h)).toEqual([]);
  });

  it('negative: a reply that breaks its contract names what is missing, offers to try again, and draws nothing', async () => {
    const orch = verified();
    delete orch.notice;
    const room = await open(orch);
    const h = room.region('#ar-view');
    expect(h).toContain('notice');
    expect(h).toContain('data-ar-wf-retry');
    expect(taskNodes(h)).toEqual([]);
    // Asked once, not again and again: the next read is the owner's.
    const asked = () => room.calls.filter((c) => c === '/system/agents/orchestration').length;
    expect(asked()).toBe(1);
    await room.click(on('[data-ar-wf-retry]', {}));
    expect(asked()).toBe(2);
  });

  it('prints hostile evidence text as text: a run title, a reason, a trace detail', async () => {
    const orch = verified();
    orch.runs[0].title = PAYLOAD;
    orch.runs[0].tasks[0].reason = { code: 'OPERATION_FAILED', message: PAYLOAD };
    orch.runs[0].trace[0].detail = PAYLOAD;
    const room = await open(orch);
    await room.click(on('[data-ar-task]', { 'data-ar-task': orch.runs[0].tasks[0].id }));
    const all = room.region('#ar-view') + room.region('#ar-wf-detail') + room.region('#ar-wf-trace');
    expect(all).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(all).not.toMatch(/<(img|script)\b/);
    expect(all).not.toContain(PAYLOAD);
  });

  it('holds no list of runs, scenarios or states of the evidence\'s own, and has no control that would run one', () => {
    for (const r of verified().runs) expect(`${r.scenario}:${CODE.includes(r.scenario)}`).toBe(`${r.scenario}:false`);
    expect(CODE).not.toMatch(/data-ar-(submit|execute|approve|reject|decide)/);
  });

  it('carries every run title and operation title the published evidence holds into the catalogue', () => {
    const orch = verified();
    const titles = [...orch.runs.map((r: { title: string }) => r.title), ...orch.operations.map((o: { title: string }) => o.title)];
    expect(titles.filter((k: string) => !(k in en))).toEqual([]);
  });

  it.each(['de', 'ar'])('%s: every run, task and trace view asks the catalogue for nothing it does not hold', async (tag) => {
    const dict = json(`public/agents-room/i18n/${tag}.json`) as Record<string, string>;
    const orch = verified();
    const room = await open(orch, dict, tag);
    for (const r of orch.runs) {
      await room.click(on('[data-ar-wf]', { 'data-ar-wf': r.id }));
      for (const t of r.tasks) await room.click(on('[data-ar-task]', { 'data-ar-task': t.id }));
      await room.click(on('[data-ar-trace]', { 'data-ar-trace': 'task' }));
      await room.click(on('[data-ar-trace]', { 'data-ar-trace': 'all' }));
    }
    expect(room.missing()).toEqual([]);
    expect(room.region('#ar-view')).toContain(dict['LAB workflow']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('approved LAB executions (AI-0.5): drawn only as the server verified them', () => {
  const en = json('public/agents-room/i18n/en.json') as Record<string, string>;
  /** What the room WOULD draw were every gallery execution approved: the Lab's rehearsal (lab:publish -- gallery). None is. */
  const gallery = () => json('tests/fixtures/agents/publications-room-view.json');
  const shipped = () => JSON.parse(JSON.stringify(publicationsRoomView(platformAgentRegistry())));
  const pubButtons = (h: string) => [...h.matchAll(/data-ar-wf="x:(pub-[0-9a-f]{24})"/g)].map((m) => m[1]);
  const taskNodes = (h: string) => [...h.matchAll(/<g class="ar-wf-node ar-wf-node--([a-z]+)[^"]*"[^>]*data-ar-task="([^"]+)"/g)].map((m) => ({ kind: m[1], id: m[2] }));
  const open = async (pub: unknown, locale?: Record<string, string>, lang?: string) => {
    const room = await runRoom(real(), (id) => operationsRoomAgent(id), locale, { orch: JSON.parse(JSON.stringify(orchestrationRoomView(platformAgentRegistry()))), pub, regions: true, lang });
    await room.click(on('[data-ar-view]', { 'data-ar-view': 'workflows' }));
    return room;
  };
  type Pub = { publicationId: string; reference: string; dossierDigest: string; evidence: { run: { outcome: string; stop: { code: string } | null; tasks: Array<{ id: string; state: string }> }; log: Array<{ type: string; code: string | null }>; plan: { title: string } } };

  it('this build ships none: the group says so, with the rule, and the AI-0.3 workflows are drawn as before', async () => {
    const v = shipped();
    expect([v.state, v.publications.length, v.unapproved]).toEqual(['VERIFIED', 0, []]);
    const h = (await open(v)).region('#ar-view');
    expect(h).toContain('Approved LAB executions');
    expect(h).toContain('No LAB execution has been approved for publication yet.');
    expect(h).toContain(APPROVAL_RULE);
    expect(pubButtons(h)).toEqual([]);
    expect(h).toContain('LAB workflow'); // the first AI-0.3 run is the one drawn
  });

  it('lists every approved execution first, and draws the first: its approval, its checks, its log', async () => {
    const v = gallery();
    const h = (await open(v)).region('#ar-view');
    expect(pubButtons(h)).toEqual(v.publications.map((p: Pub) => p.publicationId));
    const first = v.publications[0] as Pub;
    expect(h).toContain('Approved LAB execution');
    expect(h).toContain(first.reference);
    expect(h).toContain(first.dossierDigest.slice(0, 16));
    expect(h).toContain('Approved for publication');
    expect(h).toContain(EXECUTION_EVIDENCE_NOTICE);
    expect(h).toContain('Submitted by (synthetic LAB operator, not an approver)');
    for (const c of v.checks) expect(h).toContain(c.detail);
    expect(h).toContain('Execution log');
    expect(h).toContain('The submitter may not approve'); // the head coach's own approval, refused and recorded
  });

  it('draws every outcome, every stop and every cancelled task as its own kind', async () => {
    const v = gallery();
    const room = await open(v);
    const outcomes = new Set<string>();
    const kinds = new Set<string>();
    for (const p of v.publications as Pub[]) {
      await room.click(on('[data-ar-wf]', { 'data-ar-wf': `x:${p.publicationId}` }));
      const h = room.region('#ar-view');
      const r = p.evidence.run;
      outcomes.add(r.outcome);
      const drawn = taskNodes(h);
      expect([p.publicationId, drawn.map((n) => n.id)]).toEqual([p.publicationId, r.tasks.map((t) => t.id)]);
      drawn.forEach((n) => kinds.add(n.kind));
      expect(drawn.filter((n) => n.kind === 'cancelled').map((n) => n.id)).toEqual(r.tasks.filter((t) => t.state === 'CANCELLED').map((t) => t.id));
      if (r.outcome === 'HALTED') expect(h).toContain('Halted by governance before it finished');
      if (r.outcome === 'CANCELLED') expect(h).toContain('Cancelled by an operator before it finished');
      if (r.stop?.code === 'KILL_SWITCH') { expect(h).toContain('Kill switch'); expect(h).toContain('Decision refused'); }
      if (r.stop?.code === 'EXECUTION_LIMIT') expect(h).toContain('Execution limit reached');
      if (p.evidence.log.some((e) => e.type === 'CANCEL_REFUSED')) expect(h).toContain('Cancellation refused');
      if (!r.stop) expect(h).not.toContain('ar-wf-stopped');
    }
    expect([...outcomes].sort()).toEqual(['AWAITING_APPROVAL', 'CANCELLED', 'COMPLETED', 'HALTED', 'PARTIAL']);
    expect([...kinds].sort()).toEqual(['approval', 'cancelled', 'done', 'failed', 'rejected', 'skipped']);
  });

  it('counts every refusal the log records, the orchestrator\'s included: a cross-club approval refused is "Refused: 1"', async () => {
    const v = gallery();
    const p = v.publications.find((x: Pub) => x.evidence.run.outcome === 'AWAITING_APPROVAL');
    expect(p.evidence.log.filter((e: { type: string; code: string | null }) => e.type === 'DECISION_SUBMITTED' && e.code === 'REFUSED')).toHaveLength(1);
    const room = await open(v);
    await room.click(on('[data-ar-wf]', { 'data-ar-wf': `x:${p.publicationId}` }));
    const h = room.region('#ar-view');
    expect(h).toContain('Decisions: 1 · Refused: 1');
    expect(h).toMatch(/ar-chip--blocked[^>]*><span class="ar-dot" aria-hidden="true"><\/span>Refused</);
  });

  it('negative: even if a reply that is not VERIFIED carried publications, none is drawn', async () => {
    for (const state of ['INVALID', 'NOT_GENERATED']) {
      const h = (await open({ ...gallery(), state, reason: 'publication pub-0: integrity: tampered' })).region('#ar-view');
      expect(pubButtons(h)).toEqual([]);
      expect(h).toContain(state === 'INVALID' ? 'The approved executions did not verify, so none of them is shown' : 'No approval record is beside this server');
      expect(h).toContain('LAB workflow'); // the AI-0.3 evidence is still drawn: one failing does not take the other down
    }
  });

  it('negative: a reply that breaks its contract names what is missing, offers to try again, and draws nothing of it', async () => {
    const v = gallery();
    delete v.rule;
    const room = await open(v);
    const h = room.region('#ar-view');
    expect(h).toContain('rule');
    expect(h).toContain('data-ar-pub-retry');
    expect(pubButtons(h)).toEqual([]);
    const asked = () => room.calls.filter((c) => c === '/system/agents/publications').length;
    expect(asked()).toBe(1);
    await room.click(on('[data-ar-pub-retry]', {}));
    expect(asked()).toBe(2);
  });

  it('says how many dossiers sit beside the record without an approval, and shows none of them', async () => {
    const h = (await open({ ...shipped(), unapproved: ['pub-0123456789abcdef01234567'] })).region('#ar-view');
    expect(h).toContain('Without approval: 1');
    expect(pubButtons(h)).toEqual([]);
    expect(h).not.toContain('pub-0123456789abcdef01234567');
  });

  it('prints hostile publication text as text: a title, a stop, a log detail, a reference', async () => {
    const v = gallery();
    const p = v.publications.find((x: Pub) => x.evidence.run.stop);
    p.evidence.plan.title = PAYLOAD;
    p.evidence.run.stop.message = PAYLOAD;
    p.evidence.log[0].detail = PAYLOAD;
    p.reference = PAYLOAD;
    const room = await open(v);
    await room.click(on('[data-ar-wf]', { 'data-ar-wf': `x:${p.publicationId}` }));
    const all = room.region('#ar-view');
    expect(all).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(all).not.toMatch(/<(img|script)\b/);
    expect(all).not.toContain(PAYLOAD);
  });

  it('draws what produced it: the definition, the commit and the source, and the rule that checks them; a rehearsal says it measured nothing', async () => {
    const v = gallery();
    const first = v.publications[0];
    expect(first.provenance.source.revision).toBe('0'.repeat(40));
    let h = (await open(v)).region('#ar-view');
    expect(h).toContain('Provenance and reproduction');
    expect(h).toContain('Rehearsal: no commit was measured');
    expect(h).toContain('None (rehearsal)');
    expect(h).not.toContain('Reproducible by deterministic replay');
    // Nothing was measured, so nothing is shown as a figure: absent, never zero.
    const prov = h.slice(h.indexOf('ar-wf-prov'));
    expect(prov).toMatch(/Source files<\/div><div class="ar-kv-v">—</);
    expect(prov).toMatch(/Operator steps replayed<\/div><div class="ar-kv-v">—</);
    expect(prov).not.toContain(first.provenance.source.digest.slice(0, 16));
    expect(prov).not.toContain('Definition reviewed in the repository'); // a rehearsal's definition is no file of the repository
    expect(h).toContain(first.provenance.definition.path);
    expect(h).toContain(first.provenance.statement);
    // Provenance from a real commit is drawn as such: the commit, the source digest, the packages it locked.
    const real = JSON.parse(JSON.stringify(v));
    real.publications[0].provenance.source = { ...real.publications[0].provenance.source, revision: 'ab12'.repeat(10), digest: 'cd34'.repeat(16), files: 26, packages: [{ name: 'zod', version: '4.6.7' }] };
    h = (await open(real)).region('#ar-view');
    expect(h).toContain('Reproducible by deterministic replay');
    expect(h).toMatch(/Source files<\/div><div class="ar-kv-v">26</);
    expect(h).toContain('Definition reviewed in the repository');
    expect(h).not.toContain('Rehearsal: no commit was measured');
    expect(h).toContain('<code data-no-i18n>ab12ab12ab12</code>');
    expect(h).toContain('<code data-no-i18n>cd34cd34cd34cd34</code>');
    expect(h).toContain('<code data-no-i18n>zod@4.6.7</code>');
    // A hostile definition name is text, never markup.
    const hostile = JSON.parse(JSON.stringify(v));
    hostile.publications[0].provenance.definition.name = '<img src=x onerror=alert(1)>';
    h = (await open(hostile)).region('#ar-view');
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('carries every sentence the server writes for a publication, and every title it carries, into the catalogue', () => {
    const v = gallery();
    const texts = [v.notice, v.rule, ...v.checks.map((c: { detail: string }) => c.detail), ...v.publications.map((p: { provenance: { statement: string } }) => p.provenance.statement),
      ...v.publications.flatMap((p: Pub & { evidence: { operations: Array<{ title: string }> } }) => [p.evidence.plan.title, ...p.evidence.operations.map((o) => o.title)])]
      .map((t: string) => t.replace(/\d+/g, '%d'));
    expect(texts.filter((k: string) => !(k in en))).toEqual([]);
  });

  it.each(['de', 'ar'])('%s: every publication, task and log view asks the catalogue for nothing it does not hold', async (tag) => {
    const dict = json(`public/agents-room/i18n/${tag}.json`) as Record<string, string>;
    const v = gallery();
    const room = await open(v, dict, tag);
    for (const p of v.publications as Pub[]) {
      await room.click(on('[data-ar-wf]', { 'data-ar-wf': `x:${p.publicationId}` }));
      for (const t of p.evidence.run.tasks) await room.click(on('[data-ar-task]', { 'data-ar-task': t.id }));
      await room.click(on('[data-ar-trace]', { 'data-ar-trace': 'task' }));
    }
    expect(room.missing()).toEqual([]);
    const h = room.region('#ar-view');
    expect(h).toContain(dict['Approved LAB execution']);
    expect(h).toContain(dict['Verification and publication']);
    expect(h).toContain(dict['Provenance and reproduction']);
    expect(h).toContain(dict['Rehearsal: no commit was measured']);
  });
});
