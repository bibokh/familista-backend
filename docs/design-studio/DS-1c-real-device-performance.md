# Design Studio 3D: measuring on real devices

The 3D view's timings in the repository's proofs come from headless Chromium, which renders WebGL and composites the
page in software (SwiftShader). They are a slow baseline, not a measurement of real graphics hardware. This procedure
measures a real device. Nothing in it changes a design or calls the server. It reads the room's own read-only metrics
(`window.__familistaProductDesignMetrics()`) and the browser's animation-frame clock.

## What to record for every run

| Field | Example |
|---|---|
| Commit or deployed version | the `?v=` of `/product-design/pd-3d.js` in the Network panel |
| Device, OS, browser and version | MacBook Air M2, macOS 15, Chrome 141 |
| GPU, as the browser reports it | Chrome: `chrome://gpu` → *GL_RENDERER*; Safari: Develop → *Experimental features* page header |
| Window size, and the device pixel ratio (`devicePixelRatio`) | 1672 × 941 at 2 |
| Power | on mains / on battery |
| Quality level in the 3D bar | Low, Balanced or High |

Close other tabs. Wait for the room to finish loading before measuring.

## Steps

1. Sign in as the Platform Owner and open **Design Studio**.
2. Open the console:
   - desktop: DevTools;
   - Android: `chrome://inspect` from a desktop;
   - iPhone: Safari Web Inspector from a Mac.
3. Paste the measuring function once:

```js
window.__pdPerf = async function (label, seconds) {
  const m = () => window.__familistaProductDesignMetrics();
  const e0 = m().three.engine || {}; const iv = []; let last = 0; const t0 = performance.now();
  await new Promise((done) => { (function f(t) { if (last) iv.push(t - last); last = t; if (t - t0 < seconds * 1000) requestAnimationFrame(f); else done(); })(performance.now()); });
  const s = iv.slice().sort((a, b) => a - b), q = (p) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1);
  const e1 = m().three.engine || {};
  const row = { label, frames: iv.length, medianMs: q(0.5), p95Ms: q(0.95), fpsMedian: +(1000 / q(0.5)).toFixed(1),
    quality: e1.quality, scaling: e1.scaling, composites: (e1.composites || 0) - (e0.composites || 0), paints: (e1.paints || 0) - (e0.paints || 0),
    compositeMsMedian: e1.draftMsMedian, textureMsMedian: e1.textureMsMedian };
  console.table([row]); return row;
};
```

4. **Time to 3D.** Paste the following. It presses 3D and reports the time until the garment is painted:

```js
(async () => { const t0 = performance.now(); document.querySelector('#pd-root [data-pd-mode="3d"]').click();
  while (!(window.__familistaProductDesignMetrics().three.state === 'ready' && !window.__familistaProductDesignMetrics().three.engine.pending)) await new Promise((r) => setTimeout(r, 20));
  console.log('3D ready in', Math.round(performance.now() - t0), 'ms'); })();
```

5. **Turntable.** Press **360°**, then run `__pdPerf('turntable', 5)`. Press **360°** again to stop.
6. **Orbit.** Run `__pdPerf('orbit', 5)` and, within a second, drag on the empty canvas around the garment to turn it, without pausing, for five seconds.
7. **Drag.** Run `__pdPerf('drag', 5)` and, within a second, drag the *Familista* sponsor text back and forth on the garment for five seconds. `composites` counts the moves drawn. Afterwards press Ctrl+Z (⌘Z) until the text is back where it was.
8. **Rest.** Run `__pdPerf('rest', 3)` without touching anything. A median near the display's refresh period with `composites: 0` is expected: the view draws nothing at rest.
9. Change **Quality** in the 3D bar and repeat steps 5–7 for each level.

## Reading the results

- `medianMs` and `p95Ms` measure the page's frame cadence while the action runs; `fpsMedian` is `1000 / medianMs`.
- During a drag, `composites` divided by the seconds measured is the number of updates of the garment per second.

**Proposed targets, to be confirmed by these measurements.** They are not claims about current performance.
- Desktop with a graphics card or Apple silicon: turntable and orbit median ≤ 20 ms (≥ 50 fps); drag ≥ 30 updates a second.
- Recent phone: turntable and orbit median ≤ 33 ms (≥ 30 fps); drag ≥ 20 updates a second.
- Any device: 3D ready ≤ 3 s; no console error.

## If something fails

- **3D could not start.** The room returns to 2.5D and says why. Record the message and the GPU line from `chrome://gpu`, or Safari's equivalent.
- **The view closes with "could not draw the design"** (texture). This browser refused to upload the artwork to WebGL. Record the browser and version. Some older Safari versions treat images drawn from SVG as cross-origin.
- **Optional detail** (Chrome only). Record a trace: DevTools → Performance → Record, during step 7. Note the share of *GPU* and *Commit* in the main thread.
