#!/usr/bin/env node
// Familista — the Owner Control room illustrations, drawn from source.
// ─────────────────────────────────────────────────────────────────────────────
// Writes public/owner-control/illus/<room>.svg (and hub.svg): one picture per
// Owner Control room, plus the AI Operations Room's centre piece. They are
// vector drawings made here, line by line — no image service, no model, no
// licence to track — and the output is deterministic (a seeded generator), so
// `node scripts/owner-control-illustrations.js` reproduces the committed files
// byte for byte; tests/owner-control-map.unit.test.ts holds it to that.
//
// What a picture may contain is pinned by the same test: shapes, gradients and
// blur filters only. No text (nothing to translate, no figure to mistake for a
// measurement), no script, no handler, no external reference.
//
//   node scripts/owner-control-illustrations.js            → writes the files
//   node scripts/owner-control-illustrations.js --out=DIR  → writes them to DIR
'use strict';
const fs = require('fs');
const path = require('path');

const ARG = process.argv.find((a) => a.startsWith('--out='));
const OUT = ARG ? ARG.slice(6) : path.join(__dirname, '..', 'public', 'owner-control', 'illus');
const W = 320, H = 230;

// ── drawing kit ──────────────────────────────────────────────────────────────
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const f = (n) => Math.round(n * 10) / 10;
const pts = (a) => a.map((p) => f(p[0]) + ',' + f(p[1])).join(' ');
const pl = (a) => 'M' + a.map((p) => f(p[0]) + ' ' + f(p[1])).join(' L');
/** Isometric projection: o = [originX, originY, scale]. */
const iso = (o, x, y, z) => [o[0] + (x - y) * 0.866 * o[2], o[1] + (x + y) * 0.5 * o[2] - (z || 0) * o[2]];
const stops = (s) => s.map(([o, c, op]) => `<stop offset="${o}" stop-color="${c}"${op == null ? '' : ` stop-opacity="${op}"`}/>`).join('');
const lin = (id, s, x1, y1, x2, y2) => `<linearGradient id="${id}" x1="${x1 == null ? 0 : x1}" y1="${y1 == null ? 0 : y1}" x2="${x2 == null ? 0 : x2}" y2="${y2 == null ? 1 : y2}">${stops(s)}</linearGradient>`;
const rad = (id, s, cx, cy, r) => `<radialGradient id="${id}" cx="${cx == null ? 0.5 : cx}" cy="${cy == null ? 0.5 : cy}" r="${r == null ? 0.5 : r}">${stops(s)}</radialGradient>`;
const blur = (id, sd) => `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${sd}"/></filter>`;
/** A shape drawn twice: once blurred under itself, which is what makes an edge read as lit. */
const bloom = (inner, id, op) => `<g filter="url(#${id})" opacity="${op == null ? 0.85 : op}">${inner}</g>${inner}`;
const svg = (defs, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" fill="none"><defs>${defs}</defs>${body}</svg>\n`;

/** A box in isometric space: lit top, mid-lit left face, shaded right face, bright edges. */
function box(o, x, y, z, w, d, h, c) {
  const A = iso(o, x, y, z + h), B = iso(o, x + w, y, z + h), C = iso(o, x + w, y + d, z + h), D = iso(o, x, y + d, z + h);
  const E = iso(o, x, y + d, z), F = iso(o, x + w, y + d, z), G = iso(o, x + w, y, z);
  let s = `<polygon points="${pts([E, F, C, D])}" fill="${c.left}"/><polygon points="${pts([F, G, B, C])}" fill="${c.right}"/><polygon points="${pts([A, B, C, D])}" fill="${c.top}"/>`;
  if (c.edge) s += `<path d="${pl([D, A, B, C, D])} ${pl([D, E, F, G, B])} ${pl([C, F])}" stroke="${c.edge}" stroke-opacity="${c.eo == null ? 0.8 : c.eo}" stroke-width="${c.ew || 0.8}" stroke-linejoin="round"/>`;
  return s;
}
/** The floor: a rhombus with a grid, its near edges lit. */
function plate(o, x, y, w, d, c) {
  const P = [iso(o, x, y), iso(o, x + w, y), iso(o, x + w, y + d), iso(o, x, y + d)];
  let g = '';
  for (let i = c.step; i < w; i += c.step) g += `<path d="${pl([iso(o, x + i, y), iso(o, x + i, y + d)])}"/>`;
  for (let i = c.step; i < d; i += c.step) g += `<path d="${pl([iso(o, x, y + i), iso(o, x + w, y + i)])}"/>`;
  return `<polygon points="${pts(P)}" fill="${c.fill}"/>`
    + `<g stroke="${c.grid}" stroke-opacity="${c.go}" stroke-width=".6">${g}</g>`
    + bloom(`<path d="${pl([P[3], P[2], P[1]])}" stroke="${c.edge}" stroke-width="1.4" stroke-opacity=".9"/>`, c.bl || 'b1', 0.9)
    + `<path d="${pl([P[3], P[0], P[1]])}" stroke="${c.edge}" stroke-width=".8" stroke-opacity=".35"/>`;
}
/** Points of light, scattered once by the seed. */
function dust(n, x0, y0, x1, y1, col, rmax) {
  let s = '';
  for (let i = 0; i < n; i++) s += `<circle cx="${f(x0 + rnd() * (x1 - x0))}" cy="${f(y0 + rnd() * (y1 - y0))}" r="${f(0.5 + rnd() * (rmax || 1.3))}" fill="${col}" fill-opacity="${f(0.35 + rnd() * 0.6)}"/>`;
  return s;
}
const write = (name, s) => { fs.writeFileSync(path.join(OUT, name + '.svg'), s); };

fs.mkdirSync(OUT, { recursive: true });

// ── SYSTEM: a command centre — server racks, a console and its holographic displays ──
(function () {
  seed = 11;
  const o = [168, 146, 1];
  const rack = { top: 'url(#rt)', left: 'url(#rl)', right: 'url(#rr)', edge: '#c7d2fe', eo: 0.75 };
  let leds = '', ledsHot = '';
  const R = [[-64, -66, 62], [-42, -66, 78], [-20, -66, 56], [2, -66, 70]];
  for (const [x, y, h] of R) {
    for (let z = 8; z < h - 6; z += 6) {
      const a = iso(o, x + 3, y + 14, z), b = iso(o, x + 12, y + 14, z);
      const hot = rnd() > 0.55;
      (hot ? (ledsHot += `<path d="${pl([a, b])}"/>`) : (leds += `<path d="${pl([a, b])}"/>`));
    }
  }
  let body = `<ellipse cx="164" cy="170" rx="150" ry="56" fill="url(#pool)"/>`
    + plate(o, -76, -76, 152, 152, { fill: 'url(#fl)', grid: '#818cf8', go: 0.2, step: 19, edge: '#a5b4fc' })
    + `<ellipse cx="${iso(o, 22, 30)[0]}" cy="${iso(o, 22, 30)[1]}" rx="46" ry="23" fill="url(#pool2)"/>`;
  for (const [x, y, h] of R) body += box(o, x, y, 0, 16, 14, h, rack);
  body += bloom(`<g stroke="#67e8f9" stroke-width="1.5" stroke-linecap="round">${ledsHot}</g>`, 'b1', 1)
    + `<g stroke="#a5b4fc" stroke-opacity=".55" stroke-width="1.2" stroke-linecap="round">${leds}</g>`;
  // the console desk and its screens
  body += box(o, -6, 26, 0, 58, 18, 16, { top: '#4338ca', left: 'url(#rl)', right: '#1e1b4b', edge: '#a5b4fc', eo: 0.7 });
  const s1 = [iso(o, -2, 30, 18), iso(o, 24, 30, 18), iso(o, 24, 30, 46), iso(o, -2, 30, 46)];
  const s2 = [iso(o, 26, 30, 18), iso(o, 50, 30, 18), iso(o, 50, 30, 46), iso(o, 26, 30, 46)];
  body += `<polygon points="${pts(s1)}" fill="url(#scr)" stroke="#a5b4fc" stroke-width=".9"/><polygon points="${pts(s2)}" fill="url(#scr)" stroke="#a5b4fc" stroke-width=".9"/>`;
  let bars = '';
  [10, 16, 12, 22, 18].forEach((hh, i) => { const a = iso(o, 2 + i * 4.4, 30, 21), b = iso(o, 2 + i * 4.4, 30, 21 + hh); bars += `<path d="${pl([a, b])}"/>`; });
  body += bloom(`<g stroke="#67e8f9" stroke-width="2.2" stroke-linecap="round">${bars}</g>`, 'b1', 0.9);
  const wave = [0, 1, 2, 3, 4, 5, 6].map((i) => iso(o, 29 + i * 3.4, 30, 30 + [4, 9, 6, 12, 8, 14, 10][i]));
  body += bloom(`<path d="${pl(wave)}" stroke="#c4b5fd" stroke-width="1.4" stroke-linejoin="round"/>`, 'b1', 0.9);
  // a holographic panel over the floor, with its projector beam
  const hp = [iso(o, 40, -40, 64), iso(o, 78, -40, 64), iso(o, 78, -40, 104), iso(o, 40, -40, 104)];
  const base = iso(o, 59, -30, 0);
  body += `<polygon points="${f(base[0] - 14)},${f(base[1])} ${f(base[0] + 14)},${f(base[1])} ${f((hp[0][0] + hp[1][0]) / 2 + 22)},${f((hp[0][1] + hp[1][1]) / 2)} ${f((hp[0][0] + hp[1][0]) / 2 - 22)},${f((hp[0][1] + hp[1][1]) / 2)}" fill="url(#beam)"/>`
    + `<ellipse cx="${f(base[0])}" cy="${f(base[1])}" rx="16" ry="7" stroke="#a5b4fc" stroke-opacity=".8" fill="#312e81" fill-opacity=".6"/>`
    + bloom(`<polygon points="${pts(hp)}" fill="url(#holo)" stroke="#c7d2fe" stroke-width="1.1"/>`, 'b1', 0.7);
  const c = [(hp[0][0] + hp[2][0]) / 2, (hp[0][1] + hp[2][1]) / 2];
  body += bloom(`<circle cx="${f(c[0] - 8)}" cy="${f(c[1] + 1)}" r="9" stroke="#67e8f9" stroke-width="1.6"/><path d="M${f(c[0] - 8)} ${f(c[1] - 8)} A9 9 0 0 1 ${f(c[0] + 1)} ${f(c[1] + 1)}" stroke="#e0e7ff" stroke-width="2.4"/><circle cx="${f(c[0] - 8)}" cy="${f(c[1] + 1)}" r="2.4" fill="#e0e7ff"/>`, 'b1', 0.9)
    + `<g stroke="#c7d2fe" stroke-width="1.6" stroke-linecap="round"><path d="M${f(c[0] + 8)} ${f(c[1] - 3)}h9"/><path d="M${f(c[0] + 8)} ${f(c[1] + 2)}h6"/><path d="M${f(c[0] + 8)} ${f(c[1] + 7)}h8"/></g>`;
  // a second, smaller display at the back-left
  const hp2 = [iso(o, -76, 10, 58), iso(o, -76, 40, 58), iso(o, -76, 40, 84), iso(o, -76, 10, 84)];
  body += bloom(`<polygon points="${pts(hp2)}" fill="url(#holo)" stroke="#a5b4fc" stroke-width="1"/>`, 'b1', 0.6);
  let grid2 = '';
  for (let i = 1; i < 4; i++) grid2 += `<path d="${pl([iso(o, -76, 10 + i * 7.5, 62), iso(o, -76, 10 + i * 7.5, 62 + [12, 18, 9][i - 1])])}"/>`;
  body += `<g stroke="#c4b5fd" stroke-width="2" stroke-linecap="round">${grid2}</g>`;
  body += dust(26, 10, 6, 310, 120, '#c7d2fe', 1.2);
  write('system', svg(blur('b1', 2.2) + blur('b3', 5)
    + lin('rl', [[0, '#4f46e5'], [1, '#1e1b4b']]) + lin('rr', [[0, '#312e81'], [1, '#0f0d2e']]) + lin('rt', [[0, '#c7d2fe'], [1, '#6366f1']], 0, 0, 1, 1)
    + lin('fl', [[0, '#1e1b4b', 0.95], [1, '#0b0a24', 0.95]], 0, 0, 1, 1) + rad('pool', [[0, '#818cf8', 0.42], [1, '#818cf8', 0]]) + rad('pool2', [[0, '#67e8f9', 0.28], [1, '#67e8f9', 0]])
    + lin('scr', [[0, '#3730a3', 0.95], [1, '#1e1b4b', 0.95]]) + lin('holo', [[0, '#a5b4fc', 0.38], [1, '#818cf8', 0.08]]) + lin('beam', [[0, '#a5b4fc', 0.45], [1, '#a5b4fc', 0]], 0, 1, 0, 0), body));
})();

// ── CYBERSECURITY: an illuminated shield and lock inside a digital protection field ──
(function () {
  seed = 23;
  const cx = 160, cy = 100;
  let hex = '';
  const R = 15;
  for (let row = -5; row <= 5; row++) {
    for (let col = -8; col <= 8; col++) {
      const x = cx + col * R * 1.5, y = cy + row * R * 1.732 + (col % 2 ? R * 0.866 : 0);
      const dd = Math.hypot((x - cx) / 1.4, y - cy);
      if (dd > 128) continue;
      let p = '';
      for (let k = 0; k < 6; k++) { const a = Math.PI / 3 * k; p += f(x + (R - 1) * Math.cos(a)) + ',' + f(y + (R - 1) * Math.sin(a)) + ' '; }
      hex += `<polygon points="${p.trim()}" stroke-opacity="${f(Math.max(0.03, 0.34 - dd / 380))}"${rnd() > 0.93 && dd < 100 ? ' fill="#818cf8" fill-opacity=".14"' : ''}/>`;
    }
  }
  const shield = 'M160 26 L212 44 V92 C212 130 190 156 160 168 C130 156 108 130 108 92 V44 Z';
  const inner = 'M160 40 L199 54 V92 C199 121 183 141 160 151 C137 141 121 121 121 92 V54 Z';
  let circuit = '';
  [[-1, 0], [1, 0], [-1, 1], [1, 1], [-1, 2], [1, 2]].forEach(([s, k]) => {
    const y = 188 + k * 9, x1 = 160 + s * (40 + k * 6), x2 = 160 + s * (92 + k * 26);
    circuit += `<path d="M${x1} ${y - 10} V${y} H${x2}"/><circle cx="${x2}" cy="${y}" r="2.2" fill="#93c5fd" stroke="none"/>`;
  });
  const body = `<ellipse cx="160" cy="110" rx="150" ry="104" fill="url(#halo)"/>`
    + `<g stroke="#818cf8" stroke-width=".8">${hex}</g>`
    + `<ellipse cx="160" cy="186" rx="86" ry="20" fill="url(#base)" stroke="#60a5fa" stroke-opacity=".7"/>`
    + `<ellipse cx="160" cy="186" rx="64" ry="14" stroke="#93c5fd" stroke-opacity=".5" stroke-dasharray="3 4"/>`
    + bloom(`<ellipse cx="160" cy="186" rx="108" ry="27" stroke="#60a5fa" stroke-opacity=".35"/>`, 'b1', 0.8)
    + `<g stroke="#60a5fa" stroke-opacity=".75" stroke-width="1.1">${circuit}</g>`
    + bloom(`<path d="M76 98 A86 86 0 0 1 120 30" stroke="#93c5fd" stroke-width="2" stroke-linecap="round" stroke-opacity=".8"/><path d="M244 98 A86 86 0 0 1 200 30" stroke="#93c5fd" stroke-width="2" stroke-linecap="round" stroke-opacity=".8"/>`, 'b1', 0.8)
    + `<circle cx="160" cy="98" r="98" stroke="#a5b4fc" stroke-opacity=".18" stroke-dasharray="2 5"/>`
    + `<path d="M160 172 L160 186" stroke="#93c5fd" stroke-width="2"/>`
    + `<path d="${shield}" fill="#6366f1" fill-opacity=".35" filter="url(#b3)"/>`
    + `<path d="${shield}" fill="url(#sh)" stroke="#e0e7ff" stroke-width="2.4"/>`
    + `<path d="M160 26 L212 44 V92 C212 112 206 128 196 140 C188 104 178 64 160 26 Z" fill="#e0e7ff" fill-opacity=".1"/>`
    + `<path d="${inner}" fill="url(#shi)" stroke="#a5b4fc" stroke-opacity=".7" stroke-width="1.2"/>`
    + bloom(`<path d="M146 98 V86 a14 14 0 0 1 28 0 V98" stroke="#e0e7ff" stroke-width="4.5" stroke-linecap="round"/>`, 'b1', 0.8)
    + `<rect x="138" y="95" width="44" height="34" rx="7" fill="url(#lk)" stroke="#eef2ff" stroke-width="1.4"/>`
    + `<circle cx="160" cy="108" r="4.6" fill="#1e1b4b"/><path d="M160 111 V120" stroke="#1e1b4b" stroke-width="3.4" stroke-linecap="round"/>`
    + dust(30, 20, 14, 300, 214, '#c7d2fe', 1.2);
  write('cyber', svg(blur('b1', 2.4) + blur('b3', 9)
    + rad('halo', [[0, '#6366f1', 0.42], [0.6, '#3b82f6', 0.1], [1, '#3b82f6', 0]]) + rad('base', [[0, '#1d4ed8', 0.7], [1, '#0b1440', 0.3]])
    + lin('sh', [[0, '#818cf8'], [0.55, '#4338ca'], [1, '#1e3a8a']]) + lin('shi', [[0, '#312e81', 0.85], [1, '#0b1440', 0.9]])
    + lin('lk', [[0, '#eef2ff'], [1, '#a5b4fc']]), body));
})();

// ── ALGORITHMS: a glowing neural network shaped as an AI brain, under review ──
(function () {
  seed = 37;
  const cx = 160, cy = 100;
  // two hemispheres, folded
  const L = 'M158 34 C138 22 108 26 96 44 C78 46 66 62 70 80 C58 92 62 116 78 124 C80 142 98 156 118 152 C128 164 146 166 158 158 Z';
  const Rr = 'M162 34 C182 22 212 26 224 44 C242 46 254 62 250 80 C262 92 258 116 242 124 C240 142 222 156 202 152 C192 164 174 166 162 158 Z';
  const gyri = 'M100 60 C112 52 124 58 130 70 M84 90 C98 82 112 90 116 104 M96 126 C108 116 124 120 130 134 M136 44 C142 58 140 74 132 84 M140 100 C150 108 150 124 142 136'
    + ' M220 60 C208 52 196 58 190 70 M236 90 C222 82 208 90 204 104 M224 126 C212 116 196 120 190 134 M184 44 C178 58 180 74 188 84 M180 100 C170 108 170 124 178 136';
  const N = [];
  for (let i = 0; i < 34; i++) {
    let x, y, ok = false, tries = 0;
    while (!ok && tries++ < 60) { x = 76 + rnd() * 168; y = 34 + rnd() * 124; const dx = (x - cx) / 86, dy = (y - 96) / 64; ok = dx * dx + dy * dy < 0.86; }
    N.push([x, y]);
  }
  N.push([cx, 92]);
  let edges = '', hot = '';
  N.forEach((p, i) => {
    const near = N.map((q, j) => [Math.hypot(p[0] - q[0], p[1] - q[1]), j]).filter(([d, j]) => j !== i && d < 40).sort((a, b) => a[0] - b[0]).slice(0, 3);
    near.forEach(([, j]) => { if (j > i) { const s = `<path d="M${f(p[0])} ${f(p[1])} L${f(N[j][0])} ${f(N[j][1])}"/>`; (rnd() > 0.7 ? (hot += s) : (edges += s)); } });
  });
  const nodes = N.map((p, i) => `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="${i === N.length - 1 ? 5.5 : f(1.6 + rnd() * 1.8)}"/>`).join('');
  const body = `<ellipse cx="160" cy="104" rx="150" ry="100" fill="url(#halo)"/>`
    + `<ellipse cx="160" cy="194" rx="94" ry="16" fill="url(#floor)"/>`
    + bloom(`<ellipse cx="160" cy="194" rx="74" ry="11" stroke="#e879f9" stroke-opacity=".55"/>`, 'b1', 0.8)
    + `<path d="M160 166 V190" stroke="#f0abfc" stroke-opacity=".55" stroke-width="2" stroke-dasharray="2 3"/>`
    + `<ellipse cx="160" cy="96" rx="132" ry="34" stroke="#e879f9" stroke-opacity=".35" transform="rotate(-12 160 96)"/>`
    + `<path d="${L}" fill="url(#brL)" filter="url(#b3)" opacity=".55"/><path d="${Rr}" fill="url(#brR)" filter="url(#b3)" opacity=".55"/>`
    + `<path d="${L}" fill="url(#brL)" stroke="#f5d0fe" stroke-opacity=".85" stroke-width="1.6"/><path d="${Rr}" fill="url(#brR)" stroke="#f5d0fe" stroke-opacity=".85" stroke-width="1.6"/>`
    + `<path d="${gyri}" stroke="#f0abfc" stroke-opacity=".32" stroke-width="1.4" stroke-linecap="round"/>`
    + `<g stroke="#f0abfc" stroke-opacity=".5" stroke-width=".9">${edges}</g>`
    + bloom(`<g stroke="#fdf4ff" stroke-width="1.2">${hot}</g>`, 'b1', 0.9)
    + bloom(`<g fill="#fdf4ff">${nodes}</g>`, 'b1', 1)
    + `<ellipse cx="160" cy="96" rx="132" ry="34" stroke="#f0abfc" stroke-opacity=".55" stroke-dasharray="1 0 60 400" transform="rotate(-12 160 96)" stroke-width="1.6"/>`
    + `<circle cx="282" cy="74" r="3.4" fill="#f0abfc"/><circle cx="40" cy="122" r="2.6" fill="#e879f9"/>`
    + bloom(`<circle cx="246" cy="160" r="15" fill="#2e0a3a" stroke="#86efac" stroke-width="2"/><path d="M239 160 l5 5 l10 -11" stroke="#86efac" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`, 'b1', 0.7)
    + dust(28, 14, 14, 306, 214, '#f5d0fe', 1.2);
  write('algo', svg(blur('b1', 2.2) + blur('b3', 9)
    + rad('halo', [[0, '#c026d3', 0.42], [0.6, '#7e22ce', 0.12], [1, '#7e22ce', 0]]) + rad('floor', [[0, '#e879f9', 0.4], [1, '#e879f9', 0]])
    + rad('brL', [[0, '#a21caf', 0.95], [1, '#3b0a4a', 0.95]], 0.7, 0.4, 0.8) + rad('brR', [[0, '#a21caf', 0.95], [1, '#3b0a4a', 0.95]], 0.3, 0.4, 0.8), body));
})();

// ── DESIGN SYSTEM CONTROL: a creative workstation — UI components and design layers ──
(function () {
  seed = 41;
  let body = `<ellipse cx="150" cy="140" rx="148" ry="84" fill="url(#halo)"/>`
    + `<polygon points="40,188 150,214 268,188 158,166" fill="#1c1408" fill-opacity=".85" stroke="#fbbf24" stroke-opacity=".4"/>`
    + bloom(`<path d="M40 188 L150 214 L268 188" stroke="#fcd34d" stroke-opacity=".7" stroke-width="1.2"/>`, 'b1', 0.8)
    + `<path d="M138 176 h26 l6 10 h-38 z" fill="#292524" stroke="#a8a29e" stroke-opacity=".5"/><rect x="146" y="152" width="10" height="26" fill="#1c1917" stroke="#78716c" stroke-opacity=".6"/>`
    // the monitor
    + `<rect x="58" y="30" width="186" height="126" rx="9" fill="#fbbf24" fill-opacity=".22" filter="url(#b3)"/>`
    + `<rect x="58" y="30" width="186" height="126" rx="9" fill="url(#bez)" stroke="#fcd34d" stroke-width="1.8"/>`
    + `<rect x="65" y="37" width="172" height="112" rx="5" fill="url(#scr)"/>`
    + `<rect x="65" y="37" width="172" height="13" rx="5" fill="#fbbf24" fill-opacity=".16"/><g fill="#fde68a"><circle cx="73" cy="43.5" r="2"/><circle cx="80" cy="43.5" r="2"/><circle cx="87" cy="43.5" r="2"/></g>`
    + `<rect x="71" y="56" width="34" height="86" rx="4" fill="#fbbf24" fill-opacity=".1" stroke="#fcd34d" stroke-opacity=".35"/>`
    + `<g fill="#fde68a" fill-opacity=".7"><rect x="76" y="63" width="22" height="4" rx="2"/><rect x="76" y="73" width="17" height="4" rx="2"/><rect x="76" y="83" width="20" height="4" rx="2"/><rect x="76" y="93" width="14" height="4" rx="2"/></g>`
    + `<rect x="112" y="56" width="36" height="30" rx="5" fill="#fbbf24" fill-opacity=".9"/><rect x="153" y="56" width="36" height="30" rx="5" fill="#f472b6" fill-opacity=".85"/><rect x="194" y="56" width="36" height="30" rx="5" fill="#22d3ee" fill-opacity=".8"/>`
    + `<g fill="#0c0a09" fill-opacity=".35"><rect x="117" y="76" width="18" height="4" rx="2"/><rect x="158" y="76" width="18" height="4" rx="2"/><rect x="199" y="76" width="18" height="4" rx="2"/></g>`
    + `<rect x="112" y="95" width="80" height="6" rx="3" fill="#44403c"/><rect x="112" y="95" width="52" height="6" rx="3" fill="#fbbf24"/>` + bloom(`<circle cx="164" cy="98" r="5" fill="#fffbeb"/>`, 'b1', 0.7)
    + `<rect x="200" y="92" width="26" height="13" rx="6.5" fill="#4ade80"/><circle cx="219" cy="98.5" r="4.8" fill="#f0fdf4"/>`
    + `<rect x="112" y="112" width="56" height="16" rx="8" fill="#fbbf24" fill-opacity=".25" stroke="#fcd34d" stroke-opacity=".7"/><rect x="176" y="112" width="54" height="16" rx="8" stroke="#a78bfa" stroke-opacity=".8"/>`
    + `<g stroke="#a78bfa" stroke-opacity=".7" stroke-width="1"><path d="M112 136 h118"/></g>`
    // floating design layers
    + `<g transform="translate(232 18)">`
    + `<polygon points="0,44 34,28 64,42 30,58" fill="#78350f" fill-opacity=".7" stroke="#fbbf24" stroke-width="1"/>`
    + `<polygon points="0,32 34,16 64,30 30,46" fill="#9d174d" fill-opacity=".6" stroke="#f472b6" stroke-width="1"/>`
    + `<polygon points="0,20 34,4 64,18 30,34" fill="#0e7490" fill-opacity=".55" stroke="#22d3ee" stroke-width="1"/>`
    + bloom(`<polygon points="0,20 34,4 64,18 30,34" stroke="#a5f3fc" stroke-width="1.2"/>`, 'b1', 0.8) + `</g>`
    // a stylus and the palette
    + `<g transform="rotate(38 250 130)">` + bloom(`<rect x="244" y="98" width="8" height="64" rx="3" fill="url(#pen)"/>`, 'b1', 0.5) + `<path d="M244 162 L248 172 L252 162 Z" fill="#fde68a"/></g>`
    + `<g>` + bloom(`<circle cx="40" cy="156" r="9" fill="#fbbf24"/><circle cx="62" cy="168" r="8" fill="#f472b6"/><circle cx="84" cy="176" r="7.5" fill="#22d3ee"/><circle cx="34" cy="132" r="6.5" fill="#a78bfa"/>`, 'b1', 0.6) + `</g>`
    + dust(22, 14, 10, 306, 210, '#fde68a', 1.1);
  write('design', svg(blur('b1', 2.2) + blur('b3', 8)
    + rad('halo', [[0, '#f59e0b', 0.34], [0.6, '#db2777', 0.1], [1, '#db2777', 0]]) + lin('bez', [[0, '#292524'], [1, '#0c0a09']])
    + lin('scr', [[0, '#1c1917'], [1, '#0c0a09']]) + lin('pen', [[0, '#fde68a'], [1, '#f59e0b']]), body));
})();

// ── DATA VAULT: illuminated database structures in secure storage ──
(function () {
  seed = 53;
  const disk = (cx, top, rx, ry, h, i) => {
    const y2 = top + h;
    return `<path d="M${cx - rx} ${top} V${y2} A${rx} ${ry} 0 0 0 ${cx + rx} ${y2} V${top}" fill="url(#cyl)" stroke="#22d3ee" stroke-opacity=".7"/>`
      + `<ellipse cx="${cx}" cy="${top}" rx="${rx}" ry="${ry}" fill="url(#lid)" stroke="#a5f3fc" stroke-width="1.2"/>`
      + bloom(`<path d="M${cx - rx} ${y2} A${rx} ${ry} 0 0 0 ${cx + rx} ${y2}" stroke="#67e8f9" stroke-width="2"/>`, 'b1', 0.9)
      + `<g fill="#a5f3fc">${[0, 1, 2].map((k) => `<circle cx="${cx - rx + 14 + k * 8}" cy="${f(y2 - h / 2 + 6)}" r="1.8" fill-opacity="${k === i % 3 ? 1 : 0.45}"/>`).join('')}</g>`
      + `<path d="M${cx + 12} ${f(y2 - h / 2 + 6)} h${rx - 22}" stroke="#67e8f9" stroke-opacity=".45" stroke-width="1.6" stroke-linecap="round"/>`;
  };
  let streams = '';
  for (let i = 0; i < 8; i++) { const x = 30 + i * 37 + (i > 3 ? 40 : 0); if (x > 300) continue; streams += `<path d="M${x} ${f(16 + rnd() * 20)} V${f(150 + rnd() * 30)}"/>`; }
  let bits = '';
  for (let i = 0; i < 26; i++) bits += `<rect x="${f(24 + rnd() * 270)}" y="${f(20 + rnd() * 150)}" width="2.4" height="${f(3 + rnd() * 6)}" rx="1"/>`;
  let body = `<ellipse cx="160" cy="118" rx="150" ry="100" fill="url(#halo)"/>`
    + `<g stroke="#22d3ee" stroke-opacity=".28" stroke-dasharray="2 4">${streams}</g><g fill="#67e8f9" fill-opacity=".45">${bits}</g>`
    + `<ellipse cx="160" cy="194" rx="128" ry="26" fill="url(#plate)" stroke="#22d3ee" stroke-opacity=".55"/>`
    + `<ellipse cx="160" cy="194" rx="100" ry="19" stroke="#67e8f9" stroke-opacity=".45" stroke-dasharray="3 5"/>`
    + bloom(`<ellipse cx="160" cy="194" rx="72" ry="13" stroke="#67e8f9" stroke-width="1.2" stroke-opacity=".8"/>`, 'b1', 0.8);
  // archive blocks either side
  const o = [70, 168, 1];
  body += box(o, -14, -14, 0, 28, 26, 26, { top: '#0e7490', left: '#155e75', right: '#083344', edge: '#67e8f9', eo: 0.7 })
    + box(o, -4, 18, 0, 18, 16, 16, { top: '#0e7490', left: '#155e75', right: '#083344', edge: '#67e8f9', eo: 0.6 });
  const o2 = [256, 170, 1];
  body += box(o2, -12, -12, 0, 24, 24, 34, { top: '#1d4ed8', left: '#1e3a8a', right: '#0b1d47', edge: '#93c5fd', eo: 0.7 })
    + box(o2, 14, -2, 0, 16, 16, 18, { top: '#0e7490', left: '#155e75', right: '#083344', edge: '#67e8f9', eo: 0.6 });
  body += `<rect x="96" y="40" width="128" height="150" rx="40" fill="#22d3ee" fill-opacity=".14" filter="url(#b3)"/>`
    + disk(160, 132, 58, 14, 34, 0) + disk(160, 96, 58, 14, 34, 1) + disk(160, 60, 58, 14, 34, 2)
    + bloom(`<ellipse cx="160" cy="60" rx="58" ry="14" stroke="#cffafe" stroke-width="1.6"/>`, 'b1', 0.8)
    + `<path d="M160 16 L182 24 V40 C182 52 172 60 160 64 C148 60 138 52 138 40 V24 Z" fill="url(#sh)" stroke="#cffafe" stroke-width="1.6"/>`
    + bloom(`<path d="M151 40 l6 6 l11 -12" stroke="#ecfeff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`, 'b1', 0.7)
    + dust(22, 16, 10, 304, 214, '#a5f3fc', 1.1);
  write('vault', svg(blur('b1', 2.2) + blur('b3', 10)
    + rad('halo', [[0, '#0891b2', 0.45], [0.6, '#1d4ed8', 0.1], [1, '#1d4ed8', 0]]) + rad('plate', [[0, '#0e7490', 0.7], [1, '#083344', 0.4]])
    + lin('cyl', [[0, '#0e7490', 0.95], [0.5, '#155e75', 0.95], [1, '#083344', 0.95]], 0, 0, 1, 0) + rad('lid', [[0, '#67e8f9', 0.85], [1, '#0e7490', 0.9]])
    + lin('sh', [[0, '#22d3ee'], [1, '#0e7490']]), body));
})();

// ── INFRASTRUCTURE CITY: a miniature technology city, its rooftops wired into one network ──
(function () {
  seed = 67;
  const o = [164, 136, 1];
  const B = [[-58, -40, 14, 14, 30], [-36, -60, 16, 16, 50], [-12, -48, 18, 18, 74], [14, -64, 14, 14, 44], [36, -44, 16, 16, 60], [-52, -8, 14, 14, 20],
    [-28, -18, 16, 16, 40], [-2, -12, 14, 14, 58], [22, -16, 16, 16, 34], [46, -8, 12, 12, 26], [-38, 18, 14, 14, 24], [-12, 20, 16, 16, 30], [14, 16, 14, 14, 46], [40, 22, 12, 12, 18]];
  const order = B.map((b, i) => [b, i]).sort((a, c) => (a[0][0] + a[0][1]) - (c[0][0] + c[0][1]));
  let blds = '', wins = '', winsHot = '';
  const tops = [];
  order.forEach(([b, i]) => {
    const [x, y, w, d, h] = b;
    const tall = h > 55;
    blds += box(o, x, y, 0, w, d, h, { top: tall ? '#bfdbfe' : '#93c5fd', left: 'url(#bl)', right: 'url(#br)', edge: '#dbeafe', eo: 0.55 });
    for (let zz = 6; zz < h - 4; zz += 6) {
      for (const [u0, u1, face] of [[2, w - 2, 'L'], [2, d - 2, 'R']]) {
        const a = face === 'L' ? iso(o, x + u0, y + d, zz) : iso(o, x + w, y + u0, zz);
        const c = face === 'L' ? iso(o, x + u1, y + d, zz) : iso(o, x + w, y + u1, zz);
        const s = `<path d="${pl([a, c])}"/>`;
        if (rnd() > 0.72) winsHot += s; else wins += s;
      }
    }
    tops[i] = iso(o, x + w / 2, y + d / 2, h);
  });
  const links = [[2, 4], [2, 7], [7, 12], [1, 3], [3, 4], [6, 7], [7, 8], [11, 12], [0, 1], [5, 6], [8, 9], [10, 11]]
    .map(([a, b]) => { const p = tops[a], q = tops[b]; return `<path d="M${f(p[0])} ${f(p[1])} Q${f((p[0] + q[0]) / 2)} ${f(Math.min(p[1], q[1]) - 16)} ${f(q[0])} ${f(q[1])}"/>`; }).join('');
  const ant = iso(o, -3, -39, 74);
  const body = `<ellipse cx="160" cy="160" rx="152" ry="70" fill="url(#halo)"/>`
    + plate(o, -76, -80, 140, 124, { fill: 'url(#fl)', grid: '#60a5fa', go: 0.24, step: 12, edge: '#93c5fd' })
    + `<ellipse cx="${f(iso(o, -4, -20)[0])}" cy="${f(iso(o, -4, -20)[1])}" rx="72" ry="30" fill="url(#pool)"/>`
    + blds
    + `<g stroke="#bfdbfe" stroke-opacity=".5" stroke-width="1.1">${wins}</g>`
    + bloom(`<g stroke="#fde68a" stroke-opacity=".95" stroke-width="1.2">${winsHot}</g>`, 'b1', 0.7)
    + `<path d="M${f(ant[0])} ${f(ant[1])} V${f(ant[1] - 18)}" stroke="#dbeafe" stroke-width="1.6"/>` + bloom(`<circle cx="${f(ant[0])}" cy="${f(ant[1] - 20)}" r="3.2" fill="#22d3ee"/>`, 'b1', 1)
    + bloom(`<g stroke="#22d3ee" stroke-width="1.3" stroke-dasharray="3 2">${links}</g>`, 'b1', 0.8)
    + `<g fill="#cffafe">${tops.map((p) => `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="2.2"/>`).join('')}</g>`
    + dust(24, 14, 6, 306, 110, '#bfdbfe', 1.1);
  write('city', svg(blur('b1', 2) + lin('bl', [[0, '#2563eb'], [1, '#1e3a8a']]) + lin('br', [[0, '#1e40af'], [1, '#0b1d47']])
    + lin('fl', [[0, '#172554', 0.95], [1, '#0a1230', 0.95]], 0, 0, 1, 1) + rad('halo', [[0, '#3b82f6', 0.38], [0.6, '#7c3aed', 0.08], [1, '#7c3aed', 0]]) + rad('pool', [[0, '#60a5fa', 0.3], [1, '#60a5fa', 0]]), body));
})();

// ── SOURCE CORE: data lineage — sources flowing through one core into what depends on them ──
(function () {
  seed = 79;
  const core = [160, 108];
  const S = [[34, 46, 'db'], [26, 108, 'doc'], [34, 170, 'cam'], [88, 72, 'n'], [88, 146, 'n']];
  const T = [[256, 52, 'ok'], [284, 108, 'n'], [256, 166, 'ok'], [226, 82, 'n'], [226, 136, 'n']];
  const curve = (a, b) => { const mx = (a[0] + b[0]) / 2; return `M${a[0]} ${a[1]} C${mx} ${a[1]} ${mx} ${b[1]} ${b[0]} ${b[1]}`; };
  let flows = '';
  [[0, 3], [1, 3], [1, 4], [2, 4]].forEach(([i, j]) => { flows += `<path d="${curve(S[i], S[j])}"/>`; });
  [3, 4].forEach((i) => { flows += `<path d="${curve(S[i], core)}"/>`; });
  [3, 4].forEach((i) => { flows += `<path d="${curve(core, T[i])}"/>`; });
  [[3, 0], [3, 1], [4, 1], [4, 2]].forEach(([i, j]) => { flows += `<path d="${curve(T[i], T[j])}"/>`; });
  let pulses = '';
  for (let i = 0; i < 12; i++) pulses += `<circle cx="${f(60 + rnd() * 200)}" cy="${f(60 + rnd() * 100)}" r="1.8"/>`;
  const tile = (x, y, kind) => {
    const g = { db: '<ellipse cx="0" cy="-5" rx="7" ry="2.6"/><path d="M-7 -5 V5 A7 2.6 0 0 0 7 5 V-5"/><path d="M-7 0 A7 2.6 0 0 0 7 0"/>',
      doc: '<path d="M-6 -8 H3 L7 -4 V8 H-6 Z"/><path d="M-3 -1 H4 M-3 3 H4"/>',
      cam: '<rect x="-7" y="-5" width="11" height="10" rx="2"/><path d="M4 -2 L8 -4 V4 L4 2"/>',
      ok: '<path d="M-5 0 l3.5 3.5 l7 -7.5"/>' }[kind];
    if (!g) return bloom(`<circle cx="${x}" cy="${y}" r="5" fill="#0c4a6e" stroke="#7dd3fc" stroke-width="1.6"/>`, 'b1', 0.8);
    return `<rect x="${x - 16}" y="${y - 15}" width="32" height="30" rx="8" fill="#38bdf8" fill-opacity=".25" filter="url(#b3)"/>`
      + `<rect x="${x - 16}" y="${y - 15}" width="32" height="30" rx="8" fill="url(#tile)" stroke="#7dd3fc" stroke-width="1.2"/>`
      + `<g transform="translate(${x} ${y})" stroke="#e0f2fe" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${g}</g>`;
  };
  const body = `<ellipse cx="160" cy="110" rx="152" ry="100" fill="url(#halo)"/>`
    + `<g stroke="#38bdf8" stroke-width="5" stroke-opacity=".25" filter="url(#b1)">${flows}</g>`
    + `<g stroke="#7dd3fc" stroke-width="1.5" stroke-opacity=".9">${flows}</g>`
    + bloom(`<g fill="#e0f2fe">${pulses}</g>`, 'b1', 0.8)
    + `<ellipse cx="160" cy="108" rx="58" ry="18" stroke="#7dd3fc" stroke-opacity=".55" transform="rotate(-24 160 108)"/>`
    + `<ellipse cx="160" cy="108" rx="58" ry="18" stroke="#38bdf8" stroke-opacity=".4" transform="rotate(36 160 108)"/>`
    + `<circle cx="160" cy="108" r="34" fill="url(#coreGlow)"/>`
    + bloom(`<circle cx="160" cy="108" r="22" fill="#0c4a6e" stroke="#7dd3fc" stroke-width="2.4"/>`, 'b1', 0.9)
    + `<circle cx="160" cy="108" r="13" fill="url(#coreIn)"/>` + bloom(`<circle cx="160" cy="108" r="6" fill="#f0f9ff"/>`, 'b1', 1)
    + S.map((s) => tile(s[0], s[1], s[2])).join('') + T.map((t) => tile(t[0], t[1], t[2])).join('')
    + dust(22, 14, 10, 306, 214, '#bae6fd', 1.1);
  write('core', svg(blur('b1', 2.2) + blur('b3', 6)
    + rad('halo', [[0, '#0284c7', 0.4], [0.6, '#4f46e5', 0.1], [1, '#4f46e5', 0]]) + rad('coreGlow', [[0, '#38bdf8', 0.7], [1, '#38bdf8', 0]])
    + rad('coreIn', [[0, '#e0f2fe'], [1, '#0284c7']]) + lin('tile', [[0, '#075985'], [1, '#082f49']]), body));
})();

// ── FAMILISTA VISION: an AI camera tracking players and the ball across a pitch ──
(function () {
  seed = 83;
  // the pitch, in perspective
  const P = [[70, 92], [266, 92], [312, 206], [20, 206]];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const at = (u, v) => lerp(lerp(P[0], P[1], u), lerp(P[3], P[2], u), v);
  let stripes = '';
  for (let i = 0; i < 6; i++) { const a = at(0, i / 6), b = at(1, i / 6), c = at(1, (i + 0.5) / 6), d = at(0, (i + 0.5) / 6); stripes += `<polygon points="${pts([a, b, c, d])}"/>`; }
  const mid = [at(0, 0.5), at(1, 0.5)];
  const box1 = [at(0.3, 0), at(0.7, 0), at(0.7, 0.18), at(0.3, 0.18)];
  const box2 = [at(0.25, 1), at(0.75, 1), at(0.75, 0.78), at(0.25, 0.78)];
  const cc = at(0.5, 0.5);
  const players = [[0.22, 0.3, 'a'], [0.42, 0.22, 'b'], [0.6, 0.36, 'a'], [0.78, 0.28, 'b'], [0.35, 0.58, 'b'], [0.55, 0.66, 'a'], [0.74, 0.62, 'b'], [0.5, 0.86, 'a']];
  let marks = '';
  players.forEach(([u, v, t]) => {
    const p = at(u, v), s = 0.7 + v * 0.6, col = t === 'a' ? '#22d3ee' : '#fde047';
    marks += `<ellipse cx="${f(p[0])}" cy="${f(p[1] + 1)}" rx="${f(5 * s)}" ry="${f(1.8 * s)}" fill="#052e16" fill-opacity=".6"/>`
      + `<rect x="${f(p[0] - 2.6 * s)}" y="${f(p[1] - 11 * s)}" width="${f(5.2 * s)}" height="${f(10 * s)}" rx="${f(2 * s)}" fill="${col}"/>`
      + `<circle cx="${f(p[0])}" cy="${f(p[1] - 13 * s)}" r="${f(2.3 * s)}" fill="#f8fafc"/>`
      + `<rect x="${f(p[0] - 6 * s)}" y="${f(p[1] - 17 * s)}" width="${f(12 * s)}" height="${f(19 * s)}" rx="1.5" stroke="${col}" stroke-width="1" stroke-opacity=".9"/>`;
  });
  const ball = at(0.62, 0.5);
  const from = at(0.42, 0.22);
  const body = `<ellipse cx="166" cy="150" rx="150" ry="76" fill="url(#halo)"/>`
    + `<polygon points="${pts(P)}" fill="url(#pitch)"/>`
    + `<g fill="#15803d" fill-opacity=".35">${stripes}</g>`
    + `<ellipse cx="${f(at(0.66, 0.6)[0])}" cy="${f(at(0.66, 0.6)[1])}" rx="50" ry="18" fill="url(#heat)"/>`
    + `<g stroke="#dcfce7" stroke-opacity=".6" stroke-width="1.1"><polygon points="${pts(P)}"/><path d="${pl(mid)}"/><polygon points="${pts(box1)}"/><polygon points="${pts(box2)}"/><ellipse cx="${f(cc[0])}" cy="${f(cc[1])}" rx="26" ry="8"/></g>`
    // the camera's field of view
    + `<polygon points="54,40 ${f(at(0.05, 0.05)[0])},${f(at(0.05, 0.05)[1])} ${f(at(0.95, 0.95)[0])},${f(at(0.95, 0.95)[1])}" fill="url(#cone)"/>`
    + `<path d="M54 40 L${f(at(0.05, 0.05)[0])} ${f(at(0.05, 0.05)[1])} M54 40 L${f(at(0.95, 0.95)[0])} ${f(at(0.95, 0.95)[1])}" stroke="#c4b5fd" stroke-opacity=".45" stroke-dasharray="3 3"/>`
    + marks
    + bloom(`<path d="M${f(from[0])} ${f(from[1] - 8)} Q${f((from[0] + ball[0]) / 2)} ${f(from[1] - 40)} ${f(ball[0])} ${f(ball[1] - 3)}" stroke="#fef08a" stroke-width="1.6" stroke-dasharray="3 3"/><circle cx="${f(ball[0])}" cy="${f(ball[1] - 3)}" r="3.6" fill="#fefce8"/>`, 'b1', 0.9)
    // the camera on its mount
    + `<path d="M40 12 V54" stroke="#64748b" stroke-width="3"/><path d="M30 56 h20" stroke="#64748b" stroke-width="3" stroke-linecap="round"/>`
    + `<g transform="rotate(28 50 34)">` + `<rect x="30" y="24" width="44" height="20" rx="6" fill="#a78bfa" fill-opacity=".35" filter="url(#b3)"/>`
    + `<rect x="30" y="24" width="44" height="20" rx="6" fill="url(#cam)" stroke="#c4b5fd" stroke-width="1.4"/><rect x="72" y="27" width="8" height="14" rx="2" fill="#4c1d95" stroke="#c4b5fd"/>`
    + bloom(`<circle cx="46" cy="34" r="6.5" fill="#1e1b4b" stroke="#22d3ee" stroke-width="2"/><circle cx="46" cy="34" r="2.6" fill="#a5f3fc"/>`, 'b1', 0.9)
    + `<circle cx="64" cy="29" r="1.6" fill="#f87171"/></g>`
    + `<path d="M14 8 h18 M14 8 v14" stroke="#c4b5fd" stroke-width="2" stroke-linecap="round"/><path d="M306 222 h-18 M306 222 v-14" stroke="#c4b5fd" stroke-width="2" stroke-linecap="round"/>`
    + dust(18, 90, 8, 310, 84, '#ddd6fe', 1.1);
  write('vision', svg(blur('b1', 2) + blur('b3', 7)
    + rad('halo', [[0, '#7c3aed', 0.36], [0.6, '#0891b2', 0.12], [1, '#0891b2', 0]]) + lin('pitch', [[0, '#166534'], [1, '#14532d']])
    + rad('heat', [[0, '#f97316', 0.6], [0.5, '#facc15', 0.25], [1, '#facc15', 0]])
    + `<linearGradient id="cone" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa" stop-opacity=".5"/><stop offset="1" stop-color="#a78bfa" stop-opacity=".04"/></linearGradient>`
    + lin('cam', [[0, '#6d28d9'], [1, '#2e1065']]), body));
})();

// ── CLUBS: a professional football stadium under its floodlights ──
(function () {
  seed = 97;
  const cx = 160, cy = 132;
  let tiers = '', seats = '';
  for (let i = 0; i < 4; i++) {
    const rx = 136 - i * 15, ry = 66 - i * 8;
    tiers += `<ellipse cx="${cx}" cy="${cy - i * 3}" rx="${rx}" ry="${ry}" fill="url(#stand${i % 2})" stroke="#86efac" stroke-opacity="${0.14 + i * 0.05}"/>`;
  }
  for (let i = 0; i < 150; i++) {
    const a = rnd() * Math.PI * 2, t = 0.62 + rnd() * 0.36, rx = 136 * t, ry = 66 * t;
    const x = cx + rx * Math.cos(a), y = cy - 4 + ry * Math.sin(a);
    seats += `<circle cx="${f(x)}" cy="${f(y)}" r=".9" fill="${rnd() > 0.85 ? '#fde68a' : '#e2e8f0'}" fill-opacity="${f(0.25 + rnd() * 0.5)}"/>`;
  }
  const pitch = [[86, 108], [234, 108], [252, 160], [68, 160]];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const at = (u, v) => lerp(lerp(pitch[0], pitch[1], u), lerp(pitch[3], pitch[2], u), v);
  let stripes = '';
  for (let i = 0; i < 8; i++) { const a = at(i / 8, 0), b = at((i + 0.5) / 8, 0), c = at((i + 0.5) / 8, 1), d = at(i / 8, 1); stripes += `<polygon points="${pts([a, b, c, d])}"/>`; }
  const tower = (x, y, dir) => `<path d="M${x} ${y} V${y + 52}" stroke="#94a3b8" stroke-width="2.4"/>`
    + `<rect x="${x - 9}" y="${y - 8}" width="18" height="10" rx="2" fill="#f8fafc" stroke="#e2e8f0"/>`
    + bloom(`<rect x="${x - 9}" y="${y - 8}" width="18" height="10" rx="2" fill="#fefce8"/>`, 'b3', 0.9)
    + `<polygon points="${x - 8},${y + 2} ${x + 8},${y + 2} ${x + dir * 92},${y + 92} ${x + dir * 40},${y + 106}" fill="url(#beam)"/>`;
  const body = `<ellipse cx="160" cy="140" rx="156" ry="84" fill="url(#halo)"/>`
    + `<ellipse cx="${cx}" cy="${cy + 10}" rx="148" ry="72" fill="#020617" fill-opacity=".7"/>`
    + `<path d="M${cx - 140} ${cy} C${cx - 140} ${cy + 44} ${cx + 140} ${cy + 44} ${cx + 140} ${cy} V${cy + 16} C${cx + 140} ${cy + 62} ${cx - 140} ${cy + 62} ${cx - 140} ${cy + 16} Z" fill="url(#wall)"/>`
    + tiers + seats
    + `<ellipse cx="${cx}" cy="${cy - 4}" rx="104" ry="44" fill="#052e16" stroke="#4ade80" stroke-opacity=".4"/>`
    + `<polygon points="${pts(pitch)}" fill="url(#grass)"/><g fill="#22c55e" fill-opacity=".22">${stripes}</g>`
    + `<g stroke="#f0fdf4" stroke-opacity=".75" stroke-width="1"><polygon points="${pts(pitch)}"/><path d="${pl([at(0.5, 0), at(0.5, 1)])}"/><ellipse cx="${f(at(0.5, 0.5)[0])}" cy="${f(at(0.5, 0.5)[1])}" rx="13" ry="6"/>`
    + `<polygon points="${pts([at(0, 0.28), at(0.12, 0.28), at(0.12, 0.72), at(0, 0.72)])}"/><polygon points="${pts([at(1, 0.28), at(0.88, 0.28), at(0.88, 0.72), at(1, 0.72)])}"/></g>`
    + bloom(`<path d="M${cx - 136} ${cy - 2} C${cx - 136} ${cy - 92} ${cx + 136} ${cy - 92} ${cx + 136} ${cy - 2}" stroke="#4ade80" stroke-width="2.2"/>`, 'b1', 0.8)
    + bloom(`<path d="M${cx - 140} ${cy + 16} C${cx - 140} ${cy + 62} ${cx + 140} ${cy + 62} ${cx + 140} ${cy + 16}" stroke="#86efac" stroke-width="1.4" stroke-opacity=".8"/>`, 'b1', 0.8)
    + tower(30, 30, 1) + tower(290, 30, -1)
    + `<path d="M${cx} 60 V44" stroke="#cbd5e1" stroke-width="1.4"/><path d="M${cx} 44 h12 l-3.5 4 l3.5 4 h-12" fill="#4ade80"/>`
    + dust(20, 40, 6, 280, 60, '#f0fdf4', 1);
  write('clubs', svg(blur('b1', 2.2) + blur('b3', 4)
    + rad('halo', [[0, '#16a34a', 0.4], [0.6, '#0f766e', 0.1], [1, '#0f766e', 0]]) + lin('wall', [[0, '#1e293b'], [1, '#0b1220']])
    + lin('stand0', [[0, '#1f2937'], [1, '#111827']]) + lin('stand1', [[0, '#273449'], [1, '#162033']])
    + lin('grass', [[0, '#16a34a'], [1, '#14532d']]) + lin('beam', [[0, '#f8fafc', 0.4], [1, '#f8fafc', 0]]), body));
})();

// ── THE HUB: the Operations Room's own centre piece — an AI agent at its console ──
(function () {
  seed = 101;
  const body = `<circle cx="160" cy="115" r="104" fill="url(#halo)"/>`
    + `<circle cx="160" cy="115" r="86" stroke="#fcd34d" stroke-opacity=".22" stroke-dasharray="2 5"/>`
    + `<ellipse cx="160" cy="188" rx="64" ry="12" fill="url(#floor)"/>`
    + bloom(`<ellipse cx="160" cy="188" rx="46" ry="8" stroke="#fcd34d" stroke-opacity=".7"/>`, 'b1', 0.8)
    // antenna
    + `<path d="M160 52 V34" stroke="#fde68a" stroke-width="3" stroke-linecap="round"/>` + bloom(`<circle cx="160" cy="30" r="6" fill="#fef3c7"/>`, 'b1', 1)
    // the head: dark metal, lit at the rim by the room's amber
    + `<rect x="104" y="52" width="112" height="94" rx="34" fill="#f59e0b" fill-opacity=".3" filter="url(#b3)"/>`
    + `<rect x="104" y="52" width="112" height="94" rx="34" fill="url(#head)" stroke="#fcd34d" stroke-width="2.2"/>`
    + `<path d="M116 70 C130 58 190 58 204 70" stroke="#fde68a" stroke-opacity=".55" stroke-width="2.4" stroke-linecap="round"/>`
    + `<path d="M108 112 C110 132 124 142 140 144" stroke="#fbbf24" stroke-opacity=".5" stroke-width="2" stroke-linecap="round"/>`
    + `<rect x="116" y="80" width="88" height="40" rx="20" fill="url(#visor)" stroke="#7dd3fc" stroke-opacity=".65" stroke-width="1.4"/>`
    + bloom(`<rect x="128" y="94" width="22" height="12" rx="6" fill="#38bdf8"/><rect x="170" y="94" width="22" height="12" rx="6" fill="#38bdf8"/>`, 'b3', 1)
    + `<rect x="131" y="97" width="16" height="6" rx="3" fill="#e0f2fe"/><rect x="173" y="97" width="16" height="6" rx="3" fill="#e0f2fe"/>`
    + `<path d="M122 86 H198" stroke="#7dd3fc" stroke-opacity=".25"/>`
    + `<g stroke="#fcd34d" stroke-opacity=".45" stroke-width="1.2" stroke-linecap="round"><path d="M126 132 h10 l4 -4 h8"/><path d="M194 132 h-10 l-4 -4 h-8"/></g>`
    // ears and neck
    + `<rect x="90" y="82" width="14" height="36" rx="7" fill="url(#ear)" stroke="#fcd34d" stroke-width="1.4"/><rect x="216" y="82" width="14" height="36" rx="7" fill="url(#ear)" stroke="#fcd34d" stroke-width="1.4"/>`
    + bloom(`<circle cx="97" cy="100" r="2.4" fill="#fde68a"/><circle cx="223" cy="100" r="2.4" fill="#fde68a"/>`, 'b1', 1)
    + `<path d="M142 146 V158 H178 V146" fill="#1c1917" stroke="#fcd34d" stroke-opacity=".5" stroke-width="1.4"/>`
    + `<path d="M116 172 C124 160 196 160 204 172 L208 186 H112 Z" fill="url(#body)" stroke="#fcd34d" stroke-opacity=".7" stroke-width="1.4"/>`
    + bloom(`<circle cx="160" cy="174" r="4" fill="#7dd3fc"/>`, 'b1', 1)
    + dust(16, 60, 20, 260, 200, '#fef3c7', 1.1);
  write('hub', svg(blur('b1', 2.2) + blur('b3', 8)
    + rad('halo', [[0, '#f59e0b', 0.34], [0.55, '#38bdf8', 0.1], [1, '#38bdf8', 0]]) + rad('floor', [[0, '#fcd34d', 0.45], [1, '#fcd34d', 0]])
    + lin('head', [[0, '#334155'], [0.55, '#1e293b'], [1, '#0f172a']]) + lin('visor', [[0, '#0c1424'], [1, '#020617']]) + lin('ear', [[0, '#f59e0b'], [1, '#78350f']])
    + lin('body', [[0, '#334155'], [1, '#0f172a']]), body));
})();

if (require.main === module) {
  console.log('wrote ' + fs.readdirSync(OUT).filter((x) => x.endsWith('.svg')).map((x) => x + ' ' + fs.statSync(path.join(OUT, x)).size + 'B').join(', '));
}
