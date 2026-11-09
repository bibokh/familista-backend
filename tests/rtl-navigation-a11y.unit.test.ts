// Back points back in every language, and the primary action can be read and reached.
//
// 1. A control that goes back carries its arrow once, as a left-to-right reader sees it, in
//    <span class="fam-dir-ic" aria-hidden="true">←</span> (app.js _dirArrow). app.css mirrors that span
//    under :dir(rtl), so in Arabic "back" points right — the way that reader came — and a change of
//    language turns it in place. Before this, the platform shell wrote "← Back" into its buttons and an
//    Arabic reader was sent "back" to the right-hand side of a right-to-left page by an arrow pointing
//    forward. The owner rooms already mirror their own back buttons in their own stylesheets; that is
//    held here too, so a room cannot add a back button that forgets.
// 2. An arrow that means something other than "go back" — data flowing, a pipeline advancing, time
//    being scrubbed, a keyboard key — keeps its direction in every language and never carries the class.
// 3. The green primary button's white label measured 3.30:1 (axe: color-contrast). Its fill is now a
//    darker step of the same green, every state of it reaches 4.5:1, and the keyboard ring is visible on
//    both themes. The sign-in screen's links are reachable by keyboard.
//
// What a browser alone can show — the arrow's rendered direction, the computed contrast, Tab order and
// the visible ring, phone and desktop widths — is proven in tools/components/twin-browser-proof.cjs (T6).

import fs from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP = read('public/app.js');
const CSS = read('public/app.css');
const HTML = read('public/index.html');

// ── contrast (WCAG 2.x relative luminance) ────────────────────────────────────
const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const luminance = (hex: string) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}

/** Every fill a stylesheet gives a selector, in any state: [selector, hex] for each colour in a background declaration. */
export function fills(css: string, cls: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sels = m[1].split(',').map((x) => x.trim()).filter((x) => new RegExp('(^|\\s)\\.' + cls + '(?![\\w-])').test(x));
    if (!sels.length) continue;
    for (const d of m[2].matchAll(/background(?:-color)?\s*:\s*([^;]+)/g)) {
      for (const hex of d[1].match(/#[0-9a-fA-F]{6}\b/g) || []) out.push([sels.join(', '), hex.toUpperCase()]);
    }
  }
  return out;
}

// ── back arrows in code ───────────────────────────────────────────────────────
const BACK = '←‹«◀';
/** Time controls: they move through a recording, not back through the interface, and keep their direction. */
const TIME_CONTROLS = ['replayScrub(-10)">«10<', 'replayScrub(-1)">‹<', 'tosTwinStep(-1000)">«1s<'];
/** Every control whose label starts with a back-pointing arrow written as plain text, and every bare back-arrow span. */
export function unmirroredBack(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp('<(button|a)\\b[^>]*>\\s*([' + BACK + '])', 'g'))) {
    const at = src.slice(m.index as number, (m.index as number) + 160);
    if (TIME_CONTROLS.some((t) => at.includes(t))) continue;
    out.push(at.split('\n')[0].slice(0, 120));
  }
  for (const m of src.matchAll(new RegExp('<span aria-hidden="true">[' + BACK + ']</span>', 'g'))) out.push(m[0]);
  return out;
}

/** An owner room's back buttons: each class whose button opens with an arrow span, and whether the room mirrors it. */
export function roomBackButtons(js: string, css: string): Array<{ cls: string; mirrored: boolean }> {
  const flat = js.replace(/'\s*\+\s*'/g, '');
  const out: Array<{ cls: string; mirrored: boolean }> = [];
  for (const m of flat.matchAll(/<button\b[^>]*?\bclass="([^"]+)"[^>]*>\s*<span( class="[^"]*")? aria-hidden="true">←<\/span>/g)) {
    const classes = m[1].split(/\s+/);
    const shared = !!m[2] && /\bfam-dir-ic\b/.test(m[2]);
    const own = classes.some((c) => new RegExp('\\[dir="rtl"\\][^{]*\\.' + c + '\\s+span\\[aria-hidden\\][^{]*\\{[^}]*scaleX\\(-1\\)').test(css));
    out.push({ cls: classes.join('.'), mirrored: shared || own });
  }
  return out;
}
const ROOMS = fs.readdirSync(path.join(ROOT, 'public'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, 'public', d.name, 'i18n')))
  .map((d) => d.name);
const roomFiles = (room: string, ext: string) => fs.readdirSync(path.join(ROOT, 'public', room)).filter((f) => f.endsWith(ext)).map((f) => read(`public/${room}/${f}`)).join('\n');

describe('a back arrow follows the reading direction', () => {
  it('one mechanism: the class is mirrored only right to left, and the helper writes it', () => {
    expect(CSS).toContain('.fam-dir-ic{ display:inline-block; }');
    expect(CSS).toContain('.fam-dir-ic:dir(rtl){ transform:scaleX(-1); }');
    // Nothing turns it in a left-to-right language.
    const rules = [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*\.fam-dir-ic[^{}]*)\{([^}]*)\}/g)];
    for (const [, sel, body] of rules) if (/transform/.test(body)) expect(sel.trim()).toBe('.fam-dir-ic:dir(rtl)');
    const ctx: any = { window: {} };
    vm.runInNewContext((APP.match(/function _dirArrow\(glyph\) \{[^\n]*\}/) as RegExpMatchArray)[0] + '; out = [_dirArrow(), _dirArrow("›"), _dirArrow("<svg></svg>")];', ctx);
    expect(ctx.out).toEqual(['<span class="fam-dir-ic" aria-hidden="true">←</span>', '<span class="fam-dir-ic" aria-hidden="true">›</span>',
      '<span class="fam-dir-ic" aria-hidden="true"><svg></svg></span>']);
    expect(APP).toContain('window.famDirArrow = _dirArrow;');
  });

  it('the platform shell writes no back arrow a right-to-left reader would see pointing forward', () => {
    expect(unmirroredBack(APP)).toEqual([]);
    // Each control the audit found now uses it: Owner Control, Club Workspaces, Academy, Competition, Transfers, Match Centre.
    for (const s of [
      `type="button">' + _dirArrow() + ' Owner Home</button>`,
      `renderAnalyticsPage();">\${_dirArrow()} Back to Players</button>`,
      `data-action="pcBackToList">\${_dirArrow()} Back to squad</button>`,
      `data-action="trainingBack">\${_dirArrow()} Back</button>`,
      `renderMedicalPage();">\${_dirArrow()} Players</button>`,
      `data-tab="prospects">' + _dirArrow() + ' Back</button>`,
      `<span class="fam-back-ic fam-dir-ic" aria-hidden="true">←</span>Back</button>`,
      `data-at-back>' + _dirArrow() + ' ' + t('academy.backToAcademy')`,
      `data-co-back="' + to + '">' + _dirArrow() + ' ' + _coEsc(label)`,
      `'>' + _dirArrow('‹') + ' PREVIOUS</button>'`, `'>NEXT ' + _dirArrow('›') + '</button>'`,
      `_dirArrow('←') + ' ' + (prev == null`, `'Round ' + next) + ' ' + _dirArrow('→')`,
      `_dirArrow(_lgIcon('back')) + '<span>Club Workspace</span>`, `_dirArrow(_lgIcon('back')) + '<span>' + (_MCC.returnTo`,
    ]) expect([s, APP.includes(s)]).toEqual([s, true]);
    expect((APP.match(/renderPerformancePage\(\);">\$\{_dirArrow\(\)\} Back<\/button>/g) || []).length).toBe(2);
    expect(read('public/familista-vision/familista-vision.js')).toContain(`'<span class="vx-back-i fam-dir-ic" aria-hidden="true">' + ico('arrow') + '</span>'`);
    // A back button pinned to a corner sits where reading starts: left to left-to-right readers, right to right-to-left ones.
    expect(CSS).toContain('body.club-theme .cp-back{\n  position: absolute; inset-inline-start: 0; top: 0;');
    expect(CSS).toContain('.fam-back{ position:absolute; top:12px; inset-inline-start:14px;');
    // the club top bar's back button: its arrow icon turns, and its gap follows the reading direction
    expect(HTML).toMatch(/<button class="topbar-back"[^>]*>\s*<svg class="fam-dir-ic" aria-hidden="true"/);
    expect(CSS).toMatch(/body\.club-theme \.topbar-back\{[^}]*margin-inline-end: var\(--sp-2\);/);
  });

  it('every owner room mirrors its own back buttons right to left', () => {
    const found = ROOMS.flatMap((room) => roomBackButtons(roomFiles(room, '.js'), roomFiles(room, '.css')).map((b) => ({ room, ...b })));
    expect(found.map((b) => b.cls).sort()).toEqual(['al-back', 'al-rail-home', 'ar-back', 'cs-back', 'cs-rail-home', 'ds-rail-home', 'dv-rail-home', 'ic-rail-home', 'nt-back', 'nt-tool.nt-tool--wide.nt-tool--back', 'sc-rail-home', 'su-back']);
    expect(found.filter((b) => !b.mirrored)).toEqual([]);
    // Two rooms draw an icon instead of an arrow; both turn it.
    expect(read('public/design-studio/studio.css')).toContain('#st-root[dir="rtl"] .st-home svg { transform: scaleX(-1); }');
  });

  it('the sign-in screen: the back links are written ← and every right-to-left catalogue turns them (see auth-reset-localization)', () => {
    expect((HTML.match(/>← Back to sign in</g) || []).length).toBe(3);
  });

  it('an arrow that is not "go back" keeps its direction and never carries the class', () => {
    // time, in a recording
    for (const t of TIME_CONTROLS) expect(APP).toContain(t);
    // a pipeline advancing, a drawing tool, play
    expect(APP).toContain(`data-stage="' + nextStage + '">→ ' + nextStage + '</button>'`);
    expect(APP).toContain(`id="tos-mode-arrow">→ Arrow</button>`);
    // data flowing: the Algorithms room's own rule, and a catalogue's sequences, unchanged in Arabic
    expect(read('public/algorithms/algorithms.js')).toContain(`var arrow = AL_DIR === 'rtl' ? ' ← ' : ' → ';`);
    const ar = JSON.parse(read('public/i18n/catalogue/ar.json'));
    for (const k of ['Sign-in → Load Squad → Render All', 'Match Result → Refresh Standings', 'Create Session → Set Attendance', 'Promote Academy → Update Roster']) {
      expect([k, ar[k].includes('→'), ar[k].includes('←')]).toEqual([k, true, false]);
    }
    // keys on a keyboard
    expect(read('public/design-studio/studio.js')).toContain(`['←↑→↓', 'Move 1 px']`);
    // a recording stepped back is not mirrored either
    expect(roomFiles('data-vault', '.css')).not.toMatch(/\[dir="rtl"\][^{]*\.dv-tbtn/);
    // and the class is only ever inside a control
    const calls = APP.split('\n').map((l, i) => [l, i] as const).filter(([l]) => /_dirArrow\(/.test(l) && !/function _dirArrow|window\.famDirArrow/.test(l));
    expect(calls.length).toBe(16);
    for (const [l, i] of calls) expect([i + 1, /<button|data-at-back|data-co-back|data-tf-dpage|class="fl-rnav-btn"|class="mcx-back"/.test(l + APP.split('\n')[i - 1] + APP.split('\n')[i - 2])]).toEqual([i + 1, true]);
  });

  it('each label beside an arrow is translated in every official language', () => {
    const cfg = read('public/i18n/config.js');
    const tags = [...cfg.matchAll(/\{ tag: '([^']+)',[^}]*official: \d+ \}/g)].map((m) => m[1]).filter((t) => t !== 'en-GB');
    expect(tags.length).toBeGreaterThanOrEqual(1);
    for (const t of tags) {
      const c = JSON.parse(read(`public/i18n/catalogue/${t}.json`));
      for (const k of ['Back', 'Back to Players', 'Back to squad', 'Players', 'Owner Home', 'Previous', 'Next', 'Round \u0000', 'Club Workspace', 'Platform']) {
        expect([t, k, typeof c[k] === 'string' && c[k] !== '' && c[k] !== k]).toEqual([t, k, true]);
      }
    }
  });
});

const DARK_CARD = '#111115', LIGHT_CARD = '#FFFFFF', WHITE = '#FFFFFF';

describe('the green primary action can be read and reached', () => {

  it('every fill of .login-btn and .btn-primary, in every state, gives its white label 4.5:1', () => {
    for (const cls of ['login-btn', 'btn-primary']) {
      const f = fills(CSS, cls);
      expect(f.length).toBeGreaterThanOrEqual(3);
      for (const [sel, hex] of f) expect([sel, hex, contrast(WHITE, hex) >= 4.5]).toEqual([sel, hex, true]);
      expect(CSS).toMatch(new RegExp('\\.' + cls + '[^{]*\\{[^}]*color:\\s*#fff'));
    }
    expect(contrast(WHITE, '#15803D')).toBe(5.02);
    expect(contrast(WHITE, '#166534')).toBe(7.13);
    expect(contrast(WHITE, '#14532D')).toBe(9.11);
    expect(CSS).toContain('.login-btn:active{background:#14532D;}');
    expect(CSS).toContain('.btn-primary:active{background:#14532D;}');
  });

  it('the shared green is left as it was: bars, toggles and status fills keep it', () => {
    expect(CSS).toMatch(/--green:\s+#16A34A;/);
  });

  it('the keyboard ring is visible on both themes: 2px of --green, outside the control, 3:1 or better', () => {
    for (const sel of ['.login-btn', '.btn-primary', '.auth-link']) {
      expect(CSS).toMatch(new RegExp(sel.replace('.', '\\.') + ':focus-visible\\{outline:2px solid var\\(--green\\);outline-offset:2px;'));
    }
    expect(contrast('#16A34A', DARK_CARD)).toBeGreaterThanOrEqual(3);
    expect(contrast('#16A34A', LIGHT_CARD)).toBeGreaterThanOrEqual(3);
  });

  it('the sign-in screen\'s links are in the Tab order, and pressing one never changes the address', () => {
    const links = HTML.match(/<a class="auth-link"[^>]*>/g) || [];
    expect(links.length).toBe(5);
    for (const a of links) expect(a).toContain(' href="#" ');
    expect(APP).toMatch(/'\[data-action\],\[data-nav\],\[data-show-auth\],[^']*'/);
    expect(APP).toContain("if (el.tagName === 'A') e.preventDefault();");
  });
});

describe('the checks, watched working', () => {
  it('(control) a back arrow written as text, or in a bare span, is reported; the helper and the time controls are not', () => {
    expect(unmirroredBack('<button class="x">← Back</button>')).toHaveLength(1);
    expect(unmirroredBack(`'<button class="x">‹ PREVIOUS</button>'`)).toHaveLength(1);
    expect(unmirroredBack('<button><span aria-hidden="true">←</span> Back</button>')).toEqual(['<span aria-hidden="true">←</span>']);
    expect(unmirroredBack(`'<button class="x">' + _dirArrow() + ' Back</button>'`)).toEqual([]);
    expect(unmirroredBack('<button class="btn btn-outline btn-xs" onclick="replayScrub(-1)">‹</button>')).toEqual([]);
    expect(unmirroredBack('<button class="x">Next →</button>')).toEqual([]);
  });

  it('(control) a room back button with no right-to-left rule is reported; with its rule, or the shared class, it is not', () => {
    const js = `'<button class="zz-back" type="button">' + '<span aria-hidden="true">←</span> ' + T('Home') + '</button>'`;
    expect(roomBackButtons(js, '')).toEqual([{ cls: 'zz-back', mirrored: false }]);
    expect(roomBackButtons(js, '#zz[dir="rtl"] .zz-back span[aria-hidden] { display:inline-block; transform: scaleX(-1); }')).toEqual([{ cls: 'zz-back', mirrored: true }]);
    expect(roomBackButtons(js.replace('<span aria-hidden', '<span class="fam-dir-ic" aria-hidden'), '')).toEqual([{ cls: 'zz-back', mirrored: true }]);
  });

  it('(control) the green this replaces is caught: 3.30:1, in a rule or a gradient', () => {
    expect(contrast(WHITE, '#16A34A')).toBe(3.3);
    const old = '.login-btn{background:var(--green);color:#fff;}\n.btn-primary {\n  background: linear-gradient(135deg, #16A34A, #15803D);\n}';
    const bad = fills(old.replace('var(--green)', '#16A34A'), 'login-btn').concat(fills(old, 'btn-primary')).filter(([, h]) => contrast(WHITE, h) < 4.5);
    expect(bad.map(([, h]) => h)).toEqual(['#16A34A', '#16A34A']);
    expect(fills('.sq-btn-primary{ background:#f4b740; }', 'btn-primary')).toEqual([]);
  });
});
