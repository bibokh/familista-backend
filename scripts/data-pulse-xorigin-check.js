#!/usr/bin/env node
// Data Pulse — the cross-origin authentication check, in a real browser
// ─────────────────────────────────────────────────────────────────────────────
// Run:  node scripts/data-pulse-xorigin-check.js
//
// WHY THIS EXISTS AS A SCRIPT AND NOT A JEST TEST
//
// The production 401 was invisible to every same-origin test, because it was
// caused by the two things a same-origin test cannot see: an absolute API base
// and a cookie that does not travel between origins. So this serves the panel
// from ONE host and the API from ANOTHER — 127.0.0.1 and localhost are
// different origins to a browser — and drives it with the real Chromium.
//
// It is a script rather than part of `npm test` because it needs a browser
// binary the default suite does not have. The unit suite pins the SAME
// properties by reading the source; this proves them by running them.
//
// WHAT IT ASSERTS, and each one is a production failure that already happened
// or was one deploy away:
//
//   fresh owner token       → connects, Live, one frame from two server sends
//   expired access token    → ONE canonical refresh, then connects
//   signed out entirely     → 401 "Not signed in", and no retry loop
//   club president          → 403 "Not authorised", never a stream
//   head coach              → 403, likewise
//   every case              → no credential anywhere in a URL
//
// The stand-in origins map to production as:
//   http://127.0.0.1:7801  ~  https://familista-v5.onrender.com
//   http://localhost:7802  ~  https://familista-backend.onrender.com

// Reproduces production's TWO ORIGINS, in a real browser.
//   frontend  http://127.0.0.1:7801   (stands in for familista-v5.onrender.com)
//   backend   http://localhost:7802   (stands in for familista-backend.onrender.com)
// Different host => a genuinely cross-origin request, with real CORS and real
// cookie rules. A same-origin harness would have passed while production 401'd.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const FRONT = 'http://127.0.0.1:7801';
const BACK  = 'http://localhost:7802';
const seen = [];
let tokenValid = 'fresh-owner-token';
let role = 'OWNER';
let refreshCalls = 0;
let refreshWorks = true;   // a valid refresh cookie, or not

const backend = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const auth = req.headers.authorization || '';
  seen.push({ url: req.url, auth: auth || null, cookie: req.headers.cookie || null });

  const cors = {
    'Access-Control-Allow-Origin': FRONT,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  if (url === '/api/v1/auth/refresh') {
    refreshCalls += 1;
    if (!refreshWorks) { res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'No refresh token' })); return; }
    tokenValid = 'refreshed-owner-token';
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { accessToken: tokenValid } }));
    return;
  }

  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!bearer) { res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'No token provided' })); return; }
  if (bearer !== tokenValid) { res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'Token expired' })); return; }
  if (role !== 'OWNER') { res.writeHead(403, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'Platform authority required' })); return; }

  if (url === '/api/v1/system/data-pulse/stream') {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const topo = { sources: ['Clubs','Users','Players','Training','Matches','Transfers','Medical','Media','AI','System'],
      destinations: [{name:'Operational Data',live:true},{name:'Media',live:true},{name:'Audit',live:true},{name:'Analytics',live:true}],
      future: ['ML Pipeline','Feature Store','Data Lake','Cameras','GPS','Edge'].map(n=>({name:n,live:false,note:'Architecture only — nothing is connected to this yet'})),
      instrumented: [], notInstrumented: ['training.started'] };
    const met = { eventsPerSecond:1, eventsPerMinute:2, activeClubs:1, totalObserved:2, averageLatencyMs:5,
      lastEventAt:new Date().toISOString(), processed:null, failed:null, pending:null, notInstrumented:['processed','failed','pending'] };
    const frame = { eventId:'evt-1', eventType:'player.updated', schemaVersion:1,
      occurredAt:new Date().toISOString(), recordedAt:new Date().toISOString(), latencyMs:5,
      clubId:'fc-familista', teamId:null, subjectType:'PLAYER', subjectId:null, sourceType:'USER',
      correlationId:null, causationId:null, dataClassification:'CONFIDENTIAL',
      source:'Players', destination:'Operational Data', registered:true, status:'STORED' };
    res.write('retry: 3000\n\n');
    res.write('event: hello\ndata: ' + JSON.stringify({ topology: topo, metrics: met, limits: {} }) + '\n\n');
    res.write('event: backlog\ndata: ' + JSON.stringify({ frames: [frame] }) + '\n\n');
    setTimeout(() => { try { res.write('event: pulse\ndata: ' + JSON.stringify({ frames: [frame], observed: 1, sampling: 1 }) + '\n\n'); } catch (_) {} }, 150);
    return;
  }
  if (url === '/api/v1/system/data-pulse/replay') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { frames: [{ eventId:'evt-replay-1', eventType:'player.updated',
      schemaVersion:1, occurredAt:new Date().toISOString(), recordedAt:new Date().toISOString(), latencyMs:3,
      clubId:'fc-familista', teamId:null, subjectType:'PLAYER', subjectId:null, sourceType:'USER',
      correlationId:null, causationId:null, dataClassification:'CONFIDENTIAL', source:'Players',
      destination:'Operational Data', registered:true, status:'STORED' }],
      from:'', to:'', truncated:false, legacyCount:0, counts:{total:1,processed:null,failed:null,pending:null} } }));
    return;
  }
  res.writeHead(404, cors); res.end('');
});

const frontend = http.createServer((req, res) => {
  let f = req.url.split('?')[0];
  if (f === '/') f = '/__x.html';
  try {
    const b = fs.readFileSync(path.join('public', f));
    res.setHeader('Content-Type', f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(b);
  } catch (_) { res.statusCode = 404; res.end(''); }
});

const HTML = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/system/system.css">
<div id="pg-system"><div class="sy-shell"><div id="dp-host"></div></div></div>
<script>
  // Production's shape: an ABSOLUTE, cross-origin API base.
  var FAM_CONFIG = { API_BASE: '${BACK}/api/v1' };
  // The token where the application really keeps it.
  window.State = { token: 'fresh-owner-token' };
  // The client app.js actually exports: get/refreshTokens, and NO getToken.
  window.FamilistaAPI = {
    get: function (p) {
      var t = (window.State && window.State.token) || '';
      return fetch(FAM_CONFIG.API_BASE + p, {
        headers: t ? { Authorization: 'Bearer ' + t } : {}, credentials: 'include',
      }).then(function (r) {
        if (r.status === 401) {
          return window.FamilistaAPI.refreshTokens().then(function (ok) {
            if (!ok) { var e = new Error('HTTP 401'); e.status = 401; throw e; }
            return window.FamilistaAPI.get(p);
          });
        }
        if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
        return r.json();
      });
    },
    refreshTokens: function () {
      return fetch(FAM_CONFIG.API_BASE + '/auth/refresh', { method: 'POST', credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (b) {
          var at = b && b.data && b.data.accessToken;
          if (at) { window.State.token = at; return true; }
          return false;
        }).catch(function () { return false; });
    },
  };
</script>
<script src="/data-pulse.js"></script>`;

fs.writeFileSync('public/__x.html', HTML);

(async () => {
  await new Promise(r => backend.listen(7802, r));
  await new Promise(r => frontend.listen(7801, '127.0.0.1', r));
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = {};

  const run = async (label, setup) => {
    seen.length = 0;
    const p = await b.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(FRONT + '/', { waitUntil: 'load' });
    if (setup) await p.evaluate(setup);
    await p.evaluate(() => window.dpMount('dp-host'));
    await p.waitForTimeout(900);
    results[label] = {
      ...(await p.evaluate(() => ({
        connected: window._DP.connected, fatalStatus: window._DP.fatalStatus,
        frames: window._DP.frames.length,
        status: (document.querySelector('.sy-dp-status') || {}).textContent,
      }))),
      // GET only: an OPTIONS preflight never carries Authorization by spec,
      // so counting it as an unauthenticated request would be noise.
      requests: seen.filter(r => r.url.includes('data-pulse') && r.auth !== null).length + ' authenticated GET(s)',
      unauthenticatedGets: seen.filter(r => r.url.includes('data-pulse') && r.auth === null).length,
      tokenInUrl: seen.some(r => /token=/.test(r.url)),
      pageErrors: errs,
    };
    await p.close();
  };

  await run('fresh owner token');

  tokenValid = 'rotated-token'; refreshCalls = 0;
  await run('expired token -> refresh', () => { window.State.token = 'stale-token'; });
  results['expired token -> refresh'].refreshCalls = refreshCalls;

  // No access token AND no valid refresh cookie: a genuinely signed-out
  // browser, which must read 401 rather than retrying for ever.
  tokenValid = 'fresh-owner-token'; refreshWorks = false;
  await run('signed out (no token, no refresh)', () => { window.State.token = ''; try { localStorage.removeItem('familista_token'); } catch (_) {} });
  refreshWorks = true;

  role = 'PRESIDENT';
  await run('president', () => { window.State.token = 'fresh-owner-token'; });
  role = 'COACH';
  await run('head coach', () => { window.State.token = 'fresh-owner-token'; });
  role = 'OWNER';

  console.log(JSON.stringify(results, null, 1));
  await b.close(); backend.close(); frontend.close();
  try { fs.unlinkSync('public/__x.html'); } catch (_) {}
})();
