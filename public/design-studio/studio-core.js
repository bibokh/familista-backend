/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN STUDIO — Slice 1a — the core

   Pure, deterministic and dependency-free: the design document, its validation,
   the operations that change it (each one reversible), the undo history and the
   canvas geometry. No DOM, no clock, no randomness, no storage, no network.

   Loaded by public/app.js before studio.js, and required directly by the Jest
   suite (tests/design-studio.unit.test.ts).

   THE DOCUMENT

     { format: 'familista.studio.document', version: 1, name, frames: [frame] }
     frame  { id, type: 'frame', name, x, y, w, h, fill, children: [rect | text] }
     rect   { id, type: 'rect',  name, x, y, w, h, fill, radius }
     text   { id, type: 'text',  name, x, y, w, h, text, style, color }

   A frame's x and y are canvas coordinates; a child's are relative to its
   frame's top-left corner. Every coordinate and size is a whole pixel. Colours,
   radii and type are token names (the --fam-* custom properties without the
   prefix), taken from closed lists that the test suite checks against the
   published token stylesheet; a value that is not on a list is refused, so no
   document can carry a CSS string of its own. Text is plain text: the renderer
   writes it with textContent, never as markup.

   WHAT IS REFUSED

   Anything that is not exactly this shape: an unknown or missing field, an id
   that is malformed or used twice, a number that is not a whole number inside
   the limits, a control character in a name, more text, frames or nodes than
   LIMITS allows, a file larger than LIMITS.bytes. A refused document changes
   nothing; validation builds a fresh copy and never keeps the input object.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaStudioCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMAT = 'familista.studio.document';
  var VERSION = 1;

  var LIMITS = Object.freeze({
    bytes: 1048576,      // an imported or saved file, in UTF-8 bytes
    frames: 50,
    nodes: 2000,         // frames and their children together
    name: 120,           // characters in a document, frame or element name
    text: 5000,          // characters in one text element
    coord: 100000,       // |x| and |y|, canvas or frame coordinates
    size: 20000,         // the largest width or height
    history: 200,        // undo steps kept
  });

  var ZOOM = Object.freeze({ min: 0.1, max: 4, steps: Object.freeze([0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4]) });

  // Token names, without the --fam- prefix. Only these may appear in a document.
  var TOKENS = Object.freeze({
    fill: Object.freeze([
      'surface-canvas', 'surface-sunken', 'surface-base', 'surface-panel', 'surface-panel-muted', 'surface-raised',
      'surface-tile', 'surface-tile-strong', 'surface-glass',
      'brand-accent', 'status-info', 'status-success', 'status-warning', 'status-critical', 'status-neutral',
    ]),
    radius: Object.freeze(['radius-sm', 'radius-md', 'radius-lg', 'radius-xl', 'radius-2xl', 'radius-full']),
    color: Object.freeze([
      'text-primary', 'text-secondary', 'text-tertiary', 'text-disabled',
      'brand-accent', 'status-info', 'status-success', 'status-warning', 'status-critical',
    ]),
  });

  // A text style is a fixed combination of type tokens.
  var TEXT_STYLES = Object.freeze({
    display: Object.freeze({ size: 'font-size-3xl', weight: 'font-weight-extrabold', lineHeight: 'font-line-height-tight' }),
    title: Object.freeze({ size: 'font-size-2xl', weight: 'font-weight-bold', lineHeight: 'font-line-height-tight' }),
    heading: Object.freeze({ size: 'font-size-xl', weight: 'font-weight-semibold', lineHeight: 'font-line-height-snug' }),
    subheading: Object.freeze({ size: 'font-size-lg', weight: 'font-weight-semibold', lineHeight: 'font-line-height-snug' }),
    body: Object.freeze({ size: 'font-size-base', weight: 'font-weight-regular', lineHeight: 'font-line-height-normal' }),
    label: Object.freeze({ size: 'font-size-sm', weight: 'font-weight-semibold', lineHeight: 'font-line-height-snug' }),
    caption: Object.freeze({ size: 'font-size-xs', weight: 'font-weight-medium', lineHeight: 'font-line-height-normal' }),
  });

  var DEFAULTS = Object.freeze({
    frame: Object.freeze({ w: 360, h: 640, fill: 'surface-base' }),
    rect: Object.freeze({ w: 120, h: 80, fill: 'surface-raised', radius: 'radius-md' }),
    text: Object.freeze({ w: 200, h: 48, style: 'body', color: 'text-primary' }),
  });

  var KEYS = Object.freeze({
    document: Object.freeze(['format', 'version', 'name', 'frames']),
    frame: Object.freeze(['id', 'type', 'name', 'x', 'y', 'w', 'h', 'fill', 'children']),
    rect: Object.freeze(['id', 'type', 'name', 'x', 'y', 'w', 'h', 'fill', 'radius']),
    text: Object.freeze(['id', 'type', 'name', 'x', 'y', 'w', 'h', 'text', 'style', 'color']),
  });
  // What a `set` operation may change, per type. id, type and children never change.
  var SETTABLE = Object.freeze({
    frame: Object.freeze(['name', 'x', 'y', 'w', 'h', 'fill']),
    rect: Object.freeze(['name', 'x', 'y', 'w', 'h', 'fill', 'radius']),
    text: Object.freeze(['name', 'x', 'y', 'w', 'h', 'text', 'style', 'color']),
  });
  var PREFIX = Object.freeze({ frame: 'frame-', rect: 'rect-', text: 'text-' });
  var HANDLES = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);

  var ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
  var NAME_BAD = /[\u0000-\u001F\u007F]/;
  // Text keeps tabs and line breaks; every other control character is refused.
  var TEXT_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

  function StudioError(code, path) {
    var e = new Error(code + (path ? ' at ' + path : ''));
    e.name = 'StudioError';
    e.code = code;
    e.path = path || '';
    return e;
  }

  function has(list, v) { return list.indexOf(v) !== -1; }
  function finite(n) { return typeof n === 'number' && isFinite(n); }
  function whole(v, lo, hi) { return finite(v) && Math.floor(v) === v && v >= lo && v <= hi; }
  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  /** A whole number, never -0. */
  function round(n) { return Math.round(n) || 0; }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  /** A path segment that is safe to show: an unknown field name could be anything. */
  function safe(k) { return String(k).replace(/[^A-Za-z0-9_-]/g, '?').slice(0, 40) || '?'; }

  function byteLength(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    return unescape(encodeURIComponent(s)).length;
  }

  // ── validation ────────────────────────────────────────────────────────────

  function checkKeys(o, keys, path, errors) {
    var own = Object.keys(o);
    for (var i = 0; i < own.length; i++) if (!has(keys, own[i])) errors.push({ code: 'unknown-field', path: path + '.' + safe(own[i]) });
    for (var j = 0; j < keys.length; j++) if (!Object.prototype.hasOwnProperty.call(o, keys[j])) errors.push({ code: 'missing-field', path: path + '.' + keys[j] });
  }
  function checkName(v, path, errors) {
    if (typeof v !== 'string' || v.length < 1 || v.length > LIMITS.name || NAME_BAD.test(v)) errors.push({ code: 'bad-name', path: path });
  }
  function checkGeometry(n, path, errors) {
    if (!whole(n.x, -LIMITS.coord, LIMITS.coord)) errors.push({ code: 'bad-number', path: path + '.x' });
    if (!whole(n.y, -LIMITS.coord, LIMITS.coord)) errors.push({ code: 'bad-number', path: path + '.y' });
    if (!whole(n.w, 1, LIMITS.size)) errors.push({ code: 'bad-size', path: path + '.w' });
    if (!whole(n.h, 1, LIMITS.size)) errors.push({ code: 'bad-size', path: path + '.h' });
  }
  /** One value for one field, by type. Returns an error code or ''. */
  function fieldProblem(type, key, v) {
    switch (key) {
      case 'name': return (typeof v === 'string' && v.length >= 1 && v.length <= LIMITS.name && !NAME_BAD.test(v)) ? '' : 'bad-name';
      case 'x': case 'y': return whole(v, -LIMITS.coord, LIMITS.coord) ? '' : 'bad-number';
      case 'w': case 'h': return whole(v, 1, LIMITS.size) ? '' : 'bad-size';
      case 'fill': return has(TOKENS.fill, v) ? '' : 'bad-token';
      case 'radius': return (v === null || has(TOKENS.radius, v)) ? '' : 'bad-token';
      case 'color': return has(TOKENS.color, v) ? '' : 'bad-token';
      case 'style': return Object.prototype.hasOwnProperty.call(TEXT_STYLES, v) ? '' : 'bad-token';
      case 'text': return (typeof v === 'string' && v.length <= LIMITS.text && !TEXT_BAD.test(v)) ? '' : 'bad-text';
      default: return 'unknown-field';
    }
  }

  /** A child node (rect or text) or a frame, rebuilt field by field. Pushes errors; returns the copy. */
  function validateNode(n, path, wantFrame, errors, ids) {
    if (!isObject(n)) { errors.push({ code: 'not-object', path: path }); return null; }
    var type = n.type;
    if (wantFrame ? type !== 'frame' : (type !== 'rect' && type !== 'text')) { errors.push({ code: 'bad-type', path: path + '.type' }); return null; }
    checkKeys(n, KEYS[type], path, errors);
    if (typeof n.id !== 'string' || !ID_RE.test(n.id)) errors.push({ code: 'bad-id', path: path + '.id' });
    else if (ids[n.id]) errors.push({ code: 'duplicate-id', path: path + '.id' });
    else ids[n.id] = 1;
    checkName(n.name, path + '.name', errors);
    checkGeometry(n, path, errors);
    var out = { id: n.id, type: type, name: n.name, x: n.x, y: n.y, w: n.w, h: n.h };
    if (type === 'frame') {
      if (fieldProblem('frame', 'fill', n.fill)) errors.push({ code: 'bad-token', path: path + '.fill' });
      out.fill = n.fill;
      out.children = [];
      if (!Array.isArray(n.children)) errors.push({ code: 'bad-children', path: path + '.children' });
      else for (var i = 0; i < n.children.length; i++) {
        var c = validateNode(n.children[i], path + '.children[' + i + ']', false, errors, ids);
        if (c) out.children.push(c);
      }
    } else if (type === 'rect') {
      if (fieldProblem('rect', 'fill', n.fill)) errors.push({ code: 'bad-token', path: path + '.fill' });
      if (fieldProblem('rect', 'radius', n.radius)) errors.push({ code: 'bad-token', path: path + '.radius' });
      out.fill = n.fill; out.radius = n.radius;
    } else {
      if (fieldProblem('text', 'text', n.text)) errors.push({ code: 'bad-text', path: path + '.text' });
      if (fieldProblem('text', 'style', n.style)) errors.push({ code: 'bad-token', path: path + '.style' });
      if (fieldProblem('text', 'color', n.color)) errors.push({ code: 'bad-token', path: path + '.color' });
      out.text = n.text; out.style = n.style; out.color = n.color;
    }
    return out;
  }

  /** The whole document, checked and rebuilt. { ok, doc } or { ok: false, errors }. */
  function validateDocument(input) {
    var errors = [];
    if (!isObject(input)) return { ok: false, errors: [{ code: 'not-object', path: '$' }] };
    checkKeys(input, KEYS.document, '$', errors);
    if (input.format !== FORMAT) errors.push({ code: 'format', path: '$.format' });
    if (input.version !== VERSION) errors.push({ code: 'version', path: '$.version' });
    checkName(input.name, '$.name', errors);
    var doc = { format: FORMAT, version: VERSION, name: input.name, frames: [] };
    if (!Array.isArray(input.frames)) errors.push({ code: 'bad-children', path: '$.frames' });
    else {
      if (input.frames.length > LIMITS.frames) errors.push({ code: 'too-many-frames', path: '$.frames' });
      var ids = Object.create(null);
      var count = 0;
      for (var i = 0; i < input.frames.length && i <= LIMITS.frames; i++) {
        var f = validateNode(input.frames[i], '$.frames[' + i + ']', true, errors, ids);
        if (f) { doc.frames.push(f); count += 1 + f.children.length; }
        if (count > LIMITS.nodes) { errors.push({ code: 'too-many-nodes', path: '$.frames' }); break; }
      }
    }
    if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
    return { ok: true, doc: doc };
  }

  /** Text from a file or from storage. Size first, then JSON, then the shape. */
  function parseDocument(text) {
    if (typeof text !== 'string') return { ok: false, errors: [{ code: 'not-json', path: '$' }] };
    if (text.length > LIMITS.bytes || byteLength(text) > LIMITS.bytes) return { ok: false, errors: [{ code: 'too-large', path: '$' }] };
    var data;
    try { data = JSON.parse(text); } catch (_) { return { ok: false, errors: [{ code: 'not-json', path: '$' }] }; }
    return validateDocument(data);
  }

  /** The canonical text of a document: fixed key order, two-space indent, one trailing line break. */
  function serializeDocument(doc) {
    function node(n) {
      var o = { id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, w: n.w, h: n.h };
      if (n.type === 'frame') { o.fill = n.fill; o.children = n.children.map(node); }
      else if (n.type === 'rect') { o.fill = n.fill; o.radius = n.radius; }
      else { o.text = n.text; o.style = n.style; o.color = n.color; }
      return o;
    }
    return JSON.stringify({ format: FORMAT, version: VERSION, name: doc.name, frames: doc.frames.map(node) }, null, 2) + '\n';
  }

  function createDocument(name) {
    return { format: FORMAT, version: VERSION, name: typeof name === 'string' && name ? name.slice(0, LIMITS.name) : 'Untitled design', frames: [] };
  }

  // ── lookups ───────────────────────────────────────────────────────────────

  /** Where a node is: { node, frame (its frame, or null for a frame), list, index }. */
  function locate(doc, id) {
    for (var i = 0; i < doc.frames.length; i++) {
      var f = doc.frames[i];
      if (f.id === id) return { node: f, frame: null, list: doc.frames, index: i };
      for (var j = 0; j < f.children.length; j++) if (f.children[j].id === id) return { node: f.children[j], frame: f, list: f.children, index: j };
    }
    return null;
  }
  function countNodes(doc) {
    var n = 0;
    for (var i = 0; i < doc.frames.length; i++) n += 1 + doc.frames[i].children.length;
    return n;
  }
  function allIds(doc) {
    var ids = Object.create(null);
    for (var i = 0; i < doc.frames.length; i++) {
      ids[doc.frames[i].id] = 1;
      for (var j = 0; j < doc.frames[i].children.length; j++) ids[doc.frames[i].children[j].id] = 1;
    }
    return ids;
  }
  /** Frames and their children in drawing order: what Tab walks. */
  function orderedIds(doc) {
    var out = [];
    for (var i = 0; i < doc.frames.length; i++) {
      out.push(doc.frames[i].id);
      for (var j = 0; j < doc.frames[i].children.length; j++) out.push(doc.frames[i].children[j].id);
    }
    return out;
  }
  /** The next unused id for a type: frame-1, rect-7. `taken` adds ids already promised in the same operation. */
  function nextId(doc, type, taken) {
    var prefix = PREFIX[type], used = allIds(doc), max = 0, k;
    for (k in used) if (k.indexOf(prefix) === 0) { var n = Number(k.slice(prefix.length)); if (whole(n, 1, 1e9) && n > max) max = n; }
    if (taken) for (k in taken) if (k.indexOf(prefix) === 0) { var m = Number(k.slice(prefix.length)); if (whole(m, 1, 1e9) && m > max) max = m; }
    return prefix + (max + 1);
  }
  /** "Rectangle 3": the base word (already in the reader's language) and the next free number. */
  function nextName(doc, type, base) {
    var max = 0, re = new RegExp('^' + String(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' (\\d+)$');
    var ids = orderedIds(doc);
    for (var i = 0; i < ids.length; i++) {
      var l = locate(doc, ids[i]);
      if (l.node.type !== type) continue;
      var m = re.exec(l.node.name);
      if (m && Number(m[1]) > max) max = Number(m[1]);
    }
    return (String(base) + ' ' + (max + 1)).slice(0, LIMITS.name);
  }

  // ── operations ────────────────────────────────────────────────────────────
  //
  //   { kind: 'insert',  parent: null | frameId, index, node }
  //   { kind: 'remove',  id }
  //   { kind: 'set',     id, props }
  //   { kind: 'meta',    props: { name } }
  //   { kind: 'replace', doc }
  //
  // applyOp checks everything first and changes the document only when the whole
  // operation is valid; it returns the operation that undoes it.

  function applyOp(doc, op) {
    if (!isObject(op)) throw StudioError('bad-op');
    switch (op.kind) {
      case 'insert': return applyInsert(doc, op);
      case 'remove': return applyRemove(doc, op);
      case 'set': return applySet(doc, op);
      case 'meta': return applyMeta(doc, op);
      case 'replace': return applyReplace(doc, op);
      default: throw StudioError('bad-op');
    }
  }

  function applyInsert(doc, op) {
    var errors = [], ids = allIds(doc);
    var isFrame = op.parent === null;
    var parent = null;
    if (!isFrame) {
      var l = locate(doc, op.parent);
      if (!l || l.node.type !== 'frame') throw StudioError('bad-parent');
      parent = l.node;
    }
    var node = validateNode(op.node, 'node', isFrame, errors, ids);
    if (errors.length || !node) throw StudioError(errors.length ? errors[0].code : 'bad-op', errors.length ? errors[0].path : '');
    var list = isFrame ? doc.frames : parent.children;
    if (!whole(op.index, 0, list.length)) throw StudioError('bad-index');
    if (isFrame && doc.frames.length + 1 > LIMITS.frames) throw StudioError('too-many-frames');
    if (countNodes(doc) + 1 + (isFrame ? node.children.length : 0) > LIMITS.nodes) throw StudioError('too-many-nodes');
    list.splice(op.index, 0, node);
    return { inverse: { kind: 'remove', id: node.id } };
  }

  function applyRemove(doc, op) {
    var l = locate(doc, op.id);
    if (!l) throw StudioError('not-found');
    l.list.splice(l.index, 1);
    return { inverse: { kind: 'insert', parent: l.frame ? l.frame.id : null, index: l.index, node: clone(l.node) } };
  }

  function applySet(doc, op) {
    var l = locate(doc, op.id);
    if (!l) throw StudioError('not-found');
    if (!isObject(op.props)) throw StudioError('bad-op');
    var keys = Object.keys(op.props);
    if (!keys.length) throw StudioError('bad-op');
    var allowed = SETTABLE[l.node.type];
    for (var i = 0; i < keys.length; i++) {
      if (!has(allowed, keys[i])) throw StudioError('unknown-field', keys[i]);
      var p = fieldProblem(l.node.type, keys[i], op.props[keys[i]]);
      if (p) throw StudioError(p, keys[i]);
    }
    var before = {};
    for (var j = 0; j < keys.length; j++) { before[keys[j]] = l.node[keys[j]]; l.node[keys[j]] = op.props[keys[j]]; }
    return { inverse: { kind: 'set', id: op.id, props: before } };
  }

  function applyMeta(doc, op) {
    if (!isObject(op.props) || Object.keys(op.props).length !== 1 || !Object.prototype.hasOwnProperty.call(op.props, 'name')) throw StudioError('bad-op');
    if (fieldProblem('frame', 'name', op.props.name)) throw StudioError('bad-name', 'name');
    var before = doc.name;
    doc.name = op.props.name;
    return { inverse: { kind: 'meta', props: { name: before } } };
  }

  function applyReplace(doc, op) {
    var v = validateDocument(op.doc);
    if (!v.ok) throw StudioError(v.errors[0].code, v.errors[0].path);
    var before = clone(doc);
    doc.name = v.doc.name;
    doc.frames = v.doc.frames;
    return { inverse: { kind: 'replace', doc: before } };
  }

  // ── history ───────────────────────────────────────────────────────────────

  function createHistory(limit) { return { past: [], future: [], limit: whole(limit, 1, 10000) ? limit : LIMITS.history }; }

  /** Apply and remember. `label` is what the announcement and the Undo button say. */
  function commit(doc, history, op, label) {
    var r = applyOp(doc, op);
    history.past.push({ forward: clone(op), inverse: r.inverse, label: label || '' });
    if (history.past.length > history.limit) history.past.shift();
    history.future.length = 0;
    return history.past[history.past.length - 1];
  }
  function undo(doc, history) {
    var e = history.past.pop();
    if (!e) return null;
    var r = applyOp(doc, e.inverse);
    e.forward = r.inverse;
    history.future.push(e);
    return e;
  }
  function redo(doc, history) {
    var e = history.future.pop();
    if (!e) return null;
    var r = applyOp(doc, e.forward);
    e.inverse = r.inverse;
    history.past.push(e);
    return e;
  }

  // ── building operations ───────────────────────────────────────────────────

  /** A new node of `type` with its defaults, at whole-pixel geometry. */
  function makeNode(doc, type, geom, name, extra) {
    var d = DEFAULTS[type];
    var n = {
      id: nextId(doc, type), type: type, name: name,
      x: clamp(round(geom.x), -LIMITS.coord, LIMITS.coord), y: clamp(round(geom.y), -LIMITS.coord, LIMITS.coord),
      w: clamp(round(geom.w == null ? d.w : geom.w), 1, LIMITS.size), h: clamp(round(geom.h == null ? d.h : geom.h), 1, LIMITS.size),
    };
    if (type === 'frame') { n.fill = d.fill; n.children = []; }
    else if (type === 'rect') { n.fill = d.fill; n.radius = d.radius; }
    else { n.text = extra && typeof extra.text === 'string' ? extra.text : ''; n.style = d.style; n.color = d.color; }
    return n;
  }
  function insertOp(doc, parentId, node) {
    var list = parentId === null ? doc.frames : locate(doc, parentId).node.children;
    return { kind: 'insert', parent: parentId, index: list.length, node: node };
  }
  /** A copy beside the original: a frame to its right, an element 10 px down and right. New ids throughout. */
  function duplicateOp(doc, id) {
    var l = locate(doc, id);
    if (!l) throw StudioError('not-found');
    var taken = Object.create(null);
    var copy = clone(l.node);
    copy.id = nextId(doc, copy.type, taken); taken[copy.id] = 1;
    if (copy.type === 'frame') {
      copy.x = clamp(copy.x + copy.w + 40, -LIMITS.coord, LIMITS.coord);
      for (var i = 0; i < copy.children.length; i++) { copy.children[i].id = nextId(doc, copy.children[i].type, taken); taken[copy.children[i].id] = 1; }
    } else {
      copy.x = clamp(copy.x + 10, -LIMITS.coord, LIMITS.coord);
      copy.y = clamp(copy.y + 10, -LIMITS.coord, LIMITS.coord);
    }
    return { kind: 'insert', parent: l.frame ? l.frame.id : null, index: l.index + 1, node: copy };
  }

  // ── geometry ──────────────────────────────────────────────────────────────
  //
  // A camera is { x, y, z }: a world point p appears on screen at p * z + (x, y).
  // Screen coordinates are the canvas element's own CSS pixels.

  function clampZoom(z) { return finite(z) ? Math.round(clamp(z, ZOOM.min, ZOOM.max) * 10000) / 10000 : 1; }
  function zoomStep(z, dir) {
    var s = ZOOM.steps, v = clampZoom(z), i;
    if (dir > 0) { for (i = 0; i < s.length; i++) if (s[i] > v + 1e-6) return s[i]; return ZOOM.max; }
    for (i = s.length - 1; i >= 0; i--) if (s[i] < v - 1e-6) return s[i];
    return ZOOM.min;
  }
  function toScreen(cam, p) { return { x: p.x * cam.z + cam.x, y: p.y * cam.z + cam.y }; }
  function toWorld(cam, p) { return { x: (p.x - cam.x) / cam.z, y: (p.y - cam.y) / cam.z }; }
  /** Zoom to `z`, keeping the world point under `at` (a screen point) where it is. */
  function zoomAt(cam, z, at) {
    var nz = clampZoom(z), w = toWorld(cam, at);
    return { x: at.x - w.x * nz, y: at.y - w.y * nz, z: nz };
  }
  function panBy(cam, dx, dy) { return { x: cam.x + dx, y: cam.y + dy, z: cam.z }; }
  /** A screen-pixel drag turned into whole canvas pixels at the current zoom. */
  function worldDelta(sdx, sdy, z) { return { dx: round(sdx / z), dy: round(sdy / z) }; }

  /** Every frame together, or null. */
  function bounds(doc) {
    if (!doc.frames.length) return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < doc.frames.length; i++) {
      var f = doc.frames[i];
      x0 = Math.min(x0, f.x); y0 = Math.min(y0, f.y); x1 = Math.max(x1, f.x + f.w); y1 = Math.max(y1, f.y + f.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /** The camera that shows `b` whole inside a viewport, never above 100%. */
  function fitCamera(b, vw, vh, pad) {
    pad = finite(pad) ? pad : 48;
    if (!b || !(vw > 0) || !(vh > 0)) return { x: pad, y: pad, z: 1 };
    var z = clampZoom(Math.min(1, (vw - 2 * pad) / b.w, (vh - 2 * pad) / b.h));
    return { x: (vw - b.w * z) / 2 - b.x * z, y: (vh - b.h * z) / 2 - b.y * z, z: z };
  }
  /** A node's rectangle in canvas coordinates. */
  function worldRect(doc, id) {
    var l = locate(doc, id);
    if (!l) return null;
    var n = l.node;
    return l.frame ? { x: l.frame.x + n.x, y: l.frame.y + n.y, w: n.w, h: n.h } : { x: n.x, y: n.y, w: n.w, h: n.h };
  }
  /** The topmost thing under a canvas point: an element inside a frame, else the frame, else null. */
  function hitTest(doc, p) {
    for (var i = doc.frames.length - 1; i >= 0; i--) {
      var f = doc.frames[i];
      if (p.x < f.x || p.y < f.y || p.x >= f.x + f.w || p.y >= f.y + f.h) continue;
      var lx = p.x - f.x, ly = p.y - f.y;
      for (var j = f.children.length - 1; j >= 0; j--) {
        var c = f.children[j];
        if (lx >= c.x && ly >= c.y && lx < c.x + c.w && ly < c.y + c.h) return { frame: f.id, id: c.id };
      }
      return { frame: f.id, id: f.id };
    }
    return null;
  }
  function frameAt(doc, p) { var h = hitTest(doc, p); return h ? h.frame : null; }

  /** Move a geometry by whole pixels, inside the coordinate limits. */
  function moveBy(g, dx, dy) {
    return { x: clamp(round(g.x + dx), -LIMITS.coord, LIMITS.coord), y: clamp(round(g.y + dy), -LIMITS.coord, LIMITS.coord), w: g.w, h: g.h };
  }
  /**
   * Resize from one of the eight handles by a canvas-pixel delta. The opposite edge stays put; with
   * `fromCenter` the centre stays put; with `keepRatio` the proportions are kept. Never below 1 px,
   * never past the opposite edge, never above LIMITS.size.
   */
  function resize(g, handle, dx, dy, opts) {
    if (!has(HANDLES, handle)) throw StudioError('bad-handle');
    opts = opts || {};
    var left = handle === 'nw' || handle === 'w' || handle === 'sw';
    var right = handle === 'ne' || handle === 'e' || handle === 'se';
    var top = handle === 'nw' || handle === 'n' || handle === 'ne';
    var bottom = handle === 'sw' || handle === 's' || handle === 'se';
    var k = opts.fromCenter ? 2 : 1;
    var w = g.w, h = g.h;
    if (right) w = g.w + dx * k;
    if (left) w = g.w - dx * k;
    if (bottom) h = g.h + dy * k;
    if (top) h = g.h - dy * k;
    if (opts.keepRatio && g.w > 0 && g.h > 0) {
      var r = g.w / g.h;
      if ((left || right) && (top || bottom)) {
        if (Math.abs(w / g.w - 1) >= Math.abs(h / g.h - 1)) h = w / r; else w = h * r;
      } else if (left || right) h = w / r;
      else w = h * r;
    }
    w = clamp(round(w), 1, LIMITS.size);
    h = clamp(round(h), 1, LIMITS.size);
    var x = g.x, y = g.y;
    if (opts.fromCenter) { x = round(g.x + (g.w - w) / 2); y = round(g.y + (g.h - h) / 2); }
    else {
      if (left) x = g.x + g.w - w;
      if (top) y = g.y + g.h - h;
      if (opts.keepRatio && !(top || bottom)) y = round(g.y + (g.h - h) / 2);
      if (opts.keepRatio && !(left || right)) x = round(g.x + (g.w - w) / 2);
    }
    return { x: clamp(x, -LIMITS.coord, LIMITS.coord), y: clamp(y, -LIMITS.coord, LIMITS.coord), w: w, h: h };
  }
  /** A rubber band between two canvas points, as whole pixels, at least 1 × 1. */
  function band(a, b) {
    var x0 = round(Math.min(a.x, b.x)), y0 = round(Math.min(a.y, b.y));
    return { x: x0, y: y0, w: Math.max(1, round(Math.max(a.x, b.x)) - x0), h: Math.max(1, round(Math.max(a.y, b.y)) - y0) };
  }

  /** A file name for an export: the design's name, reduced to safe characters. */
  function exportFileName(name) {
    var slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return (slug || 'design') + '.familista-design.json';
  }

  return Object.freeze({
    FORMAT: FORMAT, VERSION: VERSION, LIMITS: LIMITS, ZOOM: ZOOM, TOKENS: TOKENS, TEXT_STYLES: TEXT_STYLES,
    DEFAULTS: DEFAULTS, KEYS: KEYS, SETTABLE: SETTABLE, HANDLES: HANDLES,
    StudioError: StudioError, byteLength: byteLength, clone: clone,
    validateDocument: validateDocument, parseDocument: parseDocument, serializeDocument: serializeDocument, createDocument: createDocument,
    locate: locate, countNodes: countNodes, orderedIds: orderedIds, nextId: nextId, nextName: nextName,
    applyOp: applyOp, createHistory: createHistory, commit: commit, undo: undo, redo: redo,
    makeNode: makeNode, insertOp: insertOp, duplicateOp: duplicateOp,
    clampZoom: clampZoom, zoomStep: zoomStep, toScreen: toScreen, toWorld: toWorld, zoomAt: zoomAt, panBy: panBy,
    worldDelta: worldDelta, bounds: bounds, fitCamera: fitCamera, worldRect: worldRect, hitTest: hitTest, frameAt: frameAt,
    moveBy: moveBy, resize: resize, band: band, exportFileName: exportFileName,
  });
});
