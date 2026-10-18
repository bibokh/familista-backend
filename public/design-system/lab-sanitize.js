/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN SYSTEM CONTROL — SPECIMEN LAB — Stage 3.2.3 M1

   THE ONE SANITIZER

   A fixture is a string of markup that a production render function produced for
   a fixed input. Before it is stored, before it is served and before it is drawn,
   it passes through this file — the same code in all three places:

     build time   scripts/design-system-previews.js parses and checks every fixture
     the server   src/design-system/previews-core.js re-checks them all before it
                  serves one, and refuses the whole manifest on a single failure
     the browser  public/design-system/lab.js checks the markup again and builds the
                  specimen from the checked tree

   WHAT IT DOES NOT DO

   It never hands a string to the browser's HTML parser. The markup is read by the
   small strict parser below into a tree of plain objects; the tree is checked
   against a closed allowlist; and the browser is given that tree to build nodes
   from with createElement, createElementNS, setAttribute and createTextNode. No
   innerHTML, no insertAdjacentHTML, no DOMParser, no template, no eval, no
   Function, no iframe, no srcdoc. Nothing here is executed, only read.

   FAIL CLOSED

   Anything the parser does not recognise is a problem, not something to repair:
   a tag or attribute that is not on the list, an unquoted or single-quoted value,
   a duplicate attribute, a comment, a doctype, a character reference it does not
   know, a control or bidirectional-override character, a URL that is not a small
   image data: URI, a class that does not pass the caller's provenance check, or a
   fixture beyond the size, depth and node limits. A problem makes the whole
   fixture invalid; nothing is partly used.

   NEUTRALISED, NOT HIDDEN

   Three attributes production writes are removed because they would reach into
   the application the specimen sits inside: data-action (the application's
   document-level handlers key on it), data-i18n-aria (its translator keys on it)
   and aria-modal (a live modal in the page would hide the rest of the application
   from a screen reader). Buttons are taken out of the tab order, so a keyboard
   reader is not given controls that do nothing. Every one of these is counted and
   reported; none is silent.
   ───────────────────────────────────────────────────────────────────────────── */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FamilistaLabSanitize = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;

  var LIMITS = {
    bytes: 4096,       // one fixture, as served
    nodes: 300,        // elements and text nodes together
    depth: 12,
    attrsPerElement: 12,
    text: 400,         // one text node
    classTokens: 8,    // per element
    classLength: 64,
    srcLength: 2048,
    value: 200,        // one plain attribute value
  };

  var HTML = 'html';
  var SVG = 'svg';
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // The closed list. Every tag and every attribute below appears in a production
  // fixture; anything else is refused. Reviewed against the 65 golden fixtures.
  var TAGS = {
    div: { ns: HTML, attrs: ['class', 'role', 'aria-hidden', 'aria-label', 'data-action', 'aria-modal'] },
    span: { ns: HTML, attrs: ['class', 'aria-hidden', 'data-lg-size', 'data-club-logo', 'data-user-content'] },
    b: { ns: HTML, attrs: ['class', 'data-user-content'] },
    i: { ns: HTML, attrs: ['class', 'data-user-content', 'aria-hidden', 'data-mc-width'] },
    section: { ns: HTML, attrs: ['class'] },
    header: { ns: HTML, attrs: ['class'] },
    footer: { ns: HTML, attrs: ['class'] },
    h2: { ns: HTML, attrs: ['class'] },
    p: { ns: HTML, attrs: [] },
    table: { ns: HTML, attrs: ['class'] },
    tbody: { ns: HTML, attrs: [] },
    tr: { ns: HTML, attrs: [] },
    td: { ns: HTML, attrs: [] },
    button: { ns: HTML, attrs: ['class', 'type', 'aria-label', 'data-action', 'data-i18n-aria', 'tabindex'] },
    img: { ns: HTML, isVoid: true, attrs: ['class', 'src', 'alt', 'loading', 'decoding'] },
    svg: { ns: SVG, attrs: ['class', 'viewBox', 'aria-hidden', 'focusable', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'] },
    path: { ns: SVG, attrs: ['d', 'fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-linejoin', 'stroke-linecap'] },
    circle: { ns: SVG, attrs: ['cx', 'cy', 'r'] },
  };

  // Written by production, removed here (see the header). The action is part of
  // the report, never of the markup.
  var NEUTRALISED = [
    { code: 'data-action', action: 'removed', why: 'The application listens for it at document level; a click in a specimen must not reach a production handler.' },
    { code: 'data-i18n-aria', action: 'removed', why: 'The application translates elements that carry it; a specimen shows the fixture as recorded.' },
    { code: 'aria-modal', action: 'removed', why: 'A live modal hides the rest of the page from a screen reader; a specimen is not a modal.' },
    { code: 'tabindex', action: 'set to -1 on buttons', why: 'A button in a specimen does nothing, so it is taken out of the tab order.' },
  ];

  // Attributes that may be written with no value (a boolean attribute).
  var VALUELESS = { 'data-user-content': true };

  var RE = {
    classToken: /^[A-Za-z_][A-Za-z0-9_-]*$/,
    num: /^-?\d{1,4}(\.\d{1,3})?$/,
    paint: /^(none|currentColor|#[0-9A-Fa-f]{3,8})$/,
    opacity: /^(0|1|0?\.\d{1,3})$/,
    strokeWidth: /^\d{1,2}(\.\d{1,2})?$/,
    cap: /^(round|butt|square)$/,
    join: /^(round|miter|bevel)$/,
    viewBox: /^[0-9. -]{1,40}$/,
    path: /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-., ]{1,1000}$/,
    imageUri: /^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,][^\s"'<>]{0,2000}$/,
    barWidth: /^\d{1,3}(\.\d{1,2})?%$/,
    token: /^[A-Za-z0-9_.-]{0,100}$/,
  };

  function plain(v) { return typeof v === 'string' && v.length <= LIMITS.value && !hasBadChars(v); }

  // One validator per attribute. A value either passes or the fixture is refused.
  var VALUE = {
    'role': function (v) { return v === 'dialog' || v === 'status'; },
    'aria-hidden': function (v) { return v === 'true' || v === 'false'; },
    'aria-modal': function (v) { return v === 'true'; },
    'focusable': function (v) { return v === 'false'; },
    'type': function (v) { return v === 'button'; },
    'tabindex': function (v) { return v === '-1'; },
    'loading': function (v) { return v === 'lazy' || v === 'eager'; },
    'decoding': function (v) { return v === 'async'; },
    'width': function (v) { return /^\d{1,4}$/.test(v); },
    'height': function (v) { return /^\d{1,4}$/.test(v); },
    'data-lg-size': function (v) { return /^\d{1,3}$/.test(v); },
    'data-club-logo': function (v) { return RE.token.test(v); },
    'data-mc-width': function (v) { return RE.barWidth.test(v) && parseFloat(v) <= 100; },
    'data-action': function (v) { return plain(v); },
    'data-i18n-aria': function (v) { return plain(v); },
    'data-user-content': function (v) { return v === '' || v === null; },
    'alt': plain,
    'aria-label': plain,
    'src': function (v) { return typeof v === 'string' && v.length <= LIMITS.srcLength && RE.imageUri.test(v); },
    'viewBox': function (v) { return RE.viewBox.test(v); },
    'd': function (v) { return RE.path.test(v); },
    'fill': function (v) { return RE.paint.test(v); },
    'stroke': function (v) { return RE.paint.test(v); },
    'fill-opacity': function (v) { return RE.opacity.test(v); },
    'stroke-opacity': function (v) { return RE.opacity.test(v); },
    'stroke-width': function (v) { return RE.strokeWidth.test(v); },
    'stroke-linecap': function (v) { return RE.cap.test(v); },
    'stroke-linejoin': function (v) { return RE.join.test(v); },
    'cx': function (v) { return RE.num.test(v); },
    'cy': function (v) { return RE.num.test(v); },
    'r': function (v) { return RE.num.test(v); },
  };

  // ── characters ────────────────────────────────────────────────────────────

  // Control characters (but not tab or newline), line and paragraph separators,
  // and every bidirectional override or isolate: a fixture is plain text, and
  // text that reorders itself on screen is not.
  function hasBadChars(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 32 && c !== 9 && c !== 10) return true;
      if (c === 127 || (c >= 128 && c < 160)) return true;
      if (c === 0x2028 || c === 0x2029) return true;
      if ((c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069) || c === 0x200E || c === 0x200F || c === 0x061C) return true;
      if (c === 0xFFFE || c === 0xFFFF) return true;
    }
    return false;
  }

  function utf8Bytes(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  var ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  function decode(s, problems, where) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&[^;\s]{0,8};?/g, function (m) {
      if (ENTITIES[m]) return ENTITIES[m];
      problems.push(where + ': unknown character reference "' + m + '"');
      return m;
    });
  }
  function escText(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ── the parser ────────────────────────────────────────────────────────────
  //
  // A tree of { t: 'el', tag, attrs: [[name, value|null]], kids } and { t: 'tx', v }.
  // The only thing it does that a bare tokenizer would not is the one rule of the
  // HTML parser a fixture depends on: a <tr> written directly in a <table> gets
  // the <tbody> a browser would have given it, so the specimen's tree is the
  // production tree.

  function parse(html) {
    var problems = [];
    var root = { t: 'el', tag: null, attrs: [], kids: [] };
    var stack = [root];
    var i = 0;
    var n;

    if (typeof html !== 'string') return { ok: false, problems: ['the fixture is not a string'], tree: null };
    n = html.length;
    if (utf8Bytes(html) > LIMITS.bytes) return { ok: false, problems: ['the fixture is larger than ' + LIMITS.bytes + ' bytes'], tree: null };

    function top() { return stack[stack.length - 1]; }
    function fail(m) { problems.push(m + ' (at ' + i + ')'); }

    while (i < n && problems.length === 0) {
      var ch = html.charAt(i);
      if (ch !== '<') {
        var j = html.indexOf('<', i);
        if (j < 0) j = n;
        var raw = html.slice(i, j);
        if (raw.indexOf('>') >= 0) { fail('a bare ">" in text'); break; }
        var text = decode(raw, problems, 'text');
        if (hasBadChars(text)) { fail('a control or bidirectional-override character in text'); break; }
        if (text.length > LIMITS.text) { fail('a text node longer than ' + LIMITS.text); break; }
        if (stack.length === 1) { fail('text outside any element'); break; }
        top().kids.push({ t: 'tx', v: text });
        i = j;
        continue;
      }

      var next = html.charAt(i + 1);
      if (next === '/') {
        var em = /^<\/([a-z][a-z0-9]*)>/.exec(html.slice(i, i + 24));
        if (!em) { fail('a malformed closing tag'); break; }
        var cur = top();
        // The implicit <tbody> closes with its <table>.
        if (cur.implicit && em[1] === 'table') { stack.pop(); cur = top(); }
        if (stack.length === 1 || cur.tag !== em[1]) { fail('a closing tag </' + em[1] + '> that matches nothing open'); break; }
        stack.pop();
        i += em[0].length;
        continue;
      }
      if (!/[a-z]/i.test(next)) { fail('"<" does not start a tag (comments, doctypes and declarations are refused)'); break; }

      // A start tag.
      var k = i + 1;
      var nm = /^[A-Za-z][A-Za-z0-9]*/.exec(html.slice(k, k + 16));
      if (!nm) { fail('a malformed tag'); break; }
      var tag = nm[0];
      k += tag.length;
      var spec = Object.prototype.hasOwnProperty.call(TAGS, tag) ? TAGS[tag] : null;
      if (!spec) { fail('the tag <' + tag + '> is not allowed'); break; }

      var attrs = [];
      var seen = Object.create(null);   // no prototype: "constructor" is a name like any other
      var selfClose = false;
      var closed = false;
      while (k < n) {
        var c = html.charAt(k);
        if (c === '>') { k++; closed = true; break; }
        if (c === '/' && html.charAt(k + 1) === '>') { selfClose = true; k += 2; closed = true; break; }
        if (c !== ' ') { fail('an unexpected character in the tag <' + tag + '>'); break; }
        while (html.charAt(k) === ' ') k++;
        if (html.charAt(k) === '>' || (html.charAt(k) === '/' && html.charAt(k + 1) === '>')) continue;
        var am = /^[A-Za-z][A-Za-z0-9:_-]*/.exec(html.slice(k, k + 40));
        if (!am) { fail('a malformed attribute in <' + tag + '>'); break; }
        var name = am[0];
        k += name.length;
        var value = null;
        if (html.charAt(k) === '=') {
          k++;
          if (html.charAt(k) !== '"') { fail('the value of "' + name + '" is not double-quoted'); break; }
          var e = html.indexOf('"', k + 1);
          if (e < 0) { fail('an unterminated attribute value'); break; }
          var rawValue = html.slice(k + 1, e);
          if (rawValue.indexOf('<') >= 0) { fail('a "<" inside the value of "' + name + '"'); break; }
          value = decode(rawValue, problems, 'attribute ' + name);
          k = e + 1;
        }
        if (seen[name]) { fail('the attribute "' + name + '" is written twice'); break; }
        seen[name] = true;
        attrs.push([name, value]);
        if (attrs.length > LIMITS.attrsPerElement) { fail('more than ' + LIMITS.attrsPerElement + ' attributes on <' + tag + '>'); break; }
        var after = html.charAt(k);
        if (after !== ' ' && after !== '>' && !(after === '/' && html.charAt(k + 1) === '>')) { fail('an attribute is not followed by a space or the end of the tag'); break; }
      }
      if (problems.length) break;
      if (!closed) { fail('the tag <' + tag + '> is never closed'); break; }
      if (selfClose && spec.ns !== SVG && !spec.isVoid) { fail('<' + tag + '/> is not a void element'); break; }

      // Where it may sit.
      var parent = top();
      if (spec.ns === SVG && tag !== 'svg' && !(parent.tag && TAGS[parent.tag] && TAGS[parent.tag].ns === SVG)) { fail('<' + tag + '> is only allowed inside <svg>'); break; }
      if (parent.tag && TAGS[parent.tag] && TAGS[parent.tag].ns === SVG && spec.ns !== SVG) { fail('<' + tag + '> is not allowed inside <svg>'); break; }
      if (parent.tag === 'button' && tag === 'button') { fail('a <button> inside a <button>'); break; }
      if (tag === 'tr' && parent.tag === 'table') {
        var tb = { t: 'el', tag: 'tbody', attrs: [], kids: [], implicit: true };
        parent.kids.push(tb);
        stack.push(tb);
        parent = tb;
      }
      if (tag === 'td' && parent.tag !== 'tr') { fail('<td> outside a <tr>'); break; }
      if (tag === 'tr' && parent.tag !== 'tbody') { fail('<tr> outside a <table>'); break; }

      var el = { t: 'el', tag: tag, attrs: attrs, kids: [] };
      parent.kids.push(el);
      if (stack.length > LIMITS.depth) { fail('deeper than ' + LIMITS.depth + ' levels'); break; }
      if (!spec.isVoid && !selfClose) stack.push(el);
      i = k;
    }

    if (problems.length === 0 && stack.length !== 1) {
      var open = stack[stack.length - 1];
      if (open.implicit && stack.length === 2) problems.push('the <table> is never closed');
      else problems.push('the <' + open.tag + '> is never closed');
    }
    return problems.length ? { ok: false, problems: problems, tree: null } : { ok: true, problems: [], tree: root };
  }

  // ── the check ─────────────────────────────────────────────────────────────

  function walk(node, fn, depth) {
    fn(node, depth);
    if (node.kids) for (var i = 0; i < node.kids.length; i++) walk(node.kids[i], fn, depth + 1);
  }

  /**
   * Checks and neutralises a parsed tree. `ctx.classOk(name)` is the caller's
   * provenance test for a class; without it only the token shape is checked.
   * Returns { ok, problems, neutralised, stats } and edits the tree in place.
   */
  function hasAttr(attrs, name, value) {
    for (var i = 0; i < attrs.length; i++) if (attrs[i][0] === name && (value === undefined || attrs[i][1] === value)) return true;
    return false;
  }

  function check(tree, ctx) {
    var problems = [];
    var counts = {};
    var stats = { elements: 0, textNodes: 0, nodes: 0, depth: 0, tags: {}, attributes: {}, classes: {}, bytes: 0 };
    var classOk = ctx && typeof ctx.classOk === 'function' ? ctx.classOk : null;

    function bump(code) { counts[code] = (counts[code] || 0) + 1; }

    walk(tree, function (node, depth) {
      if (node === tree) return;
      stats.nodes++;
      if (depth > stats.depth) stats.depth = depth;
      if (node.t === 'tx') { stats.textNodes++; return; }
      stats.elements++;
      stats.tags[node.tag] = true;
      var spec = TAGS[node.tag];
      var kept = [];
      var i;
      for (i = 0; i < node.attrs.length; i++) {
        var name = node.attrs[i][0];
        var value = node.attrs[i][1];
        if (!spec || spec.attrs.indexOf(name) < 0) { problems.push('the attribute "' + name + '" is not allowed on <' + node.tag + '>'); continue; }
        if (name === 'class') {
          if (value === null || hasBadChars(value)) { problems.push('a class attribute with no value'); continue; }
          var tokens = value.split(/\s+/).filter(Boolean);
          if (!tokens.length || tokens.length > LIMITS.classTokens) { problems.push('a class attribute with ' + tokens.length + ' tokens'); continue; }
          for (var t = 0; t < tokens.length; t++) {
            if (tokens[t].length > LIMITS.classLength || !RE.classToken.test(tokens[t])) { problems.push('the class "' + tokens[t] + '" is malformed'); continue; }
            if (classOk && !classOk(tokens[t])) { problems.push('the class "' + tokens[t] + '" has no approved provenance'); continue; }
            stats.classes[tokens[t]] = true;
          }
          kept.push([name, tokens.join(' ')]);
          stats.attributes[name] = true;
          continue;
        }
        var test = VALUE[name];
        if (!test) { problems.push('the attribute "' + name + '" has no validator'); continue; }
        if (value === null && !VALUELESS[name]) { problems.push('the attribute "' + name + '" needs a value'); continue; }
        if (value !== null && hasBadChars(value)) { problems.push('the value of "' + name + '" holds a control or bidirectional character'); continue; }
        if (!test(value)) { problems.push('the value of "' + name + '" is not allowed'); continue; }
        if (name === 'data-action' || name === 'data-i18n-aria' || name === 'aria-modal') { bump(name); continue; }
        if (name === 'tabindex') continue;       // re-set below, exactly once
        kept.push([name, value]);
        stats.attributes[name] = true;
      }
      if (node.tag === 'button') { kept.push(['tabindex', '-1']); bump('tabindex'); stats.attributes.tabindex = true; }
      // A div names itself only as a status region (the Owner Kit's skeleton): an
      // aria-label on any other div is refused, whatever order the attributes came in.
      if (node.tag === 'div' && hasAttr(kept, 'aria-label') && !hasAttr(kept, 'role', 'status')) problems.push('the attribute "aria-label" is only allowed on a <div> with role="status"');
      node.attrs = kept;
    }, 0);

    if (stats.nodes > LIMITS.nodes) problems.push('more than ' + LIMITS.nodes + ' nodes');
    if (stats.depth > LIMITS.depth) problems.push('deeper than ' + LIMITS.depth + ' levels');

    var neutralised = [];
    for (var n = 0; n < NEUTRALISED.length; n++) {
      var code = NEUTRALISED[n].code;
      if (counts[code]) neutralised.push({ code: code, action: NEUTRALISED[n].action, count: counts[code] });
    }
    return {
      ok: problems.length === 0,
      problems: problems,
      neutralised: neutralised,
      stats: {
        elements: stats.elements, textNodes: stats.textNodes, nodes: stats.nodes, depth: stats.depth,
        tags: Object.keys(stats.tags).sort(), attributes: Object.keys(stats.attributes).sort(), classes: Object.keys(stats.classes).sort(),
      },
    };
  }

  // ── the canonical form ────────────────────────────────────────────────────

  function serializeNode(node) {
    if (node.t === 'tx') return escText(node.v);
    var spec = TAGS[node.tag];
    var out = '<' + node.tag;
    for (var i = 0; i < node.attrs.length; i++) {
      out += ' ' + node.attrs[i][0] + (node.attrs[i][1] === null ? '' : '="' + escAttr(node.attrs[i][1]) + '"');
    }
    if (spec.isVoid) return out + '>';
    if (spec.ns === SVG && node.kids.length === 0) return out + '/>';
    out += '>';
    for (var k = 0; k < node.kids.length; k++) out += serializeNode(node.kids[k]);
    return out + '</' + node.tag + '>';
  }
  function serialize(tree) {
    var out = '';
    for (var i = 0; i < tree.kids.length; i++) out += serializeNode(tree.kids[i]);
    return out;
  }

  /** Parse, check, neutralise and serialise in one call. */
  function sanitize(html, ctx) {
    var parsed = parse(html);
    if (!parsed.ok) return { ok: false, problems: parsed.problems, neutralised: [], stats: null, html: null, tree: null };
    var checked = check(parsed.tree, ctx);
    if (!checked.ok) return { ok: false, problems: checked.problems, neutralised: checked.neutralised, stats: checked.stats, html: null, tree: null };
    var out = serialize(parsed.tree);
    var bytes = utf8Bytes(out);
    if (bytes > LIMITS.bytes) return { ok: false, problems: ['the sanitised fixture is larger than ' + LIMITS.bytes + ' bytes'], neutralised: checked.neutralised, stats: checked.stats, html: null, tree: null };
    checked.stats.bytes = bytes;
    return { ok: true, problems: [], neutralised: checked.neutralised, stats: checked.stats, html: out, tree: parsed.tree };
  }

  // ── the browser's half ────────────────────────────────────────────────────

  /**
   * Builds nodes from a checked tree. `doc` is a document (or anything with the
   * same four methods, which is how the test suite runs it). The only strings
   * that reach the page are set with setAttribute and createTextNode.
   */
  function toDom(tree, doc) {
    function make(node) {
      if (node.t === 'tx') return doc.createTextNode(node.v);
      var spec = TAGS[node.tag];
      var el = spec.ns === SVG ? doc.createElementNS(SVG_NS, node.tag) : doc.createElement(node.tag);
      for (var i = 0; i < node.attrs.length; i++) el.setAttribute(node.attrs[i][0], node.attrs[i][1] === null ? '' : node.attrs[i][1]);
      for (var k = 0; k < node.kids.length; k++) el.appendChild(make(node.kids[k]));
      return el;
    }
    var frag = doc.createDocumentFragment();
    for (var i = 0; i < tree.kids.length; i++) frag.appendChild(make(tree.kids[i]));
    return frag;
  }

  function policy() {
    var tags = {};
    Object.keys(TAGS).sort().forEach(function (t) { tags[t] = { ns: TAGS[t].ns, void: !!TAGS[t].isVoid, attributes: TAGS[t].attrs.slice().sort() }; });
    return { version: VERSION, tags: tags, limits: JSON.parse(JSON.stringify(LIMITS)), neutralised: NEUTRALISED.map(function (x) { return { code: x.code, action: x.action }; }) };
  }

  return {
    VERSION: VERSION, LIMITS: LIMITS, SVG_NS: SVG_NS,
    parse: parse, check: check, serialize: serialize, sanitize: sanitize, toDom: toDom, policy: policy,
    utf8Bytes: utf8Bytes, hasBadChars: hasBadChars, NEUTRALISED: NEUTRALISED,
  };
}));
