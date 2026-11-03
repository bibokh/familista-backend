/**
 * The Owner Control mind map — the Platform Owner's landing, redrawn around the
 * AI Agents Operations Room.
 *
 * What is pinned here:
 *   1. The map: the hub at the centre, CLUBS beneath it, the eight other rooms
 *      as two branches; every room's card is the card it was (title, words,
 *      door, status slot), and the markup order is the reading order.
 *   2. The agents beside each room come from the Agent Registry and nowhere
 *      else, placed by the manifest's own scope and domain; the hub's status
 *      says what the registry says, and an unreadable registry draws nothing.
 *   3. Owner-only: the map, its registry read and its listeners exist only in
 *      the Platform Owner's branch; a club member's landing is untouched.
 *   4. An agent opens the Operations Room on that agent's manifest, through a
 *      one-shot request the room honours only for an agent its registry lists.
 *   5. Nothing moves that the reader did not move: the lines are an overlay,
 *      hover changes no geometry, reduced motion stops the line, and the map
 *      becomes a scrolling list where it no longer fits.
 *   6. Every string the map can draw is in every locale's catalogue.
 *   7. The visual upgrade: every room's own illustration (a safe, wordless,
 *      figure-free vector), drawn icons instead of emoji, a circular hub whose
 *      ring carries the rooms' colours, connectors that leave the hub's rim and
 *      land on their card's edge, named agents under the hub, and a tablet grid
 *      that a later generic rule can no longer collapse.
 *   8. The language switch in the top bar: AR, EN and DE, the Platform Owner's
 *      alone, named from the locale registry, applied through the one
 *      existing path (I18N_APPLY.change), and redrawing the map after a change.
 * The real-browser checks of the same behaviour (geometry, Tab order, hover,
 * the room opening on an agent, loading and failure states, the club account)
 * are recorded in the pull request.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('public/app.js');
const CSS = read('public/app.css');
const LANDING = APP.slice(APP.indexOf('function _ownerHomeForPlatformOwner('), APP.indexOf('function _ownerHomeForClubMember('));
const MEMBER = APP.slice(APP.indexOf('function _ownerHomeForClubMember('), APP.indexOf('function renderOwnerHome('));
const HELPERS = APP.slice(APP.indexOf('// ── OWNER CONTROL MIND MAP: the agents beside each room'), APP.indexOf("/**\n * The platform owner's landing: four products"));

// ── a sandbox for the map's registry reader ──────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vm = require('vm');
type Reply = { ok: boolean; status: number; body?: unknown } | 'reject';
const esc = (s: unknown) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const HOSTS = ['clubs', 'system', 'cyber', 'algo', 'ds', 'vault', 'city', 'core', 'vision'];

async function runFill(reply: Reply, source = HELPERS) {
  const state: string[] = [];
  const calls: { url: string; opts: Record<string, any> }[] = [];
  const cap = { attrs: {} as Record<string, string>, textContent: '', classList: { add() {}, remove() {} }, setAttribute(k: string, v: string) { this.attrs[k] = v; } };
  const hosts = HOSTS.map((k) => ({ k, html: null as string | null, read: false, getAttribute: () => k, set innerHTML(v: string) { this.html = v; }, classList: { add(c: string) { if (c === 'is-read') (hosts.find((h) => h.k === k) as any).read = true; } } }));
  const map = { querySelectorAll: (q: string) => (q === '[data-oh-agents]' ? hosts : []), querySelector: () => null };
  const slot = { set outerHTML(v: string) { state.push(v); } };
  const sandbox: any = {
    window: { State: { token: 'tok' } }, localStorage: { getItem: () => null }, console,
    document: { getElementById: (id: string) => ({ 'oh-agents-state': slot, 'oh-agents-cap': cap, 'oh-map': map } as any)[id] || null },
    fetch: (url: string, opts: Record<string, any>) => {
      calls.push({ url, opts });
      return reply === 'reject' ? Promise.reject(new Error('net')) : Promise.resolve({ ok: reply.ok, status: reply.status, json: () => Promise.resolve(reply.body) });
    },
    _esc: esc,
    _vaultStatusHTML: (s: string, t: string) => `<span class="oh-card-state oh-card-state--${s}"><span class="oh-card-dot"></span>${esc(t)}</span>`,
    getComputedStyle: () => ({ display: 'block' }),
  };
  vm.runInNewContext(source + '\nthis.__fill = _fillAgentsMap; this.__home = _OH_AGENT_HOME;', sandbox);
  sandbox.__fill();
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  const by = Object.fromEntries(hosts.map((h) => [h.k, h.html]));
  return { state: state[state.length - 1] || '', calls, cap, by, hosts };
}
const agent = (id: string, domain: string, scope: string, lifecycle = 'RUNNING', title = id) => ({ id, version: '1.0.0', title, domain, scope, lifecycle });
const TEN = [
  ['club.big-data', 'DATA', 'Big Data'], ['club.club-manager', 'CLUB_OPERATIONS', 'Club Manager'], ['club.comms', 'COMMUNICATIONS', 'Communications'],
  ['club.device-mgmt', 'DEVICES', 'Device Management'], ['club.finance', 'FINANCE', 'Finance'], ['club.match-ops', 'MATCH_OPERATIONS', 'Match Operations'],
  ['club.medical', 'MEDICAL', 'Medical'], ['club.scouting', 'SCOUTING', 'Scouting'], ['club.tactical', 'TACTICS', 'Tactical'], ['club.training', 'TRAINING', 'Training'],
].map(([id, d, t]) => agent(id, d, 'CLUB', 'RUNNING', t));
const overview = (over: Record<string, unknown> = {}) => ({
  ok: true, status: 200,
  body: { success: true, data: { registry: { agents: 10 }, killSwitch: { engaged: false }, invariants: [{ id: 'a', holds: true }, { id: 'b', holds: true }], agents: TEN, ...over } },
});
const buttons = (html: string | null) => [...String(html || '').matchAll(/data-agent-id="([^"]+)"/g)].map((m) => m[1]);

// ─────────────────────────────────────────────────────────────────────────────
describe('1 · the map: the hub at the centre, every room a branch of it, every card the card it was', () => {
  it('puts the AI Agents Operations Room at the centre, as a real button that opens the room', () => {
    expect(LANDING).toContain('<div class="oh-cards oh-cards--core" id="oh-map">');
    expect(LANDING).toContain('<button class="oh-hub" data-action="navTo" data-page="agents-room" type="button">');
    expect(LANDING).toContain('<span class="oh-hub-title">AI AGENTS — OPERATIONS ROOM</span>');
    expect(LANDING).toContain('<span id="oh-agents-state" class="oh-card-state oh-card-state--idle"><span class="oh-card-dot"></span>Reading the Agent Registry…</span>');
    expect(LANDING).toContain('<span class="oh-hub-mark" aria-hidden="true">');
    // The lines are decoration: hidden from assistive technology, never focusable.
    expect(LANDING).toContain('<svg class="oh-links" id="oh-links" aria-hidden="true" focusable="false"></svg>');
  });

  it('keeps all nine rooms: their titles, their words, their doors and their status slots', () => {
    const doors = [...LANDING.matchAll(/<button class="oh-card oh-card--([a-z]+)" data-action="navTo" data-page="([a-z-]+)" type="button">/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(doors).toEqual(['clubs:clubs', 'system:system', 'cyber:cybersecurity', 'algo:algorithms', 'ds:design-system', 'vault:data-vault', 'city:infrastructure-city', 'core:source-core', 'vision:familista-vision']);
    for (const t of ['SYSTEM', 'CYBERSECURITY', 'CLUBS', 'ALGORITHMS', 'DATA VAULT', 'INFRASTRUCTURE CITY', 'SOURCE CORE', 'FAMILISTA VISION', 'DESIGN SYSTEM CONTROL']) {
      expect(LANDING).toContain(`<div class="oh-card-title">${t}</div>`);
    }
    for (const cta of ['Enter system area', 'Enter Cybersecurity', 'Select a club', 'Enter Algorithms', 'Open the vault', 'Enter the city', 'Enter the core', 'Open Vision', 'Enter Design System']) {
      expect(LANDING).toContain(`<div class="oh-card-cta">${cta} <span>→</span></div>`);
    }
    for (const id of ['oh-cyber-state', 'oh-algorithms-state', 'oh-vault-state', 'oh-city-state', 'oh-core-state', 'oh-vision-state', 'oh-design-state']) {
      expect(LANDING).toContain(`<span id="${id}" class="oh-card-state oh-card-state--idle">`);
    }
    // Every status is still read after paint, for the owner only, alongside the registry.
    expect(APP).toMatch(/if \(yes\) \{\s*try \{ _fillVaultStatus\(\); \} catch \(_\) \{\}[\s\S]{0,400}try \{ _fillDesignSystemStatus\(\); \} catch \(_\) \{\}\s*try \{ _fillAgentsMap\(\); \} catch \(_\) \{\}\s*try \{ _ohBindMap\(\); \} catch \(_\) \{\}\s*\}/);
  });

  it('wraps each room in a node with a slot for its agents, outside the card\'s button', () => {
    for (const k of ['system', 'cyber', 'algo', 'ds']) expect(LANDING).toContain(`<div class="oh-node oh-node--l" data-oh-node="${k}">`);
    for (const k of ['vault', 'city', 'core', 'vision']) expect(LANDING).toContain(`<div class="oh-node oh-node--r" data-oh-node="${k}">`);
    expect(LANDING).toContain('<div class="oh-node oh-node--clubs" data-oh-node="clubs">');
    for (const k of ['system', 'cyber', 'algo', 'ds', 'vault', 'city', 'core', 'vision']) {
      const at = LANDING.indexOf(`data-oh-node="${k}"`);
      const node = LANDING.slice(at, LANDING.indexOf('</div>\n        <div class="oh-node', at) > 0 ? LANDING.indexOf('</div>\n        <div class="oh-node', at) : LANDING.indexOf('<div class="oh-footer">'));
      // The slot follows the button's end: no interactive element is ever inside another.
      expect(node.indexOf(`<span class="oh-agents oh-agents--edge" data-oh-agents="${k}"></span>`)).toBeGreaterThan(node.lastIndexOf('</button>'));
    }
  });

  it('writes no inline style or handler, under a CSP with neither', () => {
    expect(LANDING + HELPERS).not.toMatch(/style="|\son[a-z]+="/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2 · the agents come from the Agent Registry, and nothing is invented', () => {
  it('reads the registry the room reads, by GET, as the signed-in owner', async () => {
    const r = await runFill(overview());
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].url).toBe('/api/v1/system/agents');
    expect(r.calls[0].opts).toEqual({ method: 'GET', headers: { Authorization: 'Bearer tok' }, credentials: 'include' });
  });

  it('stands the ten CLUB agents beside CLUBS, and says plainly that no agent serves any other room', async () => {
    const r = await runFill(overview());
    expect(buttons(r.by.clubs)).toEqual(TEN.map((a) => a.id));
    for (const k of HOSTS.filter((h) => h !== 'clubs')) {
      expect([k, r.by[k]]).toEqual([k, expect.stringContaining('No agent registered')]);
      expect(buttons(r.by[k])).toEqual([]);
    }
    expect(r.cap.attrs['data-oh-default']).toBe('Club agents: 10');
    expect(r.state).toContain('oh-card-state--ok');
    expect(r.state).toContain('Agents running: 10 of 10');
  });

  it('places by the manifest\'s own scope and domain: a PLATFORM agent by its domain, where a room has one', async () => {
    const r = await runFill(overview({ agents: [...TEN, agent('platform.vision-qa', 'VISION', 'PLATFORM', 'LAB', 'Vision QA'), agent('platform.ops', 'PLATFORM_OPERATIONS', 'PLATFORM', 'DRAFT', 'Ops'), agent('platform.data', 'DATA', 'PLATFORM', 'LAB', 'Data')] }));
    expect(buttons(r.by.vision)).toEqual(['platform.vision-qa']);
    expect(buttons(r.by.system)).toEqual(['platform.ops']);
    expect(buttons(r.by.clubs)).toHaveLength(10);
    // A platform DATA agent belongs to no room on this page: it is counted on the hub and shown only in the room.
    expect(Object.values(r.by).some((h) => buttons(h).includes('platform.data'))).toBe(false);
    expect(r.state).toContain('Agents running: 10 of 13');
    // Its lifecycle is its outline, and its domain picks its glyph.
    expect(r.by.vision).toContain('class="oh-agent oh-agent--lab"');
    expect(r.by.system).toContain('class="oh-agent oh-agent--draft"');
    expect(r.by.vision).toContain('data-agent-lc="LAB"');
  });

  it('says a failing invariant first, then an engaged kill switch, then the count', async () => {
    expect((await runFill(overview({ invariants: [{ id: 'a', holds: true }, { id: 'b', holds: false }], killSwitch: { engaged: true } }))).state)
      .toMatch(/oh-card-state--bad[\s\S]*Registry invariants failing: 1/);
    expect((await runFill(overview({ killSwitch: { engaged: true } }))).state).toMatch(/oh-card-state--warn[\s\S]*Kill switch engaged/);
    // "Running" is the manifest's lifecycle, and only RUNNING is counted as running.
    expect((await runFill(overview({ agents: [...TEN.slice(0, 9), { ...TEN[9], lifecycle: 'RETIRED' }] }))).state).toContain('Agents running: 9 of 10');
  });

  it('a registry that cannot be read is said so, and draws nothing beside any room — not even "no agent"', async () => {
    for (const reply of ['reject', { ok: false, status: 500 }, { ok: true, status: 200, body: { data: { agents: 'x' } } }, { ok: true, status: 200, body: {} }, overview({ killSwitch: undefined })] as Reply[]) {
      const r = await runFill(reply);
      expect(r.state).toMatch(/oh-card-state--bad[\s\S]*Agent Registry unreachable/);
      expect(r.cap.attrs['data-oh-default']).toBe('Agent Registry unreachable');
      expect(Object.values(r.by).every((h) => h === null)).toBe(true);
    }
  });

  it('(control) the same check fails against a reader that draws "no agent" when the registry could not be read', async () => {
    const broken = HELPERS.replace('if (!agents || !invariants || !d.registry || !d.killSwitch) return unreadable();', 'if (!agents || !invariants || !d.registry || !d.killSwitch) { unreadable(); map0(); return; }')
      .replace('function _fillAgentsMap() {', "function map0() { document.getElementById('oh-map').querySelectorAll('[data-oh-agents]').forEach(function (h) { h.innerHTML = _OH_AGENT_NONE; }); }\nfunction _fillAgentsMap() {");
    expect(broken).not.toBe(HELPERS);
    const r = await runFill({ ok: true, status: 200, body: {} }, broken);
    expect(Object.values(r.by).every((h) => h === null)).toBe(false);
  });

  it('escapes what the registry says before drawing it', async () => {
    const r = await runFill(overview({ agents: [agent('club.x', 'MEDICAL', 'CLUB', 'RUNNING', '<img src=x onerror=alert(1)>'), agent('club.y"><b', 'X', 'CLUB', 'RUN"NING', 'y')] }));
    expect(r.by.clubs).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(r.by.clubs).not.toContain('<img');
    expect(r.by.clubs).toContain('data-agent-id="club.y&quot;&gt;&lt;b"');
    expect(r.by.clubs).toContain('class="oh-agent oh-agent--running"');
  });

  it('draws no activity, task count or online state: the registry records none', () => {
    // The code, not its comments (which say why none of these is drawn).
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code(HELPERS)).not.toMatch(/online|offline|busy|tasks?:|activity|Math\.random/i);
    expect(code(LANDING)).not.toMatch(/online|tasks?:|activity/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3 · the Platform Owner\'s alone', () => {
  it('is built only after /system/whoami says yes, and the club member\'s landing has none of it', () => {
    expect(APP).toMatch(/Promise\.all\(\[_isPlatformOwner\(\), _famContextReady\]\)[\s\S]{0,400}yes\s*\n?\s*\?\s*_ownerHomeForPlatformOwner/);
    expect(MEMBER).not.toMatch(/oh-hub|oh-agent|oh-map|agents-room|_fillAgentsMap|\/system\/agents/);
  });

  it('keeps its listeners on the map itself, watches nothing, and adds one resize listener once for the page', () => {
    const bind = HELPERS.slice(HELPERS.indexOf('function _ohBindMap()'));
    // No observer of any kind: the platform keeps none in app.js, so none can loop (tests/performance-stability-pass).
    expect(HELPERS).not.toMatch(/ResizeObserver|MutationObserver|IntersectionObserver/);
    expect(bind).not.toMatch(/document\.addEventListener/);
    expect(bind.match(/window\.addEventListener/g)).toHaveLength(1);
    expect(bind).toContain("if (!_ohResizeBound) { _ohResizeBound = true; window.addEventListener('resize', _ohScheduleDraw, { passive: true }); }");
    // A redraw is one frame however often it is asked for, and does nothing once the map has gone.
    expect(HELPERS).toContain("if (document.getElementById('oh-map')) _ohDrawLinks();");
    // A status written into a card, which can change its height, asks for one.
    expect(APP).toMatch(/function _vaultStatusHTML\(state, text\) \{[\s\S]{0,300}if \(typeof _ohScheduleDraw === 'function'\) _ohScheduleDraw\(\);/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4 · an agent opens the Operations Room on its own manifest', () => {
  it('asks once, through the navigation every room uses, and the room is handed the request once', () => {
    expect(APP).toContain("case 'openAgentInRoom': {\n          _famAgentsRoomOpen = el.dataset.agentId || null;\n          try { navTo('agents-room', null); }");
    expect(APP).toContain("var _arOpen = _famAgentsRoomOpen;\n      _famAgentsRoomOpen = null;\n      window.renderFamilistaAgentsRoom(_arRoot, _arOpen ? { open: _arOpen } : undefined);");
  });

  it('is honoured by the room only for an agent its own registry read lists', () => {
    const room = read('public/agents-room/agents-room.js');
    expect(room).toContain("var open = opts && typeof opts.open === 'string' ? opts.open : null;");
    expect(room).toContain('if (open && summaryOf(open)) openAgent(host, open, host.querySelector(\'[data-ar-agent="\' + open + \'"]\'));');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5 · nothing moves that the reader did not move', () => {
  it('draws the lines as an overlay that takes no part in layout or pointing', () => {
    expect(CSS).toMatch(/body\.club-theme \.oh-links\{\s*position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0;\s*pointer-events: none;/);
  });

  it('changes no geometry on hover or focus: colour, glow and outline only', () => {
    const map = CSS.slice(CSS.indexOf('/* THE OWNER CONTROL MIND MAP.'), CSS.indexOf('/* THE ESCAPE HATCH.'));
    for (const rule of map.match(/[^{}]*:(hover|focus-visible)[^{]*\{[^}]*\}/g) || []) {
      expect([rule.trim().slice(0, 60), /transform|width|height|margin|padding|top|left/.test(rule.slice(rule.indexOf('{')))]).toEqual([rule.trim().slice(0, 60), false]);
    }
  });

  it('stops the flowing line when less motion is asked for', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)\{\s*body\.club-theme \.oh-links,\s*body\.club-theme \.oh-link\{ transition: none; \}\s*body\.club-theme \.oh-cards--core\[data-hot\] \.oh-link\.is-hot\{ animation: none; stroke-dasharray: none; \}/);
  });

  it('becomes a scrolling list where it no longer fits, hiding nothing', () => {
    expect(CSS).toContain('@media (max-width: 1180px), (max-height: 640px){');
    const hatch = CSS.slice(CSS.indexOf('@media (max-width: 1180px), (max-height: 640px){'));
    expect(hatch).toContain('body.club-theme .oh-links,');
    // The words a line stood for are shown instead.
    expect(hatch).toMatch(/body\.club-theme \.oh-agent-none-l\{\s*position: static;/);
  });

  it('gives the agents a fixed slot, so their arrival moves nothing', () => {
    expect(CSS).toContain('body.club-theme .oh-agents-list{ display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; min-height: 34px; }');
    expect(CSS).toMatch(/body\.club-theme \.oh-agents-cap\{[^}]*min-height: 16px;/);
  });

  it('shows a focus ring on the hub and on every agent', () => {
    expect(CSS).toContain('body.club-theme .oh-hub:focus-visible{ outline: 2px solid var(--oh-amber); outline-offset: 4px; }');
    expect(CSS).toContain('body.club-theme .oh-agent:focus-visible{ outline: 2px solid var(--pitch-400); outline-offset: 2px; }');
    // Each of the map's colours is written once, on the map, and read everywhere else in it.
    const map = CSS.slice(CSS.indexOf('/* THE OWNER CONTROL MIND MAP.'), CSS.indexOf("body.club-theme .oh-wrap--map .oh-title{ font-size: 26px; }"));
    expect(map).toContain('--oh-amber: #fcd34d;');
    const literals = (map.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\d[^)]*\)/g) || []);
    expect(literals).toEqual(['#fcd34d', '#c7d2fe', '#e8a8ff', '#fbbf24', '#22d3ee', '#60a5fa', '#38bdf8', '#a78bfa']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('6 · translated in every locale the platform ships', () => {
  const KEYS = ['AI AGENTS — OPERATIONS ROOM', 'Every agent in the Agent Registry: its domain, scope, lifecycle and permissions', 'Reading the Agent Registry…',
    'Agents running: \u0000 of \u0000', 'Agent Registry unreachable', 'Registry invariants failing: \u0000', 'Kill switch engaged', 'Open the Operations Room',
    'No agent registered', 'Club agents: \u0000', 'Club Manager', 'Tactical', 'Finance', 'Match Operations', 'Communications', 'Device Management', 'Big Data'];
  const tags = fs.readdirSync(path.join(ROOT, 'public/i18n/catalogue')).filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f)).map((f) => f.slice(0, -5));

  it('has every string the map can draw in every catalogue, with the same number slots', () => {
    expect(tags.length).toBeGreaterThan(2);
    for (const tag of tags.filter((t) => !/^en-US$/.test(t))) {
      const cat = JSON.parse(read(`public/i18n/catalogue/${tag}.json`)) as Record<string, string>;
      for (const k of KEYS) {
        expect([tag, k, typeof cat[k]]).toEqual([tag, k, 'string']);
        expect([tag, k, (cat[k].match(/\u0000/g) || []).length]).toEqual([tag, k, (k.match(/\u0000/g) || []).length]);
        // Translated, not copied — except where the language's word is the English one.
        const same = k === 'Big Data' || (tag === 'cs-CZ' && k === 'Finance');
        if (!/^en/.test(tag) && !same) expect([tag, k, cat[k] === k]).toEqual([tag, k, false]);
      }
    }
  });

  it('draws the count lines as a label and a number, so one entry answers every count', () => {
    expect(HELPERS).toContain("write('ok', 'Agents running: ' + running + ' of ' + agents.length);");
    expect(HELPERS).toContain("caption('Club agents: ' + agents.filter(_OH_AGENT_HOME.clubs).length);");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('7 · the visual upgrade: pictures, icons, the round hub and its lines', () => {
  const ROOMS: [string, string][] = [['clubs', 'clubs'], ['system', 'system'], ['cyber', 'cyber'], ['algo', 'algo'], ['ds', 'design'], ['vault', 'vault'], ['city', 'city'], ['core', 'core'], ['vision', 'vision']];
  const cardOf = (k: string) => { const at = LANDING.indexOf(`<button class="oh-card oh-card--${k}"`); return LANDING.slice(at, LANDING.indexOf('</button>', at)); };

  it('gives every room its own illustration inside its card, decorative and the size it is drawn at', () => {
    for (const [k, file] of ROOMS) {
      expect([k, cardOf(k)]).toEqual([k, expect.stringContaining(`<img class="oh-card-illus" src="/owner-control/illus/${file}.svg" alt="" width="220" height="160" decoding="async" draggable="false">`)]);
      expect(fs.existsSync(path.join(ROOT, `public/owner-control/illus/${file}.svg`))).toBe(true);
    }
    expect((LANDING.match(/class="oh-card-illus"/g) || []).length).toBe(9);
    // Nine different pictures: no two rooms share one.
    expect(new Set(ROOMS.map(([, f]) => read(`public/owner-control/illus/${f}.svg`))).size).toBe(9);
  });

  // An illustration is served from our own origin as an <img>, so it can run nothing; it must also
  // say nothing (no words to translate, no figure to mistake for a measurement) and fetch nothing.
  const unsafe = (svg: string) => [
    /<script/i.test(svg) && 'script', /\son[a-z]+\s*=/i.test(svg) && 'handler', /<text|<tspan/i.test(svg) && 'text',
    /<(image|foreignObject|use|a)\b/i.test(svg) && 'external element', /(href|url)\s*[=(]\s*["']?(https?:|\/\/|data:)/i.test(svg) && 'external reference',
    /@import|<style/i.test(svg) && 'stylesheet', !/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 220 160"/.test(svg) && 'frame',
    svg.length > 12000 && 'size',
  ].filter(Boolean);
  it('draws each picture as a safe, wordless, self-contained vector on one frame', () => {
    for (const [, f] of ROOMS) expect([f, unsafe(read(`public/owner-control/illus/${f}.svg`))]).toEqual([f, []]);
  });
  it('(control) the same check refuses a picture with a script, a word, a figure or a remote fetch', () => {
    const ok = read('public/owner-control/illus/system.svg');
    expect(unsafe(ok.replace('</svg>', '<script>alert(1)</script></svg>'))).toContain('script');
    expect(unsafe(ok.replace('</svg>', '<text x="1" y="1">98%</text></svg>'))).toContain('text');
    expect(unsafe(ok.replace('</svg>', '<image href="https://example.com/x.png"/></svg>'))).toContain('external element');
    expect(unsafe(ok.replace('<svg ', '<svg onload="x()" '))).toContain('handler');
  });

  it('draws every card icon and hides it from assistive technology: no emoji glyphs remain', () => {
    const icons = [...LANDING.matchAll(/<div class="oh-card-icon"[^>]*>([\s\S]*?)<\/div>/g)];
    expect(icons).toHaveLength(9);
    for (const m of icons) {
      expect(m[0]).toMatch(/^<div class="oh-card-icon" aria-hidden="true"><svg /);
    }
    // The glyphs the cards used to carry (an emoji stadium and gear, ⛁ ◈ ◉) — in the icons, not in the comments that recall them.
    expect(icons.map((m) => m[1]).join('')).not.toMatch(/[\u{1F300}-\u{1FAFF}\u2699\u26C1\u25C8\u25C9]/u);
  });

  it('places the picture in the grid beside the words, and keeps the words a gap of the picture\'s own width', () => {
    const map = CSS.slice(CSS.indexOf('/* THE OWNER CONTROL MIND MAP.'), CSS.indexOf('/* THE ESCAPE HATCH.'));
    expect(map).toMatch(/\.oh-card > \.oh-card-illus\{\s*grid-row: 2 \/ span 2; justify-self: end; align-self: center;/);
    for (const [title, sub, list] of [['title', 'sub', 'list']]) {
      expect(map).toContain(`body.club-theme .oh-cards--core .oh-card > .oh-card-${title}{ grid-row: 1; }`);
      expect(map).toContain(`body.club-theme .oh-cards--core .oh-card > .oh-card-${sub}{ grid-row: 2; }`);
      expect(map).toContain(`body.club-theme .oh-cards--core .oh-card > .oh-card-${list}{ grid-row: 3; }`);
    }
    // Every width the picture can take is the width the words step aside by (default, CLUBS, large screens).
    const widths = [...map.matchAll(/oh-card-illus\{[^}]*?width: (clamp\([^)]*\))/g)].map((m) => m[1]);
    const gaps = [...map.matchAll(/oh-card-list\{ margin-inline-end: calc\((clamp\([^)]*\)) \+ \d+px\); \}/g)].map((m) => m[1]);
    expect(widths.length).toBe(3);
    expect(gaps).toEqual(widths);
  });

  it('makes the hub a circle, ringed in the rooms\' colours in the order they stand, mirrored in Arabic', () => {
    const hub = CSS.slice(CSS.indexOf('body.club-theme .oh-hub{'), CSS.indexOf('body.club-theme .oh-hub-mark{'));
    expect(hub).toMatch(/aspect-ratio: 1; border-radius: 50%;/);
    const ring = (hub.match(/conic-gradient\(([^;]*)\);/) || [])[1] || '';
    expect([...ring.matchAll(/var\(--oh-([a-z]+)\)/g)].map((m) => m[1])).toEqual(['amber', 'vault', 'city', 'core', 'vision', 'clubs', 'ds', 'algo', 'cyber', 'system', 'amber']);
    expect(CSS).toContain('html[dir="rtl"] body.club-theme .oh-hub::after{ transform: scaleX(-1); }');
    // An arrow points the way the page reads.
    expect(CSS).toMatch(/html\[dir="rtl"\] body\.club-theme \.oh-cards--core \.oh-card-cta span,\s*html\[dir="rtl"\] body\.club-theme \.oh-hub-cta span\{ transform: scaleX\(-1\); \}/);
    // Its mark is drawn, and still hidden from assistive technology.
    expect(LANDING).toMatch(/<span class="oh-hub-mark" aria-hidden="true"><svg viewBox="0 0 64 64"[^>]*focusable="false">/);
  });

  // ── the connectors, drawn against a laid-out page ────────────────────────────
  type Box = { left: number; top: number; width: number; height: number };
  const rect = (b: Box) => ({ ...b, right: b.left + b.width, bottom: b.top + b.height });
  function draw(rtl: boolean, source = HELPERS, hubBox: Box = { left: 585, top: 277, width: 270, height: 270 }) {
    const L = { left: 24, width: 414 }, R = { left: 993, width: 414 };
    const rows = [78, 278, 478, 678];
    type Col = { left: number; width: number };
    const side: Record<string, [Col, number]> = { system: [L, 0], cyber: [L, 1], algo: [L, 2], ds: [L, 3], vault: [R, 0], city: [R, 1], core: [R, 2], vision: [R, 3] };
    const cards: Record<string, Box> = { clubs: { left: 504, top: 721, width: 423, height: 146 } };
    for (const [k, [col, i]] of Object.entries(side)) cards[k] = { left: rtl ? (col === L ? R.left : L.left) : col.left, top: rows[i], width: col.width, height: 188 };
    const svg: any = { attrs: {} as Record<string, string>, html: '', setAttribute(k: string, v: string) { this.attrs[k] = v; }, set innerHTML(v: string) { this.html = v; }, classList: { add() {} } };
    const nodes = Object.keys(cards).map((k) => ({ getAttribute: () => k, querySelector: () => ({ getBoundingClientRect: () => rect(cards[k]) }) }));
    const map = { getBoundingClientRect: () => rect({ left: 24, top: 78, width: 1383, height: 790 }), querySelector: (q: string) => (q === '.oh-hub' ? { getBoundingClientRect: () => rect(hubBox) } : null), querySelectorAll: (q: string) => (q === '[data-oh-node]' ? nodes : []), getAttribute: () => null };
    const sandbox: any = { document: { getElementById: (id: string) => ({ 'oh-map': map, 'oh-links': svg } as any)[id] || null }, getComputedStyle: () => ({ display: 'block' }), _esc: esc, console };
    vm.runInNewContext(source + '\n_ohDrawLinks();', sandbox);
    return { html: svg.html as string, cards, m: { left: 24, top: 78 } };
  }
  const audit = (r: ReturnType<typeof draw>) => {
    const cx = 585 + 135 - 24, cy = 277 + 135 - 78;
    return [...r.html.matchAll(/<path class="oh-link oh-link--([a-z]+)" data-k="\1" d="M([-\d.]+),([-\d.]+) C[^"]* ([-\d.]+),([-\d.]+)"/g)].map((m) => {
      const [k, x1, y1, x2, y2] = [m[1], +m[2], +m[3], +m[4], +m[5]];
      const c = rect(r.cards[k]);
      const rim = Math.abs(Math.hypot(x1 - cx, y1 - cy) - 135) < 0.6;
      const before = c.left + c.width / 2 < 585 + 135;
      const end = k === 'clubs'
        ? Math.abs(x2 - (c.left + c.width / 2 - 24)) < 0.6 && Math.abs(y2 - (c.top - 78)) < 0.6
        : Math.abs(x2 - ((before ? c.right : c.left) - 24)) < 0.6 && Math.abs(y2 - (c.top + c.height / 2 - 78)) < 0.6;
      const port = r.html.includes(`<circle class="oh-link-port oh-link-end--${k}" cx="${x1}" cy="${y1}"`);
      const ringAt = r.html.includes(`<circle class="oh-link-ring oh-link-ring--${k}" cx="${x2}" cy="${y2}"`);
      return { k, rim, end, port, ringAt };
    });
  };
  it('leaves the hub\'s rim for every room and lands on that card\'s edge, in either reading direction', () => {
    for (const rtl of [false, true]) {
      const a = audit(draw(rtl));
      expect(a.map((x) => x.k).sort()).toEqual(['algo', 'city', 'clubs', 'core', 'cyber', 'ds', 'system', 'vault', 'vision']);
      expect([rtl, a.filter((x) => !(x.rim && x.end && x.port && x.ringAt))]).toEqual([rtl, []]);
    }
    // Under each line, its own soft glow: decoration, which the lighting of a room also reaches.
    expect(draw(false).html).toMatch(/<path class="oh-link-glow" data-k="system" d="M[^"]+" stroke="url\(#oh-g-system\)" filter="url\(#oh-soft\)"\/>/);
    expect(HELPERS).toContain("map.querySelectorAll('.oh-link, .oh-link-glow').forEach(function (p) {");
  });
  it('(control) the same check fails against lines that leave the hub\'s box instead of its rim', () => {
    const boxy = HELPERS.replace("x1 = cx + (before ? -1 : 1) * rx * Math.sqrt(Math.max(0, 1 - Math.pow((y1 - cy) / ry, 2)));", 'x1 = (before ? h.left : h.right) - m.left;');
    expect(boxy).not.toBe(HELPERS);
    expect(audit(draw(false, boxy)).some((x) => !x.rim)).toBe(true);
  });

  it('draws nothing, and writes no NaN, while the map is in the page but not laid out', () => {
    // Another room is showing: the landing is still in the document, and a resize asks for a redraw.
    const hidden = draw(false, HELPERS, { left: 0, top: 0, width: 0, height: 0 });
    expect(hidden.html).toBe('');
    expect(hidden.html).not.toMatch(/NaN/);
  });
  it('(control) without that guard the same redraw writes NaN into the page', () => {
    const unguarded = HELPERS.replace("if (!(h.width > 0 && h.height > 0 && m.width > 0)) { svg.innerHTML = ''; return; }", '');
    expect(unguarded).not.toBe(HELPERS);
    expect(draw(false, unguarded, { left: 0, top: 0, width: 0, height: 0 }).html).toMatch(/NaN/);
  });

  it('names every agent under the hub as the registry names it, and keeps the names beside a room for the caption', async () => {
    const r = await runFill(overview());
    expect(r.by.clubs).toContain('<span class="oh-agent-orb"><svg viewBox="0 0 24 24"');
    expect(r.by.clubs).toContain('<span class="oh-agent-name">Device Management</span>');
    // Shown under the hub, on one line each (never broken inside a word); hidden beside a room's card.
    expect(CSS).toMatch(/body\.club-theme \.oh-agents--row \.oh-agent-name\{\s*position: static;[^}]*white-space: nowrap;/);
    expect(CSS).toMatch(/body\.club-theme \.oh-agent-name,\s*body\.club-theme \.oh-agent-none-l\{\s*position: absolute; width: 1px; height: 1px;/);
    // Three rows are held before the registry answers, so its arrival moves nothing.
    expect(CSS).toContain('body.club-theme .oh-agents--row .oh-agents-list:not(.is-read){ min-height: 108px; }');
  });

  it('keeps two branches side by side on a tablet: the generic one-column rule further down cannot win', () => {
    const generic = CSS.indexOf('@media (max-width: 900px){ body.club-theme .oh-cards{ grid-template-columns: 1fr; } }');
    const hatch = CSS.indexOf('@media (max-width: 1180px), (max-height: 640px){');
    expect(generic).toBeGreaterThan(hatch);
    const two = CSS.slice(hatch, CSS.indexOf('/* The core\'s own accent.'));
    // .oh-cards.oh-cards--core outweighs .oh-cards, whichever comes later.
    expect(two).toMatch(/body\.club-theme \.oh-cards\.oh-cards--core\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(two).toMatch(/@media \(max-width: 720px\)\{\s*body\.club-theme \.oh-cards\.oh-cards--core\{\s*grid-template-columns: 1fr;/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('8 · the language switch in the top bar', () => {
  const HTML = read('public/index.html');
  const group = HTML.slice(HTML.indexOf('<div class="lang-switch"'), HTML.indexOf('</div>', HTML.indexOf('<div class="lang-switch"')) + 6);
  const SWITCH = APP.slice(APP.indexOf('// ── OWNER CONTROL · the language switch in the top bar'), APP.indexOf('(function () {\n  function _boot() {\n    try { buildWorkspaceSidebar(); }'));
  const CFG = read('public/i18n/config.js');

  it('is a labelled group of three real buttons, hidden until shown, and never translated', () => {
    expect(group).toMatch(/^<div class="lang-switch" id="lang-switch" role="group" aria-label="Interface Language" data-i18n-aria="settings\.interfaceLanguage" data-no-i18n hidden>/);
    const buttons = [...group.matchAll(/<button class="lang-switch-btn" type="button" data-action="setUiLocale" data-locale="([^"]+)" lang="([a-z]+)" aria-pressed="false">([A-Z]{2})<\/button>/g)].map((m) => `${m[1]}/${m[2]}/${m[3]}`);
    expect(buttons).toEqual(['ar/ar/AR', 'en-GB/en/EN', 'de-DE/de/DE']);
    // No handler, no style, and no language list of its own: the names come from the registry.
    expect(group).not.toMatch(/\son[a-z]+=|style=|title=|العربية|Deutsch|English/);
  });

  it('offers only languages the registry declares, with the direction the registry gives them', () => {
    for (const [tag, dir] of [['ar', 'rtl'], ['en-GB', 'ltr'], ['de-DE', 'ltr']]) {
      expect(CFG).toMatch(new RegExp(`\\{ tag: '${tag}',\\s*label: '[^']+',\\s*dir: '${dir}' \\}`));
    }
    expect(SWITCH).not.toMatch(/\[\s*'ar'|'de-DE'|'en-GB'/);
  });

  function sandbox(now = 'en-GB', registry = [{ tag: 'ar', label: 'العربية' }, { tag: 'en-GB', label: 'English (UK)' }, { tag: 'de-DE', label: 'Deutsch' }]) {
    const changes: string[] = [];
    const mk = (tag: string, code: string) => ({ attrs: { 'data-locale': tag } as Record<string, string>, textContent: code, hidden: false,
      getAttribute(k: string) { return this.attrs[k] ?? null; }, setAttribute(k: string, v: string) { this.attrs[k] = v; }, closest: (q: string) => (q === '#lang-switch' ? {} : null) });
    const btns = [mk('ar', 'AR'), mk('en-GB', 'EN'), mk('de-DE', 'DE')];
    const g = { hidden: true, querySelectorAll: () => btns };
    const sb: any = {
      window: {}, document: { getElementById: (id: string) => (id === 'lang-switch' ? g : null) },
      I18N: { locale: () => now, locales: () => registry },
      I18N_APPLY: { change: (t: string) => { changes.push(t); now = t; return Promise.resolve({ locale: t, saved: true }); } },
    };
    sb.window.I18N = sb.I18N; sb.window.I18N_APPLY = sb.I18N_APPLY;
    vm.runInNewContext(SWITCH + '\nthis.show = _langSwitchShow; this.to = _langSwitchTo;', sb);
    return { sb, g, btns, changes };
  }

  it('is revealed for the owner with each button named from the registry, and says which language is in force', () => {
    const { sb, g, btns } = sandbox('de-DE');
    sb.show();
    expect(g.hidden).toBe(false);
    expect(btns.map((b) => b.attrs['aria-label'])).toEqual(['AR · العربية', 'EN · English (UK)', 'DE · Deutsch']);
    expect(btns.map((b) => b.attrs.title)).toEqual(['العربية', 'English (UK)', 'Deutsch']);
    expect(btns.map((b) => b.attrs['aria-pressed'])).toEqual(['false', 'false', 'true']);
  });

  it('(control) a button for a language the registry does not declare is not offered', () => {
    const { sb, btns } = sandbox('en-GB', [{ tag: 'en-GB', label: 'English (UK)' }, { tag: 'de-DE', label: 'Deutsch' }]);
    sb.show();
    expect(btns.map((b) => b.hidden)).toEqual([true, false, false]);
  });

  it('changes language only through I18N_APPLY.change, once, and not to the language already in force', async () => {
    const { sb, btns, changes } = sandbox('en-GB');
    sb.to(btns[2]); sb.to(btns[2]);
    await new Promise((r) => setTimeout(r, 0));
    expect(changes).toEqual(['de-DE']);
    sb.to(btns[0]);
    await new Promise((r) => setTimeout(r, 0));
    expect(changes).toEqual(['de-DE', 'ar']);
    expect(btns.map((b) => b.attrs['aria-pressed'])).toEqual(['true', 'false', 'false']);
    // A button that is not the switch's own changes nothing.
    sb.to({ getAttribute: () => 'de-DE', closest: () => null });
    expect(changes).toEqual(['de-DE', 'ar']);
    // One path: the switch never caches, sets a direction or loads a locale itself.
    expect(SWITCH).not.toMatch(/localStorage|\.dir\b|setLocale\(|\.cache\(|fetch\(/);
  });

  it('is shown only once /system/whoami says yes, and is the delegated action every button uses', () => {
    expect(APP).toContain(".catch(() => false)\n    .then(function (yes) { if (yes) { try { _langSwitchShow(); } catch (_) {} } return yes; });");
    expect(APP).toContain("case 'setUiLocale': _langSwitchTo(el); break;");
    expect(CSS).toContain('body.club-theme .lang-switch[hidden]{ display: none; }');
    // The club member's landing shows none of it.
    expect(MEMBER).not.toMatch(/lang-switch|_langSwitch/);
  });

  it('keeps its state and the map\'s lines right after any change of language, however it was made', () => {
    expect(APP).toMatch(/I18N_APPLY\.registerRepaint\(function \(\) \{\s*try \{ _langSwitchSync\(\); \} catch \(_\) \{\}\s*try \{ if \(document\.getElementById\('oh-map'\)\) _ohScheduleDraw\(\); \} catch \(_\) \{\}\s*\}\);\s*I18N_APPLY\.boot\(\);/);
  });

  it('marks the language in force with a hairline and a tint, never a filled block, and shows focus', () => {
    expect(CSS).toMatch(/\.lang-switch-btn\[aria-pressed="true"\]\{\s*color: var\(--gold-400\); background: color-mix\(in srgb, var\(--gold-500\) 13%, transparent\);\s*box-shadow: inset 0 0 0 1px/);
    expect(CSS).toContain('body.club-theme .lang-switch-btn:focus-visible{ outline: 2px solid var(--gold-400); outline-offset: 1px; }');
    // On a tablet it takes the status chips' place, and only where it is shown.
    expect(CSS).toContain('body.club-theme .header-actions:has(> .lang-switch:not([hidden])) > .status-chip{ display: none !important; }');
  });

  it('has the strings this change draws in every catalogue, translated, and the Vision card in Arabic and German', () => {
    const tags = fs.readdirSync(path.join(ROOT, 'public/i18n/catalogue')).filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f)).map((f) => f.slice(0, -5)).filter((t) => t !== 'en-US');
    const NEW = ['No historical events yet', 'Vision engine reachable · no session store', 'Clubs in your network: \u0000'];
    for (const tag of tags) {
      const cat = JSON.parse(read(`public/i18n/catalogue/${tag}.json`)) as Record<string, string>;
      for (const k of NEW) {
        expect([tag, k, typeof cat[k]]).toEqual([tag, k, 'string']);
        expect([tag, k, (cat[k].match(/\u0000/g) || []).length]).toEqual([tag, k, (k.match(/\u0000/g) || []).length]);
        if (!/^en/.test(tag)) expect([tag, k, cat[k] === k]).toEqual([tag, k, false]);
      }
    }
    for (const tag of ['ar', 'de-DE']) {
      const cat = JSON.parse(read(`public/i18n/catalogue/${tag}.json`)) as Record<string, string>;
      for (const k of ['Computer Vision, Tracking, Evidence & Match Intelligence', 'Open Vision', 'Live Analysis · Player & Ball Tracking · Pitch Calibration · Teams & Roles · Events · Tactical · Heatmaps · Timeline · Sources · Vision Hub · Models']) {
        expect([tag, k, cat[k] === k]).toEqual([tag, k, false]);
      }
    }
    // The footer keeps the account's address out of every key: it is the user's, marked so.
    expect(LANDING).toContain("<span data-no-i18n>Familista</span> · <span data-user-content>${_esc((user.email || 'Owner') + '')}</span> · <span>Clubs in your network: ${clubCount}</span>");
  });
});
