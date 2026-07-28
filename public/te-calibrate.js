/* ════════════════════════════════════════════════════════════════════════════
   Familista — Manual-Assisted Pitch Calibration workflow (production)
   ---------------------------------------------------------------------------
   Integrates a coach-facing calibration workflow into the real Video Intelligence
   player. Uses the existing homography engine (window.FamilistaTE) + the app's
   calibration data model (proj.teImg / proj.teCamKeys / _teCalibrateVI* / _teImgAt).
     • "Calibrate Pitch" → 4 draggable handles on the video → homography → every
       telestration object is projected onto the grass plane (perspective-correct).
     • "＋ Keyframe" → add a camera calibration keyframe at the current time.
     • "New Camera Shot" → start a new calibration segment (hard cut, no blend).
     • Handles keep the calibration editable at any time → manual drift correction.
   No separate demo/page; nothing in the existing UI is rebuilt. Legacy 2D stays
   as fallback for uncalibrated projects.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var DEF = [{ ix: 0.22, iy: 0.34 }, { ix: 0.78, iy: 0.34 }, { ix: 0.98, iy: 0.92 }, { ix: 0.02, iy: 0.92 }];
  var LBL = ['TL', 'TR', 'BR', 'BL'];
  var st = { on: false, handles: [], drag: null, tick: 0 };

  function proj() { return (typeof window._vistProj === 'function') ? window._vistProj() : null; }
  function vid() { return document.getElementById('vi-video'); }
  function vtime() { var v = vid(); return v ? (v.currentTime || 0) : 0; }
  function wrap() { return document.getElementById('vi-videowrap'); }
  function persist() { try { if (typeof window._vistPersist === 'function') window._vistPersist(); } catch (e) {} }
  function apply() { try { if (typeof window._teApplyHomographyNow === 'function') window._teApplyHomographyNow(); } catch (e) {} try { if (typeof window._vistRedraw === 'function') window._vistRedraw(); } catch (e) {} }
  function ptsNow() { var p = proj(); var im = (typeof window._teImgAt === 'function') ? window._teImgAt(p, vtime()) : (p && p.teImg); return (im && im.length >= 4) ? im.map(function (c) { return { ix: c.ix, iy: c.iy }; }) : DEF.map(function (c) { return { ix: c.ix, iy: c.iy }; }); }

  /* find/create the calibration keyframe nearest the current time (drift correction
     naturally edits the relevant keyframe; a new time creates a new keyframe). */
  function targetKey(create) {
    var p = proj(); if (!p) return null; var t = vtime();
    if (p.teCamKeys && p.teCamKeys.length) {
      var best = null, bd = 0.3; p.teCamKeys.forEach(function (k) { var d = Math.abs(k.t - t); if (d < bd) { bd = d; best = k; } });
      if (best) return best;
      if (!create) return null;
      var nk = { t: t, img: ptsNow() }; p.teCamKeys.push(nk); p.teCamKeys.sort(function (a, b) { return a.t - b.t; }); return nk;
    }
    if (create) { p.teCamKeys = [{ t: t, img: ptsNow() }]; return p.teCamKeys[0]; }
    return p.teImg ? { img: p.teImg, _static: true } : null;
  }

  function ensureCalibrated() {
    var p = proj(); if (!p) return;
    if (!(p.teCamKeys && p.teCamKeys.length) && !(p.teImg && p.teImg.length)) {
      if (typeof window._teCalibrateVIKeyframe === 'function') window._teCalibrateVIKeyframe(vtime(), DEF.map(function (c) { return { ix: c.ix, iy: c.iy }; }));
      else if (typeof window._teCalibrateVI === 'function') window._teCalibrateVI(DEF.map(function (c) { return { ix: c.ix, iy: c.iy }; }));
    }
  }

  function status() {
    var p = proj(); var s = document.getElementById('tecal-status'); if (!s) return;
    var nk = (p && p.teCamKeys) ? p.teCamKeys.length : 0; var shots = (p && p.teCamKeys) ? p.teCamKeys.filter(function (k) { return k.shot; }).length + (nk ? 1 : 0) : 0;
    var cal = !!(p && ((p.teImg && p.teImg.length) || nk));
    s.textContent = cal ? ('Calibrated · ' + nk + ' keyframe' + (nk === 1 ? '' : 's') + (shots > 1 ? ' · ' + shots + ' shots' : '')) : 'Not calibrated';
    s.style.color = cal ? '#7fe0c8' : '#c9a35b';
  }

  /* ── draggable handles ── */
  function clearHandles() { st.handles.forEach(function (h) { if (h.parentNode) h.parentNode.removeChild(h); }); st.handles = []; }
  function layout() {
    var w = wrap(); if (!w) return; var W = w.clientWidth, H = w.clientHeight; var pts = ptsNow();
    if (st.handles.length !== 4) { clearHandles(); pts.forEach(function (p, i) { var h = mkHandle(i); w.appendChild(h); st.handles.push(h); }); }
    if (!st.drag) st.handles.forEach(function (h, i) { h.style.left = (pts[i].ix * W) + 'px'; h.style.top = (pts[i].iy * H) + 'px'; });
  }
  function mkHandle(i) {
    var h = document.createElement('div'); h.className = 'tecal-h'; h.setAttribute('data-i', i);
    h.style.cssText = 'position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;border:2px solid #7fe0c8;background:rgba(20,40,50,.55);box-shadow:0 0 0 2px rgba(0,0,0,.5),0 0 14px rgba(127,224,200,.5);z-index:55;cursor:grab;touch-action:none;display:grid;place-items:center;color:#dffcf4;font:700 10px Inter,Arial;';
    h.textContent = LBL[i];
    h.addEventListener('pointerdown', function (ev) { st.drag = { i: i, h: h }; try { h.setPointerCapture(ev.pointerId); } catch (e) {} h.style.cursor = 'grabbing'; ev.preventDefault(); ev.stopPropagation(); });
    h.addEventListener('pointermove', function (ev) {
      if (!st.drag || st.drag.i !== i) return; var w = wrap(); if (!w) return; var r = w.getBoundingClientRect();
      var ix = Math.max(-0.1, Math.min(1.1, (ev.clientX - r.left) / (r.width || 1)));
      var iy = Math.max(-0.1, Math.min(1.1, (ev.clientY - r.top) / (r.height || 1)));
      h.style.left = (ix * w.clientWidth) + 'px'; h.style.top = (iy * w.clientHeight) + 'px';
      var k = targetKey(true); if (k) { k.img = k.img || ptsNow(); k.img[i] = { ix: ix, iy: iy }; if (k._static) { var p = proj(); p.teImg = k.img; } apply(); }
      ev.preventDefault();
    });
    function end(ev) { if (st.drag && st.drag.i === i) { st.drag = null; h.style.cursor = 'grab'; persist(); try { if (typeof window._teMountVI === 'function') window._teMountVI(true); } catch (e) {} status(); } }
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
    return h;
  }

  /* ── control bar ── */
  function bar() {
    var w = wrap(); if (!w || document.getElementById('tecal-bar')) return;
    if (getComputedStyle(w).position === 'static') w.style.position = 'relative';
    var b = document.createElement('div'); b.id = 'tecal-bar';
    b.style.cssText = 'position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:57;display:flex;gap:6px;align-items:center;background:rgba(9,14,20,.86);border:1px solid #24323d;border-radius:9px;padding:5px 7px;backdrop-filter:blur(4px);font:600 11px Inter,Arial;';
    b.innerHTML = btn('tecal-toggle', '📐 Calibrate Pitch')
      + btn('tecal-key', '＋ Keyframe')
      + btn('tecal-shot', '🎬 New Camera Shot')
      + '<span style="width:1px;height:18px;background:#2a3a45"></span>'
      + btn('tecal-auto', '🤖 Auto-assist')
      + '<span id="tecal-status" style="margin-left:4px;color:#c9a35b;font-weight:700">Not calibrated</span>';
    w.appendChild(b);
    on('tecal-toggle', function () { setMode(!st.on); });
    on('tecal-key', function () { ensureCalibrated(); var pts = ptsNow(); if (typeof window._teCalibrateVIKeyframe === 'function') window._teCalibrateVIKeyframe(vtime(), pts); if (!st.on) setMode(true); flash('tecal-key', 'Keyframe added'); status(); });
    on('tecal-shot', function () {
      ensureCalibrated(); var pts = ptsNow();
      if (typeof window._teCalibrateVIKeyframe === 'function') window._teCalibrateVIKeyframe(vtime(), pts);
      var p = proj(); if (p && p.teCamKeys) { var t = vtime(); var k = p.teCamKeys.filter(function (kk) { return Math.abs(kk.t - t) <= 0.031; })[0]; if (k) k.shot = true; persist(); try { window._teMountVI(true); } catch (e) {} }
      if (!st.on) setMode(true); flash('tecal-shot', 'New shot'); status();
    });
    on('tecal-auto', function () { var nowOn = !window._TE_AUTO; if (typeof window._teAutoRegister === 'function') window._teAutoRegister(nowOn); var el = document.getElementById('tecal-auto'); if (el) el.style.background = nowOn ? 'rgba(127,224,200,.22)' : '#18222c'; flash('tecal-auto', nowOn ? 'Auto-assist ON (manual has priority)' : 'Auto-assist OFF'); });
    status();
  }
  function btn(id, label) { return '<button id="' + id + '" type="button" style="font:600 11px Inter,Arial;color:#dfe8f0;background:#18222c;border:1px solid #2a3742;border-radius:7px;padding:6px 9px;cursor:pointer">' + label + '</button>'; }
  function on(id, fn) { var el = document.getElementById(id); if (el) el.onclick = function (ev) { ev.preventDefault(); fn(); }; }
  function flash(id, msg) { var s = document.getElementById('tecal-status'); if (s) { var old = s.textContent; s.textContent = msg; setTimeout(status, 1100); } }

  function setMode(v) {
    st.on = v; var t = document.getElementById('tecal-toggle');
    if (v) { ensureCalibrated(); if (t) { t.style.background = 'rgba(127,224,200,.22)'; t.textContent = '✓ Calibrating — drag handles'; } layout(); }
    else { if (t) { t.style.background = '#18222c'; t.textContent = '📐 Calibrate Pitch'; } clearHandles(); persist(); }
    status();
  }

  /* keep the bar present and handles in sync with the live player */
  setInterval(function () {
    if (!document.querySelector('.vi-studio') || !wrap()) return;
    bar();
    if (st.on) layout();
  }, 400);

  window.TE_Calibrate = { setMode: setMode, status: status };
})();
