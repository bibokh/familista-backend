# Design Studio 3D: measuring on real devices

The 3D view's timings in the repository's proofs come from headless Chromium, which renders WebGL and composites the
page in software (SwiftShader). They are a slow baseline, not a measurement of real graphics hardware. This procedure
measures a real device. Nothing in it changes a saved design or calls the server; the one edit it makes (step 7) is
undone at the end. It reads the room's own read-only metrics (`window.__familistaProductDesignMetrics()`): the 3D
engine's own count of frames drawn and of artwork repaints.

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
3. Paste the measuring function once. It watches the 3D engine on every animation frame and records the moment each
   new 3D frame is drawn and each time the garment's artwork is repainted:

```js
window.__pdPerf = async function (label, seconds) {
  const eng = () => (window.__familistaProductDesignMetrics().three.engine || {});
  const e0 = eng(), times = []; let renders = e0.renders || 0, last = 0; const page = []; const t0 = performance.now();
  await new Promise((done) => { (function f(t) {
    if (last) page.push(t - last); last = t;
    const r = eng().renders || 0; if (r > renders) { times.push(t); renders = r; }
    if (t - t0 < seconds * 1000) requestAnimationFrame(f); else done(); })(performance.now()); });
  const e1 = eng(), secs = (performance.now() - t0) / 1000;
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b), q = (a, p) => (a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1) : null);
  const row = { label, seconds: +secs.toFixed(1), quality: e1.quality, scaling: e1.scaling,
    frames3d: (e1.renders || 0) - (e0.renders || 0), frames3dPerSecond: +(((e1.renders || 0) - (e0.renders || 0)) / secs).toFixed(1),
    frame3dIntervalMedianMs: q(gaps, 0.5), frame3dIntervalP95Ms: q(gaps, 0.95),
    repaints: ((e1.paints || 0) - (e0.paints || 0)), repaintsPerSecond: +(((e1.paints || 0) - (e0.paints || 0)) / secs).toFixed(1),
    dragUpdates: (e1.composites || 0) - (e0.composites || 0), pageFrameMedianMs: q(page.slice().sort((a, b) => a - b), 0.5) };
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
6. **Orbit.** Run `__pdPerf('orbit', 5)` and, within a second, drag on the canvas to turn the garment, without pausing,
   for five seconds.
7. **Edit.** In the **Layers** list, select *Club crest*. Click the 3D canvas once (this selects nothing on the garment;
   it gives the canvas the keyboard). Run `__pdPerf('edit', 5)` and, within a second, press the arrow keys repeatedly
   (left, right, left, right…) for five seconds. Afterwards press Ctrl+Z (⌘Z) until the crest is back where it was.
8. **Rest.** Run `__pdPerf('rest', 3)` without touching anything. `frames3d: 0` and `repaints: 0` are expected: the view
   draws nothing at rest.
9. Change **Quality** in the 3D bar and repeat steps 5–7 for each level.

*Direct manipulation on the garment (dragging an element on it) is switched off in this version. When it is switched
on again, add a step: run `__pdPerf('drag', 5)` while dragging the sponsor text on the garment; `dragUpdates` counts
the drag's redraws.*

## Reading the results

- `frames3dPerSecond`, `frame3dIntervalMedianMs` and `frame3dIntervalP95Ms`: how often the 3D view actually drew a frame
  while the action ran. These are the figures to compare with the targets.
- `repaintsPerSecond`: during an edit, how often the garment's artwork was redrawn to follow the change.
- `pageFrameMedianMs`: the browser's own frame cadence, for context only. **It is not the 3D frame rate**: the view
  draws only when something changes, so a page can tick at 60 Hz while the garment is drawn much less often, or not at all.

**Proposed targets, to be confirmed by these measurements.** They are not claims about current performance.
- Desktop with a graphics card or Apple silicon: turntable and orbit ≥ 50 3D frames a second (median interval ≤ 20 ms).
- Recent phone: turntable and orbit ≥ 30 3D frames a second (median interval ≤ 33 ms).
- An arrow-key edit is on the garment within one or two frames: `repaintsPerSecond` close to the key-repeat rate.
- Any device: 3D ready ≤ 3 s; no console error.

## Why the method changed

The first version of this procedure (commit `ed993d3`) timed the browser's animation frames and reported their
median as the frame rate. Run in headless Chromium on 13 November 2026, it reported, at the low, balanced and high
quality levels in turn:

| Step | Low | Balanced | High |
|---|---|---|---|
| Turntable | 49.9 ms (20 fps) | 66.6 ms (15 fps) | 66.7 ms (15 fps) |
| Orbit | 16.7 ms (59.9 fps) | 16.7 ms (59.9 fps) | 16.7 ms (59.9 fps) |
| Drag | 50 ms (20 fps) | 66.7 ms (15 fps) | 66.7 ms (15 fps) |
| Rest | 16.7 ms (59.9 fps) | 16.7 ms (59.9 fps) | 16.7 ms (59.9 fps) |

These are kept as recorded. They describe the page, not the 3D view, which draws only when something changes: the
orbit's figure is the same as at rest. On 21 November it was found that this orbit drew no 3D frame at all. A defect,
since fixed, stopped a drag on the canvas from turning the camera (see §16 of
`docs/DESIGN_STUDIO_ARCHITECTURE_PROPOSAL.md`). The run's own record agrees: during the orbit the resolution stayed at
its resting level, which it leaves as soon as the camera moves. A frame rate the page reports whether or not the garment
is drawn cannot measure the garment.

The version above counts the engine's own frames and repaints. Run in the same environment on 21 November, after the
fix, it gave:

| Step: 3D frames a second, and their median interval | Low | Balanced | High |
|---|---|---|---|
| Turntable | 19.2 (50 ms) | 15.6 (66.6 ms) | 12.8 (83.3 ms) |
| Orbit | 19.0 (50 ms) | 17.0 (50.1 ms) | 12.1 (83.3 ms) |
| Edit: arrow keys pressed a second, and artwork repaints a second | 6.8 and 4.7 | 4.0 and 2.9 | 4.2 and 2.4 |
| Rest: 3D frames in 3 s | 0 | 0 | 1, with no repaint (its cause was not established) |

While the garment is drawn, the page ticks with it; at rest the page ticks at 16.7 ms while the garment draws nothing,
which is the difference the first version could not see. These are software-rendering figures, not a device, so they
are not compared with the targets above. They also show a limit to measure on a device: an arrow-key edit repaints the
whole surface at full resolution, so here one repaint covers one or two presses.

The engine-based figures in §16 and in the browser proof are unaffected. The orbit's pointer rate, which was not one of
them, is corrected there.

## If something fails

- **3D could not start.** The room returns to 2.5D and says why. Record the message and the GPU line from `chrome://gpu`, or Safari's equivalent.
- **The view closes with "could not draw the design"** (texture). This browser refused to upload the artwork to WebGL. Record the browser and version. Some older Safari versions treat images drawn from SVG as cross-origin.
- **Optional detail** (Chrome only). Record a trace: DevTools → Performance → Record, during steps 6 and 7. Note the share of *GPU* and *Commit* in the main thread.
