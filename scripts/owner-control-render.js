#!/usr/bin/env node
// Familista — render the Owner Control room illustrations from their 3D scenes.
// ─────────────────────────────────────────────────────────────────────────────
// The pictures on the Owner Control cards (and the hub's centre piece) are 3D
// scenes — scripts/owner-control-scenes.js, built with the Babylon.js the app
// already vendors (public/vendor/babylon.js) — rendered once, here, offline, to
// small WebP images under public/owner-control/art/. Nothing renders 3D at run
// time: the page only shows the images, so the landing costs what an <img>
// costs, and no image service, model or licence is involved.
//
// How a frame becomes an image: each scene is drawn at twice its output size on
// a transparent canvas, with Babylon's glow layer for the lit edges. The glow
// is additive, so it lands in the colour channels even where nothing solid is;
// those pixels are given the glow's own brightness as their opacity, so the
// light still shows once the picture sits on a card. The frame is then halved
// (supersampling, for clean edges) and encoded as WebP.
//
// Rendering is software WebGL (SwiftShader) in a headless Chromium, so the same
// machine gives the same pixels; across machines a GPU may differ by a shade,
// which is why the check is a manifest, not a byte comparison: art/manifest.json
// records the scene source's hash and every image's hash and size, and
// tests/owner-control-map.unit.test.ts fails if a scene changed without the
// images being rendered again, or an image changed without its scene.
//
//   node scripts/owner-control-render.js              → render every scene
//   node scripts/owner-control-render.js system hub   → render only these
//
// Needs Playwright (a developer tool, resolved from wherever the machine has it,
// as scripts/i18n-walk.js does) and nothing else.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'owner-control', 'art');
const SCENES = path.join(__dirname, 'owner-control-scenes.js');
const BABYLON = path.join(ROOT, 'public', 'vendor', 'babylon.js');
const { chromium } = (() => {
  const tries = [process.env.PLAYWRIGHT_PATH, 'playwright', 'playwright-core', path.join(ROOT, 'tools/components/node_modules/playwright-core')].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (_) { /* next */ } }
  console.error('playwright not found. Install it, or set PLAYWRIGHT_PATH to its directory.');
  process.exit(2);
})();
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

(async () => {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('scene error:', e.message));
  await page.setContent('<!doctype html><html><body style="margin:0;background:#000"></body></html>');
  await page.addScriptTag({ path: BABYLON });
  await page.addScriptTag({ path: SCENES });
  const all = await page.evaluate(() => Object.keys(window.OC_SCENES));
  const names = only.length ? only : all;
  fs.mkdirSync(OUT, { recursive: true });
  const manifestPath = path.join(OUT, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { images: {} };
  for (const name of names) {
    const t0 = Date.now();
    const res = await page.evaluate((n) => window.OC_RENDER(n), name);
    const buf = Buffer.from(res.data.split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, name + '.webp'), buf);
    manifest.images[name] = { file: name + '.webp', width: res.width, height: res.height, bytes: buf.length, sha256: sha(buf) };
    console.log(`${name}.webp ${res.width}×${res.height} ${(buf.length / 1024).toFixed(1)} KB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  manifest.note = 'Rendered by scripts/owner-control-render.js from scripts/owner-control-scenes.js. Do not edit by hand.';
  manifest.scenes = { file: 'scripts/owner-control-scenes.js', sha256: sha(fs.readFileSync(SCENES)) };
  manifest.renderer = { babylon: await page.evaluate(() => BABYLON.Engine.Version), webgl: 'SwiftShader (headless Chromium)' };
  const sorted = {};
  for (const k of Object.keys(manifest.images).sort()) sorted[k] = manifest.images[k];
  manifest.images = sorted;
  fs.writeFileSync(manifestPath, JSON.stringify({ note: manifest.note, scenes: manifest.scenes, renderer: manifest.renderer, images: manifest.images }, null, 2) + '\n');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
