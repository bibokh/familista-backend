/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA DESIGN SYSTEM CONTROL — COMPONENTS LIBRARY — Stage 3.2.2

   THE COMPONENTS FAMILISTA REALLY HAS, AND HOW MUCH OF EACH THE REPOSITORY CAN
   SHOW

   Loaded on demand by public/design-system/design-system.js, the first time the
   platform owner opens the Components section — never by the page, never by
   Owner Home. It draws the Components Registry the server generated from the
   repository (src/design-system/generated/design-system-components.json) and
   serves read-only at /system/design-system/components.

   WHAT IS ON SCREEN, AND WHAT IS NOT

   Every record is a reviewed claim a person made (its name, category, kind and
   one line about it) that the generator then looked for in the repository: its
   CSS rules, its render function, its Storybook cases, the classes its function
   emits. What was found is Measured; what a person wrote is Recorded; what the
   repository cannot show is "Not instrumented", said in so many words and never
   filled in. There is no usage statistic, because the platform keeps none.

   THERE IS NO PREVIEW. A card here is a structural plate drawn from metadata,
   not a rendering of the component, and it never pretends to be one. Executable
   previews are a later stage. Nothing in this file renders a production
   component, evaluates a string or writes to anything.

   READ-ONLY, CSP-SAFE

   The only reader is the room's GET-only api(). No style attribute and no inline
   handler is written: positions and sizes are SVG attributes, states are classes,
   and every string from the manifest is escaped before it reaches the page.

   This file paints with the canonical --fam-* tokens and declares none of its own.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var K = null;                 // the room's kit
  function T(s) { return K.T(s); }
  function tf() { return K.tf.apply(null, arguments); }
  function esc(s) { return K.esc(s); }
  function num(n) { return K.num(n); }
  function code(s) { return K.code(s); }

  // ── the vocabulary ────────────────────────────────────────────────────────
  //
  // A shape for every kind, a mark for every tier and a segment for every
  // section, so nothing is told by colour alone.

  var GLYPH = {
    component: '<rect x="3.5" y="3.5" width="11" height="11" rx="2.5"/><rect x="9.5" y="9.5" width="11" height="11" rx="2.5"/>',
    primitive: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.6"/>',
    pattern: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="16" height="7" rx="1.6"/>',
    'css-family': '<path d="M5 7h14M5 12h14M5 17h9"/>',
    'layout-utility': '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16"/>',
    'page-specific': '<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4"/>',
    candidate: '<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/><path d="M9.7 9.6a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.9-1.1 1.7M12 16.6v.01"/>',
  };
  var TIER_GLYPH = {
    verified: '<path d="M12 3.2 19 6v5.6c0 4.2-2.8 7.3-7 9.2-4.2-1.9-7-5-7-9.2V6z"/><path d="m8.6 12 2.4 2.4 4.4-4.8"/>',
    catalogued: '<rect x="5" y="4" width="14" height="16" rx="2.4"/><path d="M8.6 9h6.8M8.6 12.5h6.8M8.6 16h4"/>',
    listed: '<circle cx="12" cy="12" r="7.5" stroke-dasharray="2.4 3"/>',
  };
  var KIND_LABEL = {
    component: 'Production UI component', primitive: 'Shared UI primitive', pattern: 'Reusable design pattern', 'css-family': 'CSS family',
    'layout-utility': 'Layout utility', 'page-specific': 'Page-specific styles', candidate: 'Unverified candidate',
  };
  var KIND_MEANING = {
    component: 'A named unit with a production render function, CSS and a reviewed name.',
    primitive: 'Base styles for one kind of element that pages share.',
    pattern: 'A recurring composition of several parts.',
    'css-family': 'The styles of one room or module, catalogued by prefix and not as components.',
    'layout-utility': 'A class that arranges or hides, with no look of its own.',
    'page-specific': 'Styles that belong to a single page.',
    candidate: 'Looks like a component; nobody has verified that it is shared.',
  };
  var TIER_LABEL = { verified: 'Verified', catalogued: 'Catalogued', listed: 'Listed' };
  var TIER_MEANING = {
    verified: 'Render source, CSS rules and Storybook cases were all found.',
    catalogued: 'Source or CSS rules were found, without a Storybook case.',
    listed: 'Only the presence of the declared class or prefix was verified.',
  };
  var CAT_LABEL = {
    identity: 'Identity', 'data-display': 'Data display', surfaces: 'Surfaces and feedback', controls: 'Controls', shell: 'Application shell',
    'owner-kit': 'Owner room kit', families: 'Page and room families', candidates: 'Candidates',
  };
  var CAT_MEANING = {
    identity: 'Club and team identity marks.', 'data-display': 'Chips, figures, comparisons and tables.',
    surfaces: 'Panels, dialogs, messages, empty and loading states.', controls: 'Buttons, switches, filters and fields.',
    shell: 'The frame every page sits in.', 'owner-kit': 'The primitives the Design System Control room is built from.',
    families: 'Styles that belong to one page or room.', candidates: 'Look like components; not verified as reusable.',
  };
  var MODULE_LABEL = {
    core: 'Core (app.css)', competition: 'Competition', 'design-system': 'Design System Control', 'owner-home': 'Owner Home', system: 'System',
    'data-vault': 'Data Vault', 'infrastructure-city': 'Infrastructure City', 'source-core': 'Source Core', vision: 'Familista Vision',
    cybersecurity: 'Cybersecurity', algorithms: 'Algorithms', unclassified: 'Unclassified',
  };
  var SECTIONS = ['overview', 'anatomy', 'styling', 'source', 'variants', 'stories', 'accessibility', 'dependencies'];
  var SECTION_LABEL = {
    overview: 'Overview', anatomy: 'Anatomy', styling: 'Styling', source: 'Source', variants: 'Variants',
    stories: 'Stories', accessibility: 'Accessibility', dependencies: 'Dependencies',
  };
  var NOT_INSTRUMENTED = {
    anatomy: 'No parts are declared for this component.',
    styling: 'Only the presence of the declared class or prefix is verified; its rules are not counted.',
    source: 'No source was found for this component.',
    variants: 'No variants are declared for this component.',
    stories: 'No Storybook story covers this component.',
    accessibility: 'No accessibility fact was found in the source, and no audit is recorded.',
    dependencies: 'No call, caller or custom property is recorded.',
  };
  var FACETS = [
    ['source', 'Has source'], ['styling', 'Has styling'], ['anatomy', 'Has anatomy'], ['variants', 'Has variants'],
    ['stories', 'Has Storybook cases'], ['accessibility', 'Has accessibility facts'], ['dependencies', 'Has dependencies'],
  ];
  var MODES = [['cards', 'Cards'], ['compact', 'Compact'], ['list', 'List'], ['table', 'Table']];

  // ── state ─────────────────────────────────────────────────────────────────

  function fresh() {
    return {
      index: null, indexError: null, loading: false,
      detail: Object.create(null), detailError: Object.create(null), detailLoading: Object.create(null),
      sel: null, tab: 'overview', q: '', cat: 'all', mode: 'cards',
      fKind: Object.create(null), fTier: Object.create(null), fModule: Object.create(null), fHas: Object.create(null),
      sort: { key: 'order', dir: 1 }, popOpen: false, rove: null,
      shown: [], hay: Object.create(null), byId: Object.create(null),
    };
  }
  var S = fresh();
  var R = { host: null, root: null, stage: null, insp: null, bound: [] };
  var M = { drawMs: null, filterMs: null, selectMs: null, total: 0, shown: 0, domNodes: 0 };

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function rtl() { return K && K.dir() === 'rtl'; }
  function label(map, id) { return map[id] ? T(map[id]) : String(id); }
  function tax(kind, id) {
    var list = S.index && S.index.taxonomy ? S.index.taxonomy[kind] : [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function sourceOf(id) {
    var list = (S.index && S.index.sources) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  /** One, or many: "1 rule", "8 rules". The word is chosen by the count, never pluralised by appending. */
  function countText(n, one, many) { return n === 1 ? tf('%d ' + one, n) : tf('%d ' + many, n); }
  function measuredCount(sec) {
    var n = 0;
    for (var i = 0; i < SECTIONS.length; i++) if (sec[SECTIONS[i]] !== 'NONE') n++;
    return n;
  }

  // ── loading ───────────────────────────────────────────────────────────────

  function loadIndex() {
    S.loading = true;
    return K.api('/system/design-system/components').then(function (d) {
      var missing = ['state', 'sources', 'components'].filter(function (k) { return !d || d[k] === undefined || d[k] === null; });
      if (missing.length) { S.index = null; S.indexError = K.contractError('/system/design-system/components', missing); return; }
      if (d.state !== 'READY') { S.index = null; S.indexError = d.reason || T('The components could not be read'); return; }
      S.index = d; S.indexError = null;
      S.byId = Object.create(null);
      d.components.forEach(function (c, i) { c.order = i; S.byId[c.id] = c; });
      buildHaystack();
    }).catch(function (e) { S.index = null; S.indexError = e.message; })
      .then(function () { S.loading = false; });
  }

  function buildHaystack() {
    S.hay = Object.create(null);
    S.index.components.forEach(function (c) {
      S.hay[c.id] = [c.name, c.id, c.symbol || '', c.summary, T(c.summary), c.kind, label(KIND_LABEL, c.kind), c.category, label(CAT_LABEL, c.category),
        c.module, label(MODULE_LABEL, c.module), c.tier, label(TIER_LABEL, c.tier)].join(' ').toLowerCase();
    });
  }

  function loadDetail(id) {
    if (S.detail[id] || S.detailLoading[id]) return S.detailLoading[id] || Promise.resolve();
    S.detailLoading[id] = K.api('/system/design-system/components?id=' + encodeURIComponent(id)).then(function (d) {
      var missing = ['state', 'component'].filter(function (k) { return !d || d[k] === undefined; });
      if (missing.length) { S.detailError[id] = K.contractError('/system/design-system/components?id=' + id, missing); return; }
      if (d.state !== 'READY' || !d.component) { S.detailError[id] = d.reason || T('The component could not be read'); return; }
      S.detail[id] = d.component; delete S.detailError[id];
    }).catch(function (e) { S.detailError[id] = e.message; })
      .then(function () { delete S.detailLoading[id]; });
    return S.detailLoading[id];
  }

  // ── filtering ─────────────────────────────────────────────────────────────

  function on(set) { for (var k in set) if (set[k]) return true; return false; }
  function activeFilters() {
    var n = 0, g;
    for (g in S.fKind) if (S.fKind[g]) n++;
    for (g in S.fTier) if (S.fTier[g]) n++;
    for (g in S.fModule) if (S.fModule[g]) n++;
    for (g in S.fHas) if (S.fHas[g]) n++;
    return n;
  }

  /** The components that pass the search and every filter except the category. */
  function passing() {
    if (!S.index) return [];
    var terms = S.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var kinds = on(S.fKind), tiers = on(S.fTier), mods = on(S.fModule);
    return S.index.components.filter(function (c) {
      if (kinds && !S.fKind[c.kind]) return false;
      if (tiers && !S.fTier[c.tier]) return false;
      if (mods && !S.fModule[c.module]) return false;
      for (var f in S.fHas) if (S.fHas[f] && c.sections[f] === 'NONE') return false;
      if (terms.length) { var h = S.hay[c.id]; for (var i = 0; i < terms.length; i++) if (h.indexOf(terms[i]) < 0) return false; }
      return true;
    });
  }
  function compute() {
    var t0 = now();
    var base = passing();
    S.categoryCounts = Object.create(null);
    base.forEach(function (c) { var b = S.categoryCounts[c.category] || (S.categoryCounts[c.category] = { total: 0, verified: 0, catalogued: 0, listed: 0 }); b.total++; b[c.tier]++; });
    S.shown = S.cat === 'all' ? base : base.filter(function (c) { return c.category === S.cat; });
    if (S.sort.key !== 'order') {
      var key = S.sort.key, dir = S.sort.dir;
      S.shown = S.shown.slice().sort(function (a, b) {
        var x = sortValue(a, key), y = sortValue(b, key);
        return (x < y ? -1 : x > y ? 1 : a.order - b.order) * dir;
      });
    }
    M.filterMs = Math.round((now() - t0) * 10) / 10;
  }
  function sortValue(c, key) {
    switch (key) {
      case 'name': return c.name.toLowerCase();
      case 'kind': return c.kind;
      case 'category': return c.category;
      case 'module': return c.module;
      case 'tier': return ['verified', 'catalogued', 'listed'].indexOf(c.tier);
      case 'rules': return c.counts.rules;
      case 'variants': return c.counts.variants;
      case 'cases': return c.counts.cases;
      case 'evidence': return measuredCount(c.sections);
      default: return c.order;
    }
  }

  // ── drawing pieces ────────────────────────────────────────────────────────

  function svgIcon(inner, cls, size) {
    return '<svg class="cl-ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16)
      + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + inner + '</svg>';
  }
  function kindMark(kind) { return '<span class="cl-kind">' + svgIcon(GLYPH[kind] || GLYPH.component, '', 15) + '<span>' + esc(label(KIND_LABEL, kind)) + '</span></span>'; }
  function tierMark(tier) {
    return '<span class="cl-tier cl-tier--' + tier + '">' + svgIcon(TIER_GLYPH[tier], '', 14) + '<span>' + esc(label(TIER_LABEL, tier)) + '</span></span>';
  }

  /** Eight segments, one per inspector section, filled by how that section is known. Also a number, so it is never colour alone. */
  function ring(sec, size) {
    var cx = 22, cy = 22, r = 16.5, d = '';
    for (var i = 0; i < SECTIONS.length; i++) {
      var a0 = (-90 + i * 45 + 4) * Math.PI / 180, a1 = (-90 + i * 45 + 41) * Math.PI / 180;
      var x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      var st = sec[SECTIONS[i]];
      d += '<path class="cl-seg cl-seg--' + (st === 'MEASURED' ? 'm' : st === 'RECORDED' ? 'r' : 'n') + '" d="M' + x0.toFixed(2) + ' ' + y0.toFixed(2)
        + 'A' + r + ' ' + r + ' 0 0 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2) + '"/>';
    }
    return '<svg class="cl-ring" viewBox="0 0 44 44" width="' + size + '" height="' + size + '" aria-hidden="true" focusable="false">' + d
      + '<text class="cl-ring-n" x="22" y="26" text-anchor="middle">' + measuredCount(sec) + '</text></svg>';
  }
  function ringText(sec) { return tf('%d of %d sections have evidence', measuredCount(sec), SECTIONS.length); }

  /** How a section is known. The room's own chips for Measured and Recorded; "Not instrumented" for nothing. */
  function evidenceChip(state) {
    if (state === 'NONE') return K.chip('none', T('Not instrumented'), T('The repository records nothing for this. It is not filled in.'), 'ds-chip--sm');
    return K.evChip(state);
  }

  function metricsLine(c) {
    var parts = [];
    if (c.counts.rules) parts.push('<span>' + esc(countText(c.counts.rules, 'rule', 'rules')) + '</span>');
    if (c.counts.variants) parts.push('<span>' + esc(countText(c.counts.variants, 'variant', 'variants')) + '</span>');
    if (c.counts.cases) parts.push('<span>' + esc(countText(c.counts.cases, 'case', 'cases')) + '</span>');
    return parts.length ? parts.join('') : '<span class="cl-dim">' + esc(T('no counts recorded')) + '</span>';
  }

  function cardHtml(c, compact) {
    var sel = S.sel === c.id;
    var sym = c.symbol ? c.symbol : c.id;
    if (compact) {
      return '<li class="cl-item"><button type="button" class="cl-card cl-card--compact cl-t-' + c.tier + '" data-cl-id="' + esc(c.id) + '" aria-pressed="' + (sel ? 'true' : 'false') + '" tabindex="-1">'
        + '<span class="cl-card-top">' + svgIcon(GLYPH[c.kind] || GLYPH.component, 'cl-kind-ic', 15) + '<span class="cl-card-name" data-no-i18n>' + esc(c.name) + '</span>'
        + '<span class="cl-tier-dot cl-tier--' + c.tier + '" title="' + esc(label(TIER_LABEL, c.tier)) + '">' + svgIcon(TIER_GLYPH[c.tier], '', 13) + '</span></span>'
        + '<span class="cl-card-sym" data-no-i18n>' + esc(sym) + '</span>'
        + '<span class="cl-sr">' + esc(label(KIND_LABEL, c.kind) + ', ' + label(TIER_LABEL, c.tier) + ', ' + ringText(c.sections)) + '</span></button></li>';
    }
    return '<li class="cl-item"><button type="button" class="cl-card cl-t-' + c.tier + '" data-cl-id="' + esc(c.id) + '" aria-pressed="' + (sel ? 'true' : 'false') + '" tabindex="-1">'
      + '<span class="cl-card-top">' + kindMark(c.kind) + tierMark(c.tier) + '</span>'
      + '<span class="cl-card-name" data-no-i18n>' + esc(c.name) + '</span>'
      + '<span class="cl-card-sym" data-no-i18n>' + esc(sym) + '</span>'
      + '<span class="cl-card-sum">' + esc(T(c.summary)) + '</span>'
      + '<span class="cl-card-foot">' + ring(c.sections, 40) + '<span class="cl-card-metrics">' + metricsLine(c) + '</span>'
      + '<span class="cl-card-mod">' + esc(label(MODULE_LABEL, c.module)) + '</span></span>'
      + '<span class="cl-sr">' + esc(ringText(c.sections)) + '</span></button></li>';
  }

  function rowHtml(c) {
    var sel = S.sel === c.id;
    return '<li class="cl-item"><button type="button" class="cl-row cl-t-' + c.tier + '" data-cl-id="' + esc(c.id) + '" aria-pressed="' + (sel ? 'true' : 'false') + '" tabindex="-1">'
      + svgIcon(GLYPH[c.kind] || GLYPH.component, 'cl-kind-ic', 16)
      + '<span class="cl-row-name"><span data-no-i18n>' + esc(c.name) + '</span><span class="cl-card-sym" data-no-i18n>' + esc(c.symbol || c.id) + '</span></span>'
      + '<span class="cl-row-kind">' + esc(label(KIND_LABEL, c.kind)) + '</span>'
      + '<span class="cl-row-mod">' + esc(label(MODULE_LABEL, c.module)) + '</span>'
      + tierMark(c.tier)
      + '<span class="cl-row-ring">' + ring(c.sections, 28) + '</span>'
      + '<span class="cl-sr">' + esc(ringText(c.sections)) + '</span></button></li>';
  }

  /** The gallery or the list, grouped under category headings when every category is showing. */
  function groupedHtml(list, itemFn, listClass) {
    var groups = [];
    if (S.cat === 'all') {
      var order = S.index.taxonomy.categories.map(function (x) { return x.id; });
      order.forEach(function (cat) {
        var items = list.filter(function (c) { return c.category === cat; });
        if (items.length) groups.push([cat, items]);
      });
    } else groups.push([S.cat, list]);
    return groups.map(function (g) {
      var cat = g[0], items = g[1], id = 'cl-cat-' + cat;
      return '<section class="cl-group" aria-labelledby="' + esc(id) + '">'
        + '<header class="cl-group-h"><h2 class="cl-group-t" id="' + esc(id) + '">' + esc(label(CAT_LABEL, cat)) + '</h2>'
        + '<span class="cl-group-n">' + esc(num(items.length)) + '</span>'
        + '<span class="cl-group-d">' + esc(T(CAT_MEANING[cat] || '')) + '</span></header>'
        + '<ul class="' + listClass + '">' + items.map(itemFn).join('') + '</ul></section>';
    }).join('');
  }

  /** A measured figure, or a dash where the section is not instrumented: `0` is an answer, absence is not. */
  function figure(c, sec, n) { return c.sections[sec] === 'NONE' ? '—' : num(n); }
  function tableHtml(list) {
    var cols = [['name', 'Name'], ['kind', 'Kind'], ['category', 'Category'], ['module', 'Module'], ['tier', 'Tier'], ['rules', 'Rules'], ['variants', 'Variants'], ['cases', 'Cases'], ['evidence', 'Evidence']];
    var head = cols.map(function (c) {
      var on = S.sort.key === c[0];
      var numeric = ['rules', 'variants', 'cases', 'evidence'].indexOf(c[0]) >= 0;
      return '<th scope="col"' + (numeric ? ' class="ds-num"' : '') + ' aria-sort="' + (on ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none') + '">'
        + '<button type="button" class="cl-sort' + (on ? ' is-on' : '') + '" data-cl-sort="' + c[0] + '">' + esc(T(c[1]))
        + '<span class="cl-sort-ch" aria-hidden="true">' + (on ? (S.sort.dir > 0 ? '↑' : '↓') : '↕') + '</span></button></th>';
    }).join('');
    var body = list.map(function (c) {
      var sel = S.sel === c.id;
      return '<tr' + (sel ? ' class="is-cur"' : '') + '><td><button type="button" class="cl-link" data-cl-id="' + esc(c.id) + '" aria-pressed="' + (sel ? 'true' : 'false') + '" tabindex="-1">'
        + svgIcon(GLYPH[c.kind] || GLYPH.component, 'cl-kind-ic', 15) + '<span data-no-i18n>' + esc(c.name) + '</span></button></td>'
        + '<td>' + esc(label(KIND_LABEL, c.kind)) + '</td><td>' + esc(label(CAT_LABEL, c.category)) + '</td><td>' + esc(label(MODULE_LABEL, c.module)) + '</td>'
        + '<td>' + tierMark(c.tier) + '</td><td class="ds-num">' + esc(figure(c, 'styling', c.counts.rules)) + '</td><td class="ds-num">' + esc(figure(c, 'variants', c.counts.variants)) + '</td>'
        + '<td class="ds-num">' + esc(figure(c, 'stories', c.counts.cases)) + '</td><td class="ds-num">' + esc(tf('%d of %d', measuredCount(c.sections), SECTIONS.length)) + '</td></tr>';
    }).join('');
    return '<div class="cl-tablewrap" tabindex="0" role="region" aria-label="' + esc(T('Every registered component')) + '"><table class="ds-table cl-table">'
      + '<caption class="ds-sr">' + esc(T('Every registered component')) + '</caption><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  // ── the library's own summary ─────────────────────────────────────────────

  function spectrumHtml() {
    var cov = S.index.coverage, total = cov.total || 1;
    var tiers = ['verified', 'catalogued', 'listed'];
    var x = 0, bar = '';
    tiers.forEach(function (t) {
      var n = cov.byTier[t] || 0, w = Math.round((n / total) * 1000) / 10;
      bar += '<rect class="cl-sp-seg cl-sp-seg--' + t + '" x="' + x + '" y="0" width="' + w + '" height="6" rx="1.5"/>';
      x += w;
    });
    return '<section class="cl-spectrum" aria-label="' + esc(T('Library coverage')) + '">'
      + '<div class="cl-sp-total"><span class="cl-sp-n">' + esc(num(cov.total)) + '</span><span class="cl-sp-l">' + esc(T('registered')) + '</span></div>'
      + tiers.map(function (t) {
        return '<div class="cl-sp-tier cl-tier--' + t + '">' + svgIcon(TIER_GLYPH[t], '', 18) + '<span class="cl-sp-tn">' + esc(num(cov.byTier[t] || 0)) + '</span>'
          + '<span class="cl-sp-tl">' + esc(label(TIER_LABEL, t)) + '</span></div>';
      }).join('')
      + '<p class="cl-sp-note">' + esc(T('Every record is a reviewed claim, checked against the repository. A card shows verified metadata; it is not a preview.')) + '</p>'
      + '<svg class="cl-sp-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">' + bar + '</svg></section>';
  }

  function strataHtml() {
    var cats = S.index.taxonomy.categories;
    var all = 0;
    for (var k in S.categoryCounts) all += S.categoryCounts[k].total;
    var tabs = [['all', T('All'), all, null]].concat(cats.map(function (c) { return [c.id, label(CAT_LABEL, c.id), (S.categoryCounts[c.id] || { total: 0 }).total, S.categoryCounts[c.id] || null]; }));
    return tabs.map(function (t) {
      var on = S.cat === t[0], b = t[3];
      var mini = '';
      if (b && b.total) {
        var w = 28, x = 0;
        mini = '<svg class="cl-mini" viewBox="0 0 28 3" width="28" height="3" aria-hidden="true" focusable="false">';
        ['verified', 'catalogued', 'listed'].forEach(function (tier) {
          var seg = (b[tier] / b.total) * w;
          if (seg > 0) mini += '<rect class="cl-sp-seg--' + tier + '" x="' + x.toFixed(2) + '" y="0" width="' + seg.toFixed(2) + '" height="3"/>';
          x += seg;
        });
        mini += '</svg>';
      }
      return '<button type="button" class="cl-stratum' + (on ? ' is-on' : '') + (t[2] === 0 ? ' is-empty' : '') + '" role="tab" aria-selected="' + (on ? 'true' : 'false') + '" tabindex="' + (on ? '0' : '-1') + '" data-cl-cat="' + esc(t[0]) + '">'
        + '<span class="cl-stratum-l">' + esc(t[1]) + '</span><span class="cl-stratum-n">' + esc(num(t[2])) + '</span>' + mini + '</button>';
    }).join('');
  }

  function popHtml() {
    var tax = S.index.taxonomy, present = function (field, id) { return S.index.components.some(function (c) { return c[field] === id; }); };
    var tog = function (attr, val, text, on) {
      return '<button type="button" class="cl-tog' + (on ? ' is-on' : '') + '" data-' + attr + '="' + esc(val) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(text) + '</button>';
    };
    var sec = function (title, body) { return '<div class="cl-pop-sec"><div class="cl-pop-h">' + esc(T(title)) + '</div><div class="cl-pop-row">' + body + '</div></div>'; };
    return sec('Kind', tax.kinds.filter(function (k) { return present('kind', k.id); }).map(function (k) { return tog('cl-fkind', k.id, label(KIND_LABEL, k.id), !!S.fKind[k.id]); }).join(''))
      + sec('Evidence tier', tax.tiers.map(function (t) { return tog('cl-ftier', t.id, label(TIER_LABEL, t.id), !!S.fTier[t.id]); }).join(''))
      + sec('Module', tax.modules.filter(function (m) { return present('module', m.id); }).map(function (m) { return tog('cl-fmodule', m.id, label(MODULE_LABEL, m.id), !!S.fModule[m.id]); }).join(''))
      + sec('Evidence', FACETS.map(function (f) { return tog('cl-fhas', f[0], T(f[1]), !!S.fHas[f[0]]); }).join(''))
      + '<div class="cl-pop-sec cl-pop-foot"><button type="button" class="ds-btn cl-btn" data-cl-reset>' + esc(T('Reset filters')) + '</button></div>';
  }

  function libraryInspectorHtml() {
    var cov = S.index.coverage;
    var kinds = S.index.taxonomy.kinds.map(function (k) {
      var n = cov.byKind[k.id] || 0;
      return '<li class="cl-def">' + svgIcon(GLYPH[k.id] || GLYPH.component, 'cl-kind-ic', 16) + '<span class="cl-def-t">' + esc(label(KIND_LABEL, k.id))
        + '</span><span class="cl-def-n">' + esc(num(n)) + '</span><span class="cl-def-d">' + esc(T(KIND_MEANING[k.id] || k.description || '')) + '</span></li>';
    }).join('');
    var tiers = ['verified', 'catalogued', 'listed'].map(function (t) {
      return '<li class="cl-def cl-tier--' + t + '">' + svgIcon(TIER_GLYPH[t], '', 16) + '<span class="cl-def-t">' + esc(label(TIER_LABEL, t))
        + '</span><span class="cl-def-n">' + esc(num(cov.byTier[t] || 0)) + '</span><span class="cl-def-d">' + esc(T(TIER_MEANING[t])) + '</span></li>';
    }).join('');
    var srcs = S.index.sources.map(function (s) {
      return '<li>' + code(s.path) + '<div class="ds-sub">' + esc(T(s.label)) + ' · ' + esc(s.basis === 'file' ? T('Read from the file') : T('Derived from the files')) + '</div></li>';
    }).join('');
    return '<div class="cl-ihead"><div class="cl-ikind"><span>' + esc(T('The library')) + '</span></div>'
      + '<h2 class="cl-ititle" id="cl-ititle" tabindex="-1">' + esc(T('Components')) + '</h2>'
      + '<div class="cl-isub">' + esc(T('Select a component to see exactly what the repository can show about it.')) + '</div></div>'
      + '<div class="cl-ibody">'
      + '<div class="cl-ih">' + esc(T('How it is known')) + '</div><ul class="cl-legend">'
      + '<li>' + evidenceChip('MEASURED') + '<span>' + esc(T('Counted or computed from the repository files by the generator.')) + '</span></li>'
      + '<li>' + evidenceChip('RECORDED') + '<span>' + esc(T('A person’s classification, committed to the repository.')) + '</span></li>'
      + '<li>' + evidenceChip('NONE') + '<span>' + esc(T('The repository records nothing for this. It is not filled in.')) + '</span></li></ul>'
      + '<div class="cl-ih">' + esc(T('Evidence tiers')) + '</div><ul class="cl-defs">' + tiers + '</ul>'
      + '<div class="cl-ih">' + esc(T('Kinds')) + '</div><ul class="cl-defs">' + kinds + '</ul>'
      + '<div class="cl-ih">' + esc(T('Read from')) + '</div><ul class="cl-srcs">' + srcs + '</ul>'
      + '<div class="ds-note">' + esc(T('The ring on a card has one segment for each inspector section: filled when the repository can show it, dotted when it cannot.')) + '</div>'
      + '</div>';
  }

  // ── the inspector ─────────────────────────────────────────────────────────

  function sectionHead(sec, c) {
    return '<div class="cl-sec-h">' + evidenceChip(c.sections[sec]) + '</div>';
  }
  function notInstrumented(sec) {
    return '<div class="cl-ni" role="status"><div class="cl-ni-t">' + esc(T('Not instrumented')) + '</div><div class="cl-ni-d">' + esc(T(NOT_INSTRUMENTED[sec])) + '</div></div>';
  }
  function yesNo(v) { return esc(T(v ? 'Yes' : 'No')); }

  function paneOverview(c) {
    var k = tax('kinds', c.kind), t = tax('tiers', c.tier);
    return sectionHead('overview', c)
      + '<p class="cl-summary">' + esc(T(c.summary)) + '</p>'
      + '<div class="ds-kv-list">'
      + K.kv('Kind', esc(label(KIND_LABEL, c.kind)))
      + K.kv('Category', esc(label(CAT_LABEL, c.category)))
      + K.kv('Module', esc(label(MODULE_LABEL, c.module)))
      + K.kv('Evidence tier', tierMark(c.tier))
      + K.kv('Identifier', code(c.id))
      + (c.source.js ? K.kv('Render function', code(c.source.js.symbol)) : '')
      + K.kv('Sections with evidence', esc(ringText(c.sections)))
      + '</div>'
      + '<div class="cl-ringline">' + ring(c.sections, 56) + '<ul class="cl-ringkey">' + SECTIONS.map(function (s) {
        return '<li><span class="cl-key cl-seg--' + (c.sections[s] === 'MEASURED' ? 'm' : c.sections[s] === 'RECORDED' ? 'r' : 'n') + '"></span>' + esc(T(SECTION_LABEL[s])) + '</li>';
      }).join('') + '</ul></div>'
      + '<div class="ds-note">' + esc(T(TIER_MEANING[c.tier])) + '</div>'
      + (c.kind === 'candidate' ? '<div class="ds-note">' + esc(T('Nobody has verified that this is a shared component. It is listed so it is not mistaken for one.')) + '</div>' : '')
      + '<div class="ds-note">' + esc(T('There is no preview: this stage lists verified metadata only.')) + '</div>';
  }
  function paneAnatomy(c) {
    if (!c.anatomy.length) return sectionHead('anatomy', c) + notInstrumented('anatomy');
    return sectionHead('anatomy', c) + '<ul class="cl-parts">' + c.anatomy.map(function (a) {
      return '<li class="cl-part">' + code('.' + a.cls) + '<span class="cl-part-r">' + esc(countText(a.rules, 'rule', 'rules')) + '</span>'
        + (a.emitted === true ? '<span class="cl-part-e">' + esc(T('Emitted by the render function')) + '</span>'
          : a.emitted === false ? '<span class="cl-part-e is-no">' + esc(T('Not emitted by the render function')) + '</span>'
            : '<span class="cl-part-e is-no">' + esc(T('Declared; there is no render function')) + '</span>') + '</li>';
    }).join('') + '</ul>';
  }
  function paneStyling(c) {
    var s = c.styling;
    if (c.depth === 'presence' || !s.rules) return sectionHead('styling', c) + notInstrumented('styling');
    return sectionHead('styling', c)
      + '<div class="ds-kv-list">'
      + K.kv('Rules that mention it', '<bdi dir="ltr">' + esc(num(s.rules)) + '</bdi>')
      + K.kv('Distinct selectors', '<bdi dir="ltr">' + esc(num(s.selectorsTotal)) + '</bdi>')
      + K.kv('Styles :focus-visible', yesNo(s.focusVisible))
      + K.kv('Has right-to-left rules', yesNo(s.rtl))
      + K.kv('Has reduced-motion rules', yesNo(s.reducedMotion))
      + K.kv('Custom properties read', '<bdi dir="ltr">' + esc(num(s.customPropertiesTotal)) + '</bdi>')
      + '</div>'
      + (s.states.length ? '<div class="cl-ih">' + esc(T('States')) + '</div><div class="cl-chips">' + s.states.map(function (x) { return '<span class="ds-tag" data-no-i18n>' + esc(x) + '</span>'; }).join('') + '</div>' : '')
      + (s.mediaQueries.length ? '<div class="cl-ih">' + esc(T('Conditions')) + '</div><ul class="cl-codes">' + s.mediaQueries.map(function (x) { return '<li>' + code(x) + '</li>'; }).join('') + '</ul>' : '')
      + '<div class="cl-ih">' + esc(T('Selectors')) + (s.selectorsTotal > s.selectors.length ? ' <span class="cl-ih-n">' + esc(tf('%d of %d', s.selectors.length, s.selectorsTotal)) + '</span>' : '') + '</div>'
      + '<ul class="cl-codes">' + s.selectors.map(function (x) { return '<li>' + code(x) + '</li>'; }).join('') + '</ul>'
      + (s.customProperties.length ? '<div class="cl-ih">' + esc(T('Custom properties read')) + '</div><div class="cl-chips">' + s.customProperties.map(function (x) { return '<span class="ds-tag" data-no-i18n>' + esc(x) + '</span>'; }).join('') + '</div>'
        + '<div class="ds-note">' + esc(T('Names only. Mapping them to canonical tokens belongs to a later stage.')) + '</div>' : '');
  }
  function paneSource(c) {
    var s = c.source;
    if (!s.js && !s.css.length && !s.presence.length) return sectionHead('source', c) + notInstrumented('source');
    var o = [sectionHead('source', c)];
    if (s.js) o.push('<div class="cl-ih">' + esc(T('Render function')) + '</div><div class="ds-kv-list">' + K.kv('File', code(s.js.file)) + K.kv('Symbol', code(s.js.symbol))
      + K.kv('SHA-256', '<span title="' + esc(s.js.sha256) + '">' + code(K.short(s.js.sha256)) + '</span>') + K.kv('Size', '<bdi dir="ltr">' + esc(num(s.js.bytes)) + ' B</bdi>') + '</div>');
    s.css.forEach(function (x) {
      o.push('<div class="cl-ih">' + esc(T('Stylesheet slice')) + '</div><div class="ds-kv-list">' + K.kv('File', code(x.file)) + K.kv('Rules', '<bdi dir="ltr">' + esc(num(x.rules)) + '</bdi>')
        + K.kv('SHA-256', '<span title="' + esc(x.sha256) + '">' + code(K.short(x.sha256)) + '</span>') + K.kv('Size', '<bdi dir="ltr">' + esc(num(x.bytes)) + ' B</bdi>') + '</div>');
    });
    s.presence.forEach(function (x) {
      o.push('<div class="cl-ih">' + esc(T('Presence verified in')) + '</div><div class="ds-kv-list">' + K.kv('File', code(x.file)) + '</div>');
    });
    o.push('<div class="cl-ih">' + esc(T('Referenced from')) + '</div>' + (c.referencedIn.length
      ? '<ul class="cl-codes">' + c.referencedIn.map(function (x) { return '<li>' + code(x) + '</li>'; }).join('') + '</ul>'
      : '<div class="ds-note">' + esc(T('No production file was found using it. This is a text scan, not usage telemetry.')) + '</div>'));
    o.push('<div class="ds-note">' + esc(T('The hash covers the component’s own slice of source, so editing something else does not change it. No source text is shown here.')) + '</div>');
    return o.join('');
  }
  function paneVariants(c) {
    if (!c.variants.length) return sectionHead('variants', c) + notInstrumented('variants');
    var n = c.variants.filter(function (v) { return v.exercised; }).length;
    return sectionHead('variants', c)
      + '<div class="ds-note">' + esc(tf('%d of %d variants are exercised by a Storybook case', n, c.variants.length)) + '</div>'
      + '<ul class="cl-vars">' + c.variants.map(function (v) {
        var cases = v.cases.concat(v.stories);
        return '<li class="cl-var"><div class="cl-var-h"><span class="cl-var-n" data-no-i18n>' + esc(v.name) + '</span>' + code('.' + v.class)
          + '<span class="cl-var-r">' + esc(countText(v.rules, 'rule', 'rules')) + '</span>'
          + (v.exercised ? '<span class="cl-var-ok">' + esc(T('Exercised')) + '</span>' : '<span class="cl-var-no">' + esc(T('No Storybook case')) + '</span>') + '</div>'
          + (cases.length ? '<div class="cl-var-c">' + cases.map(function (x) { return '<span class="ds-tag" data-no-i18n>' + esc(x) + '</span>'; }).join('') + '</div>' : '') + '</li>';
      }).join('') + '</ul>';
  }
  function paneStories(c) {
    var s = c.stories;
    if (!s) return sectionHead('stories', c) + notInstrumented('stories');
    return sectionHead('stories', c)
      + '<div class="ds-kv-list">' + K.kv('Story file', code(s.file)) + K.kv('Title', code(s.title))
      + K.kv('Stories', '<bdi dir="ltr">' + esc(num(s.cases.length)) + '</bdi>') + K.kv('Golden snapshot cases', '<bdi dir="ltr">' + esc(num(s.golden.length)) + '</bdi>') + '</div>'
      + '<div class="cl-chips">' + [['rtl', 'Right to left'], ['tablet', 'Tablet'], ['mobile', 'Mobile']].map(function (r) {
        return K.chip(s.review[r[0]] ? 'ok' : 'none', T(r[1]), s.review[r[0]] ? T('A story renders this case.') : T('No story renders this case.'), 'ds-chip--sm');
      }).join('') + '</div>'
      + '<div class="cl-ih">' + esc(T('Stories')) + '</div><div class="cl-chips">' + s.cases.map(function (x) { return '<span class="ds-tag" data-no-i18n>' + esc(x) + '</span>'; }).join('') + '</div>'
      + (s.golden.length ? '<div class="cl-ih">' + esc(T('Golden snapshot cases')) + '</div><ul class="cl-codes">' + s.golden.map(function (x) { return '<li>' + code(x) + '</li>'; }).join('') + '</ul>' : '')
      + (s.options.length ? '<div class="cl-ih">' + esc(T('Values the controls offer')) + '</div><div class="cl-chips">' + s.options.map(function (x) { return '<span class="ds-tag" data-no-i18n>' + esc(x) + '</span>'; }).join('') + '</div>' : '');
  }
  function paneAccessibility(c) {
    var f = c.accessibility.facts;
    if (!f.length) return sectionHead('accessibility', c) + notInstrumented('accessibility');
    return sectionHead('accessibility', c)
      + '<ul class="cl-facts">' + f.map(function (x) {
        var where = (x.where === 'render function' || x.where === 'stylesheet') ? '<span>' + esc(T(x.where)) + '</span>' : code(x.where);
        return '<li class="cl-fact"><span class="cl-fact-t">' + esc(T(x.label)) + '</span><span class="cl-fact-w">' + where + '</span></li>';
      }).join('') + '</ul>'
      + '<div class="ds-note">' + esc(T('These are facts found in the source. They are not an accessibility audit, and no conformance level is recorded.')) + '</div>';
  }
  function linkBtn(id, name) {
    var known = !!S.byId[id];
    return known ? '<button type="button" class="cl-link" data-cl-go="' + esc(id) + '"><span data-no-i18n>' + esc(name || (S.byId[id] && S.byId[id].name) || id) + '</span></button>' : '<span data-no-i18n>' + esc(name || id) + '</span>';
  }
  function paneDependencies(c) {
    var d = c.dependencies;
    if (!d.calls.length && !d.calledBy.length && !d.helpers.length && !c.styling.customPropertiesTotal) return sectionHead('dependencies', c) + notInstrumented('dependencies');
    var o = [sectionHead('dependencies', c)];
    o.push('<div class="cl-ih">' + esc(T('Calls')) + '</div>' + (d.calls.length ? '<ul class="cl-links">' + d.calls.map(function (x) { return '<li>' + linkBtn(x.component, null) + ' ' + code(x.symbol) + '</li>'; }).join('') + '</ul>' : '<div class="ds-note">' + esc(T('It calls no other registered component.')) + '</div>'));
    o.push('<div class="cl-ih">' + esc(T('Called by')) + '</div>' + (d.calledBy.length ? '<ul class="cl-links">' + d.calledBy.map(function (id) { return '<li>' + linkBtn(id, null) + '</li>'; }).join('') + '</ul>' : '<div class="ds-note">' + esc(T('No registered component calls it.')) + '</div>'));
    if (d.helpers.length) o.push('<div class="cl-ih">' + esc(T('Other functions it calls')) + '</div><div class="cl-chips">' + d.helpers.map(function (x) { return '<span class="ds-tag" data-no-i18n>' + esc(x) + '</span>'; }).join('') + '</div>');
    if (c.styling.customPropertiesTotal) o.push('<div class="ds-note">' + esc(tf('Its rules read %d custom properties; they are listed under Styling.', c.styling.customPropertiesTotal)) + '</div>');
    return o.join('');
  }

  var PANES = { overview: paneOverview, anatomy: paneAnatomy, styling: paneStyling, source: paneSource, variants: paneVariants, stories: paneStories, accessibility: paneAccessibility, dependencies: paneDependencies };

  function inspectorHtml() {
    if (!S.index) return '';
    if (!S.sel || !S.byId[S.sel]) return libraryInspectorHtml();
    var sum = S.byId[S.sel], c = S.detail[S.sel];
    var head = '<div class="cl-ihead"><div class="cl-ikind">' + kindMark(sum.kind) + '<button type="button" class="cl-x" data-cl-clear aria-label="' + esc(T('Close the inspector')) + '">×</button></div>'
      + '<h2 class="cl-ititle" id="cl-ititle" tabindex="-1" data-no-i18n>' + esc(sum.name) + '</h2>'
      + '<div class="cl-isub">' + code(sum.symbol || sum.id) + ' ' + tierMark(sum.tier) + '</div></div>';
    var tabs = '<div class="cl-tabs" role="tablist" aria-label="' + esc(T('Inspector sections')) + '">' + SECTIONS.map(function (sec) {
      var on = S.tab === sec, st = sum.sections[sec];
      return '<button type="button" class="cl-tab' + (on ? ' is-on' : '') + '" role="tab" id="cl-tab-' + sec + '" aria-selected="' + (on ? 'true' : 'false') + '" aria-controls="cl-pane" tabindex="' + (on ? '0' : '-1') + '" data-cl-tab="' + sec + '">'
        + '<span>' + esc(T(SECTION_LABEL[sec])) + '</span><span class="cl-tab-dot cl-seg--' + (st === 'MEASURED' ? 'm' : st === 'RECORDED' ? 'r' : 'n') + '" aria-hidden="true"></span>'
        + '<span class="cl-sr">' + esc(st === 'NONE' ? T('Not instrumented') : st === 'MEASURED' ? T('Measured') : T('Recorded')) + '</span></button>';
    }).join('') + '</div>';
    var body;
    if (S.detailError[S.sel]) body = K.emptyState('The component could not be read', S.detailError[S.sel]);
    else if (!c) body = K.skeleton(6, 'row');
    else body = PANES[S.tab](c);
    return head + tabs + '<div class="cl-pane" id="cl-pane" role="tabpanel" aria-labelledby="cl-tab-' + S.tab + '" tabindex="0">' + body + '</div>';
  }

  // ── drawing ───────────────────────────────────────────────────────────────

  function shellHtml() {
    return '<div class="cl">'
      + '<div class="cl-bar"><label class="cl-search"><span class="ds-sr">' + esc(T('Search components')) + '</span>'
      + '<input class="ds-input cl-q" id="cl-q" type="search" autocomplete="off" spellcheck="false" value="' + esc(S.q) + '" placeholder="' + esc(T('Search by name, symbol, kind or module')) + '" aria-keyshortcuts="/">'
      + '<kbd class="cl-kbd" aria-hidden="true">/</kbd></label>'
      + '<span class="cl-count" id="cl-count" role="status" aria-live="polite"></span>'
      + '<div class="cl-popwrap"><button class="ds-btn cl-btn" type="button" id="cl-filters-b" data-cl-filters aria-haspopup="true" aria-expanded="false" aria-controls="cl-pop">'
      + esc(T('Filters')) + '<span class="cl-badge" id="cl-badge" hidden></span></button><div class="cl-pop" id="cl-pop" role="group" aria-label="' + esc(T('Filters')) + '"></div></div>'
      + '<div class="ds-seg cl-modes" role="group" aria-label="' + esc(T('Display')) + '">' + MODES.map(function (m) {
        return '<button class="ds-seg-b' + (S.mode === m[0] ? ' is-on' : '') + '" type="button" data-cl-mode="' + m[0] + '" aria-pressed="' + (S.mode === m[0] ? 'true' : 'false') + '">' + esc(T(m[1])) + '</button>';
      }).join('') + '</div></div>'
      + '<div id="cl-spectrum"></div>'
      + '<div class="cl-strata" id="cl-strata" role="tablist" aria-label="' + esc(T('Categories')) + '"></div>'
      + '<div class="cl-main"><div class="cl-stage" id="cl-stage"></div><aside class="cl-insp" id="cl-insp" aria-label="' + esc(T('Component inspector')) + '"></aside></div>'
      + '<div class="ds-sr" id="cl-live" aria-live="polite" aria-atomic="true"></div></div>';
  }

  function stageHtml() {
    if (!S.index) {
      return S.indexError ? K.emptyState('The components could not be read', T(S.indexError)) : K.skeleton(8, 'row');
    }
    if (!S.shown.length) {
      return '<div class="cl-none">' + K.emptyState('No component matches', T('Clear the search or reset the filters.'),
        '<div class="ds-notice"><button type="button" class="ds-btn cl-btn" data-cl-reset>' + esc(T('Reset filters')) + '</button></div>') + '</div>';
    }
    if (S.mode === 'table') return tableHtml(S.shown);
    if (S.mode === 'list') return groupedHtml(S.shown, rowHtml, 'cl-rows');
    if (S.mode === 'compact') return groupedHtml(S.shown, function (c) { return cardHtml(c, true); }, 'cl-grid cl-grid--compact');
    return groupedHtml(S.shown, function (c) { return cardHtml(c, false); }, 'cl-grid');
  }

  function drawStage() {
    var t0 = now();
    compute();
    var stage = document.getElementById('cl-stage');
    if (!stage) return;
    var top = stage.scrollTop;                 // read before the write: the layout is still clean
    stage.innerHTML = stageHtml();
    if (top) stage.scrollTop = top;            // written only when there is a place to keep
    var strata = document.getElementById('cl-strata'); if (strata && S.index) strata.innerHTML = strataHtml();
    var count = document.getElementById('cl-count');
    if (count && S.index) count.textContent = tf('%d of %d components', S.shown.length, S.index.coverage.total);
    var badge = document.getElementById('cl-badge'), n = activeFilters();
    if (badge) { badge.hidden = n === 0; badge.textContent = n ? String(n) : ''; }
    for (var m = 0; m < MODES.length; m++) {
      var b = R.host.querySelector('[data-cl-mode="' + MODES[m][0] + '"]');
      if (b) { b.classList.toggle('is-on', S.mode === MODES[m][0]); b.setAttribute('aria-pressed', S.mode === MODES[m][0] ? 'true' : 'false'); }
    }
    setRove();
    M.drawMs = Math.round((now() - t0) * 10) / 10; M.shown = S.shown.length; M.total = S.index ? S.index.coverage.total : 0;
    M.domNodes = stage.getElementsByTagName('*').length;
  }

  function drawInspector(focusTitle) {
    var insp = document.getElementById('cl-insp');
    if (!insp) return;
    insp.innerHTML = inspectorHtml();
    requestAnimationFrame(function () { var i = document.getElementById('cl-insp'); if (i) i.scrollTop = 0; });
    if (focusTitle) { var t = document.getElementById('cl-ititle'); if (t) t.focus({ preventScroll: true }); }
  }

  function drawAll() {
    var sp = document.getElementById('cl-spectrum');
    if (sp) sp.innerHTML = S.index ? spectrumHtml() : '';
    var pop = document.getElementById('cl-pop'); if (pop && S.index) pop.innerHTML = popHtml();
    drawStage();
    drawInspector(false);
  }

  /** Exactly one card or row is in the tab order: the selected one, else the first shown. */
  function items() { return R.host ? [].slice.call(R.host.querySelectorAll('#cl-stage [data-cl-id]')) : []; }
  function setRove() {
    var list = items();
    if (!list.length) { S.rove = null; return; }
    var want = null;
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute('data-cl-id') === S.rove) want = list[i];
    if (!want) for (var j = 0; j < list.length; j++) if (list[j].getAttribute('data-cl-id') === S.sel) want = list[j];
    if (!want) want = list[0];
    for (var k = 0; k < list.length; k++) list[k].setAttribute('tabindex', list[k] === want ? '0' : '-1');
    S.rove = want.getAttribute('data-cl-id');
  }

  function announce(text) { var l = document.getElementById('cl-live'); if (l) l.textContent = text; }

  // ── selection ─────────────────────────────────────────────────────────────

  function markSelected() {
    var list = items();
    for (var i = 0; i < list.length; i++) {
      var on = list[i].getAttribute('data-cl-id') === S.sel;
      list[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      var tr = list[i].closest ? list[i].closest('tr') : null;
      if (tr) tr.classList.toggle('is-cur', on);
    }
  }

  function select(id, opts) {
    opts = opts || {};
    if (!S.byId[id]) return;
    var t0 = now();
    S.sel = id; S.rove = id;
    if (opts.resetTab) S.tab = 'overview';
    // A component the filters hide is revealed, not silently kept out of view.
    var visible = S.shown.some(function (c) { return c.id === id; });
    if (!visible) { S.q = ''; S.fKind = Object.create(null); S.fTier = Object.create(null); S.fModule = Object.create(null); S.fHas = Object.create(null); S.cat = 'all'; var q = document.getElementById('cl-q'); if (q) q.value = ''; drawAll(); }
    else { markSelected(); setRove(); }
    drawInspector(!!opts.focusInspector);
    loadDetail(id).then(function () { if (S.sel === id && R.root) drawInspector(false); });
    announce(S.byId[id].name + ', ' + label(KIND_LABEL, S.byId[id].kind) + ', ' + label(TIER_LABEL, S.byId[id].tier));
    if (opts.focusCard) { var el = R.host.querySelector('#cl-stage [data-cl-id="' + id.replace(/["\\]/g, '\\$&') + '"]'); if (el) el.focus({ preventScroll: false }); }
    M.selectMs = Math.round((now() - t0) * 10) / 10;
  }
  function clearSelection() { S.sel = null; markSelected(); drawInspector(false); announce(T('Selection cleared')); }

  function setPop(open) {
    S.popOpen = open;
    var pop = document.getElementById('cl-pop'), b = document.getElementById('cl-filters-b');
    if (pop) pop.classList.toggle('is-open', open);
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function refreshPop() {
    var pop = document.getElementById('cl-pop'); if (!pop || !S.index) return;
    var a = document.activeElement, keep = null;
    if (a && pop.contains(a)) ['data-cl-fkind', 'data-cl-ftier', 'data-cl-fmodule', 'data-cl-fhas', 'data-cl-reset'].forEach(function (k) { if (a.hasAttribute(k)) keep = [k, a.getAttribute(k)]; });
    pop.innerHTML = popHtml();
    if (keep) { var back = pop.querySelector('[' + keep[0] + (keep[1] ? '="' + keep[1].replace(/["\\]/g, '\\$&') + '"' : '') + ']'); if (back) back.focus({ preventScroll: true }); }
  }
  function resetFilters() {
    S.fKind = Object.create(null); S.fTier = Object.create(null); S.fModule = Object.create(null); S.fHas = Object.create(null);
    S.q = ''; var q = document.getElementById('cl-q'); if (q) q.value = '';
    refreshPop(); drawStage(); announce(tf('%d of %d components', S.shown.length, S.index.coverage.total));
  }

  // ── events ────────────────────────────────────────────────────────────────

  function moveFocus(from, key) {
    var list = items(); if (!list.length) return;
    var at = list.indexOf(from); if (at < 0) return;
    var next = at;
    var flip = rtl() ? -1 : 1;
    if (key === 'ArrowRight') next = at + flip;
    else if (key === 'ArrowLeft') next = at - flip;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = list.length - 1;
    else if (key === 'ArrowDown' || key === 'ArrowUp') {
      // The item directly below or above: the nearest in the next row (or previous one) that is horizontally closest.
      var r0 = from.getBoundingClientRect(), best = -1, bestScore = Infinity;
      for (var i = 0; i < list.length; i++) {
        if (i === at) continue;
        var r = list[i].getBoundingClientRect();
        var dy = key === 'ArrowDown' ? r.top - r0.top : r0.top - r.top;
        if (dy < 4) continue;
        var score = dy + Math.abs(r.left - r0.left) * 2.2;
        if (score < bestScore) { bestScore = score; best = i; }
      }
      next = best < 0 ? at : best;
    }
    next = Math.max(0, Math.min(list.length - 1, next));
    if (next === at) return;
    list[at].setAttribute('tabindex', '-1'); list[next].setAttribute('tabindex', '0'); S.rove = list[next].getAttribute('data-cl-id');
    list[next].focus();
  }

  function onClick(ev) {
    var t = ev.target; if (!t || !t.closest) return;
    var q;
    q = t.closest('[data-cl-id]');
    if (q) { select(q.getAttribute('data-cl-id'), { resetTab: S.sel !== q.getAttribute('data-cl-id') }); return; }
    if (t.closest('[data-cl-filters]')) { setPop(!S.popOpen); return; }
    q = t.closest('[data-cl-fkind]'); if (q) { var k = q.getAttribute('data-cl-fkind'); S.fKind[k] = !S.fKind[k]; refreshPop(); drawStage(); return; }
    q = t.closest('[data-cl-ftier]'); if (q) { var r = q.getAttribute('data-cl-ftier'); S.fTier[r] = !S.fTier[r]; refreshPop(); drawStage(); return; }
    q = t.closest('[data-cl-fmodule]'); if (q) { var m = q.getAttribute('data-cl-fmodule'); S.fModule[m] = !S.fModule[m]; refreshPop(); drawStage(); return; }
    q = t.closest('[data-cl-fhas]'); if (q) { var h = q.getAttribute('data-cl-fhas'); S.fHas[h] = !S.fHas[h]; refreshPop(); drawStage(); return; }
    if (t.closest('[data-cl-reset]')) { resetFilters(); return; }
    q = t.closest('[data-cl-cat]'); if (q) { S.cat = q.getAttribute('data-cl-cat'); drawStage(); var again = R.host.querySelector('[data-cl-cat="' + S.cat.replace(/["\\]/g, '\\$&') + '"]'); if (again) again.focus(); return; }
    q = t.closest('[data-cl-mode]'); if (q) { var mode = q.getAttribute('data-cl-mode'); S.mode = MODES.some(function (x) { return x[0] === mode; }) ? mode : 'cards'; drawStage(); return; }
    q = t.closest('[data-cl-sort]');
    if (q) {
      var key = q.getAttribute('data-cl-sort');
      S.sort = S.sort.key === key ? { key: key, dir: -S.sort.dir } : { key: key, dir: 1 };
      drawStage(); var s2 = R.host.querySelector('[data-cl-sort="' + key + '"]'); if (s2) s2.focus(); return;
    }
    q = t.closest('[data-cl-tab]'); if (q) { S.tab = q.getAttribute('data-cl-tab'); drawInspector(false); var f = document.getElementById('cl-tab-' + S.tab); if (f) f.focus(); return; }
    q = t.closest('[data-cl-go]'); if (q) { select(q.getAttribute('data-cl-go'), { resetTab: true, focusInspector: true }); return; }
    if (t.closest('[data-cl-clear]')) { clearSelection(); var kept = R.host.querySelector('#cl-stage [data-cl-id][tabindex="0"]'); if (kept) kept.focus(); return; }
  }
  function onInput(ev) {
    var t = ev.target;
    if (t && t.id === 'cl-q') { S.q = t.value; drawStage(); }
  }
  function onKey(ev) {
    var t = ev.target;
    if (t && t.id === 'cl-q') {
      if (ev.key === 'Escape' && S.q) { ev.preventDefault(); S.q = ''; t.value = ''; drawStage(); }
      else if (ev.key === 'ArrowDown') { var first = R.host.querySelector('#cl-stage [data-cl-id][tabindex="0"]'); if (first) { ev.preventDefault(); first.focus(); } }
      return;
    }
    if (ev.key === 'Escape') {
      if (S.popOpen) { ev.preventDefault(); setPop(false); var b = document.getElementById('cl-filters-b'); if (b) b.focus(); return; }
      if (S.sel) { ev.preventDefault(); var was = S.sel; clearSelection(); var back = R.host.querySelector('#cl-stage [data-cl-id="' + was.replace(/["\\]/g, '\\$&') + '"]'); if (back) back.focus(); }
      return;
    }
    var card = t && t.closest ? t.closest('#cl-stage [data-cl-id]') : null;
    if (card && ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(ev.key) >= 0) { ev.preventDefault(); moveFocus(card, ev.key); return; }
    var tab = t && t.closest ? t.closest('[role="tab"]') : null;
    if (tab && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].indexOf(ev.key) >= 0) {
      var list = [].slice.call(tab.parentNode.querySelectorAll('[role="tab"]')), at = list.indexOf(tab);
      var step = (ev.key === 'ArrowRight') === !rtl() ? 1 : -1;
      var next = ev.key === 'Home' ? 0 : ev.key === 'End' ? list.length - 1 : (at + step + list.length) % list.length;
      ev.preventDefault(); list[next].click();
      var cur = tab.parentNode.querySelector('[role="tab"][tabindex="0"]'); if (cur) cur.focus();
    }
  }
  function bind(target, type, fn, opts) { target.addEventListener(type, fn, opts); R.bound.push([target, type, fn, opts]); }
  function unbind() { R.bound.forEach(function (b) { b[0].removeEventListener(b[1], b[2], b[3]); }); R.bound = []; }

  // ── mount ─────────────────────────────────────────────────────────────────

  function mount(host, kit) {
    K = kit;
    unbind();
    R.host = host; host.innerHTML = shellHtml();
    R.root = host.querySelector('.cl');
    bind(host, 'click', onClick);
    bind(host, 'input', onInput);
    bind(host, 'keydown', onKey);
    bind(document, 'click', function (ev) {
      var path = ev.composedPath ? ev.composedPath() : [];
      var inside = path.some(function (el) { return el && el.classList && el.classList.contains('cl-popwrap'); });
      if (S.popOpen && !inside) setPop(false);
    });
    bind(document, 'keydown', function (ev) {
      // "/" jumps to the search, as long as the reader is not already typing.
      if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var a = document.activeElement, tag = a && a.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (a && a.isContentEditable)) return;
      var q = document.getElementById('cl-q'); if (q && R.host && R.host.contains(q)) { ev.preventDefault(); q.focus(); q.select(); }
    });
    if (S.index) { buildHaystack(); drawAll(); if (S.sel) loadDetail(S.sel).then(function () { if (R.root) drawInspector(false); }); return; }
    drawStage();
    loadIndex().then(function () { if (R.root && R.host === host) { drawAll(); if (S.index) announce(tf('%d of %d components', S.shown.length, S.index.coverage.total)); } });
  }
  function unmount() {
    unbind();
    R.root = null; R.host = null;
    S.popOpen = false; S.sel = null;
  }
  /** Forget everything read from the server (the room's Refresh). */
  function reset() { unbind(); var keep = { mode: S.mode }; S = fresh(); S.mode = keep.mode; }

  window.FamilistaDesignComponents = { mount: mount, unmount: unmount, reset: reset };

  // Figures the page itself produced, for the test suite and the performance record. Nothing else.
  window.__familistaComponentsMetrics = function () {
    return { drawMs: M.drawMs, filterMs: M.filterMs, selectMs: M.selectMs, total: M.total, shown: M.shown, domNodes: M.domNodes, mode: S.mode };
  };
}());
