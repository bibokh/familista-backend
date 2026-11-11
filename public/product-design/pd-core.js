/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN STUDIO — DS-1a — the core

   Pure, deterministic and dependency-free: the product-design document, the
   product template it is drawn on, their validation, the operations that change
   a document (each one reversible), the undo history, the millimetre geometry
   and the design check. No DOM, no clock, no randomness, no storage, no network.

   Loaded by public/app.js before product-design.js, and required directly by the
   Jest suite (tests/product-design-core.unit.test.ts).

   This is not the Interface Studio's core (public/design-studio/studio-core.js,
   format `familista.studio.document`), which lays out interface frames in whole
   pixels from design tokens. A garment is measured in millimetres and coloured
   with the design's own palette, so it has a document of its own and shares no
   code with that one: the Interface Studio is left exactly as it is.

   THE DOCUMENT

     { format: 'familista.product-design', version: 1, name,
       template: { key, version },
       palette:  [{ id, label, srgb }],
       parts:    { collar, cuffs },                 palette ids
       surfaces: [{ id, base, layers: [layer] }] }  one per template surface, in order

     layer    { id, type, name, visible, locked, ... }
       pattern  pattern, color, scale (mm), angle (°), opacity (%)        whole surface
       text     text, font, color, outline, x, y, w, h, r, w0, h0          a box
       roster   field (name | number), font, color, outline, x, y, w, h, r, w0, h0
       shape    shape, color, outline, x, y, w, h, r, w0, h0

   A box is its centre (x, y), its size (w, h) and its rotation r in whole degrees,
   in millimetres on the surface's own coordinates at the template's reference
   size, to a tenth of a millimetre. w0 × h0 is the size it was placed at, which
   is what Scale reads. Colours are palette ids; a palette colour is #rrggbb.

   A roster layer is a placeholder. It holds no person's name or number: names,
   numbers and sizes belong to a team roster (planned, DS-3) and are joined only
   when production files are made, so a design can be shared and versioned
   without carrying anybody's data. The core refuses any field that would put a
   name into a roster layer.

   WHAT IS REFUSED

   Anything that is not exactly this shape: an unknown or missing field, an id
   that is malformed or used twice, a number outside its limits or finer than a
   tenth of a millimetre, a pattern, shape, font or field not on its closed list,
   a colour reference that names no palette colour, a surface the template does
   not have, a file larger than LIMITS.bytes. Validation builds a fresh copy and
   never keeps the input object; a refused document changes nothing.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FamilistaProductDesignCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMAT = 'familista.product-design';
  var VERSION = 1;
  var TEMPLATE_FORMAT = 'familista.product-template';

  var LIMITS = Object.freeze({
    bytes: 524288,       // an imported or saved file, in UTF-8 bytes
    name: 120,           // characters in a design or layer name
    label: 40,           // characters in a palette colour's label
    text: 60,            // characters printed by one text layer
    layers: 60,          // layers on one surface
    palette: 24,         // colours in one design
    coord: 2000,         // |x| and |y|, in mm
    size: 2000,          // the largest width or height, in mm
    minSize: 2,          // the smallest width or height, in mm
    scaleMin: 2,         // a pattern's repeat, in mm
    scaleMax: 400,
    history: 200,        // undo steps kept
  });

  var PATTERNS = Object.freeze(['diagonal', 'vertical', 'hoops', 'pinstripe', 'gradient', 'chevron', 'sash', 'halftone']);
  var SHAPES = Object.freeze(['shield', 'circle', 'star', 'band', 'chevron', 'diamond']);
  var FONTS = Object.freeze(['sans-black', 'sans-bold', 'mono-bold']);
  var ROSTER_FIELDS = Object.freeze(['name', 'number']);
  var LAYER_TYPES = Object.freeze(['pattern', 'text', 'roster', 'shape']);
  var BOX_TYPES = Object.freeze(['text', 'roster', 'shape']);
  var PARTS = Object.freeze(['collar', 'cuffs']);

  var COMMON_KEYS = ['id', 'type', 'name', 'visible', 'locked'];
  var BOX_KEYS = ['x', 'y', 'w', 'h', 'r', 'w0', 'h0'];
  var KEYS = Object.freeze({
    document: Object.freeze(['format', 'version', 'name', 'template', 'palette', 'parts', 'surfaces']),
    template: Object.freeze(['key', 'version']),
    swatch: Object.freeze(['id', 'label', 'srgb']),
    surface: Object.freeze(['id', 'base', 'layers']),
    pattern: Object.freeze(COMMON_KEYS.concat(['pattern', 'color', 'scale', 'angle', 'opacity'])),
    text: Object.freeze(COMMON_KEYS.concat(['text', 'font', 'color', 'outline'], BOX_KEYS)),
    roster: Object.freeze(COMMON_KEYS.concat(['field', 'font', 'color', 'outline'], BOX_KEYS)),
    shape: Object.freeze(COMMON_KEYS.concat(['shape', 'color', 'outline'], BOX_KEYS)),
  });
  // What a `set` operation may change, per target. Ids, types and a roster's field never change.
  var SETTABLE = Object.freeze({
    doc: Object.freeze(['name']),
    swatch: Object.freeze(['label', 'srgb']),
    surface: Object.freeze(['base']),
    part: Object.freeze(['color']),
    pattern: Object.freeze(['name', 'visible', 'locked', 'pattern', 'color', 'scale', 'angle', 'opacity']),
    text: Object.freeze(['name', 'visible', 'locked', 'text', 'font', 'color', 'outline'].concat(BOX_KEYS)),
    roster: Object.freeze(['name', 'visible', 'locked', 'font', 'color', 'outline'].concat(BOX_KEYS)),
    shape: Object.freeze(['name', 'visible', 'locked', 'shape', 'color', 'outline'].concat(BOX_KEYS)),
  });

  var ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
  var HEX_RE = /^#[0-9a-f]{6}$/;
  var CONTROL = /[\u0000-\u001F\u007F]/;

  function PDError(code, path) {
    var e = new Error(code + (path ? ' at ' + path : ''));
    e.name = 'ProductDesignError';
    e.code = code;
    e.path = path || '';
    return e;
  }

  function has(list, v) { return list.indexOf(v) !== -1; }
  function finite(n) { return typeof n === 'number' && isFinite(n); }
  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  /** A millimetre value as the document keeps it: a tenth of a millimetre, never -0. */
  function mm(n) { return Math.round(n * 10) / 10 || 0; }
  function whole(n) { return Math.round(n) || 0; }
  function isTenth(n) { return finite(n) && mm(n) === n; }
  function isWhole(n, lo, hi) { return finite(n) && Math.floor(n) === n && n >= lo && n <= hi; }
  function safe(k) { return String(k).replace(/[^A-Za-z0-9_-]/g, '?').slice(0, 40) || '?'; }
  function byteLength(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  function checkKeys(o, keys, path, errors) {
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k) && !has(keys, k)) errors.push(PDError('unknown-field', path + '.' + safe(k)));
    for (var i = 0; i < keys.length; i++) if (!Object.prototype.hasOwnProperty.call(o, keys[i])) errors.push(PDError('missing-field', path + '.' + keys[i]));
  }
  function goodName(v, max) { return typeof v === 'string' && v.trim().length > 0 && v.length <= max && !CONTROL.test(v); }
  /** An angle in whole degrees, -180 < a ≤ 180. */
  function normAngle(a) { var n = whole(a) % 360; if (n > 180) n -= 360; if (n <= -180) n += 360; return n; }

  // ── the template ──────────────────────────────────────────────────────────
  //
  // A template is reviewed repository data (public/product-design/templates/),
  // read once. An outline is a list of points; a point with four numbers is
  // reached by a quadratic curve through the control point it names. The same
  // outline draws the garment and is flattened for the geometry, so what is
  // drawn and what is checked cannot disagree.

  function validOutline(o) {
    if (!Array.isArray(o) || o.length < 3) return false;
    for (var i = 0; i < o.length; i++) {
      var p = o[i];
      if (!Array.isArray(p) || (p.length !== 2 && !(p.length === 4 && i > 0))) return false;
      for (var j = 0; j < p.length; j++) if (!finite(p[j]) || Math.abs(p[j]) > LIMITS.coord) return false;
    }
    return true;
  }
  function validatePolygonList(list) {
    return Array.isArray(list) && list.length >= 3 && list.every(function (p) { return Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]); });
  }

  /** The template, checked and frozen. Throws on the first problem; a template is ours, not a reader's. */
  function validateTemplate(t) {
    if (!isObject(t) || t.format !== TEMPLATE_FORMAT || t.version !== 1) throw PDError('template-format');
    if (typeof t.key !== 'string' || !/^[a-z0-9.-]{3,80}$/.test(t.key) || !isWhole(t.templateVersion, 1, 1000)) throw PDError('template-key');
    if (!Array.isArray(t.surfaces) || !t.surfaces.length) throw PDError('template-surfaces');
    var ids = {};
    t.surfaces.forEach(function (s, i) {
      var p = 'surfaces[' + i + ']';
      if (!isObject(s) || !ID_RE.test(s.id) || ids[s.id]) throw PDError('template-surface-id', p);
      ids[s.id] = 1;
      if (!validOutline(s.outline)) throw PDError('template-outline', p);
      if (!validatePolygonList(s.safe)) throw PDError('template-safe', p);
      if (!finite(s.width) || !finite(s.height) || s.width <= 0 || s.height <= 0) throw PDError('template-size', p);
    });
    if (!Array.isArray(t.views) || !t.views.length) throw PDError('template-views');
    t.views.forEach(function (v, i) {
      var p = 'views[' + i + ']';
      if (!isObject(v) || !ids[v.surface] || !Array.isArray(v.viewBox) || v.viewBox.length !== 4) throw PDError('template-view', p);
      (v.context || []).forEach(function (c, j) {
        if (!ids[c.surface] || !validOutline(c.outline)) throw PDError('template-context', p + '.context[' + j + ']');
      });
    });
    if (!isObject(t.rules) || !finite(t.rules.minTextHeight)) throw PDError('template-rules');
    return deepFreeze(clone(t));
  }
  function deepFreeze(o) {
    if (o && typeof o === 'object') { Object.freeze(o); for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) deepFreeze(o[k]); }
    return o;
  }
  function templateSurface(template, id) {
    for (var i = 0; i < template.surfaces.length; i++) if (template.surfaces[i].id === id) return template.surfaces[i];
    return null;
  }

  // ── validation ────────────────────────────────────────────────────────────

  function checkBox(n, path, errors) {
    if (!isTenth(n.x) || Math.abs(n.x) > LIMITS.coord) errors.push(PDError('bad-number', path + '.x'));
    if (!isTenth(n.y) || Math.abs(n.y) > LIMITS.coord) errors.push(PDError('bad-number', path + '.y'));
    ['w', 'h', 'w0', 'h0'].forEach(function (k) {
      if (!isTenth(n[k]) || n[k] < LIMITS.minSize || n[k] > LIMITS.size) errors.push(PDError('bad-number', path + '.' + k));
    });
    if (!isWhole(n.r, -179, 180)) errors.push(PDError('bad-number', path + '.r'));
  }
  /** The problem with one field's value, or null. `colors` is the set of palette ids. */
  function fieldProblem(type, key, v, colors) {
    switch (key) {
      case 'name': return goodName(v, LIMITS.name) ? null : 'bad-name';
      case 'visible': case 'locked': return typeof v === 'boolean' ? null : 'bad-flag';
      case 'pattern': return has(PATTERNS, v) ? null : 'bad-pattern';
      case 'shape': return has(SHAPES, v) ? null : 'bad-shape';
      case 'font': return has(FONTS, v) ? null : 'bad-font';
      case 'field': return has(ROSTER_FIELDS, v) ? null : 'bad-field';
      case 'color': return colors[v] ? null : 'bad-color-ref';
      case 'outline': return v === null || colors[v] ? null : 'bad-color-ref';
      case 'text': return typeof v === 'string' && v.trim().length > 0 && v.length <= LIMITS.text && !CONTROL.test(v) ? null : 'bad-text';
      case 'scale': return isTenth(v) && v >= LIMITS.scaleMin && v <= LIMITS.scaleMax ? null : 'bad-number';
      case 'angle': return isWhole(v, -179, 180) ? null : 'bad-number';
      case 'opacity': return isWhole(v, 5, 100) ? null : 'bad-number';
      case 'x': case 'y': return isTenth(v) && Math.abs(v) <= LIMITS.coord ? null : 'bad-number';
      case 'w': case 'h': case 'w0': case 'h0': return isTenth(v) && v >= LIMITS.minSize && v <= LIMITS.size ? null : 'bad-number';
      case 'r': return isWhole(v, -179, 180) ? null : 'bad-number';
      case 'label': return goodName(v, LIMITS.label) ? null : 'bad-label';
      case 'srgb': return typeof v === 'string' && HEX_RE.test(v) ? null : 'bad-colour';
      case 'base': return colors[v] ? null : 'bad-color-ref';
      default: return 'unknown-field';
    }
  }

  function validateLayer(n, path, colors, errors, ids) {
    if (!isObject(n)) { errors.push(PDError('not-object', path)); return; }
    if (!has(LAYER_TYPES, n.type)) { errors.push(PDError('bad-type', path + '.type')); return; }
    checkKeys(n, KEYS[n.type], path, errors);
    if (typeof n.id !== 'string' || !ID_RE.test(n.id)) errors.push(PDError('bad-id', path + '.id'));
    else if (ids[n.id]) errors.push(PDError('duplicate-id', path + '.id'));
    else ids[n.id] = 1;
    for (var i = 0; i < KEYS[n.type].length; i++) {
      var k = KEYS[n.type][i];
      if (k === 'id' || k === 'type' || has(BOX_KEYS, k) || !Object.prototype.hasOwnProperty.call(n, k)) continue;
      var problem = fieldProblem(n.type, k, n[k], colors);
      if (problem) errors.push(PDError(problem, path + '.' + k));
    }
    if (has(BOX_TYPES, n.type)) checkBox(n, path, errors);
  }

  /**
   * Validate a parsed document against its template. Returns a fresh copy; throws
   * a ProductDesignError carrying every problem found (`errors`) otherwise.
   */
  function validateDocument(input, template) {
    var errors = [];
    if (!isObject(input)) throw PDError('not-object', 'document');
    checkKeys(input, KEYS.document, 'document', errors);
    if (input.format !== FORMAT) errors.push(PDError('bad-format', 'document.format'));
    if (input.version !== VERSION) errors.push(PDError('bad-version', 'document.version'));
    if (!goodName(input.name, LIMITS.name)) errors.push(PDError('bad-name', 'document.name'));
    if (!isObject(input.template)) errors.push(PDError('not-object', 'document.template'));
    else {
      checkKeys(input.template, KEYS.template, 'document.template', errors);
      if (!template || input.template.key !== template.key || input.template.version !== template.templateVersion) errors.push(PDError('unknown-template', 'document.template'));
    }
    var colors = {};
    if (!Array.isArray(input.palette) || !input.palette.length || input.palette.length > LIMITS.palette) errors.push(PDError('bad-palette', 'document.palette'));
    else input.palette.forEach(function (s, i) {
      var p = 'document.palette[' + i + ']';
      if (!isObject(s)) { errors.push(PDError('not-object', p)); return; }
      checkKeys(s, KEYS.swatch, p, errors);
      if (typeof s.id !== 'string' || !ID_RE.test(s.id)) errors.push(PDError('bad-id', p + '.id'));
      else if (colors[s.id]) errors.push(PDError('duplicate-id', p + '.id'));
      else colors[s.id] = 1;
      if (fieldProblem('swatch', 'label', s.label, colors)) errors.push(PDError('bad-label', p + '.label'));
      if (fieldProblem('swatch', 'srgb', s.srgb, colors)) errors.push(PDError('bad-colour', p + '.srgb'));
    });
    if (!isObject(input.parts)) errors.push(PDError('not-object', 'document.parts'));
    else {
      checkKeys(input.parts, PARTS, 'document.parts', errors);
      PARTS.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(input.parts, k) && !colors[input.parts[k]]) errors.push(PDError('bad-color-ref', 'document.parts.' + k)); });
    }
    var ids = {};
    for (var c in colors) ids[c] = 1;
    if (!Array.isArray(input.surfaces)) errors.push(PDError('not-array', 'document.surfaces'));
    else {
      var want = template ? template.surfaces.map(function (s) { return s.id; }) : [];
      if (input.surfaces.length !== want.length) errors.push(PDError('bad-surfaces', 'document.surfaces'));
      input.surfaces.forEach(function (s, i) {
        var p = 'document.surfaces[' + i + ']';
        if (!isObject(s)) { errors.push(PDError('not-object', p)); return; }
        checkKeys(s, KEYS.surface, p, errors);
        if (s.id !== want[i]) errors.push(PDError('bad-surface', p + '.id'));
        if (!colors[s.base]) errors.push(PDError('bad-color-ref', p + '.base'));
        if (!Array.isArray(s.layers) || s.layers.length > LIMITS.layers) { errors.push(PDError('bad-layers', p + '.layers')); return; }
        s.layers.forEach(function (n, j) { validateLayer(n, p + '.layers[' + j + ']', colors, errors, ids); });
      });
    }
    if (errors.length) {
      var e = PDError(errors[0].code, errors[0].path);
      e.errors = errors;
      throw e;
    }
    return canonical(input);
  }

  /** A copy with every object's keys in the declared order: one document, one text. */
  function canonical(doc) {
    function pick(o, keys) { var out = {}; for (var i = 0; i < keys.length; i++) out[keys[i]] = clone(o[keys[i]]); return out; }
    var out = pick(doc, ['format', 'version', 'name']);
    out.template = pick(doc.template, KEYS.template);
    out.palette = doc.palette.map(function (s) { return pick(s, KEYS.swatch); });
    out.parts = pick(doc.parts, PARTS);
    out.surfaces = doc.surfaces.map(function (s) {
      return { id: s.id, base: s.base, layers: s.layers.map(function (n) { return pick(n, KEYS[n.type]); }) };
    });
    return out;
  }

  /** Parse text into a validated document. Refuses an oversized file before parsing it. */
  function parseDocument(text, template) {
    if (typeof text !== 'string') throw PDError('not-text');
    if (byteLength(text) > LIMITS.bytes) throw PDError('too-large');
    var data;
    try { data = JSON.parse(text); } catch (_) { throw PDError('not-json'); }
    return validateDocument(data, template);
  }
  function serializeDocument(doc) { return JSON.stringify(canonical(doc), null, 2) + '\n'; }

  // ── a new design ──────────────────────────────────────────────────────────

  /**
   * A starting design on the template: the template's sample palette, trims and
   * layers. `names` words the layer names in the reader's language; once created
   * they are the design's own data, like anything the reader types.
   */
  function createDocument(template, name, names) {
    names = names || {};
    var start = template.start;
    var doc = {
      format: FORMAT, version: VERSION, name: String(name || 'Design').slice(0, LIMITS.name),
      template: { key: template.key, version: template.templateVersion },
      palette: start.palette.map(function (s) { return { id: s.id, label: names[s.label] || s.label, srgb: s.srgb }; }),
      parts: clone(start.parts),
      surfaces: template.surfaces.map(function (s) {
        var own = start.surfaces[s.id] || { base: start.palette[0].id, layers: [] };
        return { id: s.id, base: own.base, layers: own.layers.map(function (n) {
          var layer = clone(n);
          if (names[layer.name]) layer.name = names[layer.name];
          return layer;
        }) };
      }),
    };
    return validateDocument(doc, template);
  }

  // ── finding things ────────────────────────────────────────────────────────

  function findLayer(doc, id) {
    for (var i = 0; i < doc.surfaces.length; i++) {
      var ls = doc.surfaces[i].layers;
      for (var j = 0; j < ls.length; j++) if (ls[j].id === id) return { surface: doc.surfaces[i], index: j, layer: ls[j] };
    }
    return null;
  }
  function findSurface(doc, id) {
    for (var i = 0; i < doc.surfaces.length; i++) if (doc.surfaces[i].id === id) return doc.surfaces[i];
    return null;
  }
  function findSwatch(doc, id) {
    for (var i = 0; i < doc.palette.length; i++) if (doc.palette[i].id === id) return { index: i, swatch: doc.palette[i] };
    return null;
  }
  function colorSet(doc) { var o = {}; for (var i = 0; i < doc.palette.length; i++) o[doc.palette[i].id] = 1; return o; }
  function allIds(doc) {
    var o = colorSet(doc);
    doc.surfaces.forEach(function (s) { s.layers.forEach(function (n) { o[n.id] = 1; }); });
    return o;
  }
  /** The next free id with this prefix: l1, l2 … or c1, c2 … */
  function nextId(doc, prefix, taken) {
    var used = allIds(doc);
    if (taken) for (var k in taken) used[k] = 1;
    for (var i = 1; ; i++) if (!used[prefix + i]) return prefix + i;
  }
  /** Is this colour used anywhere — a surface, a trim, a layer? */
  function swatchInUse(doc, id) {
    if (doc.parts.collar === id || doc.parts.cuffs === id) return true;
    return doc.surfaces.some(function (s) {
      return s.base === id || s.layers.some(function (n) { return n.color === id || n.outline === id; });
    });
  }

  // ── operations ────────────────────────────────────────────────────────────
  //
  //   { op: 'set', target: { kind: doc|swatch|surface|part|layer, id }, key, value }
  //   { op: 'insert', surface, index, layer }       { op: 'remove', id }
  //   { op: 'move', id, index }                     { op: 'batch', ops: [op] }
  //   { op: 'paletteInsert', index, swatch }        { op: 'paletteRemove', id }
  //
  // applyOp changes the document in place and returns the operation that undoes
  // it exactly, or throws (changing nothing) when the operation is not allowed.

  function applyOp(doc, op) {
    if (!isObject(op)) throw PDError('bad-op');
    switch (op.op) {
      case 'set': return applySet(doc, op);
      case 'insert': return applyInsert(doc, op);
      case 'remove': return applyRemove(doc, op);
      case 'move': return applyMove(doc, op);
      case 'paletteInsert': return applyPaletteInsert(doc, op);
      case 'paletteRemove': return applyPaletteRemove(doc, op);
      case 'batch': return applyBatch(doc, op);
      default: throw PDError('bad-op', safe(op.op));
    }
  }

  function applySet(doc, op) {
    var t = op.target || {};
    var key = op.key, value = op.value, colors = colorSet(doc), obj, settable, type;
    if (t.kind === 'doc') { obj = doc; settable = SETTABLE.doc; type = 'doc'; }
    else if (t.kind === 'swatch') { var sw = findSwatch(doc, t.id); if (!sw) throw PDError('not-found', safe(t.id)); obj = sw.swatch; settable = SETTABLE.swatch; type = 'swatch'; }
    else if (t.kind === 'surface') { obj = findSurface(doc, t.id); if (!obj) throw PDError('not-found', safe(t.id)); settable = SETTABLE.surface; type = 'surface'; }
    else if (t.kind === 'part') {
      if (!has(PARTS, t.id) || key !== 'color') throw PDError('not-settable', safe(t.id));
      if (!colors[value]) throw PDError('bad-color-ref', 'parts.' + t.id);
      var was = doc.parts[t.id];
      doc.parts[t.id] = value;
      return { op: 'set', target: { kind: 'part', id: t.id }, key: 'color', value: was };
    } else if (t.kind === 'layer') { var f = findLayer(doc, t.id); if (!f) throw PDError('not-found', safe(t.id)); obj = f.layer; settable = SETTABLE[obj.type]; type = obj.type; }
    else throw PDError('bad-target');
    if (!has(settable, key)) throw PDError('not-settable', safe(key));
    var problem = fieldProblem(type, key, value, colors);
    if (problem) throw PDError(problem, safe(key));
    var before = obj[key];
    obj[key] = value;
    return { op: 'set', target: { kind: t.kind, id: t.id }, key: key, value: before };
  }

  function applyInsert(doc, op) {
    var s = findSurface(doc, op.surface);
    if (!s) throw PDError('not-found', safe(op.surface));
    if (s.layers.length >= LIMITS.layers) throw PDError('too-many-layers');
    if (!isWhole(op.index, 0, s.layers.length)) throw PDError('bad-index');
    var errors = [], ids = allIds(doc);
    validateLayer(op.layer, 'layer', colorSet(doc), errors, ids);
    if (errors.length) throw errors[0];
    s.layers.splice(op.index, 0, clone(op.layer));
    return { op: 'remove', id: op.layer.id };
  }

  function applyRemove(doc, op) {
    var f = findLayer(doc, op.id);
    if (!f) throw PDError('not-found', safe(op.id));
    f.surface.layers.splice(f.index, 1);
    return { op: 'insert', surface: f.surface.id, index: f.index, layer: f.layer };
  }

  function applyMove(doc, op) {
    var f = findLayer(doc, op.id);
    if (!f) throw PDError('not-found', safe(op.id));
    if (!isWhole(op.index, 0, f.surface.layers.length - 1)) throw PDError('bad-index');
    f.surface.layers.splice(f.index, 1);
    f.surface.layers.splice(op.index, 0, f.layer);
    return { op: 'move', id: op.id, index: f.index };
  }

  function applyPaletteInsert(doc, op) {
    if (doc.palette.length >= LIMITS.palette) throw PDError('too-many-colours');
    if (!isWhole(op.index, 0, doc.palette.length)) throw PDError('bad-index');
    var s = op.swatch;
    if (!isObject(s)) throw PDError('not-object', 'swatch');
    var errors = [];
    checkKeys(s, KEYS.swatch, 'swatch', errors);
    if (typeof s.id !== 'string' || !ID_RE.test(s.id) || allIds(doc)[s.id]) errors.push(PDError('bad-id', 'swatch.id'));
    if (fieldProblem('swatch', 'label', s.label, {})) errors.push(PDError('bad-label', 'swatch.label'));
    if (fieldProblem('swatch', 'srgb', s.srgb, {})) errors.push(PDError('bad-colour', 'swatch.srgb'));
    if (errors.length) throw errors[0];
    doc.palette.splice(op.index, 0, { id: s.id, label: s.label, srgb: s.srgb });
    return { op: 'paletteRemove', id: s.id };
  }

  function applyPaletteRemove(doc, op) {
    var f = findSwatch(doc, op.id);
    if (!f) throw PDError('not-found', safe(op.id));
    if (doc.palette.length <= 1) throw PDError('last-colour');
    if (swatchInUse(doc, op.id)) throw PDError('colour-in-use');
    doc.palette.splice(f.index, 1);
    return { op: 'paletteInsert', index: f.index, swatch: f.swatch };
  }

  /** All or nothing: an operation that fails part way undoes the ones before it. */
  function applyBatch(doc, op) {
    if (!Array.isArray(op.ops) || !op.ops.length) throw PDError('bad-op', 'batch');
    var inverses = [];
    try {
      for (var i = 0; i < op.ops.length; i++) inverses.unshift(applyOp(doc, op.ops[i]));
    } catch (e) {
      for (var j = 0; j < inverses.length; j++) applyOp(doc, inverses[j]);
      throw e;
    }
    return { op: 'batch', ops: inverses };
  }

  // ── history ───────────────────────────────────────────────────────────────

  function createHistory(limit) { return { past: [], future: [], limit: isWhole(limit, 1, 10000) ? limit : LIMITS.history }; }
  function push(history, entry) {
    history.past.push(entry);
    if (history.past.length > history.limit) history.past.shift();
    history.future.length = 0;
  }
  /** Apply an operation and remember how to undo it. Returns the inverse. */
  function commit(doc, history, op, label) {
    var inverse = applyOp(doc, op);
    push(history, { op: clone(op), inverse: inverse, label: label || '' });
    return inverse;
  }
  /**
   * Remember an operation the editor has already applied, a little at a time —
   * a drag — as one step, with the operation that returns to where it began.
   */
  function record(history, op, inverse, label) { push(history, { op: clone(op), inverse: clone(inverse), label: label || '' }); }
  function undo(doc, history) {
    var e = history.past.pop();
    if (!e) return null;
    applyOp(doc, e.inverse);
    history.future.push(e);
    return e;
  }
  function redo(doc, history) {
    var e = history.future.pop();
    if (!e) return null;
    e.inverse = applyOp(doc, e.op);
    history.past.push(e);
    return e;
  }

  // ── geometry, in millimetres ──────────────────────────────────────────────

  /** An outline as a polygon: each curve sampled at the same twelve points, always. */
  function flatten(outline) {
    var pts = [[outline[0][0], outline[0][1]]];
    for (var i = 1; i < outline.length; i++) {
      var p = outline[i], a = pts[pts.length - 1];
      if (p.length === 4) {
        for (var k = 1; k <= 12; k++) {
          var t = k / 12, u = 1 - t;
          pts.push([u * u * a[0] + 2 * u * t * p[2] + t * t * p[0], u * u * a[1] + 2 * u * t * p[3] + t * t * p[1]]);
        }
      } else pts.push([p[0], p[1]]);
    }
    return pts;
  }
  /** The same outline as an SVG path, closed. Numbers only: nothing a reader typed. */
  function outlinePath(outline) {
    var d = 'M' + outline[0][0] + ' ' + outline[0][1];
    for (var i = 1; i < outline.length; i++) {
      var p = outline[i];
      d += p.length === 4 ? ' Q' + p[2] + ' ' + p[3] + ' ' + p[0] + ' ' + p[1] : ' L' + p[0] + ' ' + p[1];
    }
    return d + ' Z';
  }
  function boxCorners(b) {
    var a = b.r * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), hw = b.w / 2, hh = b.h / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(function (p) { return [b.x + p[0] * c - p[1] * s, b.y + p[0] * s + p[1] * c]; });
  }
  function pointInPolygon(p, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  function orient(a, b, c) { var v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0; }
  function onSegment(a, b, p) { return Math.min(a[0], b[0]) - 1e-9 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-9; }
  function segmentsIntersect(p1, p2, q1, q2) {
    var o1 = orient(p1, p2, q1), o2 = orient(p1, p2, q2), o3 = orient(q1, q2, p1), o4 = orient(q1, q2, p2);
    if (o1 !== o2 && o3 !== o4) return true;
    return (o1 === 0 && onSegment(p1, p2, q1)) || (o2 === 0 && onSegment(p1, p2, q2)) || (o3 === 0 && onSegment(q1, q2, p1)) || (o4 === 0 && onSegment(q1, q2, p2));
  }
  /** Is the whole rotated box inside the polygon? Every corner inside, and no edge crossing — so a concave notch is caught. */
  function boxInPolygon(box, poly) {
    var c = boxCorners(box);
    for (var i = 0; i < 4; i++) if (!pointInPolygon(c[i], poly)) return false;
    for (var e = 0; e < 4; e++) {
      var a = c[e], b = c[(e + 1) % 4];
      for (var k = 0, m = poly.length - 1; k < poly.length; m = k++) if (segmentsIntersect(a, b, poly[m], poly[k])) return false;
    }
    return true;
  }
  /** Does the point lie inside the box (rotated about its centre)? */
  function pointInBox(p, b) {
    var a = -b.r * Math.PI / 180, dx = p.x - b.x, dy = p.y - b.y;
    var lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
    return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
  }
  /** The topmost visible, unlocked box layer under a point, or null. Patterns cover the surface and are chosen from the layer list. */
  function hitTest(surface, p) {
    for (var i = surface.layers.length - 1; i >= 0; i--) {
      var n = surface.layers[i];
      if (!has(BOX_TYPES, n.type) || !n.visible || n.locked) continue;
      if (pointInBox(p, n)) return n.id;
    }
    return null;
  }

  /**
   * Resize a box from one of its handles: hx, hy ∈ {-1, 0, 1} name the edges the
   * handle moves; the opposite edge stays where it is, in surface coordinates,
   * whatever the rotation. A corner keeps the proportions unless `free`.
   */
  function resizeBox(b, hx, hy, p, free) {
    var a = b.r * Math.PI / 180, ux = [Math.cos(a), Math.sin(a)], uy = [-Math.sin(a), Math.cos(a)];
    var ax = -hx * b.w / 2, ay = -hy * b.h / 2;
    var A = [b.x + ux[0] * ax + uy[0] * ay, b.y + ux[1] * ax + uy[1] * ay];
    var d = [p.x - A[0], p.y - A[1]];
    var w = hx ? Math.max(LIMITS.minSize, hx * (d[0] * ux[0] + d[1] * ux[1])) : b.w;
    var h = hy ? Math.max(LIMITS.minSize, hy * (d[0] * uy[0] + d[1] * uy[1])) : b.h;
    if (hx && hy && !free) { var s = Math.max(w / b.w, h / b.h); w = b.w * s; h = b.h * s; }
    w = clamp(w, LIMITS.minSize, LIMITS.size); h = clamp(h, LIMITS.minSize, LIMITS.size);
    var cx = A[0] + ux[0] * (hx * w / 2) + uy[0] * (hy * h / 2);
    var cy = A[1] + ux[1] * (hx * w / 2) + uy[1] * (hy * h / 2);
    return { x: mm(clamp(cx, -LIMITS.coord, LIMITS.coord)), y: mm(clamp(cy, -LIMITS.coord, LIMITS.coord)), w: mm(w), h: mm(h) };
  }
  /** Scale a box about its centre to `pct` per cent of the size it was placed at. */
  function scaleBox(b, pct) {
    var s = clamp(pct, 1, 1000) / 100;
    return { w: mm(clamp(b.w0 * s, LIMITS.minSize, LIMITS.size)), h: mm(clamp(b.h0 * s, LIMITS.minSize, LIMITS.size)) };
  }
  function scaleOf(b) { return whole(b.w / b.w0 * 100); }
  /** The rotation that points the box's top at p, in whole degrees; `step` snaps (15° with Shift). */
  function rotateToward(b, p, step) {
    var deg = Math.atan2(p.y - b.y, p.x - b.x) * 180 / Math.PI + 90;
    if (step) deg = Math.round(deg / step) * step;
    return normAngle(deg);
  }
  /**
   * Move a box's centre by a distance, snapping to the surface's centre line and,
   * when a grid is on, to the grid. `threshold` is in millimetres (a few pixels at
   * the current zoom). Returns the new centre and the guides that caught it.
   */
  function moveBox(start, dx, dy, opts) {
    opts = opts || {};
    var x = start.x + dx, y = start.y + dy, guides = [];
    var th = opts.threshold || 0;
    if (opts.centerX != null && Math.abs(x - opts.centerX) <= th) { x = opts.centerX; guides.push({ axis: 'x', at: opts.centerX }); }
    else if (opts.grid) x = Math.round(x / opts.grid) * opts.grid;
    if (opts.grid) y = Math.round(y / opts.grid) * opts.grid;
    return { x: mm(clamp(x, -LIMITS.coord, LIMITS.coord)), y: mm(clamp(y, -LIMITS.coord, LIMITS.coord)), guides: guides };
  }

  // ── the design check ──────────────────────────────────────────────────────
  //
  // Against the template's own rules, and nothing else: no supplier is connected,
  // so nothing here can say a design will be manufactured. A visible box that
  // leaves its surface's printable area is a blocker; one that crosses the safe
  // zone (seams, collar, cuffs) is a warning; lettering shorter than the
  // template's minimum is a warning. Hidden layers are not printed.

  function checkDesign(doc, template) {
    var out = [];
    doc.surfaces.forEach(function (s) {
      var ts = templateSurface(template, s.id);
      if (!ts) return;
      var print = flatten(ts.outline), safeZone = ts.safe;
      s.layers.forEach(function (n) {
        if (!n.visible || !has(BOX_TYPES, n.type)) return;
        if (!boxInPolygon(n, print)) out.push({ severity: 'blocker', code: 'outside-print-area', surface: s.id, layer: n.id });
        else if (!boxInPolygon(n, safeZone)) out.push({ severity: 'warning', code: 'crosses-safe-zone', surface: s.id, layer: n.id });
        if ((n.type === 'text' || n.type === 'roster') && n.h < template.rules.minTextHeight) out.push({ severity: 'warning', code: 'text-too-small', surface: s.id, layer: n.id });
      });
    });
    return out;
  }

  // ── the camera: pixels per millimetre ─────────────────────────────────────

  var ZOOM = Object.freeze({ min: 0.05, max: 20 });
  function clampZoom(z) { return finite(z) ? clamp(z, ZOOM.min, ZOOM.max) : 1; }
  /** The camera that shows a view box whole, centred, in a w × h pixel canvas with `pad` pixels around it. */
  function fitCamera(viewBox, w, h, pad) {
    pad = pad || 0;
    var z = clampZoom(Math.min(Math.max(1, w - 2 * pad) / viewBox[2], Math.max(1, h - 2 * pad) / viewBox[3]));
    return { cx: viewBox[0] + viewBox[2] / 2, cy: viewBox[1] + viewBox[3] / 2, z: z };
  }
  /** The SVG viewBox a camera shows in a w × h pixel canvas. */
  function viewBoxOf(cam, w, h) { return [cam.cx - w / (2 * cam.z), cam.cy - h / (2 * cam.z), w / cam.z, h / cam.z]; }
  function toWorld(cam, w, h, p) { return { x: cam.cx + (p.x - w / 2) / cam.z, y: cam.cy + (p.y - h / 2) / cam.z }; }
  /** Zoom to z, keeping the surface point under the pointer p where it is. */
  function zoomAt(cam, w, h, z, p) {
    z = clampZoom(z);
    var at = toWorld(cam, w, h, p);
    return { cx: at.x - (p.x - w / 2) / z, cy: at.y - (p.y - h / 2) / z, z: z };
  }
  function panBy(cam, dx, dy) { return { cx: cam.cx - dx / cam.z, cy: cam.cy - dy / cam.z, z: cam.z }; }

  /** A file name for an export: the design's name, reduced to safe characters. */
  function exportFileName(name) {
    var slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return (slug || 'design') + '.familista-product-design.json';
  }

  return Object.freeze({
    FORMAT: FORMAT, VERSION: VERSION, TEMPLATE_FORMAT: TEMPLATE_FORMAT, LIMITS: LIMITS, ZOOM: ZOOM,
    PATTERNS: PATTERNS, SHAPES: SHAPES, FONTS: FONTS, ROSTER_FIELDS: ROSTER_FIELDS, LAYER_TYPES: LAYER_TYPES,
    BOX_TYPES: BOX_TYPES, PARTS: PARTS, KEYS: KEYS, SETTABLE: SETTABLE,
    PDError: PDError, byteLength: byteLength, clone: clone, mm: mm, normAngle: normAngle,
    validateTemplate: validateTemplate, templateSurface: templateSurface,
    validateDocument: validateDocument, parseDocument: parseDocument, serializeDocument: serializeDocument,
    createDocument: createDocument,
    findLayer: findLayer, findSurface: findSurface, findSwatch: findSwatch, nextId: nextId, swatchInUse: swatchInUse,
    applyOp: applyOp, createHistory: createHistory, commit: commit, record: record, undo: undo, redo: redo,
    flatten: flatten, outlinePath: outlinePath, boxCorners: boxCorners, pointInPolygon: pointInPolygon,
    segmentsIntersect: segmentsIntersect, boxInPolygon: boxInPolygon, pointInBox: pointInBox, hitTest: hitTest,
    resizeBox: resizeBox, scaleBox: scaleBox, scaleOf: scaleOf, rotateToward: rotateToward, moveBox: moveBox,
    checkDesign: checkDesign,
    clampZoom: clampZoom, fitCamera: fitCamera, viewBoxOf: viewBoxOf, toWorld: toWorld, zoomAt: zoomAt, panBy: panBy,
    exportFileName: exportFileName,
  });
});
