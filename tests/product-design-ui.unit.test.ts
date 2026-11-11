/**
 * tests/product-design-ui.unit.test.ts
 *
 * Familista Design Studio, DS-1a — the room: how it is wired into the platform,
 * what it may and may not do, what it says about itself, how it is laid out, the
 * languages it speaks, and what it leaves untouched.
 *
 *   · Preservation: the Interface Studio (public/design-studio/, #design-studio)
 *     is byte-for-byte what it was at 20df5fd, and the new room uses none of its
 *     identifiers, storage keys or formats.
 *   · No server: no route, no CSP change, no request but its own static files.
 *     The owner check on the client is convenience, never a security boundary.
 *   · Honesty: every control this phase does not have is present, unavailable,
 *     and carries its reason; no price, no connected supplier, no fake status.
 *   · The repository's own rules: no markup strings, no inline style, the
 *     stable-layout rules, the escape hatches, mirrored chrome and an unmirrored
 *     garment, every word in the room catalogue of every official language.
 *
 * What only a browser can show (rendering, geometry against the approved image,
 * keyboard, persistence, RTL, the real CSP) is proven by
 * tools/components/product-design-browser-proof.cjs.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const json = (f: string) => JSON.parse(read(f));
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

const APP = read('public/app.js');
const JS = read('public/product-design/product-design.js');
const CODE = strip(JS);
const CORE = read('public/product-design/pd-core.js');
const CSS = read('public/product-design/product-design.css');
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const TOKENS_CSS = read('public/tokens/familista-tokens.css');
const TEMPLATE = json('public/product-design/templates/football-jersey.json');
const EN = json('public/product-design/i18n/en.json') as Record<string, string>;
const OFFICIAL = ['en', 'de', 'ar', 'fr', 'es'];

describe('the Interface Studio is preserved', () => {
  // public/design-studio/ at the approved baseline 20df5fd. A change to any of these files is a change to the
  // Interface Studio, which DS-1a is not allowed to make; a later, approved change updates this list on purpose.
  const BASELINE: Record<string, string> = {
    'public/design-studio/studio-core.js': '284e991e09912dc1e608478772453de2385fd6827fbbe777aafd3eaceb392ba4',
    'public/design-studio/studio.js': '7608a15ee9a3bec25d25009146cde842082483f18b0d0f1dd663984f39a2aaab',
    'public/design-studio/studio-frame.css': '0777950598d1f4ef53472617b14e900b3678c5f0f05057978de04a9e77f43699',
    'public/design-studio/studio.css': '04c4a74d3eca69f1ec82e62ded4d401052c4ff643750572a6b250eda915ef84d',
    'public/design-studio/i18n/ar.json': '15e218edc21882e5b07564c48ca98eff4cc6d9a1d30194a5684b6112e9f8b15c',
    'public/design-studio/i18n/de.json': '8349dc95de3dd1a11ba97442c381c661d4aa66a17fcfd46f7943ccd6846e4a10',
    'public/design-studio/i18n/en.json': 'f509b1bfdc413dd0f645a06bbdd2e3228fa366051ade8609ec777f280ec29f54',
    'public/design-studio/i18n/es.json': 'dc962dca0cf68c968bcfb1ac808410c96277e4da8f230a263c7683bd9c550fa0',
    'public/design-studio/i18n/fr.json': '63aadf2fba89466c064d5c03da63c47e8871f7058d7374f7f25f0ddf4005342f',
  };

  it('every file of the Interface Studio is byte-for-byte the approved baseline, and no file was added beside them', () => {
    for (const [f, h] of Object.entries(BASELINE)) expect([f, sha(f)]).toEqual([f, h]);
    const files = (d: string): string[] => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(d + '/' + e.name) : [d + '/' + e.name]));
    expect(files('public/design-studio').sort()).toEqual(Object.keys(BASELINE).sort());
  });

  it('its route, page, loader, version, storage keys, document format and export name are all still where they were', () => {
    expect(APP).toContain("'design-studio': 1,");
    expect(APP).toContain("var v = '20261020-design-studio-1a';");
    expect(APP).toContain('return `<div class="page" id="pg-design-studio" data-no-i18n data-fam-context="owner"><div id="st-root"></div></div>`;');
    expect(APP).toContain("'design-system':'Design System', 'design-studio':'Design Studio',");
    const studio = read('public/design-studio/studio.js'), core = read('public/design-studio/studio-core.js');
    expect(studio).toContain("var STORE_KEY = 'familista_design_studio_document';");
    expect(core).toContain("var FORMAT = 'familista.studio.document';");
    expect(core).toContain("return (slug || 'design') + '.familista-design.json';");
  });

  it('the Design Studio uses none of its identifiers: another storage key, another format, another file name, no shared code', () => {
    for (const src of [CODE, strip(CORE)]) {
      for (const own of ['familista_design_studio_document', 'familista.studio.document', '.familista-design.json', '/design-studio/', 'FamilistaStudioCore', 'renderFamilistaDesignStudio', 'st-root']) {
        expect([own, src.includes(own)]).toEqual([own, false]);
      }
    }
    expect(JS).toContain("var STORE_KEY = 'familista_product_design_draft_v1';");
    expect(CORE).toContain("var FORMAT = 'familista.product-design';");
  });
});

describe('wiring: an owner room of its own, asking the server for nothing', () => {
  it('app.js loads it on demand behind the platform-owner check, its core before its editor, under one version that the room also uses', () => {
    expect(APP).toContain("_famLoadOwnerRoom(_PD_ROOM, '20261110-product-design-1a', '/product-design/product-design.css', ['/product-design/pd-core.js', '/product-design/product-design.js'], done);");
    expect(JS).toContain("var VERSION = '20261110-product-design-1a';");
    expect(APP).toContain("if (page === 'product-design' && !(_PD_ROOM && _PD_ROOM.state === 'ready')) {");
    expect(APP).toMatch(/_loadProductDesign\(function \(ok\) \{\s*try \{ navTo\(ok \? page : 'owner-home', ok \? el : null, _opts\); \} catch \(_\) \{\}/);
  });

  it('says plainly that the client check is convenience and not a security boundary', () => {
    expect(APP).toContain('The /system/whoami check is convenience, NOT');
    expect(APP).toContain('a security boundary: the room has no endpoint and sends nothing to the server.');
    expect(JS).toContain('That check is a');
    expect(JS).toContain('convenience and NOT a security boundary');
  });

  it('is its own page: allow-listed, behind data-no-i18n, in the owner context with its own module accent, its own shell class and teardown, drawn on entry', () => {
    const allow = /var _ALLOWED_PAGES = \{([\s\S]*?)\};/.exec(APP)![1];
    expect(allow).toMatch(/'product-design': 1,/);
    expect(APP).toContain("'product-design':              renderProductDesignHTML,");
    expect(APP).toContain('return `<div class="page" id="pg-product-design" data-no-i18n data-fam-context="owner" data-fam-module="product-design"><div id="pd-root"></div></div>`;');
    expect(APP).toContain("document.body.classList.toggle('pd-studio-open', page === 'product-design');");
    expect(APP).toContain("if (_wasProduct && page !== 'product-design' && typeof window.teardownFamilistaProductDesign === 'function') {");
    expect(APP).toContain("&& _pdRoot && (_leaving !== 'pg-product-design' || !_pdRoot.__famDrawn)) {");
    expect(APP).toContain("'product-design':'Design Studio',");
    expect(read('public/index.html')).not.toContain('/product-design/');
  });

  it('is the third destination of the Platform Owner navigation, and marks itself there', () => {
    const start = APP.indexOf('var OWNER_NAV = [');
    const code = APP.slice(start, APP.indexOf('/** Mark the page open now', start));
    const sandbox: Record<string, unknown> = { window: {}, _esc: (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
    vm.createContext(sandbox);
    vm.runInContext(code + '\n;this.__nav = famOwnerNav; this.__list = OWNER_NAV;', sandbox);
    const list = sandbox.__list as Array<{ page: string; label: string }>;
    expect(list.map((i) => i.page)).toEqual(['neural-twin', 'system-updates', 'product-design']);
    const html = (sandbox.__nav as (a: string, T?: unknown, p?: string) => string)('product-design', undefined, 'pd-ownernav');
    expect(html).toMatch(/data-page="product-design" data-owner-nav="product-design" aria-current="page" title="Design Studio">/);
    expect((html.match(/aria-current="page"/g) || []).length).toBe(1);
    expect(JS).toContain("nav.innerHTML = window.famOwnerNav('product-design', T, 'pd-ownernav');");
  });

  it('adds no route, permission or CSP change: no TypeScript under src/ knows it, and the policy is the one it was', () => {
    const ts = (d: string): string[] => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? ts(path.join(d, e.name)) : /\.ts$/.test(e.name) ? [path.join(d, e.name)] : []));
    expect(ts('src').filter((f) => /product-design|ProductDesign|pd-core/.test(read(f)))).toEqual([]);
    const app = read('src/app.ts');
    expect(app).toContain(`scriptSrc:   ["'self'"],`);
    expect(app).toContain(`styleSrc:    ["'self'", 'https://fonts.googleapis.com'],`);
    expect(app).toContain(`imgSrc:      ["'self'", 'data:', 'blob:', 'https:'],`);
    expect(app).toContain(`frameSrc:    ["'none'"],`);
    expect(app).toContain(`objectSrc:   ["'none'"],`);
    const connect = app.slice(app.indexOf('connectSrc:'), app.indexOf('fontSrc:'));
    expect(connect).not.toMatch(/s3|r2\.|amazonaws|stripe|printful|printify|gelato/i);
  });
});

describe('the room is safe by construction', () => {
  it('writes no markup but the shared Owner navigation app.js builds and escapes', () => {
    expect((CODE.match(/\.innerHTML\s*=/g) || []).length).toBe(1);
    expect(CODE).toContain("nav.innerHTML = window.famOwnerNav(");
    expect(CODE).not.toMatch(/outerHTML|insertAdjacentHTML|document\.write|DOMParser|srcdoc|createContextualFragment/);
  });

  it('never runs code from a string, creates no script or style element, and sets no inline handler', () => {
    expect(CODE).not.toMatch(/\beval\(|new Function|setTimeout\(\s*['"`]|setInterval\(/);
    expect(CODE).not.toMatch(/createElement\(\s*['"](script|style|iframe|object|embed)['"]/);
    expect(CODE).not.toMatch(/setAttribute\(\s*['"]on[a-z]+['"]|\bon[a-z]+\s*:\s*function/);
  });

  it('writes styles only through the stylesheet and the CSSOM: no style attribute, no cssText, no style key handed to the builders', () => {
    expect(CODE).not.toMatch(/setAttribute\(\s*['"]style['"]|\.cssText|\bstyle\s*:\s*['"{]/);
    for (const m of CODE.matchAll(/style\.setProperty\('([a-z-]+)'/g)) expect(m[1]).toBe('font-family');
  });

  it('talks to nothing but its own static files: its template and its catalogue; no API, socket, beacon or form', () => {
    const fetches = [...CODE.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(fetches).toEqual(["'/product-design/i18n/' + LANG + '.json?v=' + VERSION", 'TEMPLATE_URL']);
    expect(JS).toContain("var TEMPLATE_URL = '/product-design/templates/football-jersey.json?v=' + VERSION;");
    expect(CODE).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|\/api\/|\.submit\(|<form/);
  });

  it('keeps two storage keys of its own, in localStorage only, and every storage call is guarded', () => {
    const keys = [...CODE.matchAll(/localStorage\.(getItem|setItem|removeItem)\(([A-Z_]+)/g)].map((m) => m[2]);
    expect([...new Set(keys)].sort()).toEqual(['STORE_KEY', 'STORE_UNREADABLE']);
    expect(CODE).not.toMatch(/sessionStorage|indexedDB|document\.cookie/);
    for (const line of CODE.split('\n').filter((l) => /localStorage\./.test(l))) expect([line.trim(), /try \{/.test(line)]).toEqual([line.trim(), true]);
  });

  it('every file it imports is checked by the core, and one over the limit is refused before it is read', () => {
    expect(CODE).toContain('if (file.size > LIMITS.bytes)');
    expect(CODE).toContain('C.parseDocument(text, TEMPLATE)');
    expect(CODE).toContain('C.parseDocument(raw, TEMPLATE)');
  });

  it('cleans up after itself: every listener goes through listen(), and teardown removes them all and saves the draft', () => {
    expect((CODE.match(/addEventListener\(/g) || []).length).toBe(1);
    expect(CODE).toContain('target.addEventListener(type, fn, opts);');
    expect(CODE).toMatch(/teardownFamilistaProductDesign = function \(\) \{[\s\S]*?saveNow\(false\);[\s\S]*?unbind\(\);/);
  });

  it('marks what a person typed as user content, so no translation pass ever rewrites it', () => {
    for (const field of ["class: 'pd-docname'", "class: 'pd-input pd-prop-name'", "'data-pd-field': 'text', 'aria-label': T('Text'), 'data-user-content': ''", "'data-pd-swatch-label': c.id"]) {
      const at = CODE.indexOf(field);
      expect([field, at > -1 && CODE.slice(at, at + 260).includes("'data-user-content': ''")]).toEqual([field, true]);
    }
    expect(CODE).toContain("h('span', { text: n.name, 'data-user-content': '' })");
  });
});

describe('it says what it is, and what it is not yet', () => {
  const REASONS = [...CODE.matchAll(/^\s+'?([a-z0-9-]+)'?: L\('([^']+)'\),$/gm)].map((m) => [m[1], m[2]] as const);
  const REASON_KEYS = new Set(REASONS.map((r) => r[0]));

  it('every unavailable control names a reason that exists, and every reason is in the room’s catalogue', () => {
    expect([...REASON_KEYS].sort()).toEqual(['360', '3d', 'capture', 'context-club', 'context-creator', 'fabric', 'image', 'method', 'order', 'orders', 'payments', 'product', 'proof', 'store', 'suppliers', 'templates', 'versions']);
    // Each reason is defined once and used at least once: by planned(…, 'key'), a context, a read-only field or a side entry.
    for (const k of REASON_KEYS) {
      const quoted = (CODE.match(new RegExp(`'${k}'`, 'g')) || []).length;
      const definedQuoted = new RegExp(`^\\s+'${k}': L\\(`, 'm').test(CODE) ? 1 : 0;
      expect([k, quoted - definedQuoted >= 1]).toEqual([k, true]);
    }
    for (const use of ["planned(image, 'image')", "planned(capture, 'capture')", "'aria-pressed': 'false', text: '3D' }), '3d')", "]), '360'))", "]), 'versions')", "]), 'proof')", "]), 'order')",
      "if (t[0] === 'templates') planned(b, 'templates');", "if (!it.live) { planned(b, 'product');", "if (!active) { planned(b, key);", "planned(sel, reason);", ": it.reason ? planned(btn({ class: 'pd-side-btn is-planned' }), it.reason)"]) {
      expect([use, CODE.includes(use)]).toEqual([use, true]);
    }
    for (const [, text] of REASONS) expect([text, EN[text]]).toEqual([text, text]);
    expect(CODE).toContain("el.setAttribute('aria-disabled', 'true');");
    expect(CODE).toContain("el.setAttribute('data-pd-reason', reasonKey);");
  });

  it('the side navigation names only the owner pages that exist; the rest are planned and say so', () => {
    for (const page of ['owner-home', 'neural-twin', 'agents-room', 'clubs']) expect(new RegExp(`'${page}': 1`).test(APP) || APP.includes(`'${page}': 1,`) || APP.includes(`'owner-home': 1, 'clubs': 1`)).toBe(true);
    expect(CODE).toContain("{ reason: 'store', icon: 'store', label: L('Global Store') }");
    expect(CODE).toContain("{ reason: 'payments', icon: 'card', label: L('Payments') }");
  });

  it('shows no price, no currency and no connected supplier: the cost is a dash, and every supplier is under evaluation or not researched', () => {
    expect(CODE).not.toMatch(/€|\$\s?\d|\d+[.,]\d{2}\s?(EUR|USD)/);
    expect(CODE).toContain("h('strong', { class: 'pd-cost-value', text: '—' })");
    expect(CODE).toContain("text: T('No quotation: no supplier connected')");
    const sup = CODE.slice(CODE.indexOf('var SUPPLIERS = ['), CODE.indexOf('];', CODE.indexOf('var SUPPLIERS = [')));
    expect([...sup.matchAll(/state: L\('([^']+)'\)/g)].map((m) => m[1])).toEqual(['Under evaluation', 'Under evaluation', 'Under evaluation', 'Not researched']);
    expect(CODE).not.toMatch(/L\('(Connected|Operational|Sandbox connected|Production connected)'\)/);
  });

  it('says on screen, always, that drafts live in this browser only', () => {
    expect(CODE).toContain("h('span', { text: T('Drafts are saved only in this browser') })");
    expect(CODE).toContain("L('Holds no club or personal data: drafts stay in this browser')");
  });

  it('a pipeline that advances reads left to right in every language, and its arrows keep their direction', () => {
    expect(CODE).toContain("var steps = h('ol', { class: 'pd-flow-steps', dir: 'ltr' });");
    expect(CODE).toContain("h('li', { class: 'pd-flow-arrow', 'aria-hidden': 'true', text: '→' })");
  });

  it('the garment is never mirrored: the canvas is left to right; a paging arrow is the shared mirrored one', () => {
    expect(CODE).toContain("role: 'application', 'aria-roledescription': T('design canvas'), 'aria-describedby': 'pd-help', dir: 'ltr' })");
    expect(CODE).toContain("function dirArrow(glyph) { return h('span', { class: 'fam-dir-ic', 'aria-hidden': 'true', text: glyph }); }");
    expect(CODE).toContain("[dirArrow('‹')]");
    expect(CODE).toContain("[dirArrow('›')]");
    expect(TEMPLATE.views.map((v: { label: string }) => v.label)).toEqual(['Front', 'Back', 'Right side', 'Left side']);
  });
});

describe('the official languages', () => {
  const literals = new Set<string>();
  for (const m of JS.matchAll(/\b(?:T|tf|L)\('((?:[^'\\]|\\.)*)'/g)) literals.add(m[1]);
  TEMPLATE.surfaces.forEach((s: { label: string }) => literals.add(s.label));
  TEMPLATE.views.forEach((v: { label: string }) => literals.add(v.label));
  literals.add(TEMPLATE.reference.method); literals.add(TEMPLATE.reference.fabric);
  TEMPLATE.reference.fits.forEach((f: { label: string }) => literals.add(f.label));
  TEMPLATE.start.palette.forEach((p: { label: string }) => literals.add(p.label));
  Object.values(TEMPLATE.start.surfaces as Record<string, { layers: Array<{ name: string }> }>).forEach((s) => s.layers.forEach((l) => literals.add(l.name)));
  // The shared Platform Owner navigation is drawn in the room's head and worded by the room's catalogue: every label of it.
  const navBlock = APP.slice(APP.indexOf('var OWNER_NAV = ['), APP.indexOf('];', APP.indexOf('var OWNER_NAV = [')));
  const NAV_LABELS = [...navBlock.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  NAV_LABELS.forEach((l) => literals.add(l));

  it('every label of the shared Owner navigation is worded by the room, so no language sees one in English by accident', () => {
    expect(NAV_LABELS).toEqual(['Neural Digital Twin', 'System Updates', 'Design Studio']);
    for (const code of OFFICIAL) for (const l of NAV_LABELS) expect([code, l, typeof (json(`public/product-design/i18n/${code}.json`) as Record<string, string>)[l]]).toEqual([code, l, 'string']);
  });

  it('every word the room and its template show is in the English catalogue, and the catalogue holds nothing else', () => {
    expect([...literals].filter((k) => /[A-Za-z]/.test(k) && !(k in EN))).toEqual([]);
    expect(Object.keys(EN).filter((k) => !literals.has(k))).toEqual([]);
  });

  it('every official language has the same keys, keeps every %s and %d, and is not empty', () => {
    for (const code of OFFICIAL) {
      const cat = json(`public/product-design/i18n/${code}.json`) as Record<string, string>;
      expect([code, Object.keys(cat).sort()]).toEqual([code, Object.keys(EN).sort()]);
      for (const [k, v] of Object.entries(cat)) {
        expect(v.trim().length).toBeGreaterThan(0);
        expect([code, k, (v.match(/%[ds]/g) || []).sort().join('')]).toEqual([code, k, (k.match(/%[ds]/g) || []).sort().join('')]);
      }
    }
  });

  it('writes no visible English outside the catalogue: the only literal texts are the brand, the mode names and symbols', () => {
    const noIcons = CODE.slice(0, CODE.indexOf('var ICONS = {')) + CODE.slice(CODE.indexOf('function icon(name, size)'));
    const texts = [...noIcons.matchAll(/text: '([^']*)'/g)].map((m) => m[1]);
    expect([...new Set(texts)].sort()).toEqual(['2.5D', '2D', '360°', '3D', 'Familista', 'Familista Design Studio', '—', '→'].sort());
  });

  it('the product names stay as the approved reference shows them, in every language', () => {
    for (const code of OFFICIAL) {
      const cat = json(`public/product-design/i18n/${code}.json`) as Record<string, string>;
      for (const name of ['Design Studio', 'Club Design Studio', 'Creator Studio', 'Design Studio Control']) expect([code, cat[name]]).toEqual([code, name]);
    }
    expect(json('public/product-design/i18n/ar.json')['Front']).toBe('الأمام');
  });

  it('the platform catalogue carries its navigation label in every locale', () => {
    const dir = path.join(ROOT, 'public/i18n/catalogue');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_') && x !== 'en-US.json')) {
      expect([f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))['Design Studio']]).toEqual([f, 'Design Studio']);
    }
  });
});

describe('the stylesheet keeps the repository’s rules', () => {
  const declared = new Set([...TOKENS_CSS.matchAll(/(--fam-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  it('declares no custom property and writes no colour of its own: every value is a --fam-* token, or mixed from tokens', () => {
    expect(CSS_CODE).not.toMatch(/(^|[{;\s])--[a-z0-9-]+\s*:/);
    expect(CSS_CODE).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
    for (const m of CSS_CODE.matchAll(/var\((--[a-z0-9-]+)/g)) expect([m[1], declared.has(m[1])]).toEqual([m[1], true]);
  });

  it('the workspace is a fixed viewport; every panel scrolls inside itself with a stable gutter', () => {
    expect(CSS_CODE).toMatch(/\.pd-shell \{[^}]*height: 100dvh; overflow: hidden;/);
    for (const sel of ['.pd-side', '.pd-lib-body', '.pd-insp-body', '.pd-prod']) {
      const rule = new RegExp(sel.replace('.', '\\.') + ' \\{[^}]*overflow-y: auto; scrollbar-gutter: stable;');
      expect([sel, rule.test(CSS_CODE)]).toEqual([sel, true]);
    }
  });

  it('drawers and sheets are position: fixed and move by opacity and transform only', () => {
    const blocks = [...CSS_CODE.matchAll(/([^{}]*)\{([^{}]*transition:[^{}]*)\}/g)];
    for (const [, sel, body] of blocks) {
      const props = (/transition:([^;]+);/.exec(body) as RegExpExecArray)[1].split(',').map((t) => t.trim().split(/\s+/)[0]);
      for (const p of props) expect([sel.trim().slice(-60), p, ['transform', 'opacity', 'visibility', 'none'].includes(p)]).toEqual([sel.trim().slice(-60), p, true]);
    }
    expect(CSS_CODE).toMatch(/\.pd-lib \{\s*position: fixed;/);
    expect(CSS_CODE).toMatch(/:is\(\.pd-lib, \.pd-insp, \.pd-prod\) \{\s*display: flex; position: fixed;/);
  });

  it('carries the escape hatches: a small or a short screen returns to normal scrolling', () => {
    expect(CSS_CODE).toContain('@media (max-width: 980px), (max-height: 620px) {');
    expect(CSS_CODE).toContain('body.pd-studio-open { overflow: auto; }');
    expect(CSS_CODE).toContain('@media (max-width: 1599px) {');
    expect(CSS_CODE).toContain('@media (max-width: 1279px) {');
    expect(CSS_CODE).toContain('@media (prefers-reduced-motion: reduce) {');
  });

  it('follows the reading direction with logical properties, and mirrors drawers with the direction multiplier', () => {
    expect(CSS_CODE).toContain('transform: translateX(calc(-104% * var(--fam-direction-multiplier, 1)));');
    expect(CSS_CODE).not.toMatch(/\b(margin|padding)-(left|right)\s*:|\btext-align:\s*(left|right)\b/);
  });

  it('its module accent is a token of its own, separate from the status colours', () => {
    const block = /\[data-fam-module="product-design"\],\s*#pg-product-design \{([^}]*)\}/.exec(TOKENS_CSS);
    expect(block).not.toBeNull();
    expect(block![1]).toContain('--fam-module-accent: var(--fam-ref-violet-500);');
    expect(block![1]).toContain('--fam-module-accent-2: var(--fam-ref-blue-500);');
    expect(TOKENS_CSS).toContain('--fam-status-unverified: var(--fam-ref-violet-400);');
    expect(CSS_CODE).not.toContain('--fam-status-unverified');
    expect(CSS_CODE).not.toContain('--fam-status-info');
  });
});

describe('the approved visual reference', () => {
  const regions = json('docs/design-studio/reference-regions.json');

  it('is the committed image, by its hash', () => {
    expect(sha('docs/design-studio/approved-reference-2026-11-10.webp')).toBe(regions.sha256);
  });

  it('every region R1–R15 is drawn by the room exactly once, so the browser proof can measure it', () => {
    const ids = Object.keys(regions.regions);
    expect(ids).toEqual(Array.from({ length: 15 }, (_, i) => 'R' + (i + 1)));
    for (const id of ids) expect([id, (CODE.match(new RegExp(`'data-ds-region': '${id}'`, 'g')) || []).length]).toEqual([id, 1]);
  });
});
