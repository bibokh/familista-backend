// Familista Design Core — colour science (pure, dependency-free).
//
// sRGB parsing, alpha compositing and WCAG 2.x contrast. The same functions
// will serve the Product Design Studio's garment colours later; nothing here
// knows about Familista's palette.

/** @typedef {{ r: number, g: number, b: number, a: number }} RGBA  r,g,b in 0–255, a in 0–1 */

/**
 * Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() or rgba() into RGBA.
 * Returns null for anything else (gradients, keywords, var()).
 * @param {string} input
 * @returns {RGBA | null}
 */
export function parseColor(input) {
  const s = String(input).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 1000) / 1000 : 1,
    };
  }
  m = s.match(/^rgba?\(([^)]*)\)$/);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return null;
    const ch = parts.slice(0, 3).map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
    const a = parts.length === 4 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    if ([...ch, a].some((n) => Number.isNaN(n))) return null;
    return { r: ch[0], g: ch[1], b: ch[2], a };
  }
  return null;
}

/** Canonical text form used for equality checks: rgba(r,g,b,a) with trimmed numbers. */
export function colorKey(c) {
  const n = (x) => String(Math.round(x * 1000) / 1000);
  return `rgba(${n(c.r)},${n(c.g)},${n(c.b)},${n(c.a)})`;
}

/** Composite `top` over an opaque `bottom` (source-over). */
export function composite(top, bottom) {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

function channel(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an opaque colour. */
export function luminance(c) {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG contrast ratio between two opaque colours, rounded to 2 decimals. */
export function contrastRatio(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}
