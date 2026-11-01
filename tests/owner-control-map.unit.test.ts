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

  it('keeps every listener on the map itself, and disconnects its one observer', () => {
    const bind = HELPERS.slice(HELPERS.indexOf('function _ohBindMap()'));
    expect(bind).not.toMatch(/document\.addEventListener|window\.addEventListener/);
    expect(bind).toContain('_ohLinksObserver.disconnect()');
    expect(bind).toContain('if (!document.body.contains(map)) { obs.disconnect();');
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
    expect(CSS).toContain('body.club-theme .oh-hub:focus-visible{ outline: 2px solid #fcd34d; outline-offset: 4px; }');
    expect(CSS).toContain('body.club-theme .oh-agent:focus-visible{ outline: 2px solid #4ade80; outline-offset: 2px; }');
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
