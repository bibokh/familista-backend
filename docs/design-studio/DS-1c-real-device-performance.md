# Design Studio 3D: measuring on real devices

The 3D view's timings in the repository's proofs come from headless Chromium, which renders WebGL and composites the
page in software (SwiftShader). They are a slow baseline, not a measurement of real graphics hardware, and CI reports
them without gating on them. This procedure is the hardware acceptance. It measures, on a Windows computer and an
Android phone:

- **Loading:** 3D loading time, cold and warm.
- **Rendering:** the Babylon engine's own frames, in the turntable and in a hand-driven orbit.
- **Responsiveness:** how quickly the camera answers the pointer or the finger.
- **Live editing:** how quickly an edit made in the editor reaches the garment.
- **Resources:** memory, wherever the browser reports it.
- **Visual quality:** at each quality level.

It reads the room's own read-only metrics (`window.__familistaProductDesignMetrics()`): the engine's count of frames
drawn and of artwork repaints. The edits it asks for are undone at the end, and nothing is written to the server.

## Status: a post-release validation requirement

**Owner decision, 22 November 2026.** For the initial, Owner-only release of DS-1c, the Owner accepted the
documented variability of software-rendered performance. That acceptance is not legal clearance, and it does not
approve unrestricted commercial use.

No measurement has been made on physical graphics hardware or on a phone. None was reachable from the environment
that built this release, and no such figure is reported anywhere in the repository. This procedure therefore remains
a requirement after release. It must be completed before the 3D view is offered beyond the Platform Owner or used
commercially:

1. A Windows PC with a graphics card: Parts A to D below, at the three quality levels.
2. An Android phone, through the same server: Parts B to D.
3. The results compared with the proposed targets below, which the Owner then confirms or changes.

iOS is not covered: it needs a Mac or an approved test environment. Nothing in the procedure lowers or replaces the
browser proof's own budgets.

## What runs where

| Part | Where | Why |
|---|---|---|
| The application | Your Windows PC, from this branch, with `tools/components/design-studio-device-server.cjs` | The change is not deployed. That tool serves it as production does, but only to this PC. |
| Desktop measurements | Chrome or Edge on the same PC | Real GPU, driver and display |
| Phone measurements | Chrome on an Android phone, connected to the PC by USB | The phone reaches the PC's server through Chrome's port forwarding and is inspected from the PC. Nothing is opened to the network. |
| Not covered | iPhone and iPad | Safari's inspector needs a Mac, and the local server cannot be reached from an iPhone without one. Measuring iOS needs a Mac or a deployed test environment, which needs your approval. |

None of this can be measured from the development environment that produced this branch: it has no graphics card, no
display and no phone. The result of every step below exists only on your devices.

## Part A — the server on your Windows PC (once)

You need Git, Node.js 20 LTS (`node -v` shows v20), PostgreSQL 16 (the Windows installer from postgresql.org, which
includes pgAdmin and `psql`) and Chrome or Edge. In **PowerShell**:

```powershell
git clone https://github.com/bibokh/familista-backend.git
cd familista-backend
git checkout claude/kind-bell-inkoyy
npm ci
npm run build
& "C:\Program Files\PostgreSQL\16\bin\createdb.exe" -U postgres familista_device
```

Start the server. Put your PostgreSQL password where shown, and choose the test owner's email and password (12 or more
characters). They are used on this PC only.

```powershell
$env:DEVICE_DB_URL = "postgresql://postgres:YOUR_POSTGRES_PASSWORD@localhost:5432/familista_device"
$env:DEVICE_OWNER_EMAIL = "owner@device.test"
$env:DEVICE_OWNER_PASSWORD = "choose-a-long-password"
node tools/components/design-studio-device-server.cjs
```

It migrates the test database, creates that owner the first time, and prints `Ready`. It refuses any database that is
not on this computer, and listens on this computer only. Leave the window open; Ctrl+C stops it. To start again later,
open PowerShell in the same folder and run the four `$env:` and `node` lines again.

## Part B — the browsers

**Desktop.**

1. Open `http://localhost:47934/` in Chrome or Edge.
2. Sign in with the test owner's email and password.
3. Open **Design Studio** (`http://localhost:47934/#product-design`).
4. Press F12 for DevTools, and choose the **Console** tab.

**Android phone.**

1. On the phone, open Settings → About phone and tap *Build number* seven times. Then, in Settings → System → Developer
   options, turn on **USB debugging**.
2. Connect the phone to the PC by USB and accept the prompt on the phone.
3. On the PC, open `chrome://inspect/#devices` in Chrome. Under *Port forwarding…*, add port `47934` → `localhost:47934`,
   tick *Enable port forwarding* and press *Done*.
4. On the phone, open Chrome at `http://localhost:47934/`, sign in, and open Design Studio.
5. On the PC, under the phone's name in `chrome://inspect`, press **inspect** under that tab. Commands are typed in that
   window's Console; you act on the phone.

**Record for every run:**

| Field | Example |
|---|---|
| Commit | `git rev-parse --short HEAD` in the PowerShell folder |
| Device, OS, browser and version | Lenovo ThinkPad, Windows 11, Chrome 141; Pixel 8, Android 15, Chrome 141 |
| Graphics, as the browser reports it | the `gpu` row of the kit below; on the desktop also `chrome://gpu` → *GL_RENDERER* |
| Window size, and `devicePixelRatio` | in the `memory` rows of the kit |
| Power | on mains / on battery |

Close other tabs and apps. Wait for the room to finish loading before measuring.

## Part C — the measuring kit

Paste this once into the Console, after every reload. It keeps its results in this tab until the tab is closed, so a
reload loses nothing; `__pdClear()` starts again.

```js
window.__pdResults = JSON.parse(sessionStorage.getItem('__pdResults') || '[]');
window.__pdClear = () => { window.__pdResults = []; sessionStorage.removeItem('__pdResults'); };
window.__pdEngine = () => (window.__familistaProductDesignMetrics().three.engine || {});
window.__pdRecord = (row) => {
  window.__pdResults.push(Object.assign({ at: new Date().toISOString() }, row));
  sessionStorage.setItem('__pdResults', JSON.stringify(window.__pdResults));
  console.table([row]); return row;
};
// The 3D engine's own frames and artwork repaints over `seconds`; the page's own frame cadence is context only.
window.__pdPerf = async function (label, seconds) {
  const eng = window.__pdEngine;
  const e0 = eng(), times = []; let renders = e0.renders || 0, last = 0; const page = []; const t0 = performance.now();
  await new Promise((done) => { (function f(t) {
    if (last) page.push(t - last); last = t;
    const r = eng().renders || 0; if (r > renders) { times.push(t); renders = r; }
    if (t - t0 < seconds * 1000) requestAnimationFrame(f); else done(); })(performance.now()); });
  const e1 = eng(), secs = (performance.now() - t0) / 1000;
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b), q = (a, p) => (a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1) : null);
  return window.__pdRecord({ label, seconds: +secs.toFixed(1), quality: e1.quality, scaling: e1.scaling,
    frames3d: (e1.renders || 0) - (e0.renders || 0), frames3dPerSecond: +(((e1.renders || 0) - (e0.renders || 0)) / secs).toFixed(1),
    frame3dIntervalMedianMs: q(gaps, 0.5), frame3dIntervalP95Ms: q(gaps, 0.95),
    repaints: ((e1.paints || 0) - (e0.paints || 0)), repaintsPerSecond: +(((e1.paints || 0) - (e0.paints || 0)) / secs).toFixed(1),
    pageFrameMedianMs: q(page.slice().sort((a, b) => a - b), 0.5) });
};
// Press 3D and time it until the garment is painted.
window.__pdOpen3D = async function (label) {
  const t0 = performance.now(); document.querySelector('#pd-root [data-pd-mode="3d"]').click();
  while (!(window.__familistaProductDesignMetrics().three.state === 'ready' && !window.__pdEngine().pending)) await new Promise((r) => setTimeout(r, 20));
  return window.__pdRecord({ label: '3D ready, ' + label, ms: Math.round(performance.now() - t0), quality: window.__pdEngine().quality });
};
// Camera responsiveness: from each pointer or finger move on the 3D canvas to the next 3D frame (to the nearest frame).
window.__pdInput = async function (seconds) {
  const cv = document.querySelector('#pd-root .pd3-canvas'); if (!cv) throw new Error('Open 3D first');
  const lat = []; let pending = null; const a0 = window.__pdEngine().camera.alpha;
  const on = (ev) => { if (ev.buttons && !pending) pending = { t: ev.timeStamp, r: window.__pdEngine().renders || 0 }; };
  cv.addEventListener('pointermove', on, { passive: true });
  const t0 = performance.now();
  await new Promise((done) => { (function f() {
    if (pending && (window.__pdEngine().renders || 0) > pending.r) { lat.push(performance.now() - pending.t); pending = null; }
    if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(f); else done(); })(); });
  cv.removeEventListener('pointermove', on);
  const s = lat.sort((a, b) => a - b), q = (p) => (s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : null), e = window.__pdEngine();
  return window.__pdRecord({ label: 'orbit input', quality: e.quality, samples: s.length, inputToFrameMedianMs: q(0.5), inputToFrameP95Ms: q(0.95), turnedRad: +Math.abs(e.camera.alpha - a0).toFixed(2) });
};
// Live editing: from each key press or tap in the room (not on the 3D canvas) to the 3D frame showing the repainted artwork.
window.__pdEdits = async function (seconds) {
  const root = document.getElementById('pd-root'), lat = []; let pending = null, unanswered = 0;
  const on = (ev) => { if (!ev.isTrusted || pending || (ev.target.closest && ev.target.closest('.pd3-canvas'))) return; pending = { t: ev.timeStamp, p: window.__pdEngine().paints || 0, r: null }; };
  root.addEventListener('keydown', on, true); root.addEventListener('click', on, true);
  const t0 = performance.now();
  await new Promise((done) => { (function f() {
    const e = window.__pdEngine(), now = performance.now();
    if (pending && pending.r === null && (e.paints || 0) > pending.p) pending.r = e.renders || 0;
    else if (pending && pending.r !== null && (e.renders || 0) > pending.r) { lat.push(now - pending.t); pending = null; }
    else if (pending && now - pending.t > 3000) { unanswered++; pending = null; }
    if (now - t0 < seconds * 1000) requestAnimationFrame(f); else done(); })(); });
  root.removeEventListener('keydown', on, true); root.removeEventListener('click', on, true);
  const s = lat.sort((a, b) => a - b), q = (p) => (s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : null);
  return window.__pdRecord({ label: 'edit', quality: window.__pdEngine().quality, samples: s.length, editToFrameMedianMs: q(0.5), editToFrameP95Ms: q(0.95), unanswered });
};
// Memory and size, as far as this browser reports them (the JavaScript heap is Chrome-only; textures are estimated).
window.__pdMemory = function (label) {
  const m = performance.memory, e = window.__pdEngine(), cv = document.querySelector('#pd-root .pd3-canvas');
  const tex = (e.texturePx || []).reduce((n, x) => n + x[1] * x[2] * 4 * 4 / 3, 0) / 1048576;
  return window.__pdRecord({ label: 'memory, ' + label, quality: e.quality || null,
    jsHeapUsedMB: m ? +(m.usedJSHeapSize / 1048576).toFixed(1) : null, jsHeapLimitMB: m ? Math.round(m.jsHeapSizeLimit / 1048576) : null,
    artworkTexturesMB: +tex.toFixed(1), vertices: e.vertices || null, canvasPx: cv ? [cv.width, cv.height] : null,
    window: [innerWidth, innerHeight], devicePixelRatio, deviceMemoryGB: navigator.deviceMemory || null, cores: navigator.hardwareConcurrency || null });
};
// The graphics the browser uses, and its limits.
window.__pdGpu = function () {
  const c = document.createElement('canvas'), gl = c.getContext('webgl2') || c.getContext('webgl'), x = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const row = { label: 'gpu', webgl: gl ? (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? 2 : 1) : 0,
    renderer: gl ? gl.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null, vendor: gl ? gl.getParameter(x ? x.UNMASKED_VENDOR_WEBGL : gl.VENDOR) : null,
    maxTextureSize: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : null, userAgent: navigator.userAgent };
  const lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
  return window.__pdRecord(row);
};
```

## Part D — the steps

Each step names the command to type in the Console. On the phone, *drag* means a finger, and the buttons are tapped.

1. **The device.** Run `__pdGpu()` and `__pdMemory('room, 2D')`.
2. **3D, cold.**
   1. In DevTools, open the Network tab and tick **Disable cache**.
   2. Reload the page and paste the kit again.
   3. Run `__pdOpen3D('cold')`.
   4. In the Network tab, note the *Transferred* size of `babylon.js`.
3. **3D, warm.**
   1. Untick Disable cache.
   2. Press 2D, then run `__pdOpen3D('warm')`.
   3. Run `__pdMemory('3D ready')`.
4. **For each quality level, Low, Balanced and High**, choose the level with the quality button in the 3D bar, then:
   1. **Turntable.** Press **360°**, run `__pdPerf('turntable', 5)`, then press **360°** again to stop.
   2. **Orbit.** Run `__pdPerf('orbit', 5)` and, within a second, drag on the garment without pausing for five seconds.
   3. **Camera response.** Run `__pdInput(5)` and drag the same way for five seconds.
      - `turnedRad` must not be 0. If it is, the camera did not follow: record that as a failure.
   4. **Live editing.**
      1. In the **Layers** list, select *Club crest*.
         - On the desktop, click the 3D canvas once to give the editor the keyboard; this selects nothing on the garment.
      2. Run `__pdEdits(15)`.
      3. On the desktop, press an arrow key about once a second for fifteen seconds. On the phone, tap a colour in
         *Element properties* about once every two seconds.
      4. Afterwards, undo: Ctrl+Z on the desktop, until the crest is back where it was; or tap the crest's original colour
         on the phone.
   5. **Rest.** Run `__pdPerf('rest', 3)` without touching anything. `frames3d: 0` and `repaints: 0` are expected.
   6. **Memory.** Run `__pdMemory('after ' + __pdEngine().quality)`.
   7. **Visual quality.** Take three screenshots of the canvas:
      - the front view (press *Front*);
      - the close-up (press the close-up button, with the crest selected);
      - straight after a drag, within a second of letting go.

      Use Win+Shift+S on the desktop, or the phone's own screenshot. For each, note:
      - **Text and crest:** are *Familista* and the crest's edges sharp, or soft, stepped or shimmering?
      - **Fabric:** do the stripes and the knit show moiré or crawl when the garment turns?
      - **Construction:** are the collar, the cuffs and the seams whole, with no gap and no mirrored text?
      - **Settling:** is the garment sharp again within a second of a drag? It is drawn coarser while it moves, by design.
5. **Desktop only: resources.**
   1. While the turntable runs at Balanced, open Chrome's Task Manager (Shift+Esc) and note the tab's *Memory footprint*,
      *GPU memory* and *CPU*.
   2. In Windows Task Manager → Performance → GPU, note *3D* usage.
6. **Send the results.** Run `copy(JSON.stringify(__pdResults, null, 1))`, which puts every row on the clipboard. Paste them
   into a text file, and send it with the screenshots and the table from Part B.

The kit was run verbatim in headless Chromium before it was committed, to check that every command works and returns
its row. That checks the commands, not a device: it has no graphics card.

## Reading the results

- **`frames3dPerSecond`, `frame3dIntervalMedianMs` and `frame3dIntervalP95Ms`:** how often the 3D view actually drew
  while the action ran.
- **`inputToFrameMedianMs`:** how long the garment took to answer the hand.
- **`editToFrameMedianMs`:** how long an edit took to reach the garment. `unanswered` counts presses or taps that changed
  nothing.
- **`pageFrameMedianMs`:** the browser's own cadence, for context only. **It is not the 3D frame rate.** The view draws
  only when something changes.

**Proposed acceptance targets, for the Owner to confirm or change.** None is a claim about current performance.

| | Desktop with a graphics card or Apple silicon | Recent phone |
|---|---|---|
| 3D ready (warm) | ≤ 2 s | ≤ 4 s |
| Turntable and orbit | ≥ 50 3D frames a second (median interval ≤ 20 ms) | ≥ 30 (≤ 33 ms) |
| Camera response, median | ≤ 33 ms (two 60 Hz frames) | ≤ 50 ms |
| Edit to garment, median, at Balanced | ≤ 100 ms | ≤ 200 ms |
| At rest | 0 frames and 0 repaints | 0 frames and 0 repaints |
| Errors | none in the Console | none in the Console |

The visual checks above must hold at Balanced on both devices.

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

The second version (commit `7619b9c`) counted the engine's own frames and repaints, as the kit above still does. Run in
the same environment on 21 November, after the fix, it gave:

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
- **Optional detail** (Chrome only). Record a trace: DevTools → Performance → Record, during the orbit and the live editing of step 4. Note the share of *GPU* and *Commit* in the main thread.
- **The server will not start.** `Refused: DEVICE_DB_URL points at …` means the URL is not `localhost`. `prisma migrate deploy failed` usually means the PostgreSQL password or the database name is wrong, or `createdb` was not run.
- **Sign-in fails.** The owner is created only the first time; if you changed `DEVICE_OWNER_PASSWORD` afterwards, use the first one, or create a new empty database and start again.
- **The phone shows *This site can’t be reached*.** In `chrome://inspect`, port forwarding must be enabled and the phone must show as connected; the PC's server window must say `Ready`.
