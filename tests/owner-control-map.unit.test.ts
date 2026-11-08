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
import { officialRoomLocales, platformI18n } from './helpers/platform-i18n';

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
    // Its name, whole and in the catalogue, for a screen reader; drawn in two parts from the translated line.
    expect(LANDING).toContain('<span class="oh-hub-title"><span class="oh-split-src">AI AGENTS — OPERATIONS ROOM</span><span class="oh-hub-title-a" data-no-i18n aria-hidden="true"></span><span class="oh-hub-title-b" data-no-i18n aria-hidden="true"></span></span>');
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
      expect([k, cardOf(k)]).toEqual([k, expect.stringContaining(`<img class="oh-card-illus" src="/owner-control/art/${file}.webp" alt="" width="576" height="414" decoding="async" draggable="false">`)]);
      expect(fs.existsSync(path.join(ROOT, `public/owner-control/art/${file}.webp`))).toBe(true);
    }
    expect((LANDING.match(/class="oh-card-illus"/g) || []).length).toBe(9);
    // Nine different pictures: no two rooms share one.
    expect(new Set(ROOMS.map(([, f]) => fs.readFileSync(path.join(ROOT, `public/owner-control/art/${f}.webp`)).toString('base64'))).size).toBe(9);
  });

  // The pictures are 3D scenes (scripts/owner-control-scenes.js) rendered offline by
  // scripts/owner-control-render.js into WebP: images, which can run nothing, served from our own
  // origin. What is checked here is that they are what the manifest says, from the scenes it names.
  const ART = path.join(ROOT, 'public/owner-control/art');
  const MANIFEST = JSON.parse(read('public/owner-control/art/manifest.json'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sha = (b: Buffer | string) => require('crypto').createHash('sha256').update(b).digest('hex');
  /** A WebP's canvas size, from its own header (VP8X, VP8L or VP8). */
  const webpSize = (b: Buffer) => {
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    if (kind === 'VP8L') { const n = b.readUInt32LE(21); return [1 + (n & 0x3fff), 1 + ((n >> 14) & 0x3fff)]; }
    if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    return null;
  };
  const NAMES = [...ROOMS.map(([, f]) => f), 'hub', 'orb'];
  it('ships each picture as a real, small WebP of the size its manifest records', () => {
    expect(Object.keys(MANIFEST.images).sort()).toEqual([...NAMES].sort());
    expect(fs.readdirSync(ART).filter((f) => f !== 'manifest.json').sort()).toEqual(NAMES.map((n) => n + '.webp').sort());
    for (const n of NAMES) {
      const b = fs.readFileSync(path.join(ART, n + '.webp'));
      const m = MANIFEST.images[n];
      expect([n, webpSize(b)]).toEqual([n, [m.width, m.height]]);
      expect([n, b.length, sha(b)]).toEqual([n, m.bytes, m.sha256]);
      // A budget, not a guess: the heaviest room picture is the security field.
      expect([n, b.length <= 90 * 1024]).toEqual([n, true]);
    }
  });
  it('is rendered from the scenes the manifest names: a scene edited without rendering again fails here', () => {
    expect(MANIFEST.scenes).toEqual({ file: 'scripts/owner-control-scenes.js', sha256: sha(read('scripts/owner-control-scenes.js')) });
    expect(MANIFEST.renderer.babylon).toMatch(/^\d+\.\d+\.\d+$/);
    // The scenes draw shapes, light and material only: no text, no figures, nothing fetched.
    const scenes = read('scripts/owner-control-scenes.js').replace(/\/\/.*$/gm, '');
    expect(scenes).not.toMatch(/fillText|strokeText|fetch\(|XMLHttpRequest|import\(|ImportMesh|SceneLoader|https?:\/\//);
    // The renderer needs no network either: it loads the vendored Babylon.js and the scenes from disk.
    expect(read('scripts/owner-control-render.js')).toContain("path.join(ROOT, 'public', 'vendor', 'babylon.js')");
  });
  it('(control) the same check notices a scene that changed by a single character', () => {
    expect(sha(read('scripts/owner-control-scenes.js') + ' ')).not.toBe(MANIFEST.scenes.sha256);
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
    expect(map).toMatch(/\.oh-card > \.oh-card-illus\{\s*grid-row: 1 \/ span 3; justify-self: end; align-self: center;\s*width: (clamp\([^)]*\)); height: auto; aspect-ratio: 576 \/ 414;/);
    for (const [title, sub, list] of [['title', 'sub', 'list']]) {
      expect(map).toContain(`body.club-theme .oh-cards--core .oh-card > .oh-card-${title}{ grid-row: 1; }`);
      expect(map).toContain(`body.club-theme .oh-cards--core .oh-card > .oh-card-${sub}{ grid-row: 2; }`);
      expect(map).toContain(`body.club-theme .oh-cards--core .oh-card > .oh-card-${list}{ grid-row: 3; }`);
    }
    // Every width the picture can take is the width the words beside it step aside by: beside the
    // description and the contents on a wide screen, beside the title and the description on a narrower one.
    const widths = [...map.matchAll(/oh-card-illus\{[^}]*?width: (clamp\([^)]*\))/g)].map((m) => m[1]);
    const gaps = [...map.matchAll(/oh-card-(?:list|sub)\{ margin-inline-end: calc\((clamp\([^)]*\)) [-+] \d+px\); \}/g)].map((m) => m[1]);
    expect(widths.length).toBe(4);
    expect(gaps).toEqual(widths);
    const narrow = map.slice(map.indexOf('@media (max-width: 1599px){\n  body.club-theme .oh-cards--core .oh-card{ padding'));
    expect(narrow).toMatch(/\.oh-card > \.oh-card-illus\{ grid-row: 1 \/ span 2;/);
    expect(narrow).toContain('body.club-theme .oh-cards--core .oh-card > .oh-card-list{ margin-inline-end: 0; }');
  });

  it('lights each card in its own room\'s colour, written once and read as currentColor, and changes no size on hover', () => {
    const map = CSS.slice(CSS.indexOf('/* THE OWNER CONTROL MIND MAP.'), CSS.indexOf('/* THE ESCAPE HATCH.'));
    for (const k of ['system', 'cyber', 'algo', 'ds', 'vault', 'city', 'core', 'vision', 'clubs']) {
      expect(map).toMatch(new RegExp(`body\\.club-theme \\.oh-cards\\.oh-cards--core \\.oh-card--${k}\\{\\s*color: var\\(--oh-${k}\\); \\}`));
    }
    const skin = map.slice(map.indexOf('body.club-theme .oh-cards.oh-cards--core .oh-card{\n  border:'));
    expect(skin).toMatch(/^body\.club-theme \.oh-cards\.oh-cards--core \.oh-card\{\s*border: 1px solid color-mix\(in srgb, currentColor 82%, transparent\);/);
    // The icon's tile, the chips and the way in read the same colour; the words keep their own.
    expect(map).toContain('body.club-theme .oh-cards.oh-cards--core .oh-card-icon{\n  color: inherit;');
    expect(map).toContain('body.club-theme .oh-chip > span{ color: var(--t-secondary); }');
    expect(map).toContain('body.club-theme .oh-cards.oh-cards--core .oh-card:focus-visible{ outline: 2px solid currentColor; outline-offset: 3px; }');
  });

  it('makes the hub a circle, ringed in the rooms\' colours in the order they stand, mirrored in Arabic', () => {
    const hub = CSS.slice(CSS.indexOf('body.club-theme .oh-hub{'), CSS.indexOf('body.club-theme .oh-hub-mark{'));
    expect(hub).toMatch(/width: 56%; aspect-ratio: 1; border-radius: 50%;/);
    const after = hub.slice(hub.indexOf('body.club-theme .oh-hub::after{'));
    const ring = (after.match(/ conic-gradient\(([^;]*)\);/) || [])[1] || '';
    expect([...ring.matchAll(/var\(--oh-([a-z]+)\)/g)].map((m) => m[1])).toEqual(['amber', 'vault', 'city', 'core', 'vision', 'clubs', 'ds', 'algo', 'cyber', 'system', 'amber']);
    expect(CSS).toContain('html[dir="rtl"] body.club-theme .oh-hub::after{ transform: scaleX(-1); }');
    // The aura behind it, in the same order and mirrored with it.
    const aura = CSS.slice(CSS.indexOf('body.club-theme .oh-hub-slot::before{'), CSS.indexOf('html[dir="rtl"] body.club-theme .oh-hub-slot::before'));
    expect([...aura.matchAll(/var\(--oh-([a-z]+)\)/g)].map((m) => m[1])).toEqual(['amber', 'vault', 'city', 'core', 'vision', 'clubs', 'ds', 'algo', 'cyber', 'system', 'amber']);
    expect(CSS).toContain('html[dir="rtl"] body.club-theme .oh-hub-slot::before{ transform: scaleX(-1); }');
    // A fixed square: the agents arriving, or a language changing, moves nothing.
    expect(CSS).toMatch(/body\.club-theme \.oh-hub-slot\{\s*position: relative; display: flex; align-items: center; justify-content: center;\s*width: min\(100%, 600px, 54vh\); aspect-ratio: 1;/);
    // An arrow points the way the page reads.
    expect(CSS).toMatch(/html\[dir="rtl"\] body\.club-theme \.oh-cards--core \.oh-card-cta span,\s*html\[dir="rtl"\] body\.club-theme \.oh-hub-cta span\{ transform: scaleX\(-1\); \}/);
    // Its picture is the Operations Room's own, decoration, hidden from assistive technology.
    expect(LANDING).toContain('<span class="oh-hub-mark" aria-hidden="true"><img class="oh-hub-art" src="/owner-control/art/hub.webp" alt="" width="520" height="520" decoding="async" draggable="false"></span>');
    // A dial of ticks inside its rim: drawn, still.
    expect(CSS).toMatch(/body\.club-theme \.oh-hub::before\{\s*inset: 7px; opacity: 0\.85;\s*background: repeating-conic-gradient\(/);
  });

  // ── the connectors, drawn against a laid-out page ────────────────────────────
  type Box = { left: number; top: number; width: number; height: number };
  const rect = (b: Box) => ({ ...b, right: b.left + b.width, bottom: b.top + b.height });
  const ORBIT: Box = { left: 477, top: 169, width: 486, height: 486 };
  const ORBS: Box[] = Array.from({ length: 10 }, (_, i) => { const t = (18 + i * 36) * Math.PI / 180; return { left: 720 + 194 * Math.sin(t) - 20, top: 412 - 194 * Math.cos(t) - 20, width: 40, height: 40 }; });
  function draw(rtl: boolean, source = HELPERS, hubBox: Box = { left: 585, top: 277, width: 270, height: 270 }, slotBox: Box | null = ORBIT) {
    const L = { left: 24, width: 414 }, R = { left: 993, width: 414 };
    const rows = [78, 278, 478, 678];
    type Col = { left: number; width: number };
    const side: Record<string, [Col, number]> = { system: [L, 0], cyber: [L, 1], algo: [L, 2], ds: [L, 3], vault: [R, 0], city: [R, 1], core: [R, 2], vision: [R, 3] };
    const cards: Record<string, Box> = { clubs: { left: 504, top: 721, width: 423, height: 146 } };
    for (const [k, [col, i]] of Object.entries(side)) cards[k] = { left: rtl ? (col === L ? R.left : L.left) : col.left, top: rows[i], width: col.width, height: 188 };
    const svg: any = { attrs: {} as Record<string, string>, html: '', setAttribute(k: string, v: string) { this.attrs[k] = v; }, set innerHTML(v: string) { this.html = v; }, classList: { add() {} } };
    const nodes = Object.keys(cards).map((k) => ({ getAttribute: () => k, querySelector: () => ({ getBoundingClientRect: () => rect(cards[k]) }) }));
    const map = { getBoundingClientRect: () => rect({ left: 24, top: 78, width: 1383, height: 790 }), querySelector: (q: string) => (q === '.oh-hub' ? { getBoundingClientRect: () => rect(hubBox) } : q === '.oh-hub-slot' && slotBox ? { getBoundingClientRect: () => rect(slotBox) } : null), querySelectorAll: (q: string) => (q === '[data-oh-node]' ? nodes : q === '.oh-orbit .oh-agent-orb' && slotBox ? ORBS.map((b) => ({ getBoundingClientRect: () => rect(b) })) : []), getAttribute: () => null };
    const sandbox: any = { document: { getElementById: (id: string) => ({ 'oh-map': map, 'oh-links': svg } as any)[id] || null }, getComputedStyle: () => ({ display: 'block' }), _esc: esc, console };
    vm.runInNewContext(source + '\n_ohDrawLinks();', sandbox);
    return { html: svg.html as string, cards, m: { left: 24, top: 78 } };
  }
  const audit = (r: ReturnType<typeof draw>, R = 243) => {
    const cx = 585 + 135 - 24, cy = 277 + 135 - 78;
    return [...r.html.matchAll(/<path class="oh-link oh-link--([a-z]+)" data-k="\1" d="M([-\d.]+),([-\d.]+) C[^"]* ([-\d.]+),([-\d.]+)"/g)].map((m) => {
      const [k, x1, y1, x2, y2] = [m[1], +m[2], +m[3], +m[4], +m[5]];
      const c = rect(r.cards[k]);
      const rim = Math.abs(Math.hypot(x1 - cx, y1 - cy) - R) < 0.6;
      const before = c.left + c.width / 2 < 585 + 135;
      const end = k === 'clubs'
        ? Math.abs(x2 - (c.left + c.width / 2 - 24)) < 0.6 && Math.abs(y2 - (c.top - 78)) < 0.6
        : Math.abs(x2 - ((before ? c.right : c.left) - 24)) < 0.6 && Math.abs(y2 - (c.top + c.height / 2 - 78)) < 0.6;
      const port = r.html.includes(`<circle class="oh-link-port oh-link-end--${k}" cx="${x1}" cy="${y1}"`);
      const ringAt = r.html.includes(`<circle class="oh-link-ring oh-link-ring--${k}" cx="${x2}" cy="${y2}"`);
      return { k, rim, end, port, ringAt };
    });
  };
  it('leaves the orbit\'s outer ring for every room and lands on that card\'s edge, in either reading direction', () => {
    for (const rtl of [false, true]) {
      const a = audit(draw(rtl));
      expect(a.map((x) => x.k).sort()).toEqual(['algo', 'city', 'clubs', 'core', 'cyber', 'ds', 'system', 'vault', 'vision']);
      expect([rtl, a.filter((x) => !(x.rim && x.end && x.port && x.ringAt))]).toEqual([rtl, []]);
    }
    // Under each line, its own soft glow: decoration, which the lighting of a room also reaches.
    expect(draw(false).html).toMatch(/<path class="oh-link-glow" data-k="system" d="M[^"]+" stroke="url\(#oh-g-system\)" filter="url\(#oh-soft\)"\/>/);
    expect(HELPERS).toContain("map.querySelectorAll('.oh-link, .oh-link-glow').forEach(function (p) {");
    // Without an orbit (no slot, or one that is not a square round the hub) the lines leave the hub's own rim.
    const bare = audit(draw(false, HELPERS, undefined, null), 135);
    expect(bare.filter((x) => !(x.rim && x.end))).toEqual([]);
  });
  it('draws a spoke from the hub\'s rim to each agent on the orbit, ending at the agent\'s edge', () => {
    const html = draw(false).html;
    const spokes = [...html.matchAll(/<path class="oh-spoke" d="M([-\d.]+),([-\d.]+) L([-\d.]+),([-\d.]+)"\/>/g)].map((m) => m.slice(1).map(Number));
    expect(spokes).toHaveLength(10);
    const cx = 696, cy = 334;
    for (const [x1, y1, x2, y2] of spokes) {
      expect(Math.abs(Math.hypot(x1 - cx, y1 - cy) - 135)).toBeLessThan(0.6);
      expect(Math.abs(Math.hypot(x2 - cx, y2 - cy) - (194 - 20))).toBeLessThan(0.8);
    }
  });
  it('(control) the same check fails against lines that leave the hub\'s box instead of its rim', () => {
    const boxy = HELPERS.replace("x1 = cx + (before ? -1 : 1) * rx * Math.sqrt(Math.max(0, 1 - Math.pow((y1 - cy) / ry, 2)));", 'x1 = (before ? h.left : h.right) - m.left;');
    expect(boxy).not.toBe(HELPERS);
    expect(audit(draw(false, boxy)).some((x) => !x.rim)).toBe(true);
  });

  it('draws nothing, and writes no NaN, while the map is in the page but not laid out', () => {
    // Another room is showing: the landing is still in the document, and a resize asks for a redraw.
    const zero = { left: 0, top: 0, width: 0, height: 0 };
    const hidden = draw(false, HELPERS, zero, zero);
    expect(hidden.html).toBe('');
    expect(hidden.html).not.toMatch(/NaN/);
  });
  it('(control) without that guard the same redraw writes NaN into the page', () => {
    const unguarded = HELPERS.replace("if (!(h.width > 0 && h.height > 0 && m.width > 0)) { svg.innerHTML = ''; return; }", '');
    expect(unguarded).not.toBe(HELPERS);
    const zero = { left: 0, top: 0, width: 0, height: 0 };
    expect(draw(false, unguarded, zero, zero).html).toMatch(/NaN/);
  });

  it('names every agent under the hub as the registry names it, and keeps the names beside a room for the caption', async () => {
    const r = await runFill(overview());
    expect(r.by.clubs).toContain('<span class="oh-agent-orb"><svg viewBox="0 0 24 24"');
    expect(r.by.clubs).toContain('<span class="oh-agent-tag"><span class="oh-agent-name">Device Management</span><span class="oh-agent-lcb" data-no-i18n>RUNNING</span></span>');
    // On the orbit every agent is named beside its orb, with its lifecycle as the registry writes it
    // (data, never translated, never a running light); beside a room's card the name is for the caption.
    expect(CSS).toMatch(/body\.club-theme \.oh-orbit \.oh-agent-tag\{\s*position: absolute; top: calc\(100% \+ 4px\);/);
    expect(CSS).toContain('body.club-theme .oh-agent-lcb{ display: none; }');
    // Its orb is the rendered glass one, served from our own origin.
    expect(CSS).toContain('background: url(/owner-control/art/orb.webp) center / 112% no-repeat,');
    expect(CSS).toMatch(/body\.club-theme \.oh-agent-name,\s*body\.club-theme \.oh-agent-none-l\{\s*position: absolute; width: 1px; height: 1px;/);
    // The orbit is the CLUB agents' host, a sibling of the hub's button, never inside it.
    expect(LANDING).toMatch(/<\/button>\s*<div class="oh-agents-list oh-orbit" data-oh-agents="clubs"><\/div>\s*<\/div>/);
  });

  // The orbit's places, read back out of the stylesheet.
  const places = (n: number) => Array.from({ length: n }, (_, i) => {
    const m = CSS.match(new RegExp(`\\.oh-orbit > \\.oh-agent:nth-child\\(${i + 1}\\):nth-last-child\\(${n - i}\\)\\{ inset-inline-start: ([\\d.]+)%; top: ([\\d.]+)%; \\}`));
    return m ? [Number(m[1]), Number(m[2])] : null;
  });
  it('stands any number of agents up to twelve evenly on the orbit, by selector alone, and never at its foot', () => {
    for (let n = 1; n <= 12; n++) {
      const p = places(n);
      expect([n, p.every(Boolean)]).toEqual([n, true]);
      for (const [x, y] of p as number[][]) {
        expect(Math.abs(Math.hypot(x - 50, y - 50) - 40)).toBeLessThan(0.15);
        // The line to CLUBS runs straight down from the orbit's foot: no agent stands within 14° of it.
        const deg = Math.atan2(x - 50, 50 - y) * 180 / Math.PI;
        if (n > 1) expect([n, Math.abs(Math.abs(deg) - 180) > 14]).toEqual([n, true]);
      }
    }
    // Thirteen or more fall back to a dock, rather than overlapping.
    expect(CSS).toContain('body.club-theme .oh-orbit:has(> .oh-agent:nth-child(13)){ position: static;');
    // Nothing places them by script.
    expect(HELPERS + LANDING).not.toMatch(/\.style\.|setAttribute\('style'/);
  });
  it('(control) the same check fails against an orbit that stands an agent at its foot', () => {
    const tenth = places(10).map((p) => p as number[]);
    const shifted = tenth.map(([x, y]) => { const t = Math.atan2(x - 50, 50 - y) - 18 * Math.PI / 180; return [50 + 40 * Math.sin(t), 50 - 40 * Math.cos(t)]; });
    expect(shifted.some(([x, y]) => Math.abs(Math.abs(Math.atan2(x - 50, 50 - y) * 180 / Math.PI) - 180) <= 14)).toBe(true);
  });

  // ── the chips and the hub's two-part name, drawn from what the catalogue already translated ──
  function split(lines: string[], title: string) {
    const hosts = lines.map(() => ({ html: '', set innerHTML(v: string) { this.html = v; } }));
    const lists = lines.map((t, i) => ({ querySelector: (q: string) => (q === '.oh-chips-src' ? { textContent: t } : q === '.oh-chips' ? hosts[i] : null) }));
    const a = { textContent: '' }, b = { textContent: '' };
    const titleEl = { querySelector: (q: string) => (q === '.oh-split-src' ? { textContent: title } : q === '.oh-hub-title-a' ? a : q === '.oh-hub-title-b' ? b : null) };
    const map = { querySelectorAll: (q: string) => (q === '.oh-card-list[data-oh-chips]' ? lists : []), querySelector: (q: string) => (q === '.oh-hub-title' ? titleEl : null) };
    const sandbox: any = { document: { getElementById: (id: string) => (id === 'oh-map' ? map : null) }, _esc: esc, requestAnimationFrame: () => 0 };
    vm.runInNewContext(HELPERS + '\n_ohSplitPaint();', sandbox);
    return { chips: hosts.map((h) => [...h.html.matchAll(/<span class="oh-chip"><span>([^<]*)<\/span><\/span>/g)].map((m) => m[1])), raw: hosts.map((h) => h.html), a: a.textContent, b: b.textContent };
  }
  it('draws each card\'s contents as chips from the translated line, and the hub\'s name in its two parts', () => {
    const r = split(['Übersicht · Register · Intelligenzkreislauf', 'مركز القيادة · الأندية'], 'KI-AGENTEN — OPERATIONSRAUM');
    expect(r.chips).toEqual([['Übersicht', 'Register', 'Intelligenzkreislauf'], ['مركز القيادة', 'الأندية']]);
    expect([r.a, r.b]).toEqual(['KI-AGENTEN', 'OPERATIONSRAUM']);
    // What a catalogue says is escaped before it is drawn.
    expect(split(['<img src=x onerror=alert(1)> · b'], 'a — b').raw[0]).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // The pieces are never translated a second time, and only the whole line is read aloud.
    for (const k of ['system', 'cyber', 'algo', 'ds', 'vault', 'city', 'core', 'vision']) {
      expect(cardOf(k)).toMatch(/<div class="oh-card-list" data-oh-chips><span class="oh-chips-src">[^<]+<\/span><span class="oh-chips" data-no-i18n aria-hidden="true"><\/span><\/div>/);
    }
    // Drawn in the frame after the catalogue's own pass over new markup, and again on every change of language.
    expect(HELPERS).toContain('if (typeof requestAnimationFrame === \'function\') requestAnimationFrame(_ohSplitPaint); else _ohSplitPaint();');
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

  it('is a labelled, empty group, hidden until shown, and never translated', () => {
    expect(group).toBe('<div class="lang-switch" id="lang-switch" role="group" aria-label="Interface Language" data-i18n-aria="settings.interfaceLanguage" data-no-i18n hidden></div>');
    // No button, handler, style or language list of its own: every button is drawn from the registry.
    expect(group).not.toMatch(/<button|\son[a-z]+=|style=|title=|العربية|Deutsch|English|Français|Español/);
  });

  it('offers exactly the official languages, in the registry’s order, with the direction the registry gives them', () => {
    const official = [...CFG.matchAll(/\{ tag: '([^']+)',\s*label: '[^']+',\s*dir: '(ltr|rtl)', official: (\d+) \}/g)]
      .sort((a, b) => Number(a[3]) - Number(b[3])).map((m) => `${m[1]}:${m[2]}`);
    expect(official).toEqual(['en-GB:ltr', 'de-DE:ltr', 'ar:rtl', 'fr-FR:ltr', 'es-ES:ltr']);
    expect(officialRoomLocales().map((l) => `${l[3]}:${l[2]}`)).toEqual(official);
    // The switch names no language itself.
    expect(SWITCH).not.toMatch(/\[\s*'ar'|'de-DE'|'en-GB'|'fr-FR'|'es-ES'/);
  });

  const ESC = APP.slice(APP.indexOf('function _esc(s) {'), APP.indexOf('}', APP.indexOf('function _esc(s) {')) + 1);
  /** The switch, run against the real config.js and i18n.js, in a group that parses what is drawn into it. */
  async function sandbox(now = 'en-GB', officialOverride?: Array<{ tag: string; label: string }>) {
    const platform = await platformI18n(now);
    const changes: string[] = [];
    const btns: any[] = [];
    const mk = (attrs: Record<string, string>, text: string) => ({ attrs, textContent: text,
      getAttribute(k: string) { return this.attrs[k] ?? null; }, setAttribute(k: string, v: string) { this.attrs[k] = v; },
      closest: (q: string) => (q === '#lang-switch' ? {} : null) });
    let drawn = '';
    let draws = 0;
    const g: any = { hidden: true,
      set innerHTML(v: string) {
        drawn = v; draws += 1; btns.length = 0;
        for (const m of v.matchAll(/<button ([^>]*)>([^<]*)<\/button>/g)) {
          const attrs: Record<string, string> = {};
          for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
          btns.push(mk(attrs, m[2]));
        }
      },
      get innerHTML() { return drawn; },
      querySelector: (q: string) => (q === '[data-locale]' ? btns[0] || null : null),
      querySelectorAll: () => btns };
    const I18N = officialOverride ? { ...platform.I18N, officialLocales: () => officialOverride } : platform.I18N;
    const sb: any = {
      window: {}, document: { getElementById: (id: string) => (id === 'lang-switch' ? g : null) }, String,
      I18N,
      I18N_APPLY: { change: (t: string) => { changes.push(t); return platform.I18N.setLocale(t).then(() => ({ locale: t, saved: true })); } },
    };
    sb.window.I18N = sb.I18N; sb.window.I18N_APPLY = sb.I18N_APPLY;
    vm.runInNewContext(ESC + '\n' + SWITCH + '\nthis.show = _langSwitchShow; this.to = _langSwitchTo;', sb);
    return { sb, g, btns, changes, draws: () => draws };
  }

  it('is revealed for the owner with one button per official language, each named in its own language, and says which is in force', async () => {
    const { sb, g, btns } = await sandbox('de-DE');
    sb.show();
    expect(g.hidden).toBe(false);
    expect(btns.map((b) => b.textContent)).toEqual(['EN', 'DE', 'AR', 'FR', 'ES']);
    expect(btns.map((b) => b.attrs['data-locale'])).toEqual(['en-GB', 'de-DE', 'ar', 'fr-FR', 'es-ES']);
    expect(btns.map((b) => b.attrs.lang)).toEqual(['en', 'de', 'ar', 'fr', 'es']);
    expect(btns.map((b) => b.attrs['aria-label'])).toEqual(['EN · English (UK)', 'DE · Deutsch', 'AR · العربية', 'FR · Français', 'ES · Español (ES)']);
    expect(btns.map((b) => b.attrs.title)).toEqual(['English (UK)', 'Deutsch', 'العربية', 'Français', 'Español (ES)']);
    expect(btns.map((b) => b.attrs['aria-pressed'])).toEqual(['false', 'true', 'false', 'false', 'false']);
    // Real buttons, reached by Tab and pressed with Enter or Space, through the one delegated action.
    expect(btns.every((b) => b.attrs.type === 'button' && b.attrs['data-action'] === 'setUiLocale' && b.attrs.class === 'lang-switch-btn')).toBe(true);
  });

  it('is drawn once, however often it is shown', async () => {
    const { sb, draws } = await sandbox('fr-FR');
    sb.show(); sb.show(); sb.show();
    expect(draws()).toBe(1);
  });

  it('(control) a language the registry does not mark official is not offered, and with none the group stays hidden', async () => {
    const two = await sandbox('en-GB', [{ tag: 'en-GB', label: 'English (UK)' }, { tag: 'de-DE', label: 'Deutsch' }]);
    two.sb.show();
    expect(two.btns.map((b) => b.attrs['data-locale'])).toEqual(['en-GB', 'de-DE']);
    const none = await sandbox('en-GB', []);
    none.sb.show();
    expect(none.g.hidden).toBe(true);
    expect(none.btns).toEqual([]);
  });

  it('changes language only through I18N_APPLY.change, once, and not to the language already in force', async () => {
    const { sb, btns, changes } = await sandbox('en-GB');
    sb.show();
    const by = (tag: string) => btns.find((b) => b.attrs['data-locale'] === tag);
    sb.to(by('fr-FR')); await new Promise((r) => setTimeout(r, 0)); sb.to(by('fr-FR'));
    await new Promise((r) => setTimeout(r, 0));
    expect(changes).toEqual(['fr-FR']);
    sb.to(by('ar'));
    await new Promise((r) => setTimeout(r, 0));
    sb.to(by('es-ES'));
    await new Promise((r) => setTimeout(r, 0));
    expect(changes).toEqual(['fr-FR', 'ar', 'es-ES']);
    expect(btns.map((b) => b.attrs['aria-pressed'])).toEqual(['false', 'false', 'false', 'false', 'true']);
    // A button that is not the switch's own changes nothing.
    sb.to({ getAttribute: () => 'de-DE', closest: () => null });
    expect(changes).toEqual(['fr-FR', 'ar', 'es-ES']);
    // One path: the switch never caches, sets a direction or loads a locale itself.
    expect(SWITCH).not.toMatch(/localStorage|\.dir\b|setLocale\(|\.cache\(|fetch\(/);
  });

  it('is shown only once /system/whoami says yes, and is the delegated action every button uses', () => {
    // the same answer, and only it, also reveals the Platform Owner navigation (the Neural Digital Twin, System Updates)
    expect(APP).toContain(".catch(() => false)\n    .then(function (yes) { if (yes) { try { _langSwitchShow(); } catch (_) {} try { _ownerNavShow(); } catch (_) {} } return yes; });");
    expect(APP).toContain("case 'setUiLocale': _langSwitchTo(el); break;");
    expect(CSS).toContain('body.club-theme .lang-switch[hidden]{ display: none; }');
    // The club member's landing shows none of it.
    expect(MEMBER).not.toMatch(/lang-switch|_langSwitch/);
  });

  it('keeps its state and the map\'s lines right after any change of language, however it was made', () => {
    expect(APP).toMatch(/I18N_APPLY\.registerRepaint\(function \(\) \{\s*try \{ _langSwitchSync\(\); \} catch \(_\) \{\}\s*try \{ if \(document\.getElementById\('oh-map'\)\) \{ _ohSplitPaint\(\); _ohScheduleDraw\(\); \} \} catch \(_\) \{\}\s*\}\);\s*I18N_APPLY\.boot\(\);/);
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
