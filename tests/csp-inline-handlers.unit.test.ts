/**
 * tests/csp-inline-handlers.unit.test.ts
 *
 * No inline event handler where the Content-Security-Policy refuses one.
 *
 * Familista's CSP is helmet's defaults merged with src/app.ts. It carries
 * script-src 'self' with no 'unsafe-inline', and script-src-attr 'none'. An
 * on* attribute therefore never runs, in any browser: a button wired that way
 * does nothing, and an image's onerror fallback never falls back.
 *
 * Chrome 156 changed one thing. It now reports such an attribute the moment it
 * is parsed or inserted, where earlier versions reported one only when its
 * event fired. That made three of them visible to the browser proof:
 *   - the player photos' fallback chain (_sqImgTag);
 *   - the backend banner's Retry;
 *   - the onboarding form's Enter-key guard.
 * They are listeners now, wired the way this file already wires the club crest
 * and the other forms.
 *
 * This file holds the line:
 *   1. the CSP still refuses inline handlers;
 *   2. index.html carries none;
 *   3. the three are listeners, and still do what their attributes meant to do;
 *   4. the inline handlers left in app.js may only go down. Every one is in a
 *      legacy club screen and is dead under the CSP today, so it is a
 *      functional backlog, not a CSP exception.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import vm from 'vm';
import helmet from 'helmet';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const APP = read('public/app.js');
const INDEX = read('public/index.html');

/** An on* attribute written inside a tag, in markup or in a markup string. */
const INLINE_HANDLER = /<[a-zA-Z][^<>]*?\son[a-z]+\s*=\s*\\?["']/g;
const count = (src: string) => (src.match(INLINE_HANDLER) || []).length;

/**
 * app.js's legacy inline handlers on the day the Chrome 156 remediation removed the three the browser proof meets.
 * The number may only go down: wire new behaviour with addEventListener or the delegated listeners, never as an attribute.
 */
const APP_INLINE_HANDLER_CEILING = 145;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return /node_modules|vendor/.test(p) ? [] : walk(p);
    return /\.(js|html)$/.test(e.name) ? [p] : [];
  });
}

describe('the CSP refuses inline event handlers', () => {
  it('the policy the server sends carries script-src-attr \'none\', and script-src has no unsafe-inline or unsafe-hashes', () => {
    const src = read('src/app.ts');
    expect(src).not.toMatch(/scriptSrcAttr|unsafe-inline'\]|unsafe-hashes/);
    // helmet's own defaults, which src/app.ts merges with (it does not turn useDefaults off)
    expect(src).not.toMatch(/useDefaults:\s*false/);
    const defaults = helmet.contentSecurityPolicy.getDefaultDirectives();
    expect(defaults['script-src-attr']).toEqual(["'none'"]);
    expect(src).toContain(`scriptSrc:   ["'self'"],`);
  });
});

describe('no inline handler on a page the browser proof meets', () => {
  it('index.html carries no on* attribute at all', () => {
    expect(INDEX.match(INLINE_HANDLER)).toBeNull();
  });

  it('no first-party script outside app.js writes one, and app.js writes no more than it did', () => {
    const per = walk(join(ROOT, 'public')).map((f) => [relative(ROOT, f), count(readFileSync(f, 'utf8'))] as const).filter(([, n]) => n > 0);
    expect(per.filter(([f]) => f !== 'public/app.js')).toEqual([]);
    const app = per.find(([f]) => f === 'public/app.js')?.[1] ?? 0;
    expect(app).toBeLessThanOrEqual(APP_INLINE_HANDLER_CEILING);
  });

  it('negative control: the same scan finds a handler written the way the three were', () => {
    expect(count(`'<button class="retry" onclick="BackendHealth.retryNow()">Retry now</button>'`)).toBe(1);
    expect(count(`<form id="onboard-club-form" onsubmit="return false;">`)).toBe(1);
    // Assembled from parts, as _sqImgTag assembled it, the attribute is still inside the tag the string opens.
    expect(count(`'<img class="' + cls + '" src="' + u + '"' + (sil ? '' : ' onerror="' + onerr + '"') + '>'`)).toBe(1);
    expect(count(`'<img class="x" src="a.png" data-fallbacks="[]">'`)).toBe(0);
  });
});

// ── the three, as listeners ─────────────────────────────────────────────────

const slice = (from: string, to: string) => {
  const a = APP.indexOf(from);
  const b = APP.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`${from} not found`);
  return APP.slice(a, b);
};

describe('the player photo fallback chain', () => {
  const tag = slice('function _sqImgTag(', 'function _sqImgFallback(');
  const fallback = slice('function _sqImgFallback(', 'function _sqPlayerPortrait(');
  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(slice('var _SQ_SILHOUETTE', 'function _sqImgTag(') + tag + fallback
    + 'function _sqEsc(s){return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");}'
    + 'this.tag=_sqImgTag;this.fallback=_sqImgFallback;', sandbox);
  const { tag: imgTag, fallback: run } = sandbox as { tag: (c: string, p: string | null, n: string | null, i: string) => string; fallback: (img: unknown) => void };

  /** A minimal image: its src, its attributes, its classes. */
  function img(fallbacks: string[]) {
    const attrs = new Map<string, string>([['data-fallbacks', JSON.stringify(fallbacks)]]);
    const classes = new Set<string>();
    return {
      src: 'first.png', tagName: 'IMG',
      getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => attrs.set(k, v),
      hasAttribute: (k: string) => attrs.has(k), classList: { add: (c: string) => classes.add(c), contains: (c: string) => classes.has(c) },
      classes,
    };
  }

  it('writes no handler into the markup, and keeps the chain on the element', () => {
    const html = imgTag('sqmd-pimg', null, 'Maran', 'sq-1');
    expect(html).not.toMatch(/\son[a-z]+=/);
    expect(html).toContain('data-fallbacks="');
    expect(html).toContain('src="/players/maran.png"');
    expect(tag).not.toMatch(/onerror|onerr\b/);
  });

  it('walks the chain on each failed load and stops on the silhouette, as the old attribute meant to', () => {
    const el = img(['/players/sq-1.png', 'data:image/svg+xml;charset=utf-8,x']);
    run(el);
    expect([el.src, el.getAttribute('data-fallbacks'), el.classList.contains('is-sil')]).toEqual(['/players/sq-1.png', JSON.stringify(['data:image/svg+xml;charset=utf-8,x']), false]);
    run(el);
    expect([el.src, el.classList.contains('is-sil')]).toEqual(['data:image/svg+xml;charset=utf-8,x', true]);
    const empty = img([]);
    run(empty);
    expect(empty.classList.contains('is-sil')).toBe(true);
    const broken = img([]);
    broken.setAttribute('data-fallbacks', '{not json');
    expect(() => run(broken)).not.toThrow();
    expect(broken.classList.contains('is-sil')).toBe(true);
  });

  it('is run by a capture-phase error listener on the document, only for a chain that has not reached the silhouette', () => {
    // `error` does not bubble; like the club crest's, this listener has to catch it in the capture phase.
    expect(APP).toMatch(/document\.addEventListener\('error', function \(e\) \{\s*var t = e && e\.target;\s*if \(t && t\.tagName === 'IMG' && t\.hasAttribute\('data-fallbacks'\) && !t\.classList\.contains\('is-sil'\)\) _sqImgFallback\(t\);\s*\}, true\);/);
  });
});

describe('the backend banner\'s Retry and the onboarding form', () => {
  it('Retry is a button with no handler attribute, answered by one delegated click listener', () => {
    const show = slice('  function show(text, kind) {', '  function hide() {');
    expect(show).toContain(`'<button class="retry" type="button" data-backend-retry>Retry now</button>'`);
    expect(show).not.toMatch(/onclick/);
    expect(APP).toContain("if (e.target && e.target.closest && e.target.closest('#backend-banner [data-backend-retry]')) retryNow();");
  });

  it('the onboarding form is never submitted by Enter: the delegated submit listener swallows it, as it does the two edit forms', () => {
    expect(INDEX).toContain('<form id="onboard-club-form">');
    expect(APP).toContain("e.target.id === 'player-edit-form' || e.target.id === 'club-edit-form' || e.target.id === 'onboard-club-form')) { e.preventDefault(); return; }");
    // The request is still sent by its own button, which is outside the form and is not a submit button.
    expect(INDEX).toMatch(/<button class="btn btn-primary btn-sm" data-action="submitOnboardClub" type="button">Submit request<\/button>/);
  });
});
