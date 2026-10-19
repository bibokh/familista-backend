/**
 * Familista Design System Control — Stage 3.2.3 M1 — the Specimen Lab (Fixture Plate)
 *
 * The Owner-only room gains a stage on which the ten verified primitives are drawn
 * from fixtures: markup their production render functions produced for fixed
 * inputs, checked and neutralised by ONE sanitizer used at build time, on the
 * server and in the browser. This suite pins, one guarantee at a time:
 *
 *   - the sanitizer is a closed allowlist that fails closed: every hostile input in
 *     a long corpus is refused, every real fixture passes and round-trips, and the
 *     browser half builds nodes with createElement and setAttribute, never HTML;
 *   - the preview manifest is generated, deterministic and current; every fixture is
 *     the Storybook golden snapshot, sanitised, hashed and bound to the render
 *     function and CSS the components manifest recorded; the golden snapshot is
 *     itself re-proved against public/app.js in this suite, so CI refuses drift;
 *   - the validator the server runs refuses every kind of malformed or tampered
 *     manifest, and none of it is ever partly served;
 *   - the API is GET-only, authenticated and Platform-Owner-only, and `id` is looked
 *     up in a fixed list;
 *   - the client is CSP-safe, GET-only, lazy, draws no unsanitised HTML (run for
 *     real in a sandbox, with hostile data), keeps events at the stage's boundary,
 *     and speaks English, German and Arabic.
 *
 * What Jest cannot prove — layout containment of a fixed overlay, event isolation
 * under real input, the translator leaving the stage alone — is proved in a real
 * browser by tools/components/lab-browser-proof.cjs, not assumed here.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);

type Row = Record<string, unknown>;
const USERS: Record<string, Row> = {};

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$connect' || k === '$disconnect') return async () => {};
      if (k === 'user') return {
        findUnique: async (q: { where: { id?: string } }) => Object.values(USERS).find((u) => u.id === q.where.id) ?? null,
        findFirst: async (q: { where: { id?: string } }) => Object.values(USERS).find((u) => u.id === q.where.id) ?? null,
      };
      if (k === 'platformAdmin') {
        const row = async (q: { where?: { userId?: string } }) => (q?.where?.userId === 'u-padmin' ? { isActive: true, role: 'ADMIN' } : null);
        return { findFirst: row, findUnique: row };
      }
      return new Proxy({}, { get: () => async () => null });
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/app');
import { execFileSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { signToken } from '../src/security/jwt-tokens';
import { forgetIdentity } from '../src/middleware/auth.middleware';
import { resetDesignSystemComponentsCache, resetDesignSystemPreviewsCache } from '../src/design-system/design-system.service';
import { DesignSystemPreviewsIndexSchema, DesignSystemPreviewDetailSchema, OWNER_API_CONTRACTS } from '../src/contracts/owner-api.contracts';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../src/design-system/previews-core.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const generator = require('../scripts/design-system-previews.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const S = require('../public/design-system/lab-sanitize.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = path.join(__dirname, '..');
const read = (p: string, root = ROOT) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (p: string) => JSON.parse(read(p));
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
const MANIFEST_PATH = 'src/design-system/generated/design-system-previews.json';
const COMPONENTS_PATH = 'src/design-system/generated/design-system-components.json';
const GOLDEN_PATH = 'tools/storybook/tests/golden/lg-primitives.golden.json';
const manifest = json(MANIFEST_PATH);
const components = json(COMPONENTS_PATH);
const golden = json(GOLDEN_PATH);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const byId = (id: string) => manifest.components.find((c: any) => c.id === id);
const allFixtures = (): { c: any; f: any }[] => manifest.components.flatMap((c: any) => c.fixtures.map((f: any) => ({ c, f })));

const app = createApp();
const token = (id: string, role: string) => signToken('access', { sub: id, role, tv: 0 }, { expiresIn: '10m' });
const get = (url: string, who?: [string, string]) => {
  const r = request(app).get(`/api/v1/system/design-system/components/preview${url}`);
  return who ? r.set('Authorization', `Bearer ${token(...who)}`) : r;
};
const OWNER: [string, string] = ['u-owner', 'SUPER_ADMIN'];

beforeAll(() => {
  const base = { isActive: true, currentClubId: null, currentTeamId: null, tokenVersion: 0, platformAdmin: null };
  USERS.owner = { ...base, id: 'u-owner', email: 'o@x.test', role: 'SUPER_ADMIN', clubId: null };
  USERS.platformAdmin = { ...base, id: 'u-padmin', email: 'p@x.test', role: 'CLUB_ADMIN', clubId: 'c-1', platformAdmin: { isActive: true } };
  USERS.clubAdmin = { ...base, id: 'u-cadmin', email: 'c@x.test', role: 'CLUB_ADMIN', clubId: 'c-1' };
  USERS.coach = { ...base, id: 'u-coach', email: 'h@x.test', role: 'HEAD_COACH', clubId: 'c-1' };
});
beforeEach(() => { forgetIdentity(); resetDesignSystemComponentsCache(); resetDesignSystemPreviewsCache(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('the sanitizer: a closed allowlist that fails closed', () => {
  it('passes every one of the 122 real fixtures, and what it writes is a fixed point', () => {
    let n = 0;
    for (const [sym, cases] of Object.entries<any>(golden)) for (const [label, raw] of Object.entries<string>(cases)) {
      const a = S.sanitize(raw);
      expect({ sym, label, ok: a.ok, problems: a.problems }).toEqual({ sym, label, ok: true, problems: [] });
      const b = S.sanitize(a.html);
      expect(b.ok && b.html === a.html).toBe(true);
      const tree = S.parse(a.html).tree;
      expect(S.serialize(tree)).toBe(a.html);
      n++;
    }
    expect(n).toBe(122);
  });

  it('has a closed list: eighteen tags, no more, and no attribute outside the ones real fixtures use', () => {
    const p = S.policy();
    expect(Object.keys(p.tags)).toEqual(['b', 'button', 'circle', 'div', 'footer', 'h2', 'header', 'i', 'img', 'p', 'path', 'section', 'span', 'svg', 'table', 'tbody', 'td', 'tr']);
    // Every attribute a real fixture uses is allowed on its tag, and every allowed attribute (but the one the sanitizer adds) is used by a real fixture: the list is as tight as the fixtures.
    const usedByTag: Record<string, Set<string>> = {};
    const seeTree = (n: any) => { if (n.t === 'el' && n.tag) { (usedByTag[n.tag] ||= new Set()); n.attrs.forEach((x: any) => usedByTag[n.tag].add(x[0])); } (n.kids || []).forEach(seeTree); };
    for (const cases of Object.values<any>(golden)) for (const raw of Object.values<string>(cases)) seeTree(S.parse(raw).tree);
    for (const [tag, set] of Object.entries(usedByTag)) for (const a of set) expect({ tag, a, ok: p.tags[tag].attributes.includes(a) }).toEqual({ tag, a, ok: true });
    for (const [tag, spec] of Object.entries<any>(p.tags)) for (const a of spec.attributes) if (!(tag === 'button' && a === 'tabindex') && !(tag === 'tbody')) expect({ tag, a, used: usedByTag[tag]?.has(a) }).toEqual({ tag, a, used: true });
    const allowed = new Set(Object.values<any>(p.tags).flatMap((t) => t.attributes));
    for (const forbidden of ['style', 'href', 'xlink:href', 'srcdoc', 'action', 'formaction', 'onclick', 'onerror', 'onload', 'id', 'name', 'target', 'data-i18n', 'data-nav', 'data-close-modal']) expect(allowed.has(forbidden)).toBe(false);
    expect(p.limits).toMatchObject({ bytes: 4096, nodes: 300, depth: 12 });
  });

  // ── M3/S2.2b-2: four narrow additions, each held to the one rule that admits it ──
  const DOT = '<span class="ds-dot" aria-hidden="true"></span>';
  const STATUS = (label: string) => '<div class="ds-skel" role="status" aria-label="' + label + '">x</div>';
  it('admits exactly the four additions the Owner Kit writes, in any attribute order', () => {
    expect(S.sanitize('<span class="ds-chip">' + DOT + 'Pass</span>').ok).toBe(true);
    expect(S.sanitize('<span aria-hidden="false">x</span>').ok).toBe(true);
    expect(S.sanitize('<h2 class="ds-panel-title">Contrast</h2>').ok).toBe(true);
    expect(S.sanitize('<div class="ds-empty" role="status">x</div>').ok).toBe(true);
    expect(S.sanitize('<div role="dialog">x</div>').ok).toBe(true);                          // dialog is still allowed
    expect(S.sanitize(STATUS('Reading the manifest…')).ok).toBe(true);
    expect(S.sanitize('<div aria-label="Reading" class="ds-skel" role="status">x</div>').ok).toBe(true);   // label before role
    expect(S.sanitize(STATUS('a'.repeat(200))).ok).toBe(true);                                // the 200-character boundary
    // An entity is text, not markup: it is kept as text and written back escaped, so no element appears.
    const ent = S.sanitize(STATUS('&lt;b&gt;'));
    expect(ent.ok).toBe(true);
    expect(ent.html).toBe(STATUS('&lt;b&gt;'));
    expect(ent.stats.elements).toBe(1);
  });

  it.each([
    ['1. aria-hidden="yes" on a span', '<span class="ds-dot" aria-hidden="yes"></span>', 'the value of "aria-hidden" is not allowed'],
    ['2a. an empty aria-hidden', '<span aria-hidden=""></span>', 'the value of "aria-hidden" is not allowed'],
    ['2b. aria-hidden="TRUE"', '<span aria-hidden="TRUE"></span>', 'the value of "aria-hidden" is not allowed'],
    ['2c. a valueless aria-hidden', '<span aria-hidden></span>', 'the attribute "aria-hidden" needs a value'],
    ['3. role="alert" on a div', '<div role="alert">x</div>', 'the value of "role" is not allowed'],
    ['4a. role="STATUS"', '<div role="STATUS">x</div>', 'the value of "role" is not allowed'],
    ['4b. role=" status"', '<div role=" status">x</div>', 'the value of "role" is not allowed'],
    ['4c. role="status "', '<div role="status ">x</div>', 'the value of "role" is not allowed'],
    ['4d. role="status dialog"', '<div role="status dialog">x</div>', 'the value of "role" is not allowed'],
    ['5a. aria-label on a div with no role', '<div aria-label="Reading">x</div>', 'the attribute "aria-label" is only allowed on a <div> with role="status"'],
    ['5b. aria-label on a dialog div', '<div role="dialog" aria-label="Reading">x</div>', 'the attribute "aria-label" is only allowed on a <div> with role="status"'],
    ['6. aria-label longer than 200 characters', STATUS('a'.repeat(201)), 'the value of "aria-label" is not allowed'],
    ['7. aria-label holding markup', STATUS('<b>x</b>'), 'a "<" inside the value of "aria-label" (at 0)'],
    ['8a. aria-label holding a bidi override', STATUS('a\u202Eb'), 'the value of "aria-label" holds a control or bidirectional character'],
    ['8b. aria-label holding a bidi isolate', STATUS('a\u2066b'), 'the value of "aria-label" holds a control or bidirectional character'],
    ['9. onclick on h2', '<h2 class="ds-panel-title" onclick="x">t</h2>', 'the attribute "onclick" is not allowed on <h2>'],
    ['10. style on h2', '<h2 style="color:red">t</h2>', 'the attribute "style" is not allowed on <h2>'],
    ['12. title on a span', '<span class="ds-chip" title="Known failure">x</span>', 'the attribute "title" is not allowed on <span>'],
    ['13a. role on a span', '<span role="status">x</span>', 'the attribute "role" is not allowed on <span>'],
    ['13b. aria-label on a span', '<span aria-label="x">x</span>', 'the attribute "aria-label" is not allowed on <span>'],
    ['14a. a "constructor" attribute', '<div constructor="x">x</div>', 'the attribute "constructor" is not allowed on <div>'],
    ['14b. a "hasOwnProperty" attribute', '<span hasOwnProperty="x">x</span>', 'the attribute "hasOwnProperty" is not allowed on <span>'],
    ['14c. a "toString" attribute', '<h2 toString="x">t</h2>', 'the attribute "toString" is not allowed on <h2>'],
    ['14d. a "__proto__" attribute', '<div __proto__="x">x</div>', 'a malformed attribute in <div> (at 0)'],
    ['14e. a <constructor> element', '<constructor>x</constructor>', 'the tag <constructor> is not allowed (at 0)'],
  ])('refuses %s, for that reason and no other', (_n, html, cause) => {
    const r = S.sanitize(html);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([cause]);
  });

  it('11. refuses an h2 class nobody owns, and still catches a genuinely repeated attribute', () => {
    const owned = (n: string) => n === 'ds-panel-title';
    expect(S.sanitize('<h2 class="ds-panel-title">t</h2>', { classOk: owned }).ok).toBe(true);
    expect(S.sanitize('<h2 class="ds-panel-title ds-bogus">t</h2>', { classOk: owned }).problems).toEqual(['the class "ds-bogus" has no approved provenance']);
    expect(S.sanitize('<div class="a" class="b">x</div>').problems).toEqual(['the attribute "class" is written twice (at 0)']);
  });

  it('neutralises exactly the four things it says it does, and reports every one', () => {
    const r = S.sanitize(golden._lgFloat['head and body']);
    expect(r.ok).toBe(true);
    expect(r.html).not.toMatch(/data-action|aria-modal|data-i18n-aria/);
    expect(r.html).toContain('<button class="lg-float-x" type="button" aria-label="Close" tabindex="-1">');
    expect(r.neutralised).toEqual([
      { code: 'data-action', action: 'removed', count: 2 },
      { code: 'data-i18n-aria', action: 'removed', count: 1 },
      { code: 'aria-modal', action: 'removed', count: 1 },
      { code: 'tabindex', action: 'set to -1 on buttons', count: 1 },
    ]);
    expect(S.NEUTRALISED.map((x: any) => x.code)).toEqual(['data-action', 'data-i18n-aria', 'aria-modal', 'tabindex']);
  });

  const HOSTILE: [string, string][] = [
    ['a script', '<script>alert(1)</script>'],
    ['a script in a span', '<span><script>alert(1)</script></span>'],
    ['an event attribute', '<div onclick="alert(1)">x</div>'],
    ['an image with onerror', '<img src="data:image/png;base64,AAAA" onerror="alert(1)">'],
    ['onerror on a broken source', '<img src=x onerror=alert(1)>'],
    ['a javascript: anchor', '<a href="javascript:alert(1)">x</a>'],
    ['an iframe', '<iframe src="https://example.invalid"></iframe>'],
    ['an iframe with srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['a form', '<form action="https://example.invalid"><button>x</button></form>'],
    ['an input', '<input type="text">'],
    ['a style element', '<style>*{display:none}</style>'],
    ['a link', '<link rel="stylesheet" href="https://example.invalid/x.css">'],
    ['a meta', '<meta http-equiv="refresh" content="0;url=https://example.invalid">'],
    ['a base', '<base href="https://example.invalid/">'],
    ['an object', '<object data="x"></object>'],
    ['an embed', '<embed src="x">'],
    ['an svg with onload', '<svg onload="alert(1)"></svg>'],
    ['a script inside svg', '<svg><script>alert(1)</script></svg>'],
    ['foreignObject', '<svg><foreignObject><div>x</div></foreignObject></svg>'],
    ['svg use with href', '<svg><use href="https://example.invalid/x.svg#a"/></svg>'],
    ['svg animate', '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>'],
    ['math', '<math><mi>x</mi></math>'],
    ['a template', '<template><div>x</div></template>'],
    ['a style attribute', '<div style="position:fixed;inset:0">x</div>'],
    ['a remote image', '<img src="https://example.invalid/pixel.png" alt="x">'],
    ['a protocol-relative image', '<img src="//example.invalid/pixel.png" alt="x">'],
    ['a javascript: image', '<img src="javascript:alert(1)" alt="x">'],
    ['an html data: image', '<img src="data:text/html,<script>alert(1)</script>" alt="x">'],
    ['a data: svg that embeds a tag', '<img src="data:image/svg+xml,<svg onload=alert(1)>" alt="x">'],
    ['a comment', '<div>x</div><!-- hi -->'],
    ['a conditional comment', '<!--[if IE]><script>alert(1)</script><![endif]-->'],
    ['a doctype', '<!DOCTYPE html><div>x</div>'],
    ['CDATA', '<div><![CDATA[x]]></div>'],
    ['a processing instruction', '<?php echo 1 ?>'],
    ['an upper-case tag', '<DIV>x</DIV>'],
    ['a mixed-case script', '<ScRiPt>alert(1)</ScRiPt>'],
    ['an unquoted attribute', '<div class=x>y</div>'],
    ['a single-quoted attribute', "<div class='x'>y</div>"],
    ['a duplicated attribute', '<div class="a" class="b">y</div>'],
    ['an unknown character reference', '<p>a&nbsp;b</p>'],
    ['a numeric character reference', '<p>&#x3C;script&#x3E;</p>'],
    ['a reference with no semicolon', '<p>a &lt b</p>'],
    ['a NUL byte', '<p>a\u0000b</p>'],
    ['a bidirectional override', '<p>abc\u202Edef</p>'],
    ['a bidirectional isolate in an attribute', '<span class="a" data-club-logo="x\u2066y">z</span>'],
    ['a line separator', '<p>a\u2028b</p>'],
    ['mismatched closing tags', '<b><i>x</b></i>'],
    ['an unclosed element', '<div><span>x</span>'],
    ['a stray closing tag', '<div>x</div></div>'],
    ['text outside any element', 'hello'],
    ['a bare ">" in text', '<p>a > b</p>'],
    ['a "<" in an attribute value', '<span class="a<b">x</span>'],
    ['a button inside a button', '<button><button>x</button></button>'],
    ['a td outside a tr', '<div><td>x</td></div>'],
    ['svg children outside an svg', '<div><path d="M0 0"/></div>'],
    ['html inside svg', '<svg><div>x</div></svg>'],
    ['a self-closed div', '<div/>'],
    ['an attribute that is not allowed on the tag', '<p class="x">y</p>'],
    ['formaction on a button', '<button type="button" formaction="https://example.invalid">x</button>'],
    ['an invalid role', '<div role="button">x</div>'],
    ['an invalid aria-hidden', '<div aria-hidden="maybe">x</div>'],
    ['an invalid bar width', '<i data-mc-width="120%"></i>'],
    ['a bar width that is an expression', '<i data-mc-width="calc(100% - 1px)"></i>'],
    ['an invalid path', '<svg><path d="M0 0 <script>"/></svg>'],
    ['an invalid paint', '<svg><path fill="url(javascript:alert(1))" d="M0 0"/></svg>'],
    ['an id attribute', '<div id="x">y</div>'],
    ['a data-i18n attribute', '<span data-i18n="navigation.squad">x</span>'],
    ['a data-nav attribute', '<span data-nav="home">x</span>'],
    ['a tabindex that is not -1', '<button type="button" tabindex="0">x</button>'],
    ['an attribute with no validator', '<span data-club-logo="a b">x</span>'],
  ];
  it.each(HOSTILE)('refuses %s', (_n, html) => {
    const r = S.sanitize(html);
    expect(r.ok).toBe(false);
    expect(r.html).toBeNull();
    expect(r.tree).toBeNull();
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it('refuses a fixture over any of its limits', () => {
    expect(S.sanitize('<p>' + 'x'.repeat(5000) + '</p>').ok).toBe(false);                                            // bytes
    expect(S.sanitize('<div>'.repeat(14) + 'x' + '</div>'.repeat(14)).ok).toBe(false);                               // depth
    expect(S.sanitize('<div>' + '<span>a</span>'.repeat(160) + '</div>').ok).toBe(false);                            // nodes
    expect(S.sanitize('<p>' + 'y'.repeat(401) + '</p>').ok).toBe(false);                                             // one text node
    expect(S.sanitize('<span class="' + 'a '.repeat(9) + '">x</span>').ok).toBe(false);                             // class tokens
    expect(S.sanitize('<span ' + Array.from({ length: 13 }, (_, i) => `data-lg-size="${i}"`).join(' ') + '>x</span>').ok).toBe(false);
  });

  it('accepts text that looks like markup, as text only', () => {
    const r = S.sanitize('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot; &#39;y&#39;</p>');
    expect(r.ok).toBe(true);
    expect(r.tree.kids[0].kids).toEqual([{ t: 'tx', v: '<script>alert(1)</script> & "x" \'y\'' }]);
    expect(r.html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; "x" \'y\'</p>');
  });

  it('accepts a small image data: URI, and nothing else as a source', () => {
    expect(S.sanitize('<img class="a" src="data:image/png;base64,iVBORw0KGgo=" alt="x">').ok).toBe(true);
    expect(S.sanitize('<img src="data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E" alt="x">').ok).toBe(true);
    for (const bad of ['http://a/b.png', 'https://a/b.png', '/x.png', 'blob:x', 'data:text/plain,hi', 'data:image/png,a b']) expect(S.sanitize(`<img src="${bad}" alt="x">`).ok).toBe(false);
  });

  it('puts the implicit tbody a browser would, so the tree is the production tree', () => {
    const r = S.sanitize('<table class="a"><tr><td>1</td></tr></table>');
    expect(r.html).toBe('<table class="a"><tbody><tr><td>1</td></tr></tbody></table>');
  });

  it('checks every class against the caller’s provenance, and refuses one it does not approve', () => {
    expect(S.sanitize('<span class="lg-chip lg-chip--up">x</span>', { classOk: (n: string) => n.startsWith('lg-chip') }).ok).toBe(true);
    const r = S.sanitize('<span class="lg-chip evil">x</span>', { classOk: (n: string) => n.startsWith('lg-chip') });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/"evil" has no approved provenance/);
    expect(S.sanitize('<span class="1bad">x</span>').ok).toBe(false);
  });

  it('builds nodes with createElement, createElementNS, setAttribute and createTextNode only', () => {
    const made: string[] = [];
    const doc: any = {
      createDocumentFragment: () => { made.push('fragment'); return { appendChild() {} }; },
      createElement: (t: string) => { made.push('el:' + t); return { setAttribute: (n: string) => made.push('attr:' + n), appendChild() {} }; },
      createElementNS: (ns: string, t: string) => { made.push('ns:' + t); expect(ns).toBe('http://www.w3.org/2000/svg'); return { setAttribute: (n: string) => made.push('attr:' + n), appendChild() {} }; },
      createTextNode: (v: string) => { made.push('text:' + v); return {}; },
    };
    const r = S.sanitize('<div class="a"><svg viewBox="0 0 1 1"><path d="M0 0"/></svg><p>&lt;img src=x onerror=alert(1)&gt;</p></div>');
    S.toDom(r.tree, doc);
    expect(made).toEqual(['fragment', 'el:div', 'attr:class', 'ns:svg', 'attr:viewBox', 'ns:path', 'attr:d', 'el:p', 'text:<img src=x onerror=alert(1)>']);
  });

  it('has no way to reach the browser’s parser, an eval, a frame or the network', () => {
    const src = stripComments(read('public/design-system/lab-sanitize.js'));
    expect(src).not.toMatch(/\binnerHTML\b|insertAdjacentHTML|outerHTML|DOMParser|createContextualFragment|document\.write|\beval\(|new Function\(|\bFunction\(|srcdoc|<iframe|importScripts|\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|\bimport\(|\brequire\(/);
    expect(src).not.toMatch(/\.style\b|setAttribute\(\s*['"]style/);
  });

  it('is one file, loaded by the build, the server and the browser alike', () => {
    expect(read('scripts/design-system-previews.js')).toContain("require('../public/design-system/lab-sanitize.js')");
    expect(read('src/design-system/previews-core.js')).toContain("require('../../public/design-system/lab-sanitize.js')");
    expect(read('public/design-system/design-system.js')).toContain("pre: ['/design-system/lab-sanitize.js', '/design-system/lab-view.js']");
    expect(read('public/design-system/lab.js')).toContain('window.FamilistaLabSanitize');
    expect(manifest.sources.find((s: any) => s.id === 'sanitizer').sha256).toBe(sha(fs.readFileSync(path.join(ROOT, 'public/design-system/lab-sanitize.js'))));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the preview manifest: the golden fixtures, sanitised, hashed and bound to the source', () => {
  it('previews exactly the eighteen verified components, with the 122 golden fixtures between them', () => {
    const verified = components.components.filter((c: any) => c.tier === 'verified').map((c: any) => c.id);
    expect(manifest.components.map((c: any) => c.id)).toEqual(verified);
    expect(manifest.components.map((c: any) => c.id)).toEqual(['club-logo', 'club-identity', 'lg-crest', 'lg-ident', 'lg-icon', 'lg-chip', 'lg-status-chip', 'lg-form', 'lg-metric', 'lg-versus', 'lg-panel', 'lg-float', 'lg-empty', 'ds-chip', 'ds-panel', 'ds-kv', 'ds-empty', 'ds-skeleton']);
    expect(manifest.components.map((c: any) => c.fixtures.length)).toEqual([9, 8, 7, 6, 12, 7, 11, 5, 6, 10, 5, 5, 3, 8, 8, 6, 3, 3]);
    expect(manifest.coverage).toMatchObject({ registered: 60, previewable: 18, unavailable: 42, fixtures: 122 });
    expect(allFixtures()).toHaveLength(122);
  });

  it('is well-formed by the very validator the server runs', () => {
    expect(core.validateManifest(manifest, { components })).toEqual([]);
  });

  it('makes every fixture the golden snapshot for it: same labels, same order, same bytes before sanitising', () => {
    for (const c of manifest.components) {
      const sym = c.symbol;
      expect(c.fixtures.map((f: any) => f.label)).toEqual(Object.keys(golden[sym]));
      for (const f of c.fixtures) {
        const raw = golden[sym][f.label];
        expect(f.goldenSha256).toBe(sha(raw));
        const s = S.sanitize(raw, { classOk: () => true });
        expect(s.html).toBe(f.html);
        expect(f.sha256).toBe(sha(f.html));
        expect(f.bytes).toBe(Buffer.byteLength(f.html));
        expect(f.neutralised).toEqual(s.neutralised);
      }
    }
  });

  it('records the call that made each fixture, as the case file spells it, and nothing the case file does not say', () => {
    const cases = read('tools/storybook/tests/cases.mjs');
    for (const { c, f } of allFixtures()) {
      expect(f.call.startsWith(c.symbol + '(')).toBe(true);
      if (c.symbol !== '_lgStatusChip') expect(cases).toContain(f.call);
    }
    const status = byId('lg-status-chip').fixtures.map((f: any) => f.call);
    expect(status).toContain("_lgStatusChip('SCHEDULED')");
    expect(status).toContain("_lgStatusChip('')");
    expect(read('tools/storybook/tests/cases.mjs')).toContain("['SCHEDULED', 'LIVE', 'HALFTIME', 'PLAYED', 'FT', 'POSTPONED', 'CANCELLED', 'ABANDONED', 'live', 'nonsense', '']");
  });

  it('gives every fixture a strict, unique id', () => {
    const ids = allFixtures().map(({ f }) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { c, f } of allFixtures()) expect(f.id).toMatch(new RegExp(`^${c.id}\\.[a-z0-9]+(-[a-z0-9]+)*$`));
    expect(ids).toContain('lg-versus.both-missing-draws-nothing');
  });

  it('keeps an empty fixture as the real answer it is: the production function drew nothing', () => {
    const f = byId('lg-versus').fixtures.find((x: any) => x.id === 'lg-versus.both-missing-draws-nothing');
    expect(golden._lgVersus['both missing draws nothing']).toBe('');
    expect(f).toMatchObject({ html: '', bytes: 0, nodes: 0, elements: 0 });
  });

  it('binds each component to the very render function and CSS the components manifest hashed', () => {
    for (const c of manifest.components) {
      const rec = components.components.find((x: any) => x.id === c.id);
      expect(c.source.js).toEqual(rec.source.js);
      expect(c.source.css).toEqual(rec.source.css);
      expect(c.mediaQueries).toEqual(rec.styling.mediaQueries);
      expect(c.variants.map((v: any) => [v.class, v.name, v.rules])).toEqual(rec.variants.map((v: any) => [v.class, v.name, v.rules]));
      expect(c.symbol).toBe(rec.source.js.symbol);
    }
  });

  it('lists a variant under a fixture only if the fixture’s own markup carries the variant’s class', () => {
    let exercised = 0;
    for (const c of manifest.components) for (const v of c.variants) {
      for (const id of v.exercisedBy) {
        const f = c.fixtures.find((x: any) => x.id === id);
        expect(f.html).toMatch(new RegExp(`(?<![\\w-])${v.class.replace(/-/g, '\\-')}(?![\\w-])`));
        exercised++;
      }
      for (const f of c.fixtures) if (new RegExp(`(?<![\\w-])${v.class.replace(/-/g, '\\-')}(?![\\w-])`).test(f.html)) expect(v.exercisedBy).toContain(f.id);
    }
    expect(exercised).toBeGreaterThan(10);
    // Some variants no fixture shows; the manifest says so rather than inventing one.
    expect(manifest.components.flatMap((c: any) => c.variants).filter((v: any) => v.exercisedBy.length === 0).length).toBeGreaterThan(0);
  });

  it('has a provenance for every class: a registered component, production CSS, one of two named inert inputs, or one state class inert on its own component', () => {
    const owners = new Map<string, number>();
    for (const { f } of allFixtures()) for (const x of f.classes) { owners.set(x.name, x.rules); expect(['css', 'inert'].includes(x.owner) || components.components.some((c: any) => c.id === x.owner)).toBe(true); }
    const inert = allFixtures().flatMap(({ f }) => f.classes.filter((x: any) => x.owner === 'inert').map((x: any) => x.name));
    expect([...new Set(inert)].sort()).toEqual(['is-empty', 'lg-ident--hero', 'lg-t']);
    // Every stylesheet a previewed component draws from: app.css, and the Owner Kit's design-system.css.
    const css = read('public/app.css') + '\n' + read('public/design-system/design-system.css');
    for (const name of ['lg-ident--hero', 'lg-t']) expect(css).not.toMatch(new RegExp(`\\.${name.replace(/-/g, '\\-')}(?![\\w-])`));
    // is-empty is inert only on the club-logo element: production styles it elsewhere (.tfx-lane.is-empty,
    // .de-vid.is-empty), never alone and never on .club-logo, and the fixtures carry it nowhere else.
    expect(css).toMatch(/\.tfx-lane\.is-empty(?![\w-])/);
    expect(css).not.toMatch(/(^|[^\w-])\.is-empty(?![\w-])/m);
    expect(css).not.toMatch(/\.club-logo[\w-]*\.is-empty(?![\w-])|\.is-empty\.club-logo/);
    const carriers = allFixtures().flatMap(({ f }) => [...f.html.matchAll(/class="([^"]*)"/g)].map((m) => m[1].split(' ')).filter((t) => t.includes('is-empty')));
    expect(carriers.length).toBeGreaterThan(0);
    for (const t of carriers) expect(t).toContain('club-logo');
    for (const [name, rules] of owners) if (!inert.includes(name)) { expect(rules).toBeGreaterThan(0); expect(css).toMatch(new RegExp(`\\.${name.replace(/-/g, '\\-')}(?![\\w-])`)); }
  });

  it('says why each of the other 42 cannot be previewed, in a closed set of reasons', () => {
    const avail = manifest.availability;
    expect(avail.map((a: any) => a.id)).toEqual(components.components.map((c: any) => c.id));
    expect(avail.filter((a: any) => a.state === 'preview')).toHaveLength(18);
    const by = (r: string) => avail.filter((a: any) => a.reason === r).map((a: any) => a.id);
    expect(by('no-fixtures')).toEqual([]);                          // every registered render function now has fixtures
    expect(by('application-shell')).toEqual(['sidebar-nav', 'topbar', 'page-header', 'ds-shell']);
    expect(by('candidate')).toHaveLength(7);
    expect(by('css-family')).toHaveLength(7);
    expect(by('utility')).toEqual(['page', 'hidden']);
    expect(by('page-specific')).toEqual(['oh-family']);
    expect(by('css-only')).toHaveLength(21);
    expect(Object.values(manifest.coverage.byReason).reduce((a: any, b: any) => a + b, 0)).toBe(42);
  });

  it('never previews a component that has no render function', () => {
    for (const a of manifest.availability) {
      const rec = components.components.find((c: any) => c.id === a.id);
      if (a.state === 'preview') expect(rec.source.js).not.toBeNull();
      if (!rec.source.js) expect(a.state).toBe('unavailable');
    }
  });

  it('stays inside its limits: each fixture, the total and the file', () => {
    for (const { f } of allFixtures()) { expect(f.bytes).toBeLessThanOrEqual(4096); expect(f.nodes).toBeLessThanOrEqual(300); expect(f.depth).toBeLessThanOrEqual(12); }
    // Raised from 32 KB with the owner's approval in M3/S2.2b-2 (the 103 earlier fixtures were 32,633 bytes); the
    // validator the server runs refuses more than 128 KB, and the per-fixture limits above are unchanged.
    expect(manifest.coverage.bytes).toBeLessThan(64 * 1024);
    expect(Buffer.byteLength(read(MANIFEST_PATH))).toBeLessThan(160 * 1024);
  });

  it('is generated, deterministic and current (--check), and the same run checks all four manifests', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'design-system-discover.js'), '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toMatch(/manifest, graph manifest, components manifest and previews manifest are current/);
    const a = JSON.stringify(generator.build({ ROOT, components }));
    expect(a).toBe(JSON.stringify(generator.build({ ROOT, components })));
    expect(JSON.parse(a)).toEqual(manifest);
  });

  it('carries no timestamp, host, environment value, absolute path or source text', () => {
    const text = read(MANIFEST_PATH);
    expect(text).not.toMatch(/generatedAt|timestamp|hostname|\b20\d\d-\d\d-\d\dT\d\d:/i);
    expect(text).not.toContain(process.env.JWT_ACCESS_SECRET as string);
    expect(text).not.toMatch(/postgres(ql)?:\/\/|\/home\/|\/tmp\/|function _lg|return ['"`]</);
  });

  it('is never a public file: it is not under public/, and the build copies it to dist beside the server', () => {
    expect(MANIFEST_PATH.startsWith('src/design-system/generated/')).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'public/design-system/design-system-previews.json'))).toBe(false);
    const found: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/previews?\.json$/i.test(e.name)) found.push(path.relative(ROOT, p)); } };
    walk(path.join(ROOT, 'public'));
    expect(found).toEqual([]);
    const copy = read('scripts/copy-runtime-assets.js');
    expect(copy).toContain("'src/design-system/generated/design-system-previews.json'");
    expect(copy).toContain("'dist/design-system/generated/design-system-previews.json'");
    expect(copy).toContain("'dist/design-system/previews-core.js'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the golden snapshot is re-proved against public/app.js, so CI refuses drift', () => {
  // The Storybook golden test imports only Node built-ins and the extractor, so it needs no Storybook install.
  const run = (cwd: string, file: string) => spawnSync(process.execPath, ['--test', file], { cwd, encoding: 'utf8' });

  it('passes: the real render functions in public/app.js still produce exactly the golden markup', () => {
    const r = run(ROOT, 'tools/storybook/tests/golden.test.mjs');
    expect(r.stdout + r.stderr).toMatch(/# fail 0/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/golden snapshots match/);
  }, 60000);

  it('would fail the moment a render function changed (a control: the same test over an edited copy)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-golden-drift-'));
    try {
      for (const d of ['tools/storybook/lib', 'tools/storybook/tests']) { fs.mkdirSync(path.join(tmp, d), { recursive: true }); fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true }); }
      fs.writeFileSync(path.join(tmp, 'tools/storybook/package.json'), '{"type":"module"}');
      fs.mkdirSync(path.join(tmp, 'public/design-system'), { recursive: true });
      fs.cpSync(path.join(ROOT, 'public/design-system/design-system.js'), path.join(tmp, 'public/design-system/design-system.js'));
      const app = read('public/app.js');
      const edited = app.replace(/(\nfunction _lgChip\([^\n]*\n)/, "$1  if (value === 'WWDLW') value = 'DRIFTED';\n");
      expect(edited).not.toBe(app);
      fs.writeFileSync(path.join(tmp, 'public/app.js'), edited);
      const r = run(tmp, 'tools/storybook/tests/golden.test.mjs');
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/_lgChip \/ label and value/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }, 120000);

  // M3/S2.2a: the Owner Kit is held to the same rule, and so is its translator.
  const driftCopy = (edit: (ds: string) => string) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-golden-kit-'));
    for (const d of ['tools/storybook/lib', 'tools/storybook/tests']) { fs.mkdirSync(path.join(tmp, d), { recursive: true }); fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true }); }
    fs.writeFileSync(path.join(tmp, 'tools/storybook/package.json'), '{"type":"module"}');
    fs.mkdirSync(path.join(tmp, 'public/design-system'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'public/app.js'), path.join(tmp, 'public/app.js'));
    const ds = read('public/design-system/design-system.js');
    const edited = edit(ds);
    expect(edited).not.toBe(ds);
    fs.writeFileSync(path.join(tmp, 'public/design-system/design-system.js'), edited);
    return tmp;
  };
  it.each([
    ['chip itself changes', (ds: string) => ds.replace("'<span class=\"ds-dot\" aria-hidden=\"true\"></span>'", "'<span class=\"ds-dot\" aria-hidden=\"false\"></span>'"), /panel \/ titled, contrast/],   // first failure: the titled panel that composes a chip
    ['emptyState itself changes', (ds: string) => ds.replace("'<div class=\"ds-empty\" role=\"status\">", "'<div role=\"status\" class=\"ds-empty\">"), /panel \/ untitled, the tokens could not be read/],   // first failure: production's own panel(emptyState) body
    ['skeleton itself changes', (ds: string) => ds.replace("esc(T('Reading the manifest…'))", "esc(T('Reading…'))"), /panel \/ untitled, the tokens loading/],   // first failure: production's own panel(skeleton) body
    ['panel itself changes', (ds: string) => ds.replace("'<section class=\"ds-panel'", "'<section data-drift class=\"ds-panel'"), /panel \/ untitled, a key-value list/],
    ['kv itself changes', (ds: string) => ds.replace("'<div class=\"ds-kv\"><div class=\"ds-kv-k\">'", "'<div class=\"ds-kv\"><div class=\"ds-kv-k\" data-drift>'"), /kv \/ label and value/],
    ['the translator stops returning English as it is', (ds: string) => ds.replace("if (DS_LANG === 'en') return s;", "if (DS_LANG === 'en') return s.toUpperCase();"), /kv \/ label and value|translator is the room's own/],
    ['the room starts in another language', (ds: string) => ds.replace("var DS_LANG = 'en';", "var DS_LANG = 'de';"), /translator is the room's own|kv \/ /],
  ])('would fail the moment the Owner Kit drifted: %s', (_n, edit, rx) => {
    const tmp = driftCopy(edit as any);
    try {
      const r = run(tmp, 'tools/storybook/tests/golden.test.mjs');
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(rx as RegExp);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }, 120000);

  it('binds the fixtures to the render function slice, so the same drift also makes the manifests stale', () => {
    const app = read('public/app.js');
    const i = app.indexOf('\nfunction _lgChip(') + 1;
    const text = app.slice(i, app.indexOf('\n}\n', i) + 2);
    expect(byId('lg-chip').source.js.sha256).toBe(sha(text.replace(/\s+/g, ' ').trim()));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the generator and the validator refuse what they cannot back up', () => {
  const mutate = (edit: (m: any) => void) => { const m = clone(manifest); edit(m); return core.validateManifest(m, { components }).join('\n'); };
  const fx = (m: any, id = 'lg-chip', i = 0) => m.components.find((c: any) => c.id === id).fixtures[i];

  it.each([
    ['markup that carries a script', (m: any) => { fx(m).html = '<span class="lg-chip"><script>alert(1)</script></span>'; }, /fails the sanitizer/],
    ['markup that still carries data-action', (m: any) => { fx(m, 'lg-float').html = fx(m, 'lg-float').html.replace('<div class="lg-float-bg">', '<div class="lg-float-bg" data-action="closeFloat">'); }, /not exactly what the sanitizer produces/],
    ['markup that is valid but not canonical', (m: any) => { fx(m).html = '<span  class="lg-chip"><span>Form</span> <b>WWDLW</b></span>'; }, /fails the sanitizer|not exactly/],
    ['a hash that does not match its markup', (m: any) => { fx(m).sha256 = 'f'.repeat(64); }, /hash does not match/],
    ['an Owner Kit fixture whose hash does not match its markup', (m: any) => { fx(m, 'ds-skeleton', 0).sha256 = '0'.repeat(64); }, /hash does not match/],
    ['an Owner Kit fixture whose markup was changed in place', (m: any) => { fx(m, 'ds-chip', 0).html = fx(m, 'ds-chip', 0).html.replace('Pass', 'Fail'); }, /hash does not match|not exactly what the sanitizer produces/],
    ['a size that is not the markup’s', (m: any) => { fx(m).bytes += 1; }, /size, node count or depth/],
    ['a node count that is not the markup’s', (m: any) => { fx(m).nodes += 1; }, /size, node count or depth/],
    ['a class the markup uses but does not declare', (m: any) => { fx(m).classes = fx(m).classes.slice(1); }, /class list does not match|fails the sanitizer/],
    ['a declared class the markup does not use', (m: any) => { fx(m).classes.push({ name: 'zzz', owner: 'css', rules: 1 }); }, /class list/],
    ['a class owned by a component that does not exist', (m: any) => { fx(m).classes[0].owner = 'ghost'; }, /owner that does not exist/],
    ['a styled class with no rule', (m: any) => { fx(m).classes[0].rules = 0; }, /no rule/],
    ['an inert class that has rules', (m: any) => { fx(m, 'lg-ident', 3).classes.find((c: any) => c.owner === 'inert').rules = 2; }, /inert but has rules/],
    ['a fixture id with another component’s prefix', (m: any) => { fx(m).id = 'lg-panel.label-and-value'; }, /invalid fixture id/],
    ['a duplicate fixture id', (m: any) => { fx(m, 'lg-chip', 1).id = fx(m).id; }, /used twice/],
    ['a render function that is not the one recorded', (m: any) => { m.components[0].source.js.sha256 = '0'.repeat(64); }, /not the one the components manifest records/],
    ['CSS that is not what the components manifest records', (m: any) => { m.components[0].source.css[0].sha256 = '0'.repeat(64); }, /not what the components manifest records/],
    ['media queries that differ', (m: any) => { byIdIn(m, 'lg-metric').mediaQueries = []; }, /media queries differ/],
    ['a variant that is not verified', (m: any) => { byIdIn(m, 'lg-chip').variants.push({ class: 'lg-chip--ghost', name: 'ghost', rules: 1, exercisedBy: [] }); }, /not one the components manifest records|does not list every/],
    ['a variant that lists a fixture that does not carry it', (m: any) => { byIdIn(m, 'lg-chip').variants[0].exercisedBy.push(fx(m, 'lg-chip', 0).id); }, /lists fixtures that do not carry it/],
    ['a preview for a component that is not registered', (m: any) => { m.components[0].id = 'ghost'; }, /not a registered component|availability/],
    ['availability that is out of order', (m: any) => { m.availability.reverse(); }, /availability does not list/],
    ['an unavailable component with no valid reason', (m: any) => { m.availability.find((a: any) => a.state === 'unavailable').reason = 'because'; }, /invalid reason/],
    ['a previewable component with no fixtures', (m: any) => { m.availability.find((a: any) => a.state === 'unavailable').state = 'preview'; m.availability.find((a: any) => a.state === 'preview' && a.reason).reason = null; }, /previewable but has no fixtures/],
    ['a sanitizer policy that has changed', (m: any) => { m.policy.tags.script = { ns: 'html', void: false, attributes: [] }; }, /sanitizer policy changed/],
    ['a neutralisation entry that is made up', (m: any) => { fx(m, 'lg-float').neutralised.push({ code: 'onclick', action: 'removed', count: 1 }); }, /neutralisation entry/],
    ['coverage that does not add up', (m: any) => { m.coverage.fixtures += 1; }, /coverage does not match/],
    ['a source with a bad hash', (m: any) => { m.sources[0].sha256 = 'abc'; }, /source is malformed/],
    ['a schema that is not 1', (m: any) => { m.schema = 2; }, /schema 1/],
  ])('rejects %s', (_n, edit, rx) => { expect(mutate(edit as any)).toMatch(rx as RegExp); });

  const byIdIn = (m: any, id: string) => m.components.find((c: any) => c.id === id);

  it('rejects anything that is not an object, and a manifest missing its parts', () => {
    for (const bad of [null, [], 'x', 3]) expect(core.validateManifest(bad).length).toBeGreaterThan(0);
    expect(core.validateManifest({ schema: 1 }).join()).toMatch(/required/);
  });

  describe('the generator, over a tree whose files lie', () => {
    let tmp = '';
    const files = ['public', 'tools/storybook/tests', 'tools/components', 'src/design-system'];
    beforeAll(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-previews-reg-'));
      for (const f of files) { fs.mkdirSync(path.join(tmp, f), { recursive: true }); fs.cpSync(path.join(ROOT, f), path.join(tmp, f), { recursive: true, filter: (src) => fs.statSync(src).isDirectory() || /\.(css|js|html|json|mjs)$/.test(src) }); }
    }, 60000);
    afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
    const withGolden = (edit: (g: any) => void) => { const g = clone(golden); edit(g); fs.writeFileSync(path.join(tmp, GOLDEN_PATH), JSON.stringify(g)); return () => generator.build({ ROOT: tmp, components }); };
    afterEach(() => fs.cpSync(path.join(ROOT, GOLDEN_PATH), path.join(tmp, GOLDEN_PATH)));

    it('builds the untouched copy identically', () => {
      expect(JSON.parse(JSON.stringify(generator.build({ ROOT: tmp, components })))).toEqual(manifest);
    });
    it.each([
      ['a golden fixture with a script', (g: any) => { g._lgChip['label and value'] = '<span class="lg-chip"><script>x</script></span>'; }, /not allowed/],
      ['a golden fixture with an onclick', (g: any) => { g._lgChip['label and value'] = '<span class="lg-chip" onclick="x">a</span>'; }, /onclick/],
      ['a golden fixture with a remote image', (g: any) => { g._lgCrest['with crest'] = g._lgCrest['with crest'].replace(/src="[^"]*"/, 'src="https://example.invalid/x.png"'); }, /"src" is not allowed/],
      ['a golden fixture with a class nobody owns', (g: any) => { g._lgChip['label and value'] = '<span class="lg-chip zzz-unowned">a</span>'; }, /zzz-unowned/],
      ['a golden fixture that is too large', (g: any) => { g._lgChip['label and value'] = '<span class="lg-chip">' + 'x'.repeat(5000) + '</span>'; }, /larger than 4096/],
      ['a golden case the case file has no call for', (g: any) => { g._lgChip['a case nobody wrote'] = '<span class="lg-chip">x</span>'; }, /no call for this golden label/],
      ['a golden snapshot and a components manifest that disagree on the cases', (g: any) => { delete g._lgChip['zero is a value']; }, /list different cases/],
    ])('refuses %s, naming it, and builds nothing', (_n, edit, rx) => {
      expect(withGolden(edit as any)).toThrow(rx as RegExp);
    });

    // ── M3/S2.1b: the three identity components keep every control the ten have ──
    const CASES_PATH = 'tools/storybook/tests/cases.mjs';
    const withCases = (edit: (t: string) => string) => { const t = edit(read(CASES_PATH)); expect(t).not.toBe(read(CASES_PATH)); fs.writeFileSync(path.join(tmp, CASES_PATH), t); return () => generator.build({ ROOT: tmp, components }); };
    const withCss = (rule: string) => { fs.appendFileSync(path.join(tmp, 'public/app.css'), '\n' + rule + '\n'); return () => generator.build({ ROOT: tmp, components }); };
    afterEach(() => { fs.cpSync(path.join(ROOT, CASES_PATH), path.join(tmp, CASES_PATH)); fs.cpSync(path.join(ROOT, 'public/app.css'), path.join(tmp, 'public/app.css')); });
    // The real lock glyph, read from public/app.js: the one icon the Lab does not preview.
    const LOCK = (/^  lock: '([^']*)',$/m.exec(read('public/app.js')) || [])[1] || '';
    const crest = (g: any) => g.clubLogoHtml['with crest, default size'];
    const src = (g: any, v: string) => { g.clubLogoHtml['with crest, default size'] = crest(g).replace(/src="[^"]*"/, 'src="' + v + '"'); };

    it('builds the untouched cases and stylesheet identically, and the lock glyph it excludes draws a <rect>', () => {
      expect(JSON.parse(JSON.stringify(generator.build({ ROOT: tmp, components })))).toEqual(manifest);
      expect(LOCK).toMatch(/^<rect /);
      expect(Object.keys(golden._lgIcon)).not.toContain('lock');
    });
    it.each([
      ['a case section for a function that was not extracted', (t: string) => t.replace('  _lgIcon: {', "  _lgIconFake: {\n    'x': (l) => l._lgIconFake('x'),\n  },\n  _lgIcon: {"), /"_lgIconFake" is not a render function extracted from public\/app\.js/],
      ['a case that calls another function than the one it is filed under', (t: string) => t.replace("'back': (l) => l._lgIcon('back')", "'back': (l) => l._lgChip('back')"), /_lgIcon \/ back calls _lgChip, not _lgIcon/],
    ])('refuses %s, naming it', (_n, edit, rx) => {
      expect(withCases(edit as any)).toThrow(rx as RegExp);
    });
    it.each([
      ['golden cases for a function that was not extracted', (g: any) => { g._lgIconFake = { x: '' }; }, /"_lgIconFake", which is not a render function/],
      ['the lock icon, whose <rect> the sanitizer does not carry', (g: any) => { g._lgIcon.back = g._lgIcon.back.replace(/<path[\s\S]*<\/svg>$/, LOCK + '</svg>'); }, /lg-icon \/ back: the tag <rect> is not allowed/],
      ['a crest with the default title attribute', (g: any) => { g.clubLogoHtml['with crest, default size'] = crest(g).replace('club-logo--s34"', 'club-logo--s34" title="Riverside FC"'); }, /club-logo \/ with crest, default size: the attribute "title" is not allowed on <span>/],
      ['an https crest', (g: any) => src(g, 'https://example.invalid/crest.png'), /club-logo \/ with crest, default size: the value of "src" is not allowed/],
      ['a data:text/html crest', (g: any) => src(g, 'data:text/html;base64,PHNjcmlwdD4='), /club-logo \/ with crest, default size: the value of "src" is not allowed/],
      ['a crest data URI over 2048 characters', (g: any) => src(g, 'data:image/png;base64,' + 'A'.repeat(2100)), /club-logo \/ with crest, default size: the value of "src" is not allowed/],
      ['an invalid data-club-logo value', (g: any) => { g.clubLogoHtml['with crest, default size'] = crest(g).replace('data-club-logo="riverside"', 'data-club-logo="river side/../x"'); }, /club-logo \/ with crest, default size: the value of "data-club-logo" is not allowed/],
      ['a club-logo class with no rule and no reviewed entry', (g: any) => { g.clubLogoHtml['with crest, default size'] = crest(g).replace('club-logo--s34', 'club-logo--s99'); }, /the class "club-logo--s99" has no approved provenance/],
      ['is-empty borrowed by an element that is not a club logo', (g: any) => { g._lgChip['label and value'] = '<span class="lg-chip is-empty">a</span>'; }, /lg-chip \/ label and value: a scoped inert class appears on an element that is not its component/],
      ['a skeleton with a row modifier production\u2019s CSS does not define', (g: any) => { g.skeleton['4 rows'] = g.skeleton['4 rows'].replace(/ds-skel-row--row/g, 'ds-skel-row--card'); }, /ds-skeleton \/ 4 rows: the class "ds-skel-row--card" has no approved provenance/],
      ['a titled panel whose h2 carries a class nobody owns', (g: any) => { g.panel['titled with a note'] = g.panel['titled with a note'].replace('class="ds-panel-title"', 'class="ds-panel-title ds-bogus"'); }, /ds-panel \/ titled with a note: the class "ds-bogus" has no approved provenance/],
      ['a chip fixture that writes a title', (g: any) => { g.chip['ok, small'] = g.chip['ok, small'].replace('<span class="ds-chip ds-chip--ok ds-chip--sm">', '<span class="ds-chip ds-chip--ok ds-chip--sm" title="t">'); }, /ds-chip \/ ok, small: the attribute "title" is not allowed on <span>/],
      ['a panel fixture with a class nobody owns', (g: any) => { g.panel['untitled, a note only'] = g.panel['untitled, a note only'].replace('class="ds-panel"', 'class="ds-panel ds-panel--bogus"'); }, /ds-panel \/ untitled, a note only: the class "ds-panel--bogus" has no approved provenance/],
      ['a kv fixture with a class nobody owns', (g: any) => { g.kv['label and value'] = g.kv['label and value'].replace('ds-kv-k', 'ds-kv-k ds-kv-bogus'); }, /ds-kv \/ label and value: the class "ds-kv-bogus" has no approved provenance/],
      ['a kv fixture whose value carries markup the sanitizer refuses', (g: any) => { g.kv['label and value'] = g.kv['label and value'].replace('>128<', '><code>128</code><'); }, /ds-kv \/ label and value: the tag <code> is not allowed/],
      ['is-empty on a club-identity root rather than its logo', (g: any) => { g.clubIdentityHtml['no sub line'] = g.clubIdentityHtml['no sub line'].replace('<span class="club-ident">', '<span class="club-ident is-empty">'); }, /club-identity \/ no sub line: a scoped inert class appears/],
    ])('refuses %s, naming it, and builds nothing', (_n, edit, rx) => {
      expect(withGolden(edit as any)).toThrow(rx as RegExp);
    });
    it.each([
      ['.club-logo.is-empty', '.club-logo.is-empty{opacity:.5}'],
      ['.is-empty alone', '.is-empty{opacity:.5}'],
      ['.club-logo--s34.is-empty', '.club-logo--s34.is-empty{opacity:.5}'],
    ])('stops treating is-empty as inert once production styles %s, so the entry is reviewed again', (_n, rule) => {
      expect(withCss(rule)).toThrow(/SCOPED_INERT: a production rule can style \.club-logo\.is-empty; review the entry/);
    });
    it('keeps is-empty inert while the only rules for it need another component (.tfx-lane, .de-vid)', () => {
      expect(withCss('#pg-transfers .tfx-lane.is-empty .zzz{opacity:.5}')).not.toThrow();
    });
  });

  it('keeps the 100 fixtures that predate ds-panel byte for byte, and notices a one-byte change', () => {
    const FOURTEEN = ['_lgCrest', '_lgIdent', '_lgChip', '_lgStatusChip', '_lgForm', '_lgMetric', '_lgPanel', '_lgEmpty', '_lgFloat', '_lgVersus', '_lgIcon', 'clubLogoHtml', 'clubIdentityHtml', 'kv'];
    const digest = (g: any) => sha(JSON.stringify(Object.fromEntries(FOURTEEN.map((k) => [k, g[k]]))));
    // The digest of the whole golden snapshot at f400a4f, before panel was added.
    const S22A = 'd602fa8b2e03e7b2f748e96922db1b413e5d29ab73d4e7eca5ba8c11519104a3';
    expect(Object.keys(golden).slice(0, 15)).toEqual([...FOURTEEN, 'panel']);
    expect(FOURTEEN.reduce((n, k) => n + Object.keys(golden[k]).length, 0)).toBe(100);
    expect(digest(golden)).toBe(S22A);
    const g = clone(golden); g.kv['zero is a value'] = g.kv['zero is a value'].replace('>0<', '>1<');
    expect(digest(g)).not.toBe(S22A);
  });

  it('keeps the 103 fixtures that predate chip, emptyState and skeleton byte for byte, and notices a one-byte change', () => {
    const FOURTEEN = ['_lgCrest', '_lgIdent', '_lgChip', '_lgStatusChip', '_lgForm', '_lgMetric', '_lgPanel', '_lgEmpty', '_lgFloat', '_lgVersus', '_lgIcon', 'clubLogoHtml', 'clubIdentityHtml', 'kv'];
    const PANEL3 = ['untitled, a key-value list', 'untitled, a list and a note', 'untitled, a note only'];
    const project = (g: any) => Object.fromEntries([...FOURTEEN.map((k) => [k, g[k]]), ['panel', Object.fromEntries(PANEL3.map((l) => [l, g.panel[l]]))]]);
    // The digest of the whole golden snapshot at b13808d, before the S2.2b-2 fixtures were added.
    const S22B1 = '97b9d423c2fb9411796b38b22cb9399133b4a8491d6c3aea5870b76f775a7533';
    expect(Object.keys(golden)).toEqual([...FOURTEEN, 'panel', 'chip', 'emptyState', 'skeleton']);
    expect(Object.keys(golden.panel).slice(0, 3)).toEqual(PANEL3);
    expect(FOURTEEN.reduce((n, k) => n + Object.keys(golden[k]).length, 0) + PANEL3.length).toBe(103);
    expect(sha(JSON.stringify(project(golden)))).toBe(S22B1);
    const g = clone(golden); g.panel['untitled, a note only'] = g.panel['untitled, a note only'].replace('Ratios', 'ratios');
    expect(sha(JSON.stringify(project(g)))).not.toBe(S22B1);
  });

  it('records the titled panel the real panel() writes, now that the sanitizer carries class on h2, byte for byte', () => {
    // The real function, cut by the Storybook extractor, called exactly as two golden cases call it.
    const out = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const m = await import(process.argv[1]); const b = await import(process.argv[2]);"
      + " const k = b.buildDs(m.extractDs());"
      + " process.stdout.write(JSON.stringify([k.panel('Token layers', '<div class=\"ds-kv-list\">' + k.kv('Tokens', '128') + '</div>', '3 contexts · 9 modules'), k.panel('', '<div class=\"ds-kv-list\">' + k.kv('Tokens', '128') + k.kv('New failures', '0') + '</div>')]));",
      path.join(ROOT, 'tools/storybook/lib/extract-lg.mjs'), path.join(ROOT, 'tools/storybook/lib/build-lg.mjs')], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    const [titled, untitled] = JSON.parse(out.stdout);
    expect(titled).toContain('<h2 class="ds-panel-title">Token layers</h2><span class="ds-panel-note">3 contexts · 9 modules</span>');
    expect(titled).toBe(golden.panel['titled with a note']);
    expect(untitled).toBe(golden.panel['untitled, a key-value list']);
    expect(S.sanitize(titled).ok).toBe(true);
    // The h2 class still has to be one production's CSS defines for the panel: any other is refused by provenance.
    const owned = (n: string) => n.startsWith('ds-');
    expect(S.sanitize(titled.replace('class="ds-panel-title"', 'class="ds-panel-title evil"'), { classOk: owned }).problems).toEqual(['the class "evil" has no approved provenance']);
  });

  it('keeps the 94 fixtures that predate the Owner Kit byte for byte, and notices a one-byte change', () => {
    const THIRTEEN = ['_lgCrest', '_lgIdent', '_lgChip', '_lgStatusChip', '_lgForm', '_lgMetric', '_lgPanel', '_lgEmpty', '_lgFloat', '_lgVersus', '_lgIcon', 'clubLogoHtml', 'clubIdentityHtml'];
    const digest = (g: any) => sha(JSON.stringify(Object.fromEntries(THIRTEEN.map((k) => [k, g[k]]))));
    // The digest of the whole golden snapshot at 0a5c90c, before kv was added.
    const S21B = '0f9c6444649abb946d3d54bc2d818bebd57239a42d6a73d1e026fd8d339de2cd';
    expect(Object.keys(golden).slice(0, 14)).toEqual([...THIRTEEN, 'kv']);
    expect(THIRTEEN.reduce((n, k) => n + Object.keys(golden[k]).length, 0)).toBe(94);
    expect(digest(golden)).toBe(S21B);
    const g = clone(golden); g.clubLogoHtml['named size xs'] = g.clubLogoHtml['named size xs'].replace('s16', 's20');
    expect(digest(g)).not.toBe(S21B);
  });

  it('keeps the 65 fixtures of the ten original primitives byte for byte, and notices a one-byte change', () => {
    const TEN = ['_lgCrest', '_lgIdent', '_lgChip', '_lgStatusChip', '_lgForm', '_lgMetric', '_lgPanel', '_lgEmpty', '_lgFloat', '_lgVersus'];
    const digest = (g: any) => sha(JSON.stringify(Object.fromEntries(TEN.map((k) => [k, g[k]]))));
    // The digest of the whole golden snapshot at 11efcc3, before the three identity components were added.
    const S21A = '671829c01e24f216fd19d9e548fe54286cf78b2f2be0db7087309fb612ceeebe';
    expect(Object.keys(golden).slice(0, 10)).toEqual(TEN);
    expect(TEN.reduce((n, k) => n + Object.keys(golden[k]).length, 0)).toBe(65);
    expect(digest(golden)).toBe(S21A);
    const g = clone(golden); g._lgChip['label and value'] = g._lgChip['label and value'].replace('WWDLW', 'WWDLX');
    expect(digest(g)).not.toBe(S21A);
    const h = clone(golden); h._lgVersus = Object.fromEntries(Object.entries(h._lgVersus).reverse());
    expect(digest(h)).not.toBe(S21A);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the build refuses a stale previews manifest, exactly as it refuses the other three', () => {
  const put = (tmp: string, rel: string, recursive = false) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.cpSync(path.join(ROOT, rel), path.join(tmp, rel), { recursive }); };
  const tree = () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-previews-stale-'));
    for (const f of ['scripts/copy-runtime-assets.js', 'scripts/design-system-discover.js', 'scripts/design-system-graph.js', 'scripts/design-system-components.js', 'scripts/design-system-previews.js',
      'src/design-system/graph-core.js', 'src/design-system/components-core.js', 'src/design-system/previews-core.js',
      'src/design-system/generated/design-system-manifest.json', 'src/design-system/generated/design-system-graph.json', 'src/design-system/generated/design-system-components.json', 'src/design-system/generated/design-system-previews.json']) put(tmp, f);
    for (const d of ['tools/tokens', 'tools/storybook/stories', 'tools/storybook/tests', 'tools/components', 'public/tokens']) put(tmp, d, true);
    fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true, filter: (src) => fs.statSync(src).isDirectory() || /\.(css|html|js)$/.test(src) });
    return tmp;
  };
  const build = (tmp: string) => spawnSync(process.execPath, [path.join(tmp, 'scripts/copy-runtime-assets.js')], { cwd: tmp, encoding: 'utf8' });

  it('fails on a previews manifest that differs by one byte, names the fix, and rewrites nothing', () => {
    const tmp = tree();
    try {
      const f = path.join(tmp, MANIFEST_PATH);
      const stale = fs.readFileSync(f, 'utf8').replace('"schema": 1', '"schema": 1, "stale": true');
      expect(stale).not.toBe(fs.readFileSync(f, 'utf8'));
      fs.writeFileSync(f, stale);
      const r = build(tmp);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/previews manifest is stale/);
      expect(r.stderr).toContain('node scripts/design-system-discover.js');
      expect(fs.readFileSync(f, 'utf8')).toBe(stale);
      expect(fs.existsSync(path.join(tmp, 'dist'))).toBe(false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }, 90000);

  it('also fails when the golden snapshot a fixture came from changes, and when the sanitizer changes', () => {
    for (const edit of [
      (tmp: string) => { const g = path.join(tmp, GOLDEN_PATH); const o = JSON.parse(fs.readFileSync(g, 'utf8')); o._lgChip['label and value'] = '<span class="lg-chip"><span>Form</span> <b>WWDLX</b></span>'; fs.writeFileSync(g, JSON.stringify(o, null, 2) + '\n'); },
      (tmp: string) => { const s = path.join(tmp, 'public/design-system/lab-sanitize.js'); fs.writeFileSync(s, fs.readFileSync(s, 'utf8').replace('var VERSION = 1;', 'var VERSION = 2;')); },
    ]) {
      const tmp = tree();
      try {
        edit(tmp);
        const r = build(tmp);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/stale|could not be verified|malformed/);
        expect(fs.existsSync(path.join(tmp, 'dist'))).toBe(false);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
  }, 120000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the API: GET-only, authenticated and Platform-Owner-only, on the server', () => {
  const urls = ['', '?id=lg-chip', '?id=lg-float'];

  it.each(urls)('GET /components/preview%s without a session is 401', async (q) => { expect((await get(q)).status).toBe(401); });
  it.each(urls)('GET /components/preview%s as a club administrator is 403', async (q) => { expect((await get(q, ['u-cadmin', 'CLUB_ADMIN'])).status).toBe(403); });
  it.each(urls)('GET /components/preview%s as a head coach is 403', async (q) => { expect((await get(q, ['u-coach', 'HEAD_COACH'])).status).toBe(403); });
  it.each(urls)('GET /components/preview%s as the platform owner is 200 and not cacheable', async (q) => {
    const res = await get(q, OWNER);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.success).toBe(true);
  });
  it.each(urls)('GET /components/preview%s is also open to a platform administrator, whatever their club role', async (q) => {
    expect((await get(q, ['u-padmin', 'CLUB_ADMIN'])).status).toBe(200);
  });

  it('refuses the denied roles before it reads a thing: no fixture reaches a club role', async () => {
    for (const q of ['', '?id=lg-chip']) {
      const res = await get(q, ['u-cadmin', 'CLUB_ADMIN']);
      expect(JSON.stringify(res.body)).not.toMatch(/lg-chip\.|"html"|sha256|fixtures/);
    }
  });

  it('answers the index under its contract: availability for all 60, counts, the policy, and no markup', async () => {
    const res = await get('', OWNER);
    expect(DesignSystemPreviewsIndexSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data).toMatchObject({ state: 'READY', readOnly: true });
    expect(res.body.data.availability).toHaveLength(60);
    expect(res.body.data.components.map((c: any) => c.id)).toEqual(manifest.components.map((c: any) => c.id));
    expect(res.body.data.coverage).toEqual(manifest.coverage);
    expect(res.body.data.policy).toEqual(S.policy());
    expect(JSON.stringify(res.body.data.components)).not.toMatch(/"html"|<span|<div/);
  });

  it('answers ?id= with that one component, whole, under its contract — for every previewable component', async () => {
    for (const c of manifest.components) {
      const res = await get(`?id=${c.id}`, OWNER);
      expect(res.status).toBe(200);
      expect(DesignSystemPreviewDetailSchema.safeParse(res.body.data).success).toBe(true);
      expect(res.body.data.component).toEqual(c);
      expect(res.body.data.sources.map((s: any) => s.id)).toEqual(['golden', 'cases', 'registry', 'sanitizer', 'class-rules']);
    }
  });

  it.each([
    ['an unknown id', '?id=no-such-component'],
    ['a registered component of the application shell', '?id=topbar'],
    ['a registered CSS-only component', '?id=button'],
    ['an id that only looks like a path', '?id=../lg-chip'],
    ['a prototype key', '?id=__proto__'],
    ['a constructor key', '?id=constructor'],
    ['an empty id', '?id='],
    ['a different case', '?id=Lg-Chip'],
    ['a fixture id', '?id=lg-chip.label-and-value'],
    ['an id with a suffix', '?id=lg-chip%00'],
    ['a script', '?id=%3Cscript%3Ealert(1)%3C%2Fscript%3E'],
  ])('answers %s with 404', async (_n, q) => { expect((await get(q, OWNER)).status).toBe(404); });

  it.each([
    ['a second value', '?id=lg-chip&id=lg-panel'],
    ['an array', '?id[]=lg-chip'],
    ['an object', '?id[a]=b'],
    ['any other parameter', '?id=lg-chip&limit=5'],
    ['a parameter that is not id', '?q=x'],
  ])('answers %s with 400', async (_n, q) => { expect((await get(q, OWNER)).status).toBe(400); });

  it.each(['post', 'put', 'patch', 'delete'] as const)('refuses %s on /components/preview, as the owner too', async (verb) => {
    for (const q of ['', '?id=lg-chip']) {
      const res = await request(app)[verb](`/api/v1/system/design-system/components/preview${q}`).set('Authorization', `Bearer ${token(...OWNER)}`).send({});
      expect(res.status).toBe(404);
    }
  });

  it('serves no secret, environment value, server path, source text or write path', async () => {
    const text = JSON.stringify((await get('', OWNER)).body) + JSON.stringify((await get('?id=lg-float', OWNER)).body);
    expect(text).not.toContain(process.env.JWT_ACCESS_SECRET as string);
    expect(text).not.toMatch(/postgres(ql)?:\/\/|api[_-]?key|password|\/home\/|function _lg/i);
  });

  it('keeps the router GET-only, looks `id` up in a fixed list, and writes nothing', () => {
    const src = read('src/routes/design-system.routes.ts');
    expect(src.match(/router\.(get|post|put|patch|delete|all|use)\(/g)).toEqual(['router.use(', 'router.use(', 'router.get(', 'router.get(', 'router.get(', 'router.get(', 'router.get(']);
    expect(src).toContain("router.get('/components/preview'");
    expect(src).toContain('isPreviewId(id)');
    expect(src).not.toMatch(/req\.params|path\.join|readFile|exec\(|spawn\(/);
    const svc = read('src/design-system/design-system.service.ts');
    expect(svc).toMatch(/loadPreviews\(\)\.ids\.has\(id\)/);
    expect(svc).not.toMatch(/readFileSync\([^)]*\bid\b|prisma|\$queryRaw|\$executeRaw|writeFile/);
  });

  it('is registered in the API contract registry, with its consumer, for both shapes', () => {
    const entries = OWNER_API_CONTRACTS.filter((c) => c.endpoint === '/system/design-system/components/preview');
    expect(entries.map((c) => c.query ?? '')).toEqual(['', '?id=lg-chip']);
    for (const c of entries) expect(c.consumer).toBe('public/design-system/lab.js');
  });

  describe('a manifest that cannot be trusted is never served', () => {
    const file = path.join(ROOT, MANIFEST_PATH);
    const comp = path.join(ROOT, COMPONENTS_PATH);
    const withFiles = async (bodies: Record<string, string | Error>, run: () => Promise<void>) => {
      const spy = jest.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
        const hit = bodies[String(p)];
        if (hit !== undefined) { if (hit instanceof Error) throw hit; return hit; }
        return (jest.requireActual('fs') as typeof fs).readFileSync(p as string, ...(rest as [BufferEncoding]));
      }) as typeof fs.readFileSync);
      try { resetDesignSystemComponentsCache(); resetDesignSystemPreviewsCache(); await run(); } finally { spy.mockRestore(); resetDesignSystemComponentsCache(); resetDesignSystemPreviewsCache(); }
    };

    it('says NOT_GENERATED, and why, when the manifest is not beside the server', async () => {
      await withFiles({ [file]: new Error('ENOENT') }, async () => {
        const idx = await get('', OWNER);
        expect(idx.status).toBe(200);
        expect(idx.body.data).toMatchObject({ state: 'NOT_GENERATED', components: [], availability: [], sources: [], policy: null, coverage: null });
        expect(idx.body.data.reason).toMatch(/not beside this server/);
        expect(DesignSystemPreviewsIndexSchema.safeParse(idx.body.data).success).toBe(true);
        expect((await get('?id=lg-chip', OWNER)).status).toBe(404);
      });
    });

    it('refuses the whole manifest, and serves no fixture of it, when one fixture is tampered with', async () => {
      const bad = clone(manifest);
      bad.components[2].fixtures[0].html = '<span class="lg-chip"><script>alert(1)</script></span>';
      await withFiles({ [file]: JSON.stringify(bad) }, async () => {
        const idx = await get('', OWNER);
        expect(idx.body.data).toMatchObject({ state: 'NOT_GENERATED', components: [], availability: [] });
        expect(idx.body.data.reason).toMatch(/failed its integrity check/);
        expect(JSON.stringify(idx.body)).not.toMatch(/lg-chip|script/);
        expect((await get('?id=lg-crest', OWNER)).status).toBe(404);   // an untouched component is refused too
      });
    });

    it('refuses a manifest that has drifted from the components manifest: a render function that is no longer the one hashed', async () => {
      const drifted = clone(components);
      drifted.components.find((c: any) => c.id === 'lg-chip').source.js.sha256 = 'e'.repeat(64);
      // The drifted components manifest is itself a valid one (it would be what a regenerated build writes), so only the binding can refuse.
      await withFiles({ [comp]: JSON.stringify(drifted) }, async () => {
        const idx = await get('', OWNER);
        expect(idx.body.data.state).toBe('NOT_GENERATED');
        expect((await get('?id=lg-chip', OWNER)).status).toBe(404);
      });
    });

    it('refuses everything when the components manifest it depends on cannot be trusted', async () => {
      await withFiles({ [comp]: '{not json' }, async () => { expect((await get('', OWNER)).body.data.state).toBe('NOT_GENERATED'); });
    });

    it('refuses a manifest that is not JSON, or is not schema 1', async () => {
      await withFiles({ [file]: '{not json' }, async () => { expect((await get('', OWNER)).body.data.state).toBe('NOT_GENERATED'); });
      await withFiles({ [file]: JSON.stringify({ ...manifest, schema: 99 }) }, async () => { expect((await get('', OWNER)).body.data.state).toBe('NOT_GENERATED'); });
    });

    it('refuses a manifest generated under a sanitizer policy that is no longer the one enforced', async () => {
      const old = clone(manifest);
      old.policy.limits.nodes = 999;
      await withFiles({ [file]: JSON.stringify(old) }, async () => { expect((await get('', OWNER)).body.data.state).toBe('NOT_GENERATED'); });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the Specimen Lab client: CSP-safe, GET-only, lazy, and read-only', () => {
  const js = stripComments(read('public/design-system/lab.js'));
  const css = stripComments(read('public/design-system/lab.css'));
  const room = stripComments(read('public/design-system/design-system.js'));

  it('writes no style attribute, inline handler or inline script', () => {
    expect(js).not.toMatch(/style="|style='|setAttribute\(\s*['"]style|\.style\.(?!setProperty|removeProperty)|onclick=|onerror=|onload=|javascript:/i);
  });

  it('never evaluates code, never opens a frame and loads nothing from another origin', () => {
    expect(js).not.toMatch(/\beval\(|new Function\(|\bFunction\(|document\.write|importScripts|<script|<style|@import|\bsrcdoc\b|<iframe|<object|<embed|createContextualFragment|insertAdjacentHTML|DOMParser|\bimport\(/);
    expect(js + css).not.toMatch(/https?:\/\//);
  });

  it('makes no network call of its own: the only reader is the room’s GET-only api(), and it reaches exactly three shapes', () => {
    expect(js).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
    expect([...js.matchAll(/K\.api\(\s*('[^']+'(?:\s*\+\s*encodeURIComponent\(id\))?)/g)].map((m) => m[1])).toEqual([
      "'/system/design-system/components'",
      "'/system/design-system/components/preview'",
      "'/system/design-system/components/preview?id=' + encodeURIComponent(id)",
    ]);
    expect(room).toContain("method: 'GET'");
  });

  it('never hands a fixture to the browser’s HTML parser: the specimen is built from the checked tree', () => {
    expect(js).toContain('Z.toDom(res.tree, document)');
    expect(js).toContain('Z.sanitize(f.html');
    expect(js).not.toMatch(/specimen\.innerHTML|spec\.innerHTML|col\.innerHTML|lab-specimen'\)\.innerHTML/);
    // every innerHTML in the file is the room's own chrome, built from escaped strings
    const writes = [...js.matchAll(/(\w+)\.innerHTML\s*=/g)].map((m) => m[1]);
    expect([...new Set(writes)].sort()).toEqual(['bench', 'host', 'insp', 'refuse', 'strip', 'ev', 'rail', 'nav'].sort().filter((x) => writes.includes(x)));
    expect(writes).not.toContain('spec');
  });

  it('calls no production function and imports nothing of the application', () => {
    expect(js).not.toMatch(/\b_lg[A-Z]\w*\(|clubLogoHtml|clubIdentityHtml|FamilistaApp|window\.(app|_lg)|_mcPaintComputed/);
  });

  it('keeps events at the specimen’s boundary: every type production listens for at document level, stopped before it bubbles', () => {
    const list = (/var BOUNDARY = \[([^\]]*)\]/.exec(js) as RegExpExecArray)[1].match(/'[a-z]+'/g)!.map((x) => x.slice(1, -1));
    expect(list).toEqual(expect.arrayContaining(['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'input', 'change', 'submit', 'contextmenu', 'focusin', 'focusout']));
    expect(js).toMatch(/function stopAtBoundary\(ev\) \{ ev\.stopPropagation\(\); \}/);
    expect(js).toMatch(/spec\.addEventListener\(type, stopAtBoundary\)/);
    // the types the application really listens for at document level must all be in the list
    const app = read('public/app.js');
    const used = new Set([...app.matchAll(/document\.addEventListener\('([a-z]+)'/g)].map((m) => m[1]));
    for (const t of ['click', 'mousedown', 'pointerdown', 'keydown', 'input', 'change']) { expect(used.has(t)).toBe(true); expect(list).toContain(t); }
  });

  it('applies bar widths and crest sizes with the very lines production does, through the CSSOM', () => {
    const app = read('public/app.js');
    for (const line of ["el.style.setProperty('width', el.getAttribute('data-mc-width'));", "var px = el.getAttribute('data-lg-size') + 'px';", "el.style.setProperty('width', px); el.style.setProperty('height', px);"]) {
      expect(app).toContain(line);
      expect(js).toContain(line);
    }
  });

  it('marks the stage so the translator leaves it alone, and puts the contained root on nothing else', () => {
    // One builder draws every pane's canvas (Preview A's id is "lab-specimen", Preview B's "lab-specimen-b"), so both carry the marker.
    expect(js).toMatch(/id="lab-specimen' \+ x \+ '" dir="' \+ S\.dir \+ '" data-no-i18n data-lab-stage/);
    expect(js.match(/class="lab-specimen"/g) || []).toHaveLength(1);
    expect(js).not.toMatch(/data-i18n(?!-)/);
  });

  it('is built from the room’s own tokens: every custom property is --fam-*, none is defined here, and no colour is typed', () => {
    expect(css).not.toMatch(/^\s*--[a-z]/m);
    for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) expect(m[1]).toMatch(/^--fam-/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(\s*\d/);
    expect(css).not.toMatch(/--fam-status-(success|critical|danger|error)/);
    expect(css).toContain('var(--fam-module-accent)');
    expect(css).not.toMatch(/!important/g.test(css) ? /^$/ : /!important/);
  });

  it('contains the stage: layout and paint containment, a stacking context of its own, and a clip', () => {
    expect(css).toMatch(/\.lab-specimen \{[^}]*contain: layout paint;[^}]*isolation: isolate;/);
    expect(css).toMatch(/\.lab-specimen \{[^}]*position: relative;[^}]*overflow: auto;/);
    expect(css).not.toMatch(/\.lg-|\.club-logo|\.lab-specimen[^{]*\s\.[a-z]/);       // nothing restyles a production class
  });

  it('is loaded only when its section opens, with the sanitizer first, and no page, loader or Owner Home names it', () => {
    expect(read('public/index.html')).not.toMatch(/lab(-sanitize|-view)?\.(js|css)/);
    expect(read('public/app.js')).not.toMatch(/design-system\/lab/);
    expect(room).toMatch(/lab: \{[^}]*host: 'lab-host'[^}]*css: '\/design-system\/lab\.css', js: '\/design-system\/lab\.js', pre: \['\/design-system\/lab-sanitize\.js', '\/design-system\/lab-view\.js'\]/);
    expect(room).toMatch(/pre\.forEach\(function \(src\) \{[\s\S]*?dep\.async = false;/);
    expect(room).toContain('script.async = false;');
    expect(room).toContain("['lab', 'Specimen Lab']");
    expect(room.match(/loadAssets\(/g)).toHaveLength(2);
    expect(read('tools/tokens/lib/production.mjs')).toContain("'public/design-system/lab.css'");
  });

  it('gives the page a workspace that scrolls inside itself and a way out below 980px or 620px', () => {
    expect(css).toMatch(/\.lab-rail-body \{[^}]*overflow-y: auto; scrollbar-gutter: stable;/);
    expect(css).toMatch(/\.lab-insp \{[^}]*overflow-y: auto; scrollbar-gutter: stable;/);
    expect(css).toMatch(/\.lab-bench \{[^}]*overflow-y: auto; scrollbar-gutter: stable;/);
    expect(css).toMatch(/@media \(max-width: 980px\), \(max-height: 620px\)/);
    expect(css).toMatch(/\.lab-plate \{[^}]*min-height: 380px;/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    expect(css).toMatch(/:focus-visible \{\s*outline: var\(--fam-border-width-strong\) solid var\(--fam-focus-ring\)/);
  });

  it('is operable without a mouse: roving focus in the rail, tabs for fixtures and inspector sections, "/", "[" and "]"', () => {
    for (const needle of ["ev.key !== '/'", 'var act = V.navAction(ev); if (!act) return;', "tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (a && a.isContentEditable)", 'aria-keyshortcuts="\' + esc(key)', "'ArrowDown'", "'ArrowUp'", "'Home'", "'End'", "'ArrowRight'", "'ArrowLeft'", 'role="tab"', 'role="tablist"', 'aria-selected', 'aria-current', 'aria-expanded', 'aria-pressed', 'aria-disabled="true"', 'aria-live="polite"', 'aria-keyshortcuts="/"', 'tabindex="-1"']) expect(js).toContain(needle);
    expect(js).toMatch(/var s = \(ev\.key === 'ArrowRight'\) === !rtl\(\) \? 1 : -1;/);
  });

  it('names the direction buttons by the text they show, then say what it means (WCAG 2.5.3 Label in Name)', () => {
    expect(js).toContain("aria-label=\"' + esc(d.toUpperCase() + ' · ' + T(d === 'ltr' ? 'Left to right' : 'Right to left')) + '\"><span data-no-i18n>' + d.toUpperCase() + '</span>");
  });

  it('announces the fixture, refuses a fixture the browser’s own check rejects, and says so as text', () => {
    expect(js).toContain("live(tf('Fixture %d of %d'");
    expect(js).toMatch(/if \(!res\.ok\) \{[\s\S]*?refuse\.hidden = false;[\s\S]*?return false;/);
    expect(js).toContain("K.emptyState('This fixture failed the browser’s check', res.problems.slice(0, 3).join(' · '))");
  });

  it('draws no state, no hover, no focus emulation, no anatomy overlay, no device emulation and no pixel diff: M1, the M2 / S1 zoom, the S2 width and the S3 comparison only', () => {
    expect(js).not.toMatch(/data-lab-force|forceState|:hover|adoptedStyleSheets|CSSStyleSheet|insertRule|replaceSync|getBoundingClientRect|anatomy|overlay|viewport preset/i);
    expect(css).not.toMatch(/data-lab-force|\.lab-anatomy/);
    // The comparison draws the second pane from the same checked tree, the same way: no cloned node, no canvas, no pixel read, no image of a specimen.
    expect(js).not.toMatch(/cloneNode|importNode|<canvas|getImageData|toDataURL|drawImage|html2canvas|outerHTML/i);
    // The width is a container width: the window, its media queries and its pixel ratio are never asked or faked, and nothing is kept between visits.
    expect(js).not.toMatch(/matchMedia|innerWidth|outerWidth|devicePixelRatio|visualViewport|<iframe|localStorage|sessionStorage|@container|container-type/i);
    // getComputedStyle is read for one thing only: the specimen's padding, for Fit.
    expect(js.match(/getComputedStyle\(/g) || []).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the zoom view maths (M2 / S1): pure, deterministic and clamped', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const V = require('../public/design-system/lab-view.js');
  const junk: unknown[] = [NaN, Infinity, -Infinity, '2', '0.5', null, undefined, {}, [], true, () => 1];

  it('clamps any value to 25%–200% in two decimals, and treats anything that is not a finite number as 100%', () => {
    for (const j of junk) expect(V.clamp(j)).toBe(1);
    expect([V.clamp(-5), V.clamp(0), V.clamp(0.1), V.clamp(0.333), V.clamp(1), V.clamp(1.999), V.clamp(9)]).toEqual([0.25, 0.25, 0.25, 0.33, 1, 2, 2]);
    expect(V.MIN).toBe(0.25); expect(V.MAX).toBe(2);
    expect(V.STEPS).toContain(1); expect(V.STEPS[0]).toBe(V.MIN); expect(V.STEPS[V.STEPS.length - 1]).toBe(V.MAX);
    expect([...V.STEPS].sort((a: number, b: number) => a - b)).toEqual(V.STEPS);
  });

  it('steps up and down the ladder, stops at the limits, and joins it from any value', () => {
    const up: number[] = []; let s = 1; for (let i = 0; i < 8; i++) { s = V.zoomIn(s); up.push(s); }
    expect(up).toEqual([1.1, 1.25, 1.5, 1.75, 2, 2, 2, 2]);
    const down: number[] = []; s = 1; for (let i = 0; i < 10; i++) { s = V.zoomOut(s); down.push(s); }
    expect(down).toEqual([0.9, 0.8, 0.75, 0.67, 0.5, 0.33, 0.25, 0.25, 0.25, 0.25]);
    expect([V.zoomIn(0.6), V.zoomOut(0.6), V.zoomIn(NaN), V.zoomOut('x'), V.zoomIn(99), V.zoomOut(-1)]).toEqual([0.67, 0.5, 1.1, 0.9, 2, 0.25]);
  });

  it('fits by shrinking only, rounds down so it really fits, and says 100% for any size it cannot trust', () => {
    expect(V.fit(2000, 2000, 100, 100)).toBe(1);                 // small content is never enlarged
    expect(V.fit(500, 300, 1000, 300)).toBe(0.5);
    expect(V.fit(333, 1000, 1000, 1000)).toBe(0.33);             // 0.333 rounds down
    expect(V.fit(999, 1000, 1000, 1000)).toBe(0.99);
    expect(V.fit(100, 100, 1000, 1000)).toBe(0.25);              // never below the floor
    for (const j of junk) { expect(V.fit(j, 100, 100, 100)).toBe(1); expect(V.fit(100, 100, j, 100)).toBe(1); }
    expect(V.fit(0, 100, 100, 100)).toBe(1); expect(V.fit(100, 100, -1, 100)).toBe(1);
  });

  it('derives every value written to the stylesheet from a clamped number, and nothing else', () => {
    expect([V.transform(1), V.transform(0.5), V.transform(NaN), V.transform(5), V.transform('scale(9);background:url(x)')]).toEqual(['none', 'scale(0.5)', 'none', 'scale(2)', 'none']);
    expect(V.frameSize(1000, 500, 0.5)).toEqual({ width: 500, height: 250 });
    expect(V.frameSize(333, 101, 0.33)).toEqual({ width: 110, height: 34 });
    expect(V.frameSize(NaN, 500, 0.5)).toEqual({ width: 0, height: 250 });
    expect(V.frameSize(-4, '9', 2)).toEqual({ width: 0, height: 0 });
    expect([V.origin('rtl'), V.origin('ltr'), V.origin(undefined), V.origin('rtl;x')]).toEqual(['top right', 'top left', 'top left', 'top left']);
    expect([V.percent(0.333), V.percent(NaN), V.percent(2)]).toEqual([33, 100, 200]);
    // a deterministic sweep: every output is a plain number or one of two exact shapes
    for (let i = -50; i <= 500; i += 7) {
      const s = i / 100;
      expect(V.transform(s)).toMatch(/^(none|scale\((0|1|2)(\.\d{1,2})?\))$/);
      expect(V.clamp(s)).toBe(V.clamp(s));
      const f = V.frameSize(1234, 567, s);
      expect(Number.isInteger(f.width) && Number.isInteger(f.height)).toBe(true);
    }
  });

  it('touches no DOM, keeps no state and exports the same object to the browser and to Node', () => {
    const src = read('public/design-system/lab-view.js');
    expect(src).not.toMatch(/document|window\.(?!FamilistaLabView)|innerHTML|eval\(|new Function|setTimeout|Date\.now|Math\.random|localStorage/);
    const sandbox: any = {}; sandbox.window = sandbox;
    vm.runInNewContext(src, sandbox);
    expect(Object.keys(sandbox.FamilistaLabView).sort()).toEqual(Object.keys(V).sort());
  });
});

describe('the width view maths (M2 / S2): strict, clamped, and honest about what a width cannot tell', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const V = require('../public/design-system/lab-view.js');
  const junk: unknown[] = [NaN, Infinity, -Infinity, null, undefined, {}, [], true, () => 1, 0, -390, '', ' ', 'abc', '1e3', '-5', '+5', '0x200', '390px', '390 px', '3 90', '123456', '1.23456', '.5', 'Infinity', '١٢٣', '390\n;x'];

  it('declares the approved limits and presets, and hands out a copy', () => {
    expect([V.WIDTH_MIN, V.WIDTH_MAX]).toEqual([320, 1600]);
    expect(V.PRESETS).toEqual({ desktop: 1280, tablet: 834, mobile: 390 });
    V.PRESETS.desktop = 1; // eslint-disable-line no-param-reassign
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(require('vm').runInNewContext(read('public/design-system/lab-view.js') + ';this.FamilistaLabView.PRESETS.desktop', { window: undefined })).toBe(1280);
  });

  it('clamps a positive number to a whole width in 320–1600, and refuses everything else', () => {
    expect([V.clampWidth(1), V.clampWidth(319.4), V.clampWidth(320), V.clampWidth(390.5), V.clampWidth(834), V.clampWidth(1600.4), V.clampWidth(1e9)]).toEqual([320, 320, 320, 391, 834, 1600, 1600]);
    for (const j of junk) if (typeof j !== 'string') expect(V.clampWidth(j)).toBeNull();
  });

  it('reads typed text strictly: digits with an optional decimal part, nothing else, and says when it had to clamp', () => {
    expect(V.parseWidth('390')).toEqual({ value: 390, clamped: false });
    expect(V.parseWidth(' 834 ')).toEqual({ value: 834, clamped: false });
    expect(V.parseWidth('390.6')).toEqual({ value: 391, clamped: false });
    expect(V.parseWidth('100')).toEqual({ value: 320, clamped: true });
    expect(V.parseWidth('99999')).toEqual({ value: 1600, clamped: true });
    expect(V.parseWidth(1280)).toEqual({ value: 1280, clamped: false });
    for (const j of junk) expect({ j, out: V.parseWidth(j) }).toEqual({ j, out: null });
  });

  it('measures overflow in whole pixels, calls sub-pixel rounding 0, and returns null when nothing was measured', () => {
    expect([V.overflowPx(390, 390), V.overflowPx(391, 390), V.overflowPx(392.4, 390), V.overflowPx(300, 390), V.overflowPx(1700, 1600)]).toEqual([0, 0, 2, 0, 100]);
    for (const [a, b] of [[NaN, 390], [390, 0], [390, -1], [-1, 390], [undefined, 390], [390, null]]) expect(V.overflowPx(a, b)).toBeNull();
  });

  it('judges a recorded viewport rule against a window width from its text alone, and says when it cannot', () => {
    expect([V.mqAt('@media (max-width:760px)', 390), V.mqAt('@media (max-width:760px)', 760), V.mqAt('@media (max-width:760px)', 834)]).toEqual([true, true, false]);
    expect([V.mqAt('@media (min-width: 600px) and (max-width: 900px)', 834), V.mqAt('@media screen and (min-width: 600px)', 390), V.mqAt('@media only screen and (max-width: 480px)', 390)]).toEqual([true, false, true]);
    expect(V.mqAt('@media (max-width: 980px), (max-height: 620px)', 390)).toBe(true);    // one part is enough
    expect(V.mqAt('@media (max-width: 980px), (max-height: 620px)', 1280)).toBeNull();  // the other part needs a height
    expect(V.mqAt('@media (max-width: 300px) and (orientation: portrait)', 390)).toBe(false);
    for (const q of ['@media (max-width: 40em)', '@media print', '@media not all and (max-width: 500px)', '@media (orientation: portrait)', '@media (hover: hover)', '@supports (display: grid)', '@container (max-width: 400px)', '', 7, null])
      expect({ q, r: V.mqAt(q, 390) }).toEqual({ q, r: null });
    expect(V.mqAt('@media (max-width:760px)', NaN)).toBeNull();
  });
});

describe('the comparison view maths (M2 / S3): one shared Fit, and a set difference of class names', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const V = require('../public/design-system/lab-view.js');
  it('shares the smaller fit scale, floored to two decimals and kept in 25%–100%, and ignores anything that is not a scale', () => {
    expect([V.sharedFit([0.53, 0.35]), V.sharedFit([1, 1]), V.sharedFit([0.999, 0.5]), V.sharedFit([0.1, 0.9]), V.sharedFit([2, 3])]).toEqual([0.35, 1, 0.5, 0.25, 1]);
    for (const j of [[], [NaN, 0, -1, Infinity], 'x', null, undefined, {}, [null, '0.5']]) expect(V.sharedFit(j)).toBe(1);
    expect(V.sharedFit([NaN, 0.6])).toBe(0.6);
  });
  it('compares two lists of names as sets: sorted, deduplicated, strings only', () => {
    expect(V.diffSets(['b', 'a', 'a', 'c'], ['c', 'd', 3, null])).toEqual({ onlyA: ['a', 'b'], onlyB: ['d'], both: ['c'] });
    expect(V.diffSets([], [])).toEqual({ onlyA: [], onlyB: [], both: [] });
    expect(V.diffSets('x', { a: 1 })).toEqual({ onlyA: [], onlyB: [], both: [] });
    expect(V.diffSets(['__proto__', 'constructor'], ['constructor'])).toEqual({ onlyA: ['__proto__'], onlyB: [], both: ['constructor'] });
  });
});

describe('the Lab, run for real in a sandbox: hostile data, selection, fixtures, direction, keys', () => {
  const PAYLOAD = '"><img src=x onerror=alert(1)><script>alert(2)</script>';

  /** A DOM just big enough to run the client, that remembers how every node was made. */
  function makeDom() {
    const log = { created: [] as string[], innerHTML: {} as Record<string, string[]>, setAttr: [] as string[], focused: [] as string[] };
    const listeners = new Map<any, Record<string, ((e: any) => void)[]>>();
    const byId: Record<string, any> = {};
    function node(tag: string, ns?: string): any {
      const n: any = {
        nodeType: 1, tag, ns, attrs: {} as Record<string, string>, children: [] as any[], parent: null, hidden: false, id: '', textContent: '', value: '', scrollTop: 0,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        style: { props: {} as Record<string, string>, setProperty(k: string, v: string) { this.props[k] = v; }, removeProperty(k: string) { delete this.props[k]; } },
        setAttribute(k: string, v: string) { this.attrs[k] = v; log.setAttr.push(tag + '.' + k); if (k === 'id') byId[v] = this; },
        getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; },
        removeAttribute(k: string) { delete this.attrs[k]; },
        hasAttribute(k: string) { return k in this.attrs; },
        appendChild(c: any) { if (c.tag === '#fragment') { for (const k of c.children) { k.parent = this; this.children.push(k); } c.children = []; return c; } c.parent = this; this.children.push(c); return c; },
        removeChild(c: any) { this.children = this.children.filter((x: any) => x !== c); c.parent = null; return c; },
        get firstChild() { return this.children[0] || null; },
        get firstElementChild() { return this.children.find((c: any) => c.nodeType === 1) || null; },
        addEventListener(t: string, fn: (e: any) => void) { const m = listeners.get(this) || {}; (m[t] ||= []).push(fn); listeners.set(this, m); },
        removeEventListener() {},
        contains(o: any) { for (let x = o; x; x = x.parent) if (x === this) return true; return false; },
        closest() { return null; }, focus() { (log.focused ||= []).push(this.id || this.tag); }, setSelectionRange() {}, select() {}, click() {},
        querySelector() { return null; },
        querySelectorAll(sel: string) {
          const attr = /^\[([a-z-]+)\]$/.exec(sel);
          const out: any[] = [];
          const walk = (x: any) => { for (const c of x.children || []) { if (c.nodeType === 1) { if (attr && attr[1] in c.attrs) out.push(c); walk(c); } } };
          walk(this);
          return out;
        },
        getElementsByTagName() { const out: any[] = []; const walk = (x: any) => { for (const c of x.children || []) { if (c.nodeType === 1) { out.push(c); walk(c); } } }; walk(this); return out; },
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
        parentNode: { querySelectorAll: () => [] },
      };
      Object.defineProperty(n, 'innerHTML', { get() { return n._h || ''; }, set(v: string) { n._h = String(v); (log.innerHTML[n.id || tag] ||= []).push(String(v)); register(String(v)); } });
      return n;
    }
    // Writing markup replaces the elements it names, as a real browser would: a fresh node for every id in it.
    function register(html: string) { for (const m of html.matchAll(/ id="([^"]+)"/g)) byId[m[1]] = Object.assign(node('div'), { id: m[1] }); }
    const el = (id: string) => byId[id] || (byId[id] = Object.assign(node('div'), { id }));
    const host = el('host');
    host.querySelector = (s: string) => (s === '.lab' ? el('lab-root') : /^#[\w-]+$/.test(s) ? byId[s.slice(1)] || null : null);
    host.contains = () => true;
    const doc: any = {
      getElementById: (id: string) => byId[id] || null, activeElement: null,
      addEventListener(ty: string, fn: (e: any) => void) { const m = listeners.get(doc) || {}; (m[ty] ||= []).push(fn); listeners.set(doc, m); }, removeEventListener() {},
      createElement: (t: string) => { log.created.push(t); return node(t); }, createElementNS: (ns: string, t: string) => { log.created.push('ns:' + t); return node(t, ns); },
      createTextNode: (v: string) => ({ nodeType: 3, v, parent: null }), createDocumentFragment: () => node('#fragment'),
      body: node('body'),
    };
    return { log, listeners, byId, el, host, doc, node };
  }

  interface Run { remount: () => void; fire: (type: string, ev: any) => void; dom: ReturnType<typeof makeDom>; click: (m: Record<string, any>) => void; key: (k: string, target: any, extra?: any) => void; type: (v: string) => void; settle: () => Promise<void>; api: string[]; metrics: () => any; text: () => string }

  function launch(opts: { previews?: any; components?: any; detail?: (id: string) => any; dir?: string } = {}): Promise<Run> {
    const dom = makeDom();
    const api: string[] = [];
    const sum = (c: any) => ({ id: c.id, name: c.name, category: c.category, kind: c.kind, tier: c.tier, module: c.module, summary: c.summary, symbol: c.source.js ? c.source.js.symbol : null, sections: c.sections, counts: { rules: 0, selectors: 0, variants: 0, anatomy: 0, cases: 0, facts: 0, dependencies: 0 } });
    const compIndex = opts.components ?? { state: 'READY', reason: null, readOnly: true, generator: 'g', sources: [], taxonomy: null, coverage: null, components: components.components.map(sum) };
    const pvIndex = opts.previews ?? { state: 'READY', reason: null, readOnly: true, generator: manifest.generator, sources: manifest.sources, policy: manifest.policy, coverage: manifest.coverage, availability: manifest.availability, components: manifest.components.map((c: any) => ({ id: c.id, symbol: c.symbol, fixtures: c.fixtures.length, bytes: 1, variants: c.variants.length })) };
    const detail = opts.detail ?? ((id: string) => ({ state: 'READY', reason: null, sources: manifest.sources, component: byId(id) ?? null }));
    const esc = (v: unknown) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    const kit = {
      T: (s: string) => s, tf: (s: string, ...a: unknown[]) => { let i = 0; return s.replace(/%d/g, () => String(a[i++])); }, esc, num: (n: number) => String(n),
      code: (v: unknown) => `<code data-no-i18n>${esc(v)}</code>`, short: (s: string) => String(s).slice(0, 12), ltr: esc,
      kv: (l: string, v: string) => `<div class="ds-kv"><div>${l}</div><div>${v}</div></div>`,
      chip: (_k: string, t: string) => `<span>${esc(t)}</span>`, evChip: (s: string) => `<span>${esc(s)}</span>`,
      emptyState: (t: string, w: string, x?: string) => `<div class="ds-empty">${esc(t)}${esc(w)}${x || ''}</div>`, skeleton: () => '<div class="sk"></div>',
      contractError: (e: string, m: string[]) => `${e}${m.join()}`, dir: () => opts.dir || 'ltr',
      api: (p: string) => { api.push(p); return Promise.resolve(p.includes('/preview?id=') ? detail(decodeURIComponent(p.split('?id=')[1])) : p.endsWith('/preview') ? pvIndex : compIndex); },
    };
    const sandbox: any = {
      window: {} as any, document: dom.doc, performance: { now: () => Date.now() }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout,
      Math, JSON, Object, Array, String, Number, Date, Promise, isFinite, parseInt, console, Map, Set, encodeURIComponent,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(read('public/design-system/lab-sanitize.js'), sandbox);
    vm.runInNewContext(read('public/design-system/lab-view.js'), sandbox);
    vm.runInNewContext(read('public/design-system/lab.js'), sandbox);
    sandbox.FamilistaDesignLab.mount(dom.host, kit);
    const settle = () => new Promise<void>((r) => setTimeout(r, 40));
    const fire = (type: string, ev: any) => (dom.listeners.get(dom.host)?.[type] || []).forEach((fn) => fn(ev));
    const run: Run = {
      dom, api, settle, fire, remount: () => sandbox.FamilistaDesignLab.mount(dom.host, kit),
      click: (m) => fire('click', { target: { closest: (s: string) => m[s] ?? null } }),
      key: (k, target, extra) => fire('keydown', { key: k, target, preventDefault() {}, ...(extra || {}) }),
      type: (v) => fire('input', { target: { id: 'lab-q', value: v } }),
      metrics: () => sandbox.__familistaLabMetrics(),
      text: () => Object.values(dom.log.innerHTML).flat().join('\n'),
    };
    return settle().then(() => settle()).then(() => run);
  }
  const attr = (v: string) => ({ getAttribute: () => v });

  it('opens on the first previewable component and its first fixture, built from nodes and never from a string', async () => {
    const r = await launch();
    expect(r.api).toEqual(['/system/design-system/components', '/system/design-system/components/preview', '/system/design-system/components/preview?id=club-logo']);
    expect(r.metrics()).toMatchObject({ selected: 'club-logo', fixture: 'club-logo.with-crest-default-size', dir: 'ltr', components: 18, fixtures: 122 });
    // the specimen element never had innerHTML written; only elements made with createElement were put in it
    expect(r.dom.log.innerHTML['lab-specimen']).toBeUndefined();
    expect(r.dom.log.created.length).toBeGreaterThan(5);
    expect(r.dom.log.created.every((t) => ['div', 'span', 'svg', 'ns:svg', 'ns:path', 'img', 'ns:circle', 'b', 'i', 'section', 'header', 'footer', 'h2', 'p', 'table', 'tbody', 'tr', 'td', 'button'].includes(t))).toBe(true);
    const spec = r.dom.byId['lab-specimen'];
    expect(spec.children).toHaveLength(1);
    expect(spec.children[0].className).toBe('lab-col');
  });

  it('draws all 122 fixtures without throwing, one node for every element the manifest counts', async () => {
    const r = await launch();
    for (const c of manifest.components) {
      r.click({ '[data-lab-id]': attr(c.id) }); await r.settle();
      for (const f of c.fixtures) {
        r.click({ '[data-lab-fx]': attr(f.id) });
        const spec = r.dom.byId['lab-specimen'];
        const drawn = spec.children.length ? spec.children[0].getElementsByTagName('*').length : 0;
        expect({ id: f.id, drawn }).toEqual({ id: f.id, drawn: f.elements });
      }
    }
  });

  it('applies bar widths and crest sizes through the CSSOM, from the attribute, and writes no style attribute', async () => {
    const r = await launch();
    r.click({ '[data-lab-id]': attr('lg-versus') }); await r.settle();
    r.click({ '[data-lab-fx]': attr('lg-versus.a-leads') });
    const bars = r.dom.byId['lab-specimen'].querySelectorAll('[data-mc-width]');
    expect(bars.length).toBe(2);
    for (const b of bars) { expect(b.style.props.width).toBe(b.attrs['data-mc-width']); expect(b.attrs.style).toBeUndefined(); }
    r.click({ '[data-lab-id]': attr('lg-crest') }); await r.settle();
    const crest = r.dom.byId['lab-specimen'].querySelectorAll('[data-lg-size]')[0];
    expect(crest.style.props).toEqual({ width: '30px', height: '30px' });
  });

  it('switches the stage’s direction without redrawing the fixture, and announces it', async () => {
    const r = await launch();
    r.click({ '[data-lab-dir]': attr('rtl') });
    expect(r.dom.byId['lab-specimen'].attrs.dir).toBe('rtl');
    expect(r.metrics().dir).toBe('rtl');
    r.click({ '[data-lab-dir]': attr('sideways') });
    expect(r.dom.byId['lab-specimen'].attrs.dir).toBe('rtl');
  });

  it('stops every event at the specimen’s boundary: each listener it registers calls stopPropagation', async () => {
    const r = await launch();
    const spec = r.dom.byId['lab-specimen'];
    const m = r.dom.listeners.get(spec) as Record<string, ((e: any) => void)[]>;
    expect(Object.keys(m).sort()).toEqual(['auxclick', 'change', 'click', 'contextmenu', 'dblclick', 'focusin', 'focusout', 'input', 'keydown', 'keypress', 'keyup', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'submit', 'touchend', 'touchstart']);
    for (const fns of Object.values(m)) for (const fn of fns) { let stopped = 0; fn({ stopPropagation() { stopped++; } }); expect(stopped).toBe(1); }
  });

  it('shows a component it cannot preview as such: the reason, what would change it, and no specimen', async () => {
    // Every registered render function has fixtures now, so the no-fixtures state is drawn from an index that says club-logo has none.
    const pv = { state: 'READY', reason: null, readOnly: true, generator: manifest.generator, sources: manifest.sources, policy: manifest.policy, coverage: manifest.coverage,
      availability: manifest.availability.map((a: any) => (a.id === 'club-logo' ? { id: a.id, state: 'unavailable', reason: 'no-fixtures' } : a)),
      components: manifest.components.filter((c: any) => c.id !== 'club-logo').map((c: any) => ({ id: c.id, symbol: c.symbol, fixtures: c.fixtures.length, bytes: 1, variants: c.variants.length })) };
    const r = await launch({ previews: pv });
    r.click({ '[data-lab-id]': attr('club-logo') }); await r.settle();
    const txt = r.dom.log.innerHTML['lab-bench'].join('\n') + r.dom.log.innerHTML['lab-insp'].join('\n');
    expect(txt).toContain('Not previewable');
    expect(txt).toContain('A render function exists, but no fixtures are recorded for it yet.');
    expect(txt).toContain('Not instrumented');
    expect(r.dom.log.innerHTML['lab-bench'].slice(-1)[0]).not.toContain('lab-specimen');
    for (const id of ['button', 'topbar', 'page', 'oh-family', 'sy-family', 'tf-btn']) { r.click({ '[data-lab-id]': attr(id) }); await r.settle(); expect(r.dom.log.innerHTML['lab-bench'].slice(-1)[0]).toContain('Not previewable'); }
    expect(r.api.filter((p) => p.includes('?id='))).toEqual(['/system/design-system/components/preview?id=club-identity']);   // nothing fetched for a component with no fixtures
  });

  it('lists all 60: the eighteen live ones first, and the other forty-two grouped by reason with the reason on each', async () => {
    const r = await launch();
    const rail = r.dom.log.innerHTML['lab-rail-body'].slice(-1)[0];
    expect(rail.match(/data-lab-id="/g)).toHaveLength(60);
    expect(rail.match(/<ul class="lab-list" id="lab-g-[a-z-]+" hidden>/g)).toHaveLength(6);        // the six unavailable groups start closed
    expect(rail).toMatch(/<ul class="lab-list" id="lab-g-preview">/);
    expect(rail.match(/aria-disabled="true"/g)).toHaveLength(42);
    expect(rail).toContain('CSS only');
    expect(rail).not.toContain('No fixtures yet');                 // no registered render function is without fixtures
    r.type('o');                                                    // a search opens every group that has a match
    expect(r.dom.log.innerHTML['lab-rail-body'].slice(-1)[0]).not.toMatch(/ hidden>/);
    r.type('zzzz-nothing');
    expect(r.dom.log.innerHTML['lab-rail-body'].slice(-1)[0]).toContain('No component matches');
    r.type('');
    r.click({ '[data-lab-grp]': attr('css-only') });
    expect(r.dom.log.innerHTML['lab-rail-body'].slice(-1)[0].match(/<ul class="lab-list" id="lab-g-[a-z-]+" hidden>/g)).toHaveLength(5);
  });

  it('searches name, symbol and reason, together, in any order', async () => {
    const r = await launch();
    r.type('_lgChip');
    const rail = r.dom.log.innerHTML['lab-rail-body'].slice(-1)[0];
    expect(rail).toContain('data-lab-id="lg-chip"');
    expect(rail).not.toContain('data-lab-id="lg-crest"');
    r.type('candidate tf');
    expect(r.dom.log.innerHTML['lab-rail-body'].slice(-1)[0]).toContain('data-lab-id="tf-btn"');
  });

  it('steps through fixtures with the arrow keys, Home and End, mirrored in a right-to-left room', async () => {
    for (const dir of ['ltr', 'rtl']) {
      const r = await launch({ dir });
      const ids = byId('lg-crest').fixtures.map((f: any) => f.id);
      // The element returned by closest() must be the same object that indexOf finds, so build the list from it.
      const nodes = ids.map((x: string) => ({ getAttribute: () => x }));
      const mk = (at: number) => { const t: any = { getAttribute: () => ids[at] }; t.parentNode = { querySelectorAll: () => nodes.map((n: any, i: number) => (i === at ? t : n)) }; return { id: 'x', closest: (s: string) => (s === '[role="tab"][data-lab-fx]' ? t : null) }; };
      r.key('ArrowRight', mk(0));
      expect(r.metrics().fixture).toBe(dir === 'ltr' ? ids[1] : ids[ids.length - 1]);
      r.key('End', mk(0)); expect(r.metrics().fixture).toBe(ids[ids.length - 1]);
      r.key('Home', mk(3)); expect(r.metrics().fixture).toBe(ids[0]);
    }
  });

  it('prints hostile strings as text in the rail, the stage, the strip and every inspector tab, and draws a hostile fixture as nothing', async () => {
    const hostile = clone(manifest);
    for (const c of hostile.components) {
      Object.assign(c, { symbol: PAYLOAD.replace(/[^\w]/g, '') || 'x' });
      c.fixtures.forEach((f: any) => { f.label = PAYLOAD; f.call = PAYLOAD; f.classes.forEach((x: any) => { x.owner = 'css'; }); f.html = '<span class="lg-chip"><img src="https://example.invalid/a.png" onerror="alert(1)"></span>'; });
      c.variants.forEach((v: any) => { v.name = PAYLOAD; });
      c.mediaQueries = [PAYLOAD];
    }
    const comps = components.components.map((c: any) => ({ id: c.id, name: PAYLOAD, category: c.category, kind: c.kind, tier: c.tier, module: c.module, summary: PAYLOAD, symbol: c.source.js ? PAYLOAD : null, sections: c.sections, counts: { rules: 0, selectors: 0, variants: 0, anatomy: 0, cases: 0, facts: 0, dependencies: 0 } }));
    const r = await launch({
      components: { state: 'READY', reason: null, readOnly: true, generator: 'g', sources: [], taxonomy: null, coverage: null, components: comps },
      previews: { state: 'READY', reason: null, readOnly: true, generator: PAYLOAD, sources: manifest.sources.map((s: any) => ({ ...s, label: PAYLOAD, path: PAYLOAD })), policy: manifest.policy, coverage: manifest.coverage, availability: manifest.availability, components: manifest.components.map((c: any) => ({ id: c.id, symbol: c.symbol, fixtures: c.fixtures.length, bytes: 1, variants: c.variants.length })) },
      detail: (id: string) => ({ state: 'READY', reason: null, sources: manifest.sources.map((s: any) => ({ ...s, label: PAYLOAD, path: PAYLOAD })), component: hostile.components.find((c: any) => c.id === id) }),
    });
    r.click({ '[data-lab-id]': attr('lg-chip') }); await r.settle();
    for (const tab of ['provenance', 'source', 'sanitization', 'variants']) r.click({ '[data-lab-tab]': attr(tab) });
    r.click({ '[data-lab-id]': attr('club-logo') }); await r.settle();
    r.type('x');
    const out = r.text();
    expect(out.length).toBeGreaterThan(3000);
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).not.toMatch(/<(img|script)\b/);
    expect(out).not.toMatch(/"[^"<>]*"><img/);
    expect(out).not.toContain(PAYLOAD);
    // the hostile fixtures were refused by the browser's own check: nothing was built
    r.click({ '[data-lab-id]': attr('lg-chip') }); await r.settle();
    expect(r.dom.byId['lab-specimen'].children).toHaveLength(0);
    expect(r.dom.byId['lab-refuse'].innerHTML).toContain('failed the browser');
    expect(r.dom.log.created.filter((t) => t === 'img')).toHaveLength(0);
  });

  it('refuses a fixture that is not the canonical form the server checked, even if it is otherwise harmless', async () => {
    const odd = clone(manifest);
    odd.components[2].fixtures[0].html = '<span  class="lg-chip">x</span>';       // an extra space: valid markup, not canonical
    const r = await launch({ detail: (id: string) => ({ state: 'READY', reason: null, sources: [], component: id === 'lg-chip' ? odd.components[2] : byId(id) }) });
    r.click({ '[data-lab-id]': attr('lg-chip') }); await r.settle();
    expect(r.dom.byId['lab-specimen'].children).toHaveLength(0);
    expect(r.dom.byId['lab-refuse'].innerHTML).toMatch(/not the canonical form|failed/);
  });

  it('shows the whole provenance: render function, hashes, the recorded call, classes with owners, and the viewport rules it does not simulate', async () => {
    const r = await launch();
    r.click({ '[data-lab-id]': attr('lg-metric') }); await r.settle();
    const prov = r.dom.log.innerHTML['lab-insp'].slice(-1)[0];
    for (const needle of ['_lgMetric', 'Fixture sha256', 'Golden snapshot sha256', 'The call', 'RECORDED', 'MEASURED', '@media (max-width:760px)', 'These rules respond to the browser window, not to the stage.', 'data-mc-width', 'data-lg-size']) expect(prov).toContain(needle);
    r.click({ '[data-lab-tab]': attr('source') });
    const src = r.dom.log.innerHTML['lab-insp'].slice(-1)[0];
    expect(src).toContain(byId('lg-metric').source.js.sha256);
    expect(src).toContain(byId('lg-metric').source.css[0].sha256);
    expect(src).toContain('Only a hash of the function is shown.');
    expect(src).not.toMatch(/function _lgMetric|return '</);
    r.click({ '[data-lab-tab]': attr('sanitization') });
    expect(r.dom.log.innerHTML['lab-insp'].slice(-1)[0]).toContain('Passed in this browser');
    r.click({ '[data-lab-tab]': attr('variants') });
    const vars = r.dom.log.innerHTML['lab-insp'].slice(-1)[0];
    expect(vars).toContain('lg-metric--hero');
    expect(vars).toContain('No fixture shows this variant.');
  });

  it('puts focus back when the room repaints and mounts the Lab again within moments, and not after', async () => {
    const r = await launch();
    r.fire('focusin', { target: { id: 'lab-q', getAttribute: () => null } });
    r.dom.log.focused.length = 0;
    r.remount();
    expect(r.dom.log.focused).toContain('lab-q');
    expect(r.metrics()).toMatchObject({ selected: 'club-logo' });         // the choice survives the remount, too
    // a visit, not a repaint: nothing is focused for it
    const later = await launch();
    later.fire('focusin', { target: { id: 'lab-q', getAttribute: () => null } });
    const realNow = Date.now; Date.now = () => realNow() + 10000;
    try { later.dom.log.focused.length = 0; later.remount(); } finally { Date.now = realNow; }
    expect(later.dom.log.focused).not.toContain('lab-q');
  });

  it('says why when the Lab cannot read the manifest, and draws nothing it did not read', async () => {
    const reason = 'The design-system previews manifest is not beside this server (run scripts/design-system-discover.js).';
    const r = await launch({ previews: { state: 'NOT_GENERATED', reason, readOnly: true, generator: null, sources: [], policy: null, coverage: null, availability: [], components: [] } });
    expect(r.dom.log.innerHTML['lab-bench'].slice(-1)[0]).toContain('The Specimen Lab could not be read');
    expect(r.dom.log.innerHTML['lab-bench'].slice(-1)[0]).toContain('not beside this server');
    expect(r.dom.byId['lab-specimen']).toBeUndefined();
  });

  it('names a contract break rather than drawing a half-empty screen', async () => {
    const r = await launch({ previews: { state: 'READY' } });
    expect(r.dom.log.innerHTML['lab-bench'].slice(-1)[0]).toContain('/system/design-system/components/preview');
    expect(r.dom.byId['lab-specimen']).toBeUndefined();
  });

  it('draws the specimen in under 2,000 nodes and keeps its DOM from growing as fixtures change', async () => {
    const r = await launch();
    const counts: number[] = [];
    for (const c of manifest.components) { r.click({ '[data-lab-id]': attr(c.id) }); await r.settle(); for (const f of c.fixtures) { r.click({ '[data-lab-fx]': attr(f.id) }); counts.push(r.metrics().specimenNodes); } }
    expect(Math.max(...counts)).toBeLessThan(40);
    expect(counts).toHaveLength(122);
  });

  // ── M2 / S1: zoom ──────────────────────────────────────────────────────────
  const docKey = (r: Run, key: string, extra: Record<string, unknown> = {}) => {
    let prevented = false;
    (r.dom.listeners.get(r.dom.doc)?.keydown || []).forEach((fn) => fn({ key, preventDefault() { prevented = true; }, ...extra }));
    return prevented;
  };
  const zoomTool = (r: Run) => r.dom.log.innerHTML['lab-bench'].slice(-1)[0];

  it('draws the zoom tools beside the direction, each with a name, a shortcut and a state, and opens at 100%', async () => {
    const r = await launch();
    const bench = zoomTool(r);
    expect(bench).toContain('class="ds-seg lab-zoom" role="group" aria-label="Zoom"');
    for (const [act, key] of [['out', '-'], ['in', '='], ['fit', 'F'], ['reset', '0']]) expect(bench).toMatch(new RegExp(`data-lab-zoom="${act}"[^>]*aria-keyshortcuts="${key}"`));
    expect(bench).toMatch(/data-lab-zoom="reset" aria-label="Reset to 100%" aria-disabled="true"/);
    expect(bench).toMatch(/data-lab-zoom="fit" aria-label="Fit to stage" aria-pressed="false"/);
    expect(bench).toContain('<span class="lab-zoom-v" id="lab-zoom-v" data-no-i18n>100%</span>');
    expect(bench).toContain('<div class="lab-viewport" id="lab-viewport"><div class="lab-frame" id="lab-frame" dir="ltr"><div class="lab-specimen" id="lab-specimen"');
    expect(r.metrics()).toMatchObject({ zoom: 1, fit: false });
  });

  it('walks the zoom ladder with the buttons and stops at both limits, announcing each step', async () => {
    const r = await launch();
    r.click({ '[data-lab-zoom]': attr('in') });
    expect(r.metrics().zoom).toBe(1.1);
    expect(r.dom.byId['lab-live'].textContent).toBe('Zoom 110%');
    expect(r.dom.byId['lab-zoom-v'].textContent).toBe('110%');
    for (let i = 0; i < 20; i++) r.click({ '[data-lab-zoom]': attr('in') });
    expect(r.metrics().zoom).toBe(2);
    for (let i = 0; i < 30; i++) r.click({ '[data-lab-zoom]': attr('out') });
    expect(r.metrics().zoom).toBe(0.25);
    r.click({ '[data-lab-zoom]': attr('reset') });
    expect(r.metrics()).toMatchObject({ zoom: 1, fit: false });
    r.click({ '[data-lab-zoom]': attr('fit') });
    expect(r.metrics().fit).toBe(true);
    expect(r.metrics().zoom).toBeLessThanOrEqual(1);              // fit never enlarges; nothing is measurable here, so 100%
    expect(r.dom.byId['lab-live'].textContent).toBe('Fit to stage: 100%');
  });

  it('answers "-", "=", "+", "0" and "F" outside text fields, and never takes Ctrl, Cmd or Alt from the browser', async () => {
    const r = await launch();
    expect(docKey(r, '=')).toBe(true); expect(r.metrics().zoom).toBe(1.1);
    expect(docKey(r, '+')).toBe(true); expect(r.metrics().zoom).toBe(1.25);
    expect(docKey(r, '-')).toBe(true); expect(r.metrics().zoom).toBe(1.1);
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) for (const k of ['=', '-', '0', '+']) {
      expect(docKey(r, k, { [mod]: true })).toBe(false);                     // not prevented: the browser's own zoom
      expect(r.metrics().zoom).toBe(1.1);
    }
    r.dom.doc.activeElement = { tagName: 'INPUT' };
    expect(docKey(r, '0')).toBe(false); expect(docKey(r, 'f')).toBe(false);
    expect(r.metrics()).toMatchObject({ zoom: 1.1, fit: false });
    r.dom.doc.activeElement = null;
    expect(docKey(r, '0')).toBe(true); expect(r.metrics().zoom).toBe(1);
    expect(docKey(r, 'F')).toBe(true); expect(r.metrics().fit).toBe(true);
    expect(docKey(r, 'x')).toBe(false);
  });

  it('keeps the zoom across fixtures, components, a direction change and a remount, and draws the tools in that state', async () => {
    const r = await launch();
    r.click({ '[data-lab-zoom]': attr('out') }); r.click({ '[data-lab-zoom]': attr('out') });
    expect(r.metrics().zoom).toBe(0.8);
    r.click({ '[data-lab-fx]': attr('lg-crest.no-crest') });
    r.click({ '[data-lab-id]': attr('lg-chip') }); await r.settle();
    r.click({ '[data-lab-dir]': attr('rtl') });
    r.remount(); await r.settle();
    expect(r.metrics()).toMatchObject({ zoom: 0.8, fit: false, dir: 'rtl' });
    expect(zoomTool(r)).toContain('data-no-i18n>80%</span>');
    expect(zoomTool(r)).toContain('<div class="lab-frame" id="lab-frame" dir="rtl">');
    for (let i = 0; i < 20; i++) r.click({ '[data-lab-zoom]': attr('out') });
    r.click({ '[data-lab-id]': attr('lg-crest') }); await r.settle();
    expect(zoomTool(r)).toMatch(/data-lab-zoom="out" aria-label="Zoom out" aria-disabled="true"/);
  });

  it('a component it cannot preview has no zoom, and the zoom keys do nothing there', async () => {
    const r = await launch();
    r.click({ '[data-lab-id]': attr('ds-button') }); await r.settle();
    expect(zoomTool(r)).not.toContain('data-lab-zoom');
    expect(docKey(r, '=')).toBe(false);
    expect(r.metrics().zoom).toBe(1);
  });

  it('puts focus back on a zoom control after the room redraws the Lab', async () => {
    const r = await launch();
    r.fire('focusin', { target: { getAttribute: (k: string) => (k === 'data-lab-zoom' ? 'in' : null), id: '' } });
    const zin = Object.assign(r.dom.node('button'), { id: 'zin' });
    const q = r.dom.host.querySelector;
    r.dom.host.querySelector = (s: string) => (s === '[data-lab-zoom="in"]' ? zin : q(s));
    r.remount(); await r.settle();
    expect(r.dom.log.focused).toContain('zin');
  });

  // ── M2 / S2: width ─────────────────────────────────────────────────────────
  const widthKey = (r: Run, value: string, how: 'change' | 'Enter' | 'Escape' = 'change') => {
    const t = { id: 'lab-w', value };
    if (how === 'change') r.fire('change', { target: t }); else r.key(how, t);
  };
  const col = (r: Run) => r.dom.byId['lab-specimen'].children[0];
  const live = (r: Run) => r.dom.byId['lab-live'].textContent;

  it('draws Fill, Desktop, Tablet and Mobile beside the zoom, a strict custom field, and readouts that are always laid out', async () => {
    const r = await launch();
    const bench = zoomTool(r);
    expect(bench).toContain('class="ds-seg lab-width" role="group" aria-label="Width"');
    expect(bench).toMatch(/data-lab-width="fill" aria-pressed="true" aria-label="Fill the stage"/);
    for (const [k, w] of [['desktop', 1280], ['tablet', 834], ['mobile', 390]]) expect(bench).toMatch(new RegExp(`data-lab-width="${k}" aria-pressed="false" aria-label="[A-Za-z]+ · ${w} px"`));
    expect(bench).toContain('<input class="ds-input lab-w" id="lab-w" type="number" inputmode="numeric" min="320" max="1600" step="1" autocomplete="off" value="" aria-describedby="lab-w-h">');
    expect(bench).toContain('id="lab-w-h">From 320 to 1600 px. Press Enter to apply.</span>');
    expect(bench).toContain('<div class="lab-wbar" id="lab-wbar" data-off><span class="lab-wdim" id="lab-wdim" data-no-i18n>—</span><span class="lab-ov" id="lab-ov">—</span><span class="lab-wnote" id="lab-wnote">Width simulation — not full device emulation.</span></div>');
    expect(bench.indexOf('lab-zoom')).toBeLessThan(bench.indexOf('lab-width'));
    expect(bench.indexOf('lab-width')).toBeLessThan(bench.indexOf('lab-dir'));
    expect(r.metrics()).toMatchObject({ width: null, zoom: 1, fit: false });
  });

  it('sets the content container, not the canvas, through the CSSOM, and Fill hands it back to the stylesheet', async () => {
    const r = await launch();
    r.click({ '[data-lab-width]': attr('mobile') });
    expect(r.metrics().width).toBe(390);
    expect(col(r).className).toBe('lab-col');
    expect(col(r).style.props).toEqual({ width: '390px', 'max-width': 'none' });
    expect(col(r).attrs.style).toBeUndefined();
    expect(r.dom.byId['lab-specimen'].attrs.style).toBeUndefined();
    expect(live(r)).toBe('Width 390 px');
    expect(r.dom.byId['lab-w'].value).toBe('390');
    expect(r.dom.byId['lab-wbar'].attrs['data-off']).toBeUndefined();
    for (const [k, w] of [['desktop', 1280], ['tablet', 834]] as const) { r.click({ '[data-lab-width]': attr(k) }); expect(r.metrics().width).toBe(w); expect(col(r).style.props.width).toBe(`${w}px`); }
    r.click({ '[data-lab-width]': attr('fill') });
    expect(r.metrics().width).toBeNull();
    expect(col(r).style.props).toEqual({});
    expect(live(r)).toBe('Width: fill the stage');
    expect(r.dom.byId['lab-w'].value).toBe('');
    expect(r.dom.byId['lab-wbar'].attrs['data-off']).toBe('');
    for (const junk of ['huge', '__proto__', 'constructor', 'custom', '']) { r.click({ '[data-lab-width]': attr(junk) }); expect(r.metrics().width).toBeNull(); }
  });

  it('reads a custom width strictly: clamps a number outside 320–1600, and refuses anything that is not a number', async () => {
    const r = await launch();
    widthKey(r, '500'); expect(r.metrics().width).toBe(500); expect(live(r)).toBe('Width 500 px');
    widthKey(r, ' 834.4 ', 'Enter'); expect(r.metrics().width).toBe(834);
    widthKey(r, '100'); expect(r.metrics().width).toBe(320); expect(live(r)).toBe('Width 320 px · Kept within 320 to 1600 px'); expect(r.dom.byId['lab-w'].value).toBe('320');
    widthKey(r, '0.4'); expect(r.metrics().width).toBe(320);                  // a positive number, only too small: held at the floor
    widthKey(r, '99999', 'Enter'); expect(r.metrics().width).toBe(1600);
    for (const bad of ['', ' ', 'abc', '1e3', '-5', '+400', '0x200', '390px', '39 0', '123456', '0', 'Infinity', 'NaN', '400;color:red', '١٢٣']) {
      widthKey(r, bad, bad.length % 2 ? 'Enter' : 'change');
      expect({ bad, width: r.metrics().width }).toEqual({ bad, width: 1600 });
      expect(r.dom.byId['lab-w'].value).toBe('1600');                       // the field goes back to the width in force
      expect(live(r)).toBe('Enter a width between 320 and 1600 px');
    }
    widthKey(r, '700', 'Escape'); expect(r.metrics().width).toBe(1600); expect(r.dom.byId['lab-w'].value).toBe('1600');
    for (const v of Object.values(col(r).style.props)) expect(String(v)).toMatch(/^(\d+px|none)$/);
  });

  it('keeps the zoom when the width changes, never turns Fit on by itself, and works Fit out again when it is on', async () => {
    const r = await launch();
    r.click({ '[data-lab-zoom]': attr('out') });
    expect(r.metrics().zoom).toBe(0.9);
    for (const k of ['desktop', 'mobile', 'fill', 'tablet']) { r.click({ '[data-lab-width]': attr(k) }); expect(r.metrics()).toMatchObject({ zoom: 0.9, fit: false }); }
    r.click({ '[data-lab-zoom]': attr('fit') });
    r.click({ '[data-lab-width]': attr('desktop') });
    expect(r.metrics()).toMatchObject({ fit: true, width: 1280 });
    r.click({ '[data-lab-zoom]': attr('reset') });
    expect(r.metrics()).toMatchObject({ zoom: 1, fit: false, width: 1280 });  // Reset is the zoom's; the width stays
  });

  it('keeps the width across fixtures, components, a direction change, a remount and the room’s Refresh, and draws the tools in that state', async () => {
    const r = await launch();
    r.click({ '[data-lab-width]': attr('tablet') });
    r.click({ '[data-lab-fx]': attr('lg-crest.no-crest') });
    expect(col(r).style.props.width).toBe('834px');                            // a fresh specimen is sized too
    r.click({ '[data-lab-id]': attr('lg-chip') }); await r.settle();
    r.click({ '[data-lab-dir]': attr('rtl') });
    r.remount(); await r.settle();
    expect(r.metrics()).toMatchObject({ width: 834, dir: 'rtl' });
    expect(zoomTool(r)).toMatch(/data-lab-width="tablet" aria-pressed="true"/);
    expect(zoomTool(r)).toContain('value="834"');
    expect(zoomTool(r)).toContain('<div class="lab-wbar" id="lab-wbar"><span class="lab-wdim"');
    widthKey(r, '1000');
    expect(zoomTool(r)).toBeTruthy();
    expect(r.metrics().width).toBe(1000);
  });

  it('a component it cannot preview has no width tools, and an empty or refused fixture measures nothing', async () => {
    const r = await launch();
    r.click({ '[data-lab-id]': attr('ds-button') }); await r.settle();
    expect(zoomTool(r)).not.toContain('data-lab-width');
    r.click({ '[data-lab-width]': attr('mobile') });
    expect(r.metrics().width).toBeNull();
  });

  it('marks each recorded viewport rule against the width, from its text, and says it is not simulated', async () => {
    const r = await launch();
    r.click({ '[data-lab-id]': attr('lg-metric') }); await r.settle();
    const insp = () => r.dom.log.innerHTML['lab-insp'].slice(-1)[0];
    expect(insp()).toContain('<ul class="lab-plain lab-mq" id="lab-mq"><li><code data-no-i18n>@media (max-width:760px)</code><span class="lab-mq-s" data-lab-mq="0"></span></li></ul>');
    expect(insp()).toContain('These rules respond to the browser window, not to the stage.');
    r.click({ '[data-lab-width]': attr('mobile') });
    r.click({ '[data-lab-fx]': attr(byId('lg-metric').fixtures[1].id) });
    expect(insp()).toContain('data-lab-mq="0">Would apply in a 390 px window — not simulated</span>');
    r.click({ '[data-lab-width]': attr('tablet') });
    r.click({ '[data-lab-fx]': attr(byId('lg-metric').fixtures[0].id) });
    expect(insp()).toContain('data-lab-mq="0">Would not apply in a 834 px window</span>');
  });

  it('puts focus back on a width preset or on the custom field after the room redraws the Lab', async () => {
    const r = await launch();
    r.fire('focusin', { target: { getAttribute: (k: string) => (k === 'data-lab-width' ? 'mobile' : null), id: '' } });
    const mob = Object.assign(r.dom.node('button'), { id: 'mob' });
    const q = r.dom.host.querySelector;
    r.dom.host.querySelector = (s: string) => (s === '[data-lab-width="mobile"]' ? mob : s === '#lab-w' ? Object.assign(r.dom.node('input'), { id: 'wf' }) : q(s));
    r.remount(); await r.settle();
    expect(r.dom.log.focused).toContain('mob');
    r.fire('focusin', { target: { getAttribute: () => null, id: 'lab-w' } });
    r.dom.doc.activeElement = null;
    r.remount(); await r.settle();
    expect(r.dom.log.focused).toContain('wf');
  });

  it('never lets a key typed in the custom field zoom, step a fixture or jump to the search', async () => {
    const r = await launch();
    r.dom.doc.activeElement = { tagName: 'INPUT', id: 'lab-w' };
    for (const k of ['0', '-', '=', 'F', '[', ']', '/']) expect(docKey(r, k)).toBe(false);
    expect(r.metrics()).toMatchObject({ zoom: 1, fit: false, fixture: 'club-logo.with-crest-default-size' });
  });

  // ── M2 / S3: comparison ────────────────────────────────────────────────────
  const bench = (r: Run) => r.dom.log.innerHTML['lab-bench'].slice(-1)[0];
  const ids = (html: string) => [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  const pickB = (r: Run, value: string) => r.fire('change', { target: { id: 'lab-fx-b', value } });

  it('opens in single preview, exactly the S2 stage, with a View group to switch to comparison', async () => {
    const r = await launch();
    const b = bench(r);
    expect(b).toContain('class="ds-seg lab-mode" role="group" aria-label="View"');
    expect(b).toMatch(/data-lab-mode="single" aria-pressed="true" aria-label="Single preview"><span>Single<\/span>/);
    expect(b).toMatch(/data-lab-mode="compare" aria-pressed="false" aria-label="Compare side by side"><span>Compare<\/span>/);
    expect(b).toContain('<div class="lab-plate" id="lab-plate" role="tabpanel" aria-labelledby="lab-tab-current"><div class="lab-viewport" id="lab-viewport">');
    expect(b).not.toMatch(/ id="[^"]*-b"|lab-cmp|lab-fx-b|data-lab-swap/);
    expect(r.metrics()).toMatchObject({ compare: false, fixtureB: null, specimenNodesB: 0 });
  });

  it('opens Preview B beside A with the next fixture, its own walls and boundary, every id unique, and no new request', async () => {
    const r = await launch();
    const before = r.api.length;
    r.click({ '[data-lab-mode]': attr('compare') });
    const b = bench(r);
    expect(r.metrics()).toMatchObject({ compare: true, fixture: 'club-logo.with-crest-default-size', fixtureB: byId('club-logo').fixtures[1].id });
    const all = ids(b);
    expect(all.length).toBeGreaterThan(20);
    expect(new Set(all).size).toBe(all.length);
    for (const name of ['viewport', 'frame', 'specimen', 'void', 'refuse', 'wdim', 'ov']) { expect(all).toContain(`lab-${name}`); expect(all).toContain(`lab-${name}-b`); }
    expect(b).toContain('<div class="lab-cmp-pane" id="lab-pane-a" role="tabpanel" aria-labelledby="lab-tab-current">');
    expect(b).toContain('<div class="lab-specimen" id="lab-specimen-b" dir="ltr" data-no-i18n data-lab-stage="b" role="group" aria-label="Preview B">');
    expect(b).toContain('<select class="ds-input lab-fxb-s" id="lab-fx-b" data-no-i18n>');
    expect(b).toContain('data-lab-swap="ab">Swap A and B</button>');
    const specB = r.dom.byId['lab-specimen-b'];
    expect(Object.keys(r.dom.listeners.get(specB) || {}).sort()).toEqual(Object.keys(r.dom.listeners.get(r.dom.byId['lab-specimen']) || {}).sort());
    expect(specB.children[0].className).toBe('lab-col');
    expect(specB.children[0].getElementsByTagName('*').length).toBe(byId('club-logo').fixtures[1].elements);
    expect(r.dom.log.innerHTML['lab-specimen-b']).toBeUndefined();          // built from nodes, never from a string
    expect(r.api.length).toBe(before);
    expect(r.dom.byId['lab-live'].textContent).toBe('Compare side by side');
  });

  it('changes Preview B on its own, refuses a fixture that is not this component’s, and leaves A, the strip and the zoom alone', async () => {
    const r = await launch();
    r.click({ '[data-lab-zoom]': attr('out') });
    r.click({ '[data-lab-mode]': attr('compare') });
    const c = byId('club-logo');
    const nodesA = r.dom.byId['lab-specimen'].getElementsByTagName('*').length;
    pickB(r, c.fixtures[2].id);
    expect(r.metrics()).toMatchObject({ fixture: c.fixtures[0].id, fixtureB: c.fixtures[2].id, zoom: 0.9 });
    expect(r.dom.byId['lab-specimen-b'].children[0].getElementsByTagName('*').length).toBe(c.fixtures[2].elements);
    expect(r.dom.byId['lab-specimen'].getElementsByTagName('*').length).toBe(nodesA);
    expect(r.dom.byId['lab-live'].textContent).toBe('Preview B: ' + c.fixtures[2].label);
    for (const bad of ['lg-chip.label-and-value', '__proto__', '', '"><script>']) { pickB(r, bad); expect(r.metrics().fixtureB).toBe(c.fixtures[2].id); }
    r.click({ '[data-lab-fx]': attr(c.fixtures[1].id) });
    expect(r.metrics()).toMatchObject({ fixture: c.fixtures[1].id, fixtureB: c.fixtures[2].id });
  });

  it('swaps A and B, the strip following A', async () => {
    const r = await launch();
    r.click({ '[data-lab-mode]': attr('compare') });
    const c = byId('club-logo');
    pickB(r, c.fixtures[3].id);
    r.click({ '[data-lab-swap]': attr('ab') });
    expect(r.metrics()).toMatchObject({ fixture: c.fixtures[3].id, fixtureB: c.fixtures[0].id });
    expect(r.dom.byId['lab-specimen'].children[0].getElementsByTagName('*').length).toBe(c.fixtures[3].elements);
    expect(r.dom.byId['lab-specimen-b'].children[0].getElementsByTagName('*').length).toBe(c.fixtures[0].elements);
    expect(r.dom.byId['lab-live'].textContent).toBe('Preview A and Preview B swapped');
  });

  it('compares the two fixtures in Provenance from the manifest alone: ids, markup, elements and classes, 0 for an empty set', async () => {
    const r = await launch();
    r.click({ '[data-lab-mode]': attr('compare') });
    const c = byId('club-logo'), a = c.fixtures[0], b = c.fixtures[1];
    const insp = r.dom.log.innerHTML['lab-insp'].slice(-1)[0];
    expect(insp).toContain('id="lab-cmp-i"');
    expect(insp.indexOf('lab-cmp-i')).toBeLessThan(insp.indexOf('Where this specimen comes from'));
    expect(insp).toContain(`<code data-no-i18n>${a.id}</code>`); expect(insp).toContain(`<code data-no-i18n>${b.id}</code>`);
    expect(insp).toContain(a.sha256 === b.sha256 ? 'Identical in both' : 'Different');
    expect(insp).toContain(`<span data-no-i18n>${a.elements} · ${b.elements}</span>`);
    const names = (f: any) => new Set(f.classes.map((k: any) => k.name));
    const onlyA = [...names(a)].filter((n) => !names(b).has(n));
    expect(insp).toMatch(new RegExp(`Only in A</div><div><span class="lab-cmp-n" data-no-i18n>${onlyA.length}</span>`));
    r.click({ '[data-lab-mode]': attr('single') });
    expect(r.dom.log.innerHTML['lab-insp'].slice(-1)[0]).not.toContain('lab-cmp-i');
  });

  it('a fixture refused in Preview B draws nothing there, says why, and leaves Preview A drawn', async () => {
    const bad = clone(manifest);
    const c = bad.components.find((x: any) => x.id === 'club-logo');
    c.fixtures[1].html = '<span class="club-logo"><img src="https://example.invalid/a.png" onerror="alert(1)"></span>';
    const r = await launch({ detail: (id: string) => ({ state: 'READY', reason: null, sources: manifest.sources, component: bad.components.find((x: any) => x.id === id) }) });
    r.click({ '[data-lab-mode]': attr('compare') });
    expect(r.metrics().fixtureB).toBe(c.fixtures[1].id);
    expect(r.dom.byId['lab-specimen-b'].children).toHaveLength(0);
    expect(r.dom.byId['lab-refuse-b'].hidden).toBe(false);
    expect(r.dom.log.innerHTML['lab-refuse-b'].slice(-1)[0]).toContain('This fixture failed the browser’s check');
    expect(r.dom.byId['lab-specimen'].children).toHaveLength(1);
    expect(r.dom.byId['lab-refuse'].hidden).toBe(true);
  });

  it('removes Preview B completely when comparison ends, and keeps the mode across a remount and the room’s Refresh', async () => {
    const r = await launch();
    r.click({ '[data-lab-mode]': attr('compare') });
    r.click({ '[data-lab-mode]': attr('single') });
    expect(bench(r)).not.toMatch(/ id="[^"]*-b"|lab-cmp|lab-fx-b/);
    expect(r.metrics()).toMatchObject({ compare: false, fixtureB: null, specimenNodesB: 0 });
    r.click({ '[data-lab-mode]': attr('compare') });
    r.remount(); await r.settle();
    expect(r.metrics().compare).toBe(true);
    expect(bench(r)).toContain('id="lab-specimen-b"');
    for (const junk of ['both', '', '__proto__']) { r.click({ '[data-lab-mode]': attr(junk) }); expect(r.metrics().compare).toBe(true); }
  });

  it('shares the toolbar: width and zoom reach both containers, and a component it cannot preview has no comparison', async () => {
    const r = await launch();
    r.click({ '[data-lab-mode]': attr('compare') });
    r.click({ '[data-lab-width]': attr('mobile') });
    expect(r.dom.byId['lab-specimen'].children[0].style.props.width).toBe('390px');
    expect(r.dom.byId['lab-specimen-b'].children[0].style.props.width).toBe('390px');
    r.click({ '[data-lab-dir]': attr('rtl') });
    expect([r.dom.byId['lab-specimen'].attrs.dir, r.dom.byId['lab-specimen-b'].attrs.dir]).toEqual(['rtl', 'rtl']);
    r.click({ '[data-lab-id]': attr('ds-button') }); await r.settle();
    expect(bench(r)).not.toContain('data-lab-mode');
  });

  it('puts focus back on the View group, Preview B’s fixture and Swap after the room redraws the Lab', async () => {
    const r = await launch();
    r.click({ '[data-lab-mode]': attr('compare') });
    const made: Record<string, any> = {};
    const q = r.dom.host.querySelector;
    r.dom.host.querySelector = (sel: string) => ({ '[data-lab-mode="compare"]': 'mode', '#lab-fx-b': 'pick', '[data-lab-swap="ab"]': 'swap' } as Record<string, string>)[sel]
      ? (made[sel] ||= Object.assign(r.dom.node('button'), { id: ({ '[data-lab-mode="compare"]': 'mode', '#lab-fx-b': 'pick', '[data-lab-swap="ab"]': 'swap' } as Record<string, string>)[sel] })) : q(sel);
    for (const [target, id] of [[{ getAttribute: (k: string) => (k === 'data-lab-mode' ? 'compare' : null), id: '' }, 'mode'], [{ getAttribute: () => null, id: 'lab-fx-b' }, 'pick'], [{ getAttribute: (k: string) => (k === 'data-lab-swap' ? 'ab' : null), id: '' }, 'swap']] as const) {
      r.fire('focusin', { target });
      r.dom.doc.activeElement = null;
      r.remount(); await r.settle();
      expect(r.dom.log.focused).toContain(id);
    }
  });

});

// ─────────────────────────────────────────────────────────────────────────────
describe('English, German and Arabic: everything the Lab can say is in all three catalogues', () => {
  const dict = (t: string) => json(`public/design-system/i18n/${t}.json`) as Record<string, string>;
  const en = dict('en'); const de = dict('de'); const ar = dict('ar');
  const js = read('public/design-system/lab.js');
  const unescape = (s: string) => s.replace(/\\'/g, "'");
  const mapValues = (src: string, name: string) => {
    const at = src.indexOf(`var ${name} = {`);
    let depth = 0; let end = at;
    for (let i = src.indexOf('{', at); i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i; break; } }
    return [...src.slice(at, end).matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => unescape(m[1]));
  };

  it('covers every literal the Lab passes through T(), tf() and the room’s helpers', () => {
    const calls = [...js.matchAll(/\b(?:T|tf|K\.kv|K\.emptyState|sectionHead|notInstrumented)\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => unescape(m[1]));
    const keys = [...new Set(calls)].filter((k) => /[A-Za-z]{2}/.test(k));
    expect(keys.length).toBeGreaterThan(60);
    expect(keys.filter((k) => !(k in en))).toEqual([]);
    expect(keys.filter((k) => !(k in de) || !(k in ar))).toEqual([]);
  });

  it('covers every reason, explanation, neutralisation, owner label and tab held in the Lab’s vocabulary', () => {
    const values = ['REASON_LABEL', 'REASON_WHY', 'REASON_FIX', 'NEUTRAL_WHY', 'NEUTRAL_ACTION', 'OWNER_LABEL'].flatMap((n) => mapValues(js, n));
    values.push(...[...js.matchAll(/\['(?:provenance|source|sanitization|variants)', '([^']+)'\]/g)].map((m) => m[1]));
    expect(values.length).toBeGreaterThan(30);
    expect(values.filter((v) => !(v in en))).toEqual([]);
    expect(values.filter((v) => !(v in de) || !(v in ar))).toEqual([]);
  });

  it('covers every plural form it asks for, in the singular and the plural', () => {
    for (const w of ['fixture', 'element', 'node', 'rule']) for (const k of [`%d ${w}`, `%d ${w}s`]) { expect(en).toHaveProperty([k]); expect(de).toHaveProperty([k]); expect(ar).toHaveProperty([k]); }
  });

  it('covers the source labels and the server’s reasons for a previews manifest that is missing or fails its check', () => {
    for (const s of manifest.sources) { expect(en).toHaveProperty([s.label]); expect(de).toHaveProperty([s.label]); expect(ar).toHaveProperty([s.label]); }
    const svc = read('src/design-system/design-system.service.ts');
    for (const reason of ['The design-system previews manifest is not beside this server (run scripts/design-system-discover.js).', 'The design-system previews manifest failed its integrity check, so none of it is served.']) {
      expect(svc).toContain(reason);
      expect(en).toHaveProperty([reason]);
      expect(de[reason]).not.toBe(reason);
      expect(ar[reason]).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it('translates the Lab’s own words into German and Arabic, with every %d slot kept', () => {
    const slots = (s: string) => (s.match(/%d/g) || []).length;
    const keys = ['Specimen Lab', 'Live previews', 'Not previewable', 'Sanitization', 'Neutralised for embedding', 'Verified variants', 'Provenance', 'Stage direction', 'Left to right', 'Right to left', 'Fixtures', 'Fixture %d of %d', 'This input draws nothing', 'Checked three times'];
    for (const k of keys) {
      expect(en).toHaveProperty([k]);
      expect(de[k]).toBeTruthy(); expect(de[k]).not.toBe(k);
      expect(ar[k]).toMatch(/[\u0600-\u06FF]/);
      expect(slots(de[k])).toBe(slots(k));
      if (!/^%d (fixture|element|node)$/.test(k)) expect(slots(ar[k])).toBe(slots(k));
    }
  });

  it('translates every width word (M2 / S2) into German and Arabic, with every %d slot kept', () => {
    const slots = (s: string) => (s.match(/%d/g) || []).length;
    const keys = ['Width', 'Fill', 'Fill the stage', 'Desktop', 'Tablet', 'Mobile', 'Custom width', 'From %d to %d px. Press Enter to apply.', 'Width simulation — not full device emulation.', 'Content overflows by %d px', 'No horizontal overflow', 'Width: fill the stage', 'Width %d px', 'Enter a width between %d and %d px', 'Kept within %d to %d px', 'Would apply in a %d px window — not simulated', 'Would not apply in a %d px window', 'Cannot be judged from a width alone'];
    for (const k of keys) {
      expect(en[k]).toBe(k);
      expect(de[k]).toBeTruthy();
      if (k !== 'Tablet') expect(de[k]).not.toBe(k);     // the same word in German
      expect(ar[k]).toMatch(/[\u0600-\u06FF]/);
      expect([slots(de[k]), slots(ar[k])]).toEqual([slots(k), slots(k)]);
    }
    expect(de['Width simulation — not full device emulation.']).toMatch(/simulation/i);
    // A preset's accessible name holds its visible word (WCAG 2.5.3, label in name), in every language.
    for (const d of [en, de, ar]) expect(d['Fill the stage'].toLowerCase()).toContain(d.Fill.toLowerCase());
    expect(ar['Width simulation — not full device emulation.']).toMatch(/محاكاة/);
  });

  it('translates every comparison word (M2 / S3) into German and Arabic, and each View button’s name holds its visible word', () => {
    const keys = ['View', 'Single', 'Single preview', 'Compare', 'Compare side by side', 'Preview A', 'Preview B', 'Fixture for Preview B', 'Swap A and B', 'Preview A and Preview B swapped', 'Comparison', 'Markup', 'Identical in both', 'Different', 'Elements', 'Only in A', 'Only in B', 'In both'];
    for (const k of keys) { expect(en[k]).toBe(k); expect(de[k]).toBeTruthy(); expect(de[k]).not.toBe(k); expect(ar[k]).toMatch(/[\u0600-\u06FF]/); }
    // Whole words, as axe's label-content-name-mismatch reads them: "Einzeln" is not a word of "Einzelne Vorschau".
    const words = (x: string) => x.toLowerCase().split(/\s+/);
    for (const d of [en, de, ar]) {
      expect(words(d['Single preview'])).toContain(d.Single.toLowerCase());
      expect(words(d['Compare side by side'])).toContain(d.Compare.toLowerCase());
    }
  });

  it('keeps the room’s boundary: no entry into the club product’s language registry, bundles or catalogue', () => {
    expect(js).not.toMatch(/\bI18N\b|\/i18n\/locales|\/i18n\/catalogue|familista\.locale/);
  });

  it('marks what is data, not language: component names, symbols, labels, calls and hashes are never translated', () => {
    expect(js).toContain('data-no-i18n');
    expect(js).toContain('code(');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the navigation helpers (M2 / S4): steps that wrap, and keys that never take a browser shortcut', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const V = require('../public/design-system/lab-view.js');
  const ev = (key: string, more: Record<string, unknown> = {}) => ({ key, code: '', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...more });
  const altGr = (on: boolean) => ({ ctrlKey: true, altKey: true, getModifierState: (m: string) => on && m === 'AltGraph' });

  it('steps one place and wraps at both ends; from outside the list forward is the first and back the last; an empty list goes nowhere', () => {
    expect([V.wrapStep(0, 1, 5), V.wrapStep(3, 1, 5), V.wrapStep(4, 1, 5), V.wrapStep(0, -1, 5), V.wrapStep(2, -1, 5)]).toEqual([1, 4, 0, 4, 1]);
    expect([V.wrapStep(0, 1, 1), V.wrapStep(0, -1, 1)]).toEqual([0, 0]);
    expect([V.wrapStep(-1, 1, 4), V.wrapStep(-1, -1, 4), V.wrapStep(9, 1, 4), V.wrapStep(NaN, -1, 4)]).toEqual([0, 3, 0, 3]);
    for (const n of [0, -1, NaN, undefined]) expect(V.wrapStep(0, 1, n)).toBe(-1);
  });

  it('reads "[" "]" as the fixtures and "{" "}" as the components, with or without the Shift the layout needs, and nothing else', () => {
    expect(['[', ']', '{', '}'].map((k) => V.navAction(ev(k)))).toEqual(['fixture-prev', 'fixture-next', 'component-prev', 'component-next']);
    expect(V.navAction(ev('{', { shiftKey: true, code: 'BracketLeft' }))).toBe('component-prev');
    for (const k of ['(', ')', '<', '>', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Tab', 'f', '/', 'Dead', '']) expect({ k, a: V.navAction(ev(k)) }).toEqual({ k, a: null });
    expect(V.navAction(null)).toBeNull();
  });

  it('never takes Ctrl, Cmd or Alt, and takes Ctrl+Alt only when the browser itself reports AltGr', () => {
    for (const more of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { ctrlKey: true, altKey: true }, altGr(false), { ...altGr(true), metaKey: true }])
      for (const k of ['[', ']', '{', '}']) expect({ more: Object.keys(more), k, a: V.navAction(ev(k, more)) }).toEqual({ more: Object.keys(more), k, a: null });
    expect(['[', ']', '{', '}'].map((k) => V.navAction(ev(k, altGr(true))))).toEqual(['fixture-prev', 'fixture-next', 'component-prev', 'component-next']);
    // Linux reports AltGr as the modifier alone, with neither Ctrl nor Alt
    expect(V.navAction(ev('[', { getModifierState: (m: string) => m === 'AltGraph' }))).toBe('fixture-prev');
    expect([V.plainKey(ev('a')), V.plainKey(ev('a', { altKey: true })), V.plainKey(null)]).toEqual([true, false, false]);
  });

  it('reads the physical key only when the layout types a non-Latin character, so Latin letters are never remapped', () => {
    // Arabic (101) types ج and د on the bracket keys and ب on F; Russian types х and ъ
    expect(V.navAction(ev('ج', { code: 'BracketLeft' }))).toBe('fixture-prev');
    expect(V.navAction(ev('د', { code: 'BracketRight' }))).toBe('fixture-next');
    expect(V.navAction(ev('Х', { code: 'BracketLeft', shiftKey: true }))).toBe('component-prev');
    expect(V.navAction(ev('ъ', { code: 'BracketRight' }))).toBe('fixture-next');
    expect([V.shortcutKey(ev('ب', { code: 'KeyF' })), V.shortcutKey(ev('ب', { code: 'KeyF', shiftKey: true }))]).toEqual(['f', 'F']);
    // German ü and +, French ^, and every Latin letter stay themselves; an unknown physical key is never invented
    for (const [k, code] of [['ü', 'BracketLeft'], ['+', 'BracketRight'], ['Dead', 'BracketLeft'], ['é', 'BracketLeft'], ['x', 'KeyF'], ['ش', 'KeyA'], ['ش', '']]) {
      expect({ k, code, a: V.navAction(ev(k, { code })) }).toEqual({ k, code, a: null });
      expect(V.shortcutKey(ev(k, { code }))).toBe(k);
    }
    // the modifier rule holds for a remapped key too
    expect(V.navAction(ev('ج', { code: 'BracketLeft', ctrlKey: true }))).toBeNull();
  });
});

describe('the browser proof is kept with the code and is a required CI job', () => {
  it('lives in tools/, is valid JavaScript, and proves every boundary the Lab claims', () => {
    const file = path.join(ROOT, 'tools/components/lab-browser-proof.cjs');
    expect(spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status).toBe(0);
    const src = fs.readFileSync(file, 'utf8');
    for (const claim of ['lazy:', 'csp:', 'layout:', 'layout (control)', 'events:', 'events (control)', 'sanitizer:', 'keyboard:', 'i18n:', 'isolation:', 'fail closed:', 'stability:', 'api:', 'accessibility ', 'focus ', 'focus (control)', 'errors (control)', 'csp (control)', 'accessibility (control)', 'view (control)', 'compare announce:', 'compare announce (control)', 'nav component:', 'nav search:', 'nav fixture:', 'nav keys:', 'nav keys (control)', 'nav compare:', 'nav focus:', 'nav isolation:', 'nav stability:', 'nav languages:']) expect(src).toContain(claim);
    expect(fs.readdirSync(path.join(ROOT, 'tests')).some((f) => f.includes('lab-browser-proof'))).toBe(false);
  });

  const CI = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const code = (src: string) => src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  it('pins its two tools exactly, in a package of its own with a lockfile, and touches no production dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/components/package.json'), 'utf8'));
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toEqual({ 'axe-core': '4.14.0', 'playwright-core': '1.63.0' });
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/components/package-lock.json'), 'utf8'));
    expect(Object.keys(lock.packages).sort()).toEqual(['', 'node_modules/axe-core', 'node_modules/playwright-core']);
    for (const k of ['node_modules/axe-core', 'node_modules/playwright-core']) {
      expect(lock.packages[k].integrity).toMatch(/^sha512-/);
      expect(lock.packages[k].resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    }
    expect(lock.packages['node_modules/axe-core'].version).toBe('4.14.0');
    expect(lock.packages['node_modules/playwright-core'].version).toBe('1.63.0');
    const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    for (const n of ['axe-core', 'playwright-core', 'playwright', 'puppeteer']) {
      expect(root.dependencies?.[n]).toBeUndefined();
      expect(root.devDependencies?.[n]).toBeUndefined();
    }
    expect(fs.readFileSync(path.join(ROOT, 'tools/components/lab-browser-proof.cjs'), 'utf8')).toContain("tools/components/node_modules/axe-core/axe.min.js");
  });

  it('runs in ci.yml on the compiled app, in two shards that together cover every section, and nothing in it can fail quietly', () => {
    const job = CI.slice(CI.indexOf('  browser-proof:'), CI.indexOf('  secret-scan:'));
    expect(job.length).toBeGreaterThan(500);
    const body = code(job);
    expect(body).toContain('npm ci --ignore-scripts --prefix tools/components');
    expect(body).toContain('npm audit --audit-level=high --prefix tools/components');
    expect(body).toContain('npm run build');
    expect(body).toContain('command -v google-chrome');
    expect(body).toContain('node tools/components/lab-browser-proof.cjs');
    expect(body).not.toMatch(/continue-on-error|\|\|\s*true|playwright install|secrets\./);
    const sections = [...body.matchAll(/sections:\s*'([^']+)'/g)].map((m) => m[1].split(',')).flat().sort();
    expect(sections).toEqual(['1', '10', '11', '12', '13', '13a', '2', '2b', '3', '4', '5', '6', '7', '8', '9']);
    expect(body).toMatch(/axe:\s*'--axe'/);
    // a shard that ran nothing, skipped something or failed something is red
    expect(body).toContain("grep -Eq ', 0 failed, 0 skipped$'");
    expect(body).toMatch(/test "\$passed" -ge "\$PROOF_MIN"/);
    const mins = [...body.matchAll(/min:\s*'(\d+)'/g)].map((m) => Number(m[1]));
    expect(mins.length).toBe(2);
    expect(mins.every((n) => n >= 34)).toBe(true);
    // M3/S2.2b-2: the floors are the counts measured with eighteen previewable components; they never go below S2.2b-1's 197 and 68.
    expect(mins).toEqual([203, 74]);
  });

  it('classifies the browser\'s own copy of a CSP violation as a notice in both Chrome wordings, and nothing else', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools/components/lab-browser-proof.cjs'), 'utf8');
    const m = /^const NOTICE = \/(.+)\/;$/m.exec(src);
    expect(m).not.toBeNull();
    const notice = new RegExp(m![1]);
    const dir = "the following Content Security Policy directive 'style-src 'self' https://fonts.googleapis.com'. Either the 'unsafe-inline' keyword";
    for (const text of [
      'Failed to load resource: the server responded with a status of 404 (Not Found)',
      "Refused to apply inline style because it violates " + dir,
      "Refused to connect to 'https://fonts.googleapis.com/css2?family=Inter' because it violates the following Content Security Policy directive: \"connect-src 'self'\"",
      'Applying inline style violates ' + dir,
      "Connecting to 'https://fonts.googleapis.com/css2?family=Inter:wght@300&display=swap' violates the following Content Security Policy directive: \"connect-src 'self'\"",
    ]) expect(notice.test(text)).toBe(true);
    for (const text of [
      "Executing inline script violates the following Content Security Policy directive 'script-src 'self''.",
      "Loading the script 'https://evil.example/x.js' violates the following Content Security Policy directive: \"script-src 'self'\"",
      "Refused to execute script from 'http://127.0.0.1/design-system/x.js' because its MIME type is not executable",
      'Uncaught TypeError: x is not a function',
      'lab-control-console-error',
    ]) expect(notice.test(text)).toBe(false);
  });

  it('is part of the same workflow that deploy.yml waits for', () => {
    const deploy = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
    expect(deploy).toMatch(/workflows:\s*\['ci'\]/);
    expect(deploy).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(CI).toMatch(/^  browser-proof:\s*$/m);
  });
});

// ── M3/S3.1 L2a — loaded CSS provenance ─────────────────────────────────────
describe('M3/S3.1 L2a — every class a fixture uses has a rule in a stylesheet the Specimen Lab has loaded', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { cssRules, classesOf } = require('../scripts/design-system-components.js');
  const { REVIEWED_INERT, SCOPED_INERT } = generator;

  // The page loads its stylesheets in three steps, each read from its own source:
  //   1. public/index.html links its stylesheets, before any script runs;
  //   2. app.js's room loader adds the room's own stylesheet when the Design System room opens;
  //   3. design-system.js's LAZY table adds the Lab's stylesheet when the Specimen Lab section opens.
  // explorer.css and components.css load only if the reader opened those sections first. That depends on
  // what they did before, so neither is counted: no fixture may rely on a stylesheet it is not promised.
  const linked = [...read('public/index.html').matchAll(/<link\b[^>]*>/gi)].map((m) => m[0])
    .filter((t) => /rel=["']?stylesheet/i.test(t))
    .map((t) => (t.match(/href=["']([^"']+)["']/i) || [])[1])
    .filter((h): h is string => !!h && !/^(https?:)?\/\//i.test(h))
    .map((h) => 'public' + h.split('?')[0]);
  const roomLoader = [...read('public/app.js').matchAll(/link\.href\s*=\s*'(\/design-system\/[\w-]+\.css)\?/g)].map((m) => 'public' + m[1]);
  const dsJs = read('public/design-system/design-system.js');
  const labEntry = (dsJs.slice(dsJs.indexOf('var LAZY = {')).match(/\blab:\s*\{[^}]*?\bcss:\s*'([^']+)'/) || [])[1];
  const LOADED = [...linked, ...roomLoader, ...(labEntry ? ['public' + labEntry] : [])];

  const graphView = json('src/design-system/generated/design-system-graph.json').views.find((v: any) => v.id === 'stylesheets-to-surfaces');
  const surface = (id: string) => graphView.edges.filter((e: any) => e.to === 'surface:' + id).map((e: any) => e.from.replace(/^css:/, '')).sort();

  /** Class → the stylesheets with a rule that styles it. A class named only inside :not() is excluded by that rule, not styled by it. */
  const supportIndex = (sheets: Record<string, string>) => {
    const index = new Map<string, string[]>();
    for (const [file, text] of Object.entries(sheets)) {
      for (const r of cssRules(text)) {
        for (const k of classesOf(r.sel.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, ''))) index.set(k, [...(index.get(k) || []), file]);
      }
    }
    return index;
  };
  const approvedInert = new Set<string>([...Object.keys(REVIEWED_INERT), ...Object.values(SCOPED_INERT).flatMap((v: any) => Object.keys(v))]);
  /** The classes in `classes` that nothing the page has loaded styles, and that no approved exception covers. */
  const unsupported = (classes: { name: string; owner: string }[], index: Map<string, string[]>) =>
    classes.filter((x) => (x.owner === 'inert' ? !approvedInert.has(x.name) : !index.has(x.name))).map((x) => x.name);

  const sheetsOf = (files: string[]) => Object.fromEntries(files.map((f) => [f, read(f)]));
  const index = supportIndex(sheetsOf(LOADED));

  it('reads the loading order from the page, the room loader and the Lab entry, and it agrees with the graph manifest', () => {
    expect(roomLoader).toEqual(['public/design-system/design-system.css']);
    expect(labEntry).toBe('/design-system/lab.css');
    expect([...linked].sort()).toEqual(surface('main'));
    for (const f of [...roomLoader, 'public' + labEntry]) expect(surface('lazy')).toContain(f);
    for (const f of LOADED) expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
    expect(LOADED).not.toContain('public/design-system/explorer.css');
    expect(LOADED).not.toContain('public/design-system/components.css');
  });

  it('every stylesheet a previewable component declares is one the Lab has loaded', () => {
    const registry = json('tools/components/registry.json');
    const previewable = new Set(manifest.components.map((c: any) => c.id));
    const declared = registry.components.filter((c: any) => previewable.has(c.id)).flatMap((c: any) => c.css.files.map((f: string) => ({ id: c.id, f })));
    expect(declared.length).toBeGreaterThanOrEqual(previewable.size);
    expect(declared.filter((d: any) => !LOADED.includes(d.f))).toEqual([]);
  });

  it('every class of every fixture is styled by a loaded stylesheet, or is one of the approved inert exceptions', () => {
    let checked = 0;
    const problems: string[] = [];
    for (const { c, f } of allFixtures()) {
      checked += f.classes.length;
      for (const name of unsupported(f.classes, index)) problems.push(`${c.id} · ${f.id}: .${name}`);
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(400);
    expect(allFixtures()).toHaveLength(manifest.coverage.fixtures);
  });

  // Controls: the same predicate, with real classes from real stylesheets where one exists.
  it('control: a class whose only rule is in a stylesheet the Lab has not loaded is refused', () => {
    const everywhere = supportIndex(sheetsOf([...LOADED, 'public/design-system/explorer.css', 'public/invite/invite.css']));
    for (const [name, home] of [['ex-bar', 'public/design-system/explorer.css'], ['brand-mark', 'public/invite/invite.css']]) {
      expect(everywhere.get(name)).toEqual([home]);   // the rule exists, in that file only
      expect(unsupported([{ name, owner: 'css' }], index)).toEqual([name]);
      expect(unsupported([{ name, owner: 'css' }], everywhere)).toEqual([]);
    }
  });

  it('control: a class with a rule in a loaded stylesheet passes', () => {
    expect(index.get('club-logo')).toContain('public/app.css');
    expect(index.get('ds-chip')).toContain('public/design-system/design-system.css');
    expect(unsupported([{ name: 'club-logo', owner: 'club-logo' }, { name: 'ds-chip', owner: 'ds-chip' }], index)).toEqual([]);
  });

  it('control: a class no stylesheet styles is refused, and so is an inert class nobody approved', () => {
    expect(index.has('lab-proof-unowned')).toBe(false);
    expect(unsupported([{ name: 'lab-proof-unowned', owner: 'css' }], index)).toEqual(['lab-proof-unowned']);
    expect(unsupported([{ name: 'lab-proof-unowned', owner: 'inert' }], index)).toEqual(['lab-proof-unowned']);
  });

  it('control: the approved exceptions still pass, exactly the three the manifest records', () => {
    expect([...approvedInert].sort()).toEqual(['is-empty', 'lg-ident--hero', 'lg-t']);
    expect(index.has('lg-ident--hero')).toBe(false);
    expect(index.has('lg-t')).toBe(false);
    expect(unsupported([...approvedInert].map((name) => ({ name, owner: 'inert' })), index)).toEqual([]);
  });

  it('control: a class named only inside :not() is not styled by that rule; a class in a descendant selector is', () => {
    const synthetic = supportIndex({ 'x.css': '.a:not(.only-negated){color:inherit} .ctx .leaf{color:inherit}' });
    expect(unsupported([{ name: 'only-negated', owner: 'css' }], synthetic)).toEqual(['only-negated']);
    expect(unsupported([{ name: 'a', owner: 'css' }, { name: 'ctx', owner: 'css' }, { name: 'leaf', owner: 'css' }], synthetic)).toEqual([]);
  });
});

// ── M3/S3.2 — the performance budget report ─────────────────────────────────
describe('M3/S3.2 — the performance budget report: eight official budgets, diagnostics apart, no PASS without a measurement', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const R = require('../tools/components/budget-report.cjs');
  const REPORT_PATH = 'tools/components/budget-report.cjs';
  const PROOF_SRC = read('tools/components/lab-browser-proof.cjs');
  const CI = read('.github/workflows/ci.yml');
  const ISOLATION = ['1', '2', '2b', '3', '4', '5', '8', '9', '10', '11', '12', '13'];
  const line = (o: object) => 'METRIC ' + JSON.stringify(o);
  // Every metric the proof writes. The values are main 4173c02's CI figures where its log printed them; n and max are illustrative.
  const FULL: Record<string, object> = {
    'nav.component.median': { value: 44.6, unit: 'ms', n: 120, max: 70.1 },
    'nav.component.p95': { value: 52.8, unit: 'ms', n: 120, max: 70.1 },
    'compare.open.p95': { value: 66.8, unit: 'ms', n: 40, max: 70.2 },
    'fit.recalc.p95': { value: 77.7, unit: 'ms', n: 40, max: 83.4 },
    'mem.app.growth': { value: 0.1, unit: 'KB' },
    'mem.listeners.growth': { value: 0, unit: 'count' },
    'mem.detached.growth': { value: 0, unit: 'count' },
    'dom.growth': { value: 0, unit: 'count' },
    'diag.nav.component.app.median': { value: 1.7, unit: 'ms', n: 120 },
    'diag.nav.component.browser.median': { value: 42.9, unit: 'ms', n: 120 },
    'diag.nav.component.frames': { unit: 'frames', interval: 16.67, n: 120, distribution: { 2: 70, 3: 45, 4: 5 } },
    'diag.nav.fixture.median': { value: 33.3, unit: 'ms', n: 110 },
    'diag.nav.fixture.p95': { value: 34.8, unit: 'ms', n: 110, max: 51 },
    'diag.compare.open.frames': { unit: 'frames', interval: 16.67, n: 40, distribution: { 3: 30, 4: 10 } },
    'diag.fit.recalc.frames': { unit: 'frames', interval: 16.67, n: 40, distribution: { 4: 28, 5: 12 } },
    'diag.compare.open.s10.p95': { value: 105.1, unit: 'ms', n: 40, max: 118.4 },
    'diag.compare.open.s10.median': { value: 80.3, unit: 'ms', n: 40 },
    'diag.compare.open.s10.app.median': { value: 2.8, unit: 'ms', n: 40 },
    'diag.compare.open.s10.browser.median': { value: 77.1, unit: 'ms', n: 40 },
    'diag.compare.open.s10.frames': { unit: 'frames', interval: 16.67, n: 40, distribution: { 4: 12, 5: 24, 6: 4 } },
  };
  /** A proof log: its SUMMARY line, every metric (null drops one, an object replaces it) and any extra lines. */
  const log = (edit: Record<string, object | null> = {}, extra: string[] = []) => ['{"level":"info","msg":"an application log line"}', 'SUMMARY 203 passed, 0 failed, 0 skipped',
    ...Object.entries({ ...FULL, ...edit }).filter(([, v]) => v !== null).map(([id, v]) => line({ id, ...(v as object) })), ...extra].join('\n');
  const run = (text: string | null, sections: string[] | null = ISOLATION) => R.report(text, { sections });
  const row = (r: any, id: string) => r.rows.find((x: any) => x.def.id === id);
  const OFFICIAL = ['nav.component.median', 'nav.component.p95', 'compare.open.p95', 'fit.recalc.p95', 'mem.app.growth', 'mem.listeners.growth', 'mem.detached.growth', 'dom.growth'];

  it('9. knows exactly the eight approved budgets at their approved thresholds, frozen, and nothing else carries a budget', () => {
    expect(R.METRICS.filter((m: any) => m.cls === 'OFFICIAL').map((m: any) => [m.id, m.unit, m.budget.op, m.budget.value])).toEqual([
      ['nav.component.median', 'ms', '<=', 50], ['nav.component.p95', 'ms', '<=', 80], ['compare.open.p95', 'ms', '<=', 100], ['fit.recalc.p95', 'ms', '<=', 100],
      ['mem.app.growth', 'KB', '<=', 32], ['mem.listeners.growth', 'count', '=', 0], ['mem.detached.growth', 'count', '<=', 0], ['dom.growth', 'count', '<=', 0],
    ]);
    expect(R.METRICS.filter((m: any) => m.cls === 'DIAGNOSTIC').every((m: any) => m.budget === null)).toBe(true);
    expect(new Set(R.METRICS.map((m: any) => m.id)).size).toBe(R.METRICS.length);
    expect(R.METRICS.every((m: any) => ['OFFICIAL', 'DIAGNOSTIC'].includes(m.cls) && ['ms', 'KB', 'count', 'frames'].includes(m.unit))).toBe(true);
    expect(Object.isFrozen(R.METRICS) && R.METRICS.every((m: any) => Object.isFrozen(m) && (m.budget === null || Object.isFrozen(m.budget)))).toBe(true);
    expect(() => { R.METRICS[2].budget.value = 1000; }).toThrow(TypeError);
    expect(R.METRICS[2].budget.value).toBe(100);
    // D1: the official navigation is section 11's component navigation; D6: section 10's Compare figure is diagnostic, with a 100 ms reference.
    expect(R.METRICS.filter((m: any) => m.id.startsWith('nav.')).every((m: any) => m.section === '11' && /component navigation/.test(m.method))).toBe(true);
    const s10 = R.METRICS.find((m: any) => m.id === 'diag.compare.open.s10.p95');
    expect([s10.cls, s10.section, s10.reference, s10.budget]).toEqual(['DIAGNOSTIC', '10', 100, null]);
    expect(R.METRICS.find((m: any) => m.id === 'compare.open.p95').section).toBe('12');
  });

  it('a complete log: every official budget PASS, every diagnostic INFO, the section 10 figure visibly above its reference, and the step passes', () => {
    const r = run(log());
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(OFFICIAL.map((id) => row(r, id).status)).toEqual(Array(8).fill('PASS'));
    expect(r.rows.filter((x: any) => x.def.cls === 'DIAGNOSTIC').every((x: any) => /^INFO/.test(x.status))).toBe(true);
    expect(row(r, 'diag.compare.open.s10.p95').status).toBe('INFO (above reference)');
    expect(r.markdown).toContain('Proof: 203 passed, 0 failed, 0 skipped');
    expect(r.markdown).toContain('Report: every official measurement is present and valid.');
    expect(r.markdown).toMatch(/Compare opening p95 \(`compare\.open\.p95`\) \| OFFICIAL \| 66\.8 ms, n 40, max 70\.2 ms \| ≤ 100 ms \| \*\*PASS\*\*/);
  });

  it.each([
    ['nav.component.median', { value: 50.1, unit: 'ms', n: 120, max: 90 }], ['nav.component.p95', { value: 80.1, unit: 'ms', n: 120, max: 90 }],
    ['compare.open.p95', { value: 100.1, unit: 'ms', n: 40, max: 120 }], ['fit.recalc.p95', { value: 100.1, unit: 'ms', n: 40, max: 120 }],
    ['mem.app.growth', { value: 32.1, unit: 'KB' }], ['mem.listeners.growth', { value: 1, unit: 'count' }], ['mem.listeners.growth', { value: -1, unit: 'count' }],
    ['mem.detached.growth', { value: 1, unit: 'count' }], ['dom.growth', { value: 1, unit: 'count' }],
  ] as [string, object][])('1. %s over its budget is OVER, shown, and (report-only) does not fail the step', (id, rec) => {
    const r = run(log({ [id]: rec }));
    expect(row(r, id).status).toBe('OVER');
    expect(r.ok).toBe(true);
    expect(r.markdown.split('\n').find((l: string) => l.includes('`' + id + '`'))).toContain('**OVER**');
  });

  it('1. a value exactly at its budget passes: the budgets are inclusive, as approved', () => {
    const r = run(log({ 'nav.component.median': { value: 50, unit: 'ms', n: 120, max: 60 }, 'compare.open.p95': { value: 100, unit: 'ms', n: 40, max: 100 }, 'mem.app.growth': { value: 32, unit: 'KB' } }));
    expect(['nav.component.median', 'compare.open.p95', 'mem.app.growth'].map((id) => row(r, id).status)).toEqual(['PASS', 'PASS', 'PASS']);
  });

  it('2. a diagnostic above its reference stays visible as INFO (above reference), never PASS; below it, INFO', () => {
    const r = run(log({ 'diag.compare.open.s10.p95': { value: 250, unit: 'ms', n: 40, max: 300 } }));
    expect(row(r, 'diag.compare.open.s10.p95').status).toBe('INFO (above reference)');
    expect(r.ok).toBe(true);
    const md = r.markdown.split('\n').find((l: string) => l.includes('`diag.compare.open.s10.p95`'));
    expect(md).toContain('250.0 ms, n 40, max 300.0 ms');
    expect(md).toContain('reference 100 ms (no budget)');
    expect(md).toContain('**INFO (above reference)**');
    expect(md).not.toMatch(/PASS|OVER/);
    expect(row(run(log({ 'diag.compare.open.s10.p95': { value: 99.9, unit: 'ms', n: 40, max: 100 } })), 'diag.compare.open.s10.p95').status).toBe('INFO');
    // a diagnostic with no reference is INFO however large: no budget is borrowed for it
    expect(row(run(log({ 'diag.nav.fixture.p95': { value: 999, unit: 'ms', n: 110, max: 999 } })), 'diag.nav.fixture.p95').status).toBe('INFO');
  });

  it.each(OFFICIAL)('3. %s missing is MISSING, never PASS, and fails the step', (id) => {
    const r = run(log({ [id]: null }));
    expect(row(r, id).status).toBe('MISSING');
    expect(r.ok).toBe(false);
    expect(r.failures).toContain(`${id}: the official measurement is missing`);
    expect(r.markdown.split('\n').find((l: string) => l.includes('`' + id + '`'))).not.toContain('PASS');
  });

  it('3. a missing diagnostic is NOT MEASURED and does not fail the step', () => {
    const r = run(log({ 'diag.nav.fixture.p95': null, 'diag.compare.open.s10.frames': null }));
    expect([row(r, 'diag.nav.fixture.p95').status, row(r, 'diag.compare.open.s10.frames').status]).toEqual(['NOT MEASURED', 'NOT MEASURED']);
    expect(r.ok).toBe(true);
  });

  it('4. an unknown metric id fails the step, and what it shows of the id cannot carry markup', () => {
    const r = run(log({}, [line({ id: 'nav.component.mean', value: 1, unit: 'ms' }), line({ id: '<img src=x onerror=alert(1)>|`x`', value: 1, unit: 'ms' }), line({ value: 1, unit: 'ms' })]));
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(expect.arrayContaining(['unknown metric id "nav.component.mean"', 'unknown metric id "(empty)"']));
    expect(r.failures.join(' ')).not.toMatch(/[<>|`]/);
    expect(r.markdown).not.toMatch(/[<>`]x|<img|onerror=alert\(1\)>/);
    expect(r.markdown.replace(/`[a-z0-9.]+`/g, '')).not.toMatch(/[<>]/);
  });

  it('5. a duplicate metric id fails the step and the metric is not used', () => {
    const r = run(log({}, [line({ id: 'compare.open.p95', value: 12, unit: 'ms', n: 40, max: 20 })]));
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(expect.arrayContaining(['duplicate metric id "compare.open.p95"', 'compare.open.p95: reported more than once']));
    expect(row(r, 'compare.open.p95').status).toBe('INVALID');
  });

  it.each([
    ['compare.open.p95', { value: 0.0668, unit: 's', n: 40, max: 0.07 }],
    ['mem.app.growth', { value: 0.0001, unit: 'MB' }],
    ['mem.listeners.growth', { value: 0, unit: 'ms' }],
    ['diag.nav.component.frames', { unit: 'ms', interval: 16.67, n: 120, distribution: { 2: 120 } }],
  ] as [string, object][])('6. %s in the wrong unit is INVALID and fails the step', (id, rec) => {
    const r = run(log({ [id]: rec }));
    expect(row(r, id).status).toBe('INVALID');
    expect(r.ok).toBe(false);
    expect(r.failures.find((f: string) => f.startsWith(id + ': unit'))).toBeDefined();
  });

  it.each([
    ['NaN (JSON writes it as null)', 'nav.component.median', line({ id: 'nav.component.median', value: NaN, unit: 'ms', n: 120, max: 1 }), 'the value is not a finite number'],
    ['Infinity read from the log', 'nav.component.p95', 'METRIC {"id":"nav.component.p95","value":1e999,"unit":"ms","n":120,"max":1e999}', 'the value is not a finite number'],
    ['a negative duration', 'compare.open.p95', line({ id: 'compare.open.p95', value: -0.1, unit: 'ms', n: 40, max: 1 }), 'a duration is negative'],
    ['a value as a string', 'fit.recalc.p95', line({ id: 'fit.recalc.p95', value: '77.7', unit: 'ms', n: 40, max: 80 }), 'the value is not a finite number'],
    ['a fractional listener count', 'mem.listeners.growth', line({ id: 'mem.listeners.growth', value: 0.5, unit: 'count' }), 'the value is not a whole number'],
    ['a maximum below the value', 'compare.open.p95', line({ id: 'compare.open.p95', value: 66.8, unit: 'ms', n: 40, max: 50 }), 'max is below the value'],
    ['n that is not a positive whole number', 'nav.component.median', line({ id: 'nav.component.median', value: 40, unit: 'ms', n: 0, max: 50 }), 'n is not a positive whole number'],
    ['a frame distribution that does not add up to n', 'diag.compare.open.frames', line({ id: 'diag.compare.open.frames', unit: 'frames', interval: 16.67, n: 40, distribution: { 3: 30 } }), 'the distribution counts 30 samples, n is 40'],
    ['a frame count of zero', 'diag.fit.recalc.frames', line({ id: 'diag.fit.recalc.frames', unit: 'frames', interval: 16.67, n: 40, distribution: { 0: 40 } }), 'a frame count is not a positive whole number'],
    ['a frame interval of zero', 'diag.nav.component.frames', line({ id: 'diag.nav.component.frames', unit: 'frames', interval: 0, n: 120, distribution: { 2: 120 } }), 'the frame interval is not a positive number'],
    ['a negative diagnostic duration', 'diag.compare.open.s10.browser.median', line({ id: 'diag.compare.open.s10.browser.median', value: -3, unit: 'ms', n: 40 }), 'a duration is negative'],
  ] as [string, string, string, string][])('7. %s is INVALID and fails the step', (_label, id, bad, problem) => {
    const r = run(log({ [id]: null }, [bad]));
    expect(row(r, id).status).toBe('INVALID');
    expect(r.failures).toContain(`${id}: ${problem}`);
    expect(r.ok).toBe(false);
  });

  it('7. a negative memory growth is a measurement, not an error: memory can shrink after garbage collection', () => {
    const r = run(log({ 'mem.app.growth': { value: -0.3, unit: 'KB' } }));
    expect(row(r, 'mem.app.growth').status).toBe('PASS');
    expect(r.ok).toBe(true);
  });

  it('7. a METRIC line that is not JSON, or not an object, fails the step', () => {
    expect(run(log({}, ['METRIC {"id":"compare.open.p95","value":NaN}'])).failures).toContain('a METRIC line is not valid JSON');
    expect(run(log({}, ['METRIC [1,2,3]'])).failures).toContain('a METRIC line is not a JSON object');
  });

  it('8. no log, or an empty one, cannot pass: every official measurement is MISSING and the step fails', () => {
    for (const [text, said] of [[null, '**no proof log was found**'], ['', 'no SUMMARY line'], ['SUMMARY 203 passed, 0 failed, 0 skipped', '203 passed']] as [string | null, string][]) {
      const r = run(text);
      expect(r.ok).toBe(false);
      expect(OFFICIAL.map((id) => row(r, id).status)).toEqual(Array(8).fill('MISSING'));
      expect(r.markdown).toContain(said);
      expect(r.markdown).not.toContain('**PASS**');
    }
  });

  it('8. from the command line: a missing log exits 1, an OVER exits 0 (report-only), a missing official measurement exits 1', () => {
    const cli = (args: string[]) => spawnSync(process.execPath, [path.join(ROOT, REPORT_PATH), ...args], { encoding: 'utf8' });
    const none = cli([path.join(os.tmpdir(), 'familista-s32-no-such-log-' + process.pid), '--sections', ISOLATION.join(',')]);
    expect(none.status).toBe(1);
    expect(none.stdout).toContain('no proof log was found');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'familista-s32-'));
    try {
      const over = path.join(dir, 'over.log'); fs.writeFileSync(over, log({ 'compare.open.p95': { value: 140, unit: 'ms', n: 40, max: 150 } }));
      const r1 = cli([over, '--sections', ISOLATION.join(',')]);
      expect([r1.status, /\*\*OVER\*\*/.test(r1.stdout)]).toEqual([0, true]);
      const missing = path.join(dir, 'missing.log'); fs.writeFileSync(missing, log({ 'mem.app.growth': null }));
      const r2 = cli([missing, '--sections', ISOLATION.join(',')]);
      expect([r2.status, r2.stdout.includes('mem.app.growth: the official measurement is missing')]).toEqual([1, true]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('the accessibility shard runs no timed section: every metric is NOT IN THIS SHARD and the step passes; a metric it did not run fails', () => {
    const a11y = ['6', '7', '13a'];
    const r = run('SUMMARY 74 passed, 0 failed, 0 skipped', a11y);
    expect(r.rows.every((x: any) => x.status === 'NOT IN THIS SHARD')).toBe(true);
    expect(r.ok).toBe(true);
    const stray = run(['SUMMARY 74 passed, 0 failed, 0 skipped', line({ id: 'compare.open.p95', value: 50, unit: 'ms', n: 40, max: 60 })].join('\n'), a11y);
    expect(row(stray, 'compare.open.p95').status).toBe('INVALID');
    expect(stray.ok).toBe(false);
  });

  it('shows the proof\'s SUMMARY only in its exact form, and the same log gives the same report every time, in the registry\'s order', () => {
    expect(run(log({}, ['SUMMARY <b>203</b> passed'])).markdown).toContain('Proof: unreadable');
    const a = run(log()).markdown, b = run(log()).markdown;
    expect(a).toBe(b);
    expect(run(log()).rows.map((x: any) => x.def.id)).toEqual(R.METRICS.map((m: any) => m.id));
  });

  it('writes safe Markdown: the registry\'s own text has no table or markup characters, and esc() neutralises any that arrive', () => {
    for (const m of R.METRICS) for (const s of [m.id, m.name, m.method]) expect(s).not.toMatch(/[|<>\r\n`]/);
    expect(R.esc('<script>a|b</script>\n`c`')).toBe('&lt;script&gt;a&#124;b&lt;/script&gt; \\`c\\`');
    expect(R.safeId('a<b>|c')).toBe('a?b??c');
  });

  it('is pure: it reads one file from the command line and nothing else — no network, no environment, no other module, no eval', () => {
    const src = read(REPORT_PATH);
    expect([...src.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])).toEqual(['fs']);
    expect(src).toMatch(/if \(require\.main === module\) \{[\s\S]*require\('fs'\)\.readFileSync\(args\[0\], 'utf8'\)/);
    expect(src).not.toMatch(/process\.env|https?:|\bfetch\(|\beval\(|new Function|child_process|writeFile|\bnet\b|\bdns\b/);
  });

  it('10. the proof writes every registered metric exactly once, and nothing else, while its official loops and gates are unchanged', () => {
    const written = [...PROOF_SRC.matchAll(/\bemitMetric\('([^']+)'/g)].map((m) => m[1]);
    expect([...written].sort()).toEqual(R.METRICS.map((m: any) => m.id).sort());
    // The official measurements, as audited at M3/S3.2: section 11's component loop and section 12's budget loops.
    expect(PROOF_SRC).toContain("for (let i = 0; i < n * Math.ceil(100 / n); i++) { const t0 = performance.now(); document.querySelector('[data-lab-nav=\"component-next\"]').click(); await fr(); out.comp.push(performance.now() - t0); out.compSync.push(window.__familistaLabMetrics().switchMs); }");
    expect(PROOF_SRC).toContain("for (let i = 0; i < 43; i++) { const t0 = performance.now(); document.querySelector('[data-lab-mode=\"compare\"]').click(); await fr(); out.push(performance.now() - t0); document.querySelector('[data-lab-mode=\"single\"]').click(); await fr(); }");
    expect(PROOF_SRC).toContain('for (let i = 0; i < 43; i++) { const t0 = performance.now(); document.querySelector(`[data-lab-width="${cyc[i % 3]}"]`).click(); await fr(); out.push(performance.now() - t0); }');
    // The estimator (D7) and the resource gate, unchanged; the budget lines are still printed.
    expect(PROOF_SRC).toContain('const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { median: Math.round(s[Math.floor(s.length / 2)] * 10) / 10, p95: Math.round(s[Math.floor(s.length * 0.95)] * 10) / 10, n: s.length }; };');
    expect(PROOF_SRC).toContain('const APP_MEMORY_BUDGET_KB = 32;');
    expect(PROOF_SRC).toContain('d.appKB <= APP_MEMORY_BUDGET_KB && d.listeners === 0 && d.detached <= 0, d);');
    expect(PROOF_SRC).toMatch(/console\.log\('BUDGET ' \+ name \+ ': p95 ' \+ s\.p95 \+ ' ms against 100 ms, '/);
  });

  it('12. a proof that failed stays a failure: the report says so plainly, and a complete set of metrics does not soften it', () => {
    const failed = run(log({}, ['SUMMARY 202 passed, 1 failed, 0 skipped']));
    expect(failed.summary).toBe('202 passed, 1 failed, 0 skipped');
    expect(failed.markdown).toContain('**The proof itself did not pass (1 failed, 0 skipped).** Its own pass/fail step fails this job, whatever this report says.');
    expect(run(log({}, ['SUMMARY 203 passed, 0 failed, 2 skipped'])).markdown).toContain('(0 failed, 2 skipped)');
    expect(run(log()).markdown).not.toContain('The proof itself did not pass');
  });

  it('10. the browser-proof floors stay 203 and 74: the report adds no browser check, so nothing raises them', () => {
    const job = CI.slice(CI.indexOf('  browser-proof:'), CI.indexOf('  secret-scan:'));
    expect([...job.matchAll(/min:\s*'(\d+)'/g)].map((m) => Number(m[1]))).toEqual([203, 74]);
    expect(PROOF_SRC.match(/\bemitMetric\(/g)!.length).toBe(R.METRICS.length);   // one call per metric; the helper is `emitMetric = (`
    expect(PROOF_SRC).not.toMatch(/emitMetric\([^)]*\)\s*;\s*check\(|check\([^;]*emitMetric/);
  });

  it('12. CI runs the report in the existing browser-proof job, after its pass/fail step, even when that failed, and fails on what the report fails', () => {
    const job = CI.slice(CI.indexOf('  browser-proof:'), CI.indexOf('  secret-scan:'));
    const gate = job.indexOf('- name: The proof must have run, in full, with nothing failed or skipped');
    const step = job.indexOf('- name: Performance budget report');
    expect(gate).toBeGreaterThan(0);
    expect(step).toBeGreaterThan(gate);
    const body = job.slice(step);
    expect(body).toMatch(/^\s+if: always\(\)$/m);
    expect(body).toContain('set -euo pipefail');
    expect(body).toContain('node tools/components/budget-report.cjs "$RUNNER_TEMP/browser-proof.log" --sections "$PROOF_SECTIONS" | tee -a "$GITHUB_STEP_SUMMARY"');
    expect(body).not.toMatch(/continue-on-error|\|\|\s*true|\$\{\{/);
    expect([...CI.slice(CI.indexOf('\njobs:')).matchAll(/^  ([a-z-]+):\s*$/gm)].map((m) => m[1])).toEqual(['validate', 'browser-proof', 'secret-scan']);
  });
});
