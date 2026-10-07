#!/usr/bin/env node
// Familista Cyber Defense — the security manifest, read from the repository
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS
//
// Step 1 of Cyber Defense: a factual, build-time inventory of the platform's
// security posture — the API surface and which of it is reachable without a
// session, the route modules that exist but are not mounted, the security
// controls the code actually contains, the secrets the deployment declares (by
// NAME), the cryptography in use, and the software supply chain.
//
//   node scripts/security-discover.js           → write the manifest
//   node scripts/security-discover.js --check   → verify it is current
//   node scripts/security-discover.js --print   → print it, write nothing
//
// It changes nothing at runtime. Nothing imports the manifest yet; the posture
// tests read it, and a later step will draw it in the Cyber Defense room.
//
// WHAT IT WILL NOT DO
//
// It never reads the process environment. Secrets are reported by the NAME
// render.yaml declares and by HOW the value is supplied (dashboard, inline,
// linked) — the value itself has no path into this script. The serialised
// manifest is also run through the same paranoid sanitiser the infrastructure
// manifest uses, which refuses to write rather than redacting.
//
// EVERY FACT CARRIES ITS EVIDENCE
//
// A control is PRESENT, PARTIAL or ABSENT because of a named file and a pattern
// in it, and the manifest says which. A heuristic that stops matching after a
// refactor shows up as a changed manifest and a failing posture test, which is
// the point: somebody looks.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'src', 'cyber-defense', 'generated');
const OUT = path.join(OUT_DIR, 'security-manifest.json');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const PRINT = argv.includes('--print');

const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return null; }
};
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** Files this run actually opened. Reported, so the manifest can be audited. */
const evidenceFiles = new Set();
const cite = (rel) => { if (exists(rel)) evidenceFiles.add(rel); return rel; };

// ── the sanitiser ────────────────────────────────────────────────────────────

const SECRET_SHAPES = [
  /postgres(?:ql)?:\/\/[^\s"']+/i,
  /redis:\/\/[^\s"']+/i,
  /mongodb(?:\+srv)?:\/\/[^\s"']+/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsk_live_[A-Za-z0-9]{8,}/,
  /\brk_live_[A-Za-z0-9]{8,}/,
  /\bwhsec_[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

/**
 * Refuse to emit anything secret-shaped. Throws rather than redacts: a manifest
 * that silently dropped a leaked value would ship the next one too.
 */
function assertNoSecrets(serialised) {
  for (const shape of SECRET_SHAPES) {
    if (shape.test(serialised)) {
      throw new Error(
        `security-discover: refusing to write a manifest containing a secret-shaped value `
        + `(matched ${shape}). Nothing was written.`,
      );
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Every .ts file under a directory, repository-relative, sorted. Skips generated output. */
function tsFiles(relDir) {
  const out = [];
  const walk = (rel) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'generated' && e.name !== 'node_modules') walk(child); }
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(child);
    }
  };
  walk(relDir);
  return out.sort();
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Count files outside `exceptPrefix` whose source matches `re`. */
function callers(files, re, exceptPrefix) {
  return files.filter((f) => !f.startsWith(exceptPrefix) && re.test(read(f) || '')).length;
}

// ── 1 · the API surface ──────────────────────────────────────────────────────
//
// `src/routes/index.ts` is the one place routers are mounted. A handler is
// authenticated when its mount carries `authenticate`, when it is declared
// after its router's `router.use(authenticate)`, or when `authenticate` is in
// its own middleware list. Anything else is reachable without a session.

const INDEX = cite('src/routes/index.ts');
const indexSrc = read(INDEX) || '';

const importsByName = {};
for (const m of indexSrc.matchAll(/import\s+(\w+)\s+from\s+'\.\/([\w.-]+)'/g)) importsByName[m[1]] = m[2];

const ROUTE_RE = /router\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]*)\2/g;

const mounts = [];
const publicRoutes = [];
let handlersTotal = 0;
for (const m of indexSrc.matchAll(/router\.use\(\s*'([^']+)'\s*,([^;]+?)\);/g)) {
  const mountPath = m[1];
  const args = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  const routerName = args[args.length - 1];
  const moduleName = importsByName[routerName];
  if (!moduleName) continue;
  const file = cite(`src/routes/${moduleName}.ts`);
  const src = read(file) || '';
  const mountAuth = args.slice(0, -1).some((a) => /authenticate/.test(a));
  // Comments are blanked (same length, so offsets hold) before looking for the
  // gate: a comment that merely mentions router.use(authenticate) is not one.
  const code = src.replace(/\/\/[^\n]*/g, (c) => ' '.repeat(c.length));
  const gate = code.search(/router\.use\(\s*authenticate\b/);
  let handlers = 0;
  let open = 0;
  for (const r of src.matchAll(ROUTE_RE)) {
    handlers += 1;
    const close = src.indexOf(');', r.index);
    const own = src.slice(r.index, close < 0 ? r.index + 400 : close);
    const authed = mountAuth || (gate >= 0 && r.index > gate) || /\bauthenticate\b/.test(own);
    if (!authed) {
      open += 1;
      const sub = r[3] === '/' ? '' : r[3];
      publicRoutes.push({
        route: `${r[1].toUpperCase()} ${mountPath}${sub}`,
        file, line: lineOf(src, r.index),
      });
    }
  }
  handlersTotal += handlers;
  mounts.push({ path: mountPath, module: moduleName, handlers, public: open, routerWideAuth: gate >= 0 || mountAuth });
}

// ── tenancy coverage (Cyber Defense R2) ─────────────────────────────────────
//
// Every path parameter on every mounted route, and whether the route checks
// that the row it names belongs to the caller's club BEFORE the handler runs:
//
//   GUARDED   a `tenantParam('<resource>', '<param>')` on the route itself, a
//             `router.param('<param>', …)` hook on its router, or the router's
//             `guardTeamScopedRouter(router)` for teamId / playerId / matchId;
//   EXEMPT    named, with the exact routes and a written reason, in
//             posture-policy.json `tenancyExemptions`;
//   UNGUARDED anything else — which fails the posture test.
//
// `router.use(tenantGuard)` is not a guard: Express fills req.params in only
// after a route matches, so mounted that way it sees nothing. It is reported.
//
// Path parameters only. An id that arrives in a JSON body is checked by the
// service that reads it and is not inventoried here.
const tenantMwSrc = read(cite('src/middleware/tenant-guard.middleware.ts')) || '';
// The exemptions are reviewed decisions, kept with the rest of the posture policy.
const posturePolicyForScan = (() => { try { return JSON.parse(read('src/cyber-defense/posture-policy.json') || '{}'); } catch (_) { return {}; } })();
const tenantResources = (() => {
  const i = tenantMwSrc.indexOf('export const TENANT_RESOURCES');
  const block = i < 0 ? '' : tenantMwSrc.slice(i, tenantMwSrc.indexOf('} as const;', i));
  return new Set([...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
})();
const TEAM_SCOPED_DEFAULT = ['teamId', 'playerId', 'matchId'];
const tenancyRoutes = [];
const deadTenantGuardMounts = [];
const unknownTenantResources = [];
for (const m of indexSrc.matchAll(/router\.use\(\s*'([^']+)'\s*,([^;]+?)\);/g)) {
  const args = m[2].split(',').map((x) => x.trim()).filter(Boolean);
  const moduleName = importsByName[args[args.length - 1]];
  if (!moduleName) continue;
  const file = `src/routes/${moduleName}.ts`;
  const code = (read(file) || '').replace(/\/\/[^\n]*/g, (c) => ' '.repeat(c.length));
  if (/router\.use\(\s*tenantGuard\s*\)/.test(code)) deadTenantGuardMounts.push(file);
  const hooked = new Set([...code.matchAll(/router\.param\(\s*'(\w+)'/g)].map((x) => x[1]));
  if (/guardTeamScopedRouter\(\s*router\s*\)/.test(code)) TEAM_SCOPED_DEFAULT.forEach((x) => hooked.add(x));
  for (const r of code.matchAll(ROUTE_RE)) {
    const params = [...r[3].matchAll(/:(\w+)/g)].map((x) => x[1]);
    if (!params.length) continue;
    const close = code.indexOf(');', r.index);
    const own = code.slice(r.index, close < 0 ? r.index + 400 : close);
    const onRoute = new Map();
    for (const t of own.matchAll(/tenantParam\(\s*'(\w+)'(?:\s*,\s*'(\w+)')?\s*\)/g)) {
      onRoute.set(t[2] || 'id', t[1]);
      if (!tenantResources.has(t[1])) unknownTenantResources.push(`${file}: ${t[1]}`);
    }
    const route = `${r[1].toUpperCase()} ${m[1]}${r[3] === '/' ? '' : r[3]}`;
    for (const param of params) {
      const how = onRoute.has(param) ? `tenantParam:${onRoute.get(param)}` : hooked.has(param) ? 'router.param' : null;
      tenancyRoutes.push({ module: moduleName, param, route, guard: how });
    }
  }
}
const tenancyExemptions = posturePolicyForScan.tenancyExemptions || {};
const tenancyUnguarded = [];
const tenancyExempted = [];
for (const t of tenancyRoutes) {
  if (t.guard) continue;
  const ex = tenancyExemptions[`${t.module} :${t.param}`];
  if (ex && Array.isArray(ex.routes) && ex.routes.includes(t.route)) tenancyExempted.push(t);
  else tenancyUnguarded.push({ module: t.module, param: t.param, route: t.route });
}
const tenancyStaleExemptions = [];
for (const [key, ex] of Object.entries(tenancyExemptions)) {
  for (const route of (ex && ex.routes) || []) {
    const [mod, param] = key.split(' :');
    if (!tenancyRoutes.some((t) => !t.guard && t.module === mod && t.param === param && t.route === route)) tenancyStaleExemptions.push(`${key} ${route}`);
  }
}
const tenancyByRouter = {};
for (const t of tenancyRoutes) {
  const b = tenancyByRouter[t.module] || (tenancyByRouter[t.module] = { guarded: 0, exempt: 0, unguarded: 0 });
  if (t.guard) b.guarded += 1;
  else if (tenancyExempted.includes(t)) b.exempt += 1;
  else b.unguarded += 1;
}
const tenancy = {
  idParameters: tenancyRoutes.length,
  guarded: tenancyRoutes.filter((t) => t.guard).length,
  exempt: tenancyExempted.length,
  unguarded: tenancyUnguarded,
  staleExemptions: tenancyStaleExemptions,
  routerWideTenantGuardMounts: deadTenantGuardMounts,
  unknownTenantResources,
  byRouter: Object.fromEntries(Object.entries(tenancyByRouter).sort(([a], [b]) => a.localeCompare(b))),
};

// ── authorization per handler (Cyber Defense R11) ────────────────────────────
//
// What each mounted handler requires beyond a session, read from the route
// file and — where the route itself says nothing — from the controller
// function it calls and the service function that calls into, one hop deep:
//
//   public          reachable without a session (justified in publicRoutes)
//   platform-owner  requirePlatformAuthority, or assertPlatformOwner /
//                   hasPlatformAuthority on the route, router or that call path
//   roles:<…>       authorize(…) on the route or router-wide before it
//   scoped:<…>      a require*/ensure* guard on the route (team access, club access…)
//   member          any signed-in member of the caller's club, and nothing else
//
// `member` is a legitimate answer — most reads are exactly that — but it is a
// reviewed one: the set of member-level handlers is pinned in posture-policy
// `authorizationMemberHandlers`, so a new handler that checks no role arrives
// as a diff somebody reads. The platform-owner rooms are pinned whole.
const OWNER_RE = /assertPlatformOwner\(|requirePlatformAuthority|hasPlatformAuthority\(|assertPlatformAuthority\(/;
const fnBody = (src, name) => {
  const i = src.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s+const\\s+${name}\\s*=`));
  if (i < 0) return '';
  const end = src.indexOf('\nexport ', i + 10);
  return src.slice(i, end < 0 ? undefined : end);
};
const resolveTs = (fromFile, spec) => {
  if (!spec.startsWith('.')) return null;
  const base = path.join(path.dirname(fromFile), spec);
  for (const c of [`${base}.ts`, `${base}/index.ts`]) if (exists(c)) return c;
  return null;
};
const importsOf = (file, src) => {
  const out = {};
  for (const m of src.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+'([^']+)'/g)) out[m[1]] = { file: resolveTs(file, m[2]), ns: true };
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'([^']+)'/g)) {
    for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      const [orig, alias] = n.split(/\s+as\s+/);
      out[(alias || orig).trim()] = { file: resolveTs(file, m[2]), name: orig.trim() };
    }
  }
  return out;
};
/** True when the controller function, or a service function it calls, asserts platform authority. */
function ownerViaCallPath(routeFile, routeSrc, handlerExpr) {
  const routeImports = importsOf(routeFile, routeSrc);
  let ctrlFile = null; let ctrlFn = null;
  const dotted = handlerExpr.match(/^(\w+)\.(\w+)$/);
  if (dotted && routeImports[dotted[1]] && routeImports[dotted[1]].ns) { ctrlFile = routeImports[dotted[1]].file; ctrlFn = dotted[2]; }
  else if (/^\w+$/.test(handlerExpr) && routeImports[handlerExpr] && !routeImports[handlerExpr].ns) { ctrlFile = routeImports[handlerExpr].file; ctrlFn = routeImports[handlerExpr].name; }
  if (!ctrlFile) return false;
  const csrc = (read(ctrlFile) || '').replace(/\/\/[^\n]*/g, '');
  const body = fnBody(csrc, ctrlFn);
  if (OWNER_RE.test(body)) return true;
  const cImports = importsOf(ctrlFile, csrc);
  for (const call of body.matchAll(/\b(\w+)\.(\w+)\(|\b(\w+)\(/g)) {
    const target = call[1] ? (cImports[call[1]] && cImports[call[1]].ns ? { file: cImports[call[1]].file, name: call[2] } : null)
      : (cImports[call[3]] && !cImports[call[3]].ns ? cImports[call[3]] : null);
    if (!target || !target.file) continue;
    const ssrc = (read(target.file) || '').replace(/\/\/[^\n]*/g, '');
    const sbody = fnBody(ssrc, target.name);
    if (OWNER_RE.test(sbody)) return true;
    // …and one helper in the same service file (`transition()` in club-lifecycle).
    for (const h of sbody.matchAll(/\b(\w+)\(/g)) {
      if (h[1] === target.name) continue;
      if (OWNER_RE.test(localFnBody(ssrc, h[1]))) return true;
    }
  }
  return false;
}
function localFnBody(src, name) {
  const i = src.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`, 'm'));
  if (i < 0) return '';
  const end = src.slice(i + 10).search(/^(?:export\s+)?(?:async\s+)?function\s|^export\s/m);
  return src.slice(i, end < 0 ? undefined : i + 10 + end);
}
const publicRouteSet = new Set(publicRoutes.map((r) => r.route));
const authzHandlers = {};
const authzByRouter = {};
for (const m of indexSrc.matchAll(/router\.use\(\s*'([^']+)'\s*,([^;]+?)\);/g)) {
  const args = m[2].split(',').map((x) => x.trim()).filter(Boolean);
  const moduleName = importsByName[args[args.length - 1]];
  if (!moduleName) continue;
  const file = `src/routes/${moduleName}.ts`;
  const raw = read(file) || '';
  const code = raw.replace(/\/\/[^\n]*/g, (c) => ' '.repeat(c.length));
  const ownerGates = [...code.matchAll(/router\.use\(\s*(?:requirePlatformAuthority\b|async\s*\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*\{)/g)]
    .filter((g) => g[0].includes('requirePlatformAuthority') || OWNER_RE.test(code.slice(g.index, code.indexOf('\n});', g.index))))
    .map((g) => g.index);
  const roleGates = [...code.matchAll(/router\.use\(\s*authorize\(([^)]*)\)/g)].map((g) => ({ at: g.index, roles: g[1] }));
  // Route files name guard bundles once (`const tradeGuard = [requireMembership(…), …]`)
  // and use the name on each route: read the name as what it stands for.
  const guardConsts = [...code.matchAll(/^const\s+(\w+)\s*=\s*(\[[^\]]*\]|authorize\([^)]*\)|(?:require|ensure)\w+\([^;]*\));/gm)];
  const expand = (txt) => guardConsts.reduce((t, g) => t.replace(new RegExp(`\\b${g[1]}\\b`, 'g'), g[2]), txt);
  for (const r of code.matchAll(ROUTE_RE)) {
    const route = `${r[1].toUpperCase()} ${m[1]}${r[3] === '/' ? '' : r[3]}`;
    const close = code.indexOf(');', r.index);
    const ownRaw = code.slice(r.index, close < 0 ? r.index + 400 : close);
    const own = expand(ownRaw);
    const roles = (own.match(/authorize\(([^)]*)\)/) || [])[1] || (roleGates.filter((g) => g.at < r.index).pop() || {}).roles;
    const scoped = [...own.matchAll(/\b((?:require|ensure)\w+)\b(?:\(\s*MembershipRole\.(\w+))?/g)]
      .map((x) => (x[2] ? `${x[1]}(${x[2]})` : x[1])).filter((n) => n !== 'requirePlatformAuthority');
    const handlerExpr = (ownRaw.replace(/\s+$/, '').match(/([\w.]+)\s*$/) || [])[1] || '';
    let kind;
    if (publicRouteSet.has(route)) kind = 'public';
    else if (/requirePlatformAuthority/.test(own) || OWNER_RE.test(own) || ownerGates.some((at) => at < r.index)
      || ownerViaCallPath(file, raw, handlerExpr)) kind = 'platform-owner';
    else if (roles) kind = `roles:${roles.replace(/['"\s]/g, '').replace(/UserRole\./g, '')}`;
    else if (scoped.length) kind = `scoped:${[...new Set(scoped)].join('+')}`;
    else kind = 'member';
    authzHandlers[route] = kind;
    const b = authzByRouter[moduleName] || (authzByRouter[moduleName] = {});
    const k = kind.split(':')[0];
    b[k] = (b[k] || 0) + 1;
  }
}
const memberPolicy = posturePolicyForScan.authorizationMemberHandlers || {};
const memberReviewed = new Set(Object.values(memberPolicy).flat());
const memberActual = Object.entries(authzHandlers).filter(([, k]) => k === 'member').map(([r]) => r);
const ownerRoomsPolicy = posturePolicyForScan.ownerRooms || {};
const ownerRoomViolations = [];
for (const [mod, room] of Object.entries(ownerRoomsPolicy)) {
  const mounted = [...indexSrc.matchAll(/router\.use\(\s*'([^']+)'\s*,([^;]+?)\);/g)]
    .find((x) => importsByName[x[2].split(',').map((y) => y.trim()).pop()] === mod);
  if (!mounted || mounted[1] !== room.mount) { ownerRoomViolations.push(`${mod}: not mounted at ${room.mount}`); continue; }
  const routes = Object.keys(authzHandlers).filter((rt) => rt.split(' ')[1] === room.mount || rt.split(' ')[1].startsWith(`${room.mount}/`))
    .filter((rt) => authzByRouterOwner(rt, mod));
  if (!routes.length) ownerRoomViolations.push(`${mod}: no handlers found`);
  for (const rt of routes) {
    if (authzHandlers[rt] !== 'platform-owner' && !(room.except && room.except[rt])) ownerRoomViolations.push(`${mod}: ${rt} is ${authzHandlers[rt]}`);
  }
}
function authzByRouterOwner(route, mod) {
  // A route belongs to the module whose mount path is its longest matching prefix.
  const p = route.split(' ')[1];
  let best = null;
  for (const x of indexSrc.matchAll(/router\.use\(\s*'([^']+)'\s*,([^;]+?)\);/g)) {
    const mm = importsByName[x[2].split(',').map((y) => y.trim()).pop()];
    if (!mm) continue;
    if ((p === x[1] || p.startsWith(`${x[1]}/`)) && (!best || x[1].length > best.len)) best = { mod: mm, len: x[1].length };
  }
  return best && best.mod === mod;
}
const authorization = {
  handlers: Object.keys(authzHandlers).length,
  byKind: Object.entries(authzHandlers).reduce((a, [, k]) => { const kk = k.split(':')[0]; a[kk] = (a[kk] || 0) + 1; return a; }, {}),
  memberUnreviewed: memberActual.filter((r) => !memberReviewed.has(r)).sort(),
  memberStale: [...memberReviewed].filter((r) => authzHandlers[r] !== 'member').sort(),
  ownerRoomViolations,
  byRouter: Object.fromEntries(Object.entries(authzByRouter).sort(([a], [b]) => a.localeCompare(b))),
  perHandler: Object.fromEntries(Object.entries(authzHandlers).sort(([a], [b]) => a.localeCompare(b))),
};

// Routes the application itself declares, outside the API router: health and
// the pages a browser deep-links into. All public by design.
const APP = cite('src/app.ts');
const appSrc = read(APP) || '';
const appRoutes = [];
for (const m of appSrc.matchAll(/app\.(get|post|put|patch|delete)\(\s*(\[[^\]]*\]|'[^']*')/g)) {
  const paths = m[2].startsWith('[') ? [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [m[2].slice(1, -1)];
  for (const p of paths) appRoutes.push({ route: `${m[1].toUpperCase()} ${p}`, file: APP, line: lineOf(appSrc, m.index) });
}

// Route modules nothing mounts. Present in the build, unreachable today — and
// one import away from being live, which is why they are listed at all.
const srcFiles = tsFiles('src');
const allSrc = srcFiles.map((f) => read(f) || '');
const routeModules = fs.readdirSync(path.join(ROOT, 'src/routes'))
  .filter((f) => f.endsWith('.routes.ts')).map((f) => f.replace(/\.ts$/, '')).sort();
const dormantRouteModules = routeModules.filter((mod) => {
  const importRe = new RegExp(`from\\s+['"][./]*(?:routes/)?${mod.replace(/[.-]/g, '\\$&')}['"]`);
  return !srcFiles.some((f, i) => f !== `src/routes/${mod}.ts` && importRe.test(allSrc[i]));
});

publicRoutes.sort((a, b) => a.route.localeCompare(b.route));
appRoutes.sort((a, b) => a.route.localeCompare(b.route));

// Every file that opens an outbound HTTP request (R1b). Comments are blanked
// first. A new call site changes this list and fails the posture test until
// it is reviewed: is its URL the operator's configuration, or something a
// user supplied — which must go through src/security/outbound-url-guard.ts?
const OUTBOUND_RE = /\bfetch\s*\(|\bhttps?\.request\s*\(|\bhttps?\.get\s*\(|\baxios\b|\bgot\s*\(|\bundici\b/;
// Every file that opens a long-lived connection — an event stream or a
// WebSocket server (R1c). Each must be held to the session it opened under;
// a new one fails the posture test until it is reviewed.
const REALTIME_RE = /text\/event-stream|new\s+WebSocketServer\s*\(/;
const realtimeEndpoints = srcFiles.filter((f, i) => {
  const code = allSrc[i].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return REALTIME_RE.test(code);
}).sort();

const outboundCallSites = srcFiles.filter((f, i) => {
  const code = allSrc[i].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return OUTBOUND_RE.test(code);
}).sort();

// ── 2 · security controls, each from evidence ────────────────────────────────

const AUTH_SERVICE = cite('src/services/auth.service.ts');
const AUTH_MW = cite('src/middleware/auth.middleware.ts');
const authServiceSrc = read(AUTH_SERVICE) || '';
const authMwSrc = read(AUTH_MW) || '';
const loginBody = (() => {
  const i = authServiceSrc.indexOf('export async function loginUser');
  return i < 0 ? '' : authServiceSrc.slice(i, authServiceSrc.indexOf('\nexport ', i + 10));
})();
const realtimeSrc = ['src/realtime/match-ws.ts', 'src/realtime/market-ws.ts'].map((f) => read(cite(f)) || '').join('\n');
// R7: every JWT is signed and verified in src/security/jwt-tokens.ts and
// nowhere else, so the rules below are read from that one file — and any
// jwt.sign / jwt.verify that appears elsewhere fails all three JWT controls.
const JWT_TOKENS = cite('src/security/jwt-tokens.ts');
const jwtTokensSrc = (read(JWT_TOKENS) || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const jwtDirectSites = srcFiles.filter((f, i) => f !== JWT_TOKENS
  && /\bjwt\.(?:verify|sign)\(/.test(allSrc[i].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));
const jwtVerifySites = jwtTokensSrc.match(/jwt\.verify\([^)]*\)/g) || [];
const jwtLegacyCutoff = (jwtTokensSrc.match(/LEGACY_ISSUED_BEFORE = Date\.parse\('([0-9TZ:.-]+)'\)/) || [])[1] || null;
const ADMIN_MFA = cite('src/auth-prod/admin-mfa.ts');
const adminMfaSrc = read(ADMIN_MFA) || '';
const WS_TICKET = cite('src/realtime/ws-ticket.ts');
const wsTicketSrc = read(WS_TICKET) || '';

// Batch 5 (R3 + R8): the AI layer. Every rule below reads the code it names.
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const AI_PROVIDER = cite('src/platform/intelligence/anthropic-provider.ts');
const AI_GATEWAY = cite('src/platform/intelligence/gateway.ts');
const gatewaySrc = stripComments(read(AI_GATEWAY) || '');
const sdkImporters = srcFiles.filter((f, i) => /from\s+['"]@anthropic-ai\/sdk['"]|require\(\s*['"]@anthropic-ai\/sdk['"]\s*\)/.test(stripComments(allSrc[i])));
const AI_CALLERS = ['src/services/ai.service.ts', 'src/services/ai-llm.adapter.ts', 'src/services/llm-adapter.service.ts'];
const gatewayCallSites = srcFiles.flatMap((f, i) => {
  if (f.startsWith('src/platform/intelligence/')) return [];
  const code = stripComments(allSrc[i]);
  if (!/from\s+['"][./]*(?:\.\.\/)*platform\/intelligence\/gateway['"]/.test(code)) return [];
  const calls = code.split(/\bcomplete\(\{/).slice(1);
  return calls.map((body) => ({ file: f, declares: /^[\s\S]{0,1200}?dataClasses:/.test(body) }));
});
const completeBody = (() => { const i = gatewaySrc.indexOf('export async function complete('); return i < 0 ? '' : gatewaySrc.slice(i); })();
const recorderCreate = (() => { const i = gatewaySrc.indexOf('aiEgressRecord.create('); return i < 0 ? '' : gatewaySrc.slice(i, gatewaySrc.indexOf('});', i)); })();
const egressModel = (() => { const sch = read('prisma/schema.prisma') || ''; const i = sch.indexOf('model AiEgressRecord {'); return i < 0 ? '' : sch.slice(i, sch.indexOf('\n}', i)); })();
const workerSrc = stripComments(read(cite('src/workers/ai-agent.worker.ts')) || '');
const agentJobsSrc = stripComments(read(cite('src/platform/intelligence/agent-jobs.ts')) || '');
const orchestratorSrc = stripComments(read(cite('src/services/ai-orchestrator.service.ts')) || '');
const promotionSrc = stripComments(read(cite('src/services/ai-model-promotion.service.ts')) || '');
const registrySrc = stripComments(read(cite('src/services/ai-model-registry.service.ts')) || '');
const seedSrc = stripComments(read(cite('src/data/ai-models.seed.ts')) || '');
const fedSrc = stripComments(read(cite('src/federated/federated.service.ts')) || '');
const dataClassesSrc = read(cite('src/platform/intelligence/data-classes.ts')) || '';
const trainingSrc = stripComments(read(cite('src/platform/intelligence/training-data.ts')) || '');
const aiFnBody = (src, name) => { const i = src.indexOf(`function ${name}(`); if (i < 0) return ''; const j = src.indexOf('\nexport ', i + 10); return src.slice(i, j < 0 ? undefined : j); };
// Every key of every feature type the decision engine extracts, and every factor name it scores, is classified.
const classifiedKeys = new Set([...dataClassesSrc.matchAll(/^\s{2}([A-Za-z0-9_]+): '(?:PUBLIC|INTERNAL|CONFIDENTIAL|RESTRICTED)',/gm)].map((m) => m[1]));
const featureKeys = (() => {
  const t = read(cite('src/types/ai-engine.types.ts')) || '';
  const keys = [];
  for (const m of t.matchAll(/export type \w+Features = FeatureMap & \{([\s\S]*?)\n\};/g)) for (const k of m[1].matchAll(/^\s+(\w+):/gm)) keys.push(k[1]);
  return [...new Set(keys)];
})();
const factorNames = (() => {
  const names = new Set();
  const files = ['src/lib/ai-scoring.lib.ts', ...srcFiles.filter((f) => /^src\/services\/ai-[a-z-]+-decisions\.service\.ts$/.test(f))];
  for (const f of files) for (const m of (read(f) || '').matchAll(/name: '([a-z0-9_]+)'/g)) names.add(m[1]);
  return [...names];
})();
const unclassifiedFeatures = featureKeys.filter((k) => !classifiedKeys.has(k));
const unclassifiedFactors = factorNames.filter((k) => !classifiedKeys.has(k));
const migrationsSql = (() => {
  const dir = path.join(ROOT, 'prisma/migrations');
  let text = '';
  try {
    for (const d of fs.readdirSync(dir)) {
      const f = path.join(dir, d, 'migration.sql');
      if (fs.existsSync(f)) text += fs.readFileSync(f, 'utf8');
    }
    cite('prisma/migrations');
  } catch (_) { /* no migrations */ }
  return text;
})();
const has = (rel, re) => re.test(read(cite(rel)) || '');

// The signed device and camera paths. Each must take its key from the
// credential seam and refuse when there is none — never `value ?? ''`, the
// empty HMAC key anyone can compute — and the shared verifier must refuse an
// empty key on its own, as must the device-session handshake's. The replay
// gates the public frame ingest, activation, attestation and the handshake
// lacked are part of the same control.
const DEVICE_INGEST_PATHS = [
  'src/vision/vision-ingest.service.ts',
  'src/vision/event-stream.service.ts',
  'src/vision/biomechanical-ingest.service.ts',
  'src/services/device-registry.service.ts',
  'src/security-l/attestation.service.ts',
];
const deviceIngestFailsClosed = () =>
  has('src/services/device-auth.service.ts', /timingSafeEqual/)
  && has('src/services/device-auth.service.ts', /if \(secret\.length === 0\) return false;/)
  && has('src/services/device-auth.service.ts', /assertFreshAndRemember\(`device-session-auth:\$\{session\.id\}`, req\.nonce\)/)
  && has('src/fabric/secrets/device-credentials.ts', /export function signingKeyOf\(/)
  && has('src/fabric/secrets/device-credentials.ts', /if \(key\.length === 0\) return false;/)
  && DEVICE_INGEST_PATHS.every((p) => has(p, /signingKeyOf\(await resolveCredential\(/) && !has(p, /credential\.value\s*\?\?\s*''/))
  && has('src/vision/vision-ingest.service.ts', /Math\.abs\(nowMs - cameraMs\) > TS_SKEW_LIMIT_MS/)
  && has('src/vision/vision-ingest.service.ts', /assertFreshAndRemember\(`cam-frame:\$\{cam\.id\}`, dto\.nonce\)/)
  && has('src/services/device-registry.service.ts', /assertFreshAndRemember\(`device-activate:\$\{d\.id\}`, dto\.nonce\)/)
  && has('src/security-l/attestation.service.ts', /deviceAttestation\.findFirst\(\{ where: \{ deviceId: dev\.id, nonce: dto\.nonce \}/);

const lockoutCallers = callers(srcFiles, /\b(assertNotLocked|recordAttempt)\(/, 'src/security/login-attempt');
const auditChainCallers = allSrc.reduce((n, s) => n + (s.match(/appendAuditEvent(?:Async)?\(/g) || []).length, 0)
  - ((read('src/security/audit-chain.service.ts') || '').match(/appendAuditEvent(?:Async)?\(/g) || []).length;
const securityEventCallers = allSrc.reduce((n, s) => n + (s.match(/\blogSecurityEvent\(/g) || []).length, 0)
  - ((read('src/security/security-event.service.ts') || '').match(/\blogSecurityEvent\(/g) || []).length;
const unsafeRawSql = allSrc.reduce((n, s) => n + (s.match(/\$(?:queryRawUnsafe|executeRawUnsafe)\(/g) || []).length, 0);

const AUDIT_APPEND_ONLY_TABLES = ['SecurityAuditEvent', 'AIAudit', 'DeviceSecurityEvent', 'SecurityEvent', 'AiEgressRecord'];
const control = (id, status, evidence, note) => ({ id, status, evidence, ...(note ? { note } : {}) });
const controls = [
  control('csp-script-self',
    /scriptSrc:\s*\[\s*"'self'"\s*\]/.test(appSrc) ? 'PRESENT' : 'ABSENT', APP,
    'Content-Security-Policy script-src is the site\'s own origin only.'),
  control('csp-no-plugins-no-frames',
    /objectSrc:\s*\[\s*"'none'"\s*\]/.test(appSrc) && /frameSrc:\s*\[\s*"'none'"\s*\]/.test(appSrc) ? 'PRESENT' : 'ABSENT', APP),
  control('cors-allowlist', /corsAllowlist/.test(appSrc) ? 'PRESENT' : 'ABSENT', APP),
  control('cors-rejection-is-403',
    /callback\(new OriginNotAllowedError\(\)\)/.test(appSrc) && !/new Error\(`CORS: origin/.test(appSrc)
      ? 'PRESENT' : 'ABSENT', APP,
    'A refused origin is an OriginNotAllowedError: 403, never counted as a server error.'),
  control('auth-rate-limit', /router\.use\('\/auth',\s*rateLimitAuth/.test(indexSrc) ? 'PRESENT' : 'ABSENT', INDEX),
  control('password-hashing-bcrypt', has('src/utils/password.ts', /BCRYPT_ROUNDS/) ? 'PRESENT' : 'ABSENT', 'src/utils/password.ts'),
  control('session-revocation-token-version', /tokenVersion/.test(authMwSrc) ? 'PRESENT' : 'ABSENT', AUTH_MW),
  control('mfa-service', exists('src/auth-prod/mfa.service.ts') ? 'PRESENT' : 'ABSENT', cite('src/auth-prod/mfa.service.ts')),
  // Step 7: the owner can require a code at sign-in. Present when the password
  // step asks the enforcement service before issuing anything, the second step
  // has its route, and that route is in the credential rate-limit bucket.
  control('mfa-owner-enforcement-at-login',
    /await loginSecondFactor\(user\.id(?:, user\.role)?\)[\s\S]*if \(challenge\) return challenge;[\s\S]*issueTokens\(user\)/.test(loginBody)
      && has('src/routes/auth.routes.ts', /router\.post\('\/login\/mfa',\s*ctrl\.loginMfa\)/)
      && has('src/middleware/rate-limit.middleware.ts', /'\/login\/mfa'/)
      ? 'PRESENT' : 'ABSENT', AUTH_SERVICE,
    'An account whose owner switched it on gets no session from the password alone.'),
  // Required for EVERY account is a different, stricter claim. Opt-in per
  // owner, and administrators behind the operator's switch, is PARTIAL and
  // says so; nothing here can report it PRESENT.
  control('mfa-required-at-login', /loginSecondFactor\(/.test(loginBody) ? 'PARTIAL' : 'ABSENT', AUTH_SERVICE,
    /loginSecondFactor\(/.test(loginBody)
      ? 'Required at sign-in for an owner who switched it on (mfa-owner-enforcement-at-login) and, with MFA_REQUIRED_FOR_ADMINS on, for administrators (mfa-required-for-admins); other roles opt in.'
      : 'loginUser() issues tokens without asking for a second factor.'),
  // R7: SUPER_ADMIN and CLUB_ADMIN must pass a code, behind one operator
  // switch. Present when the mechanism is complete end to end: the roles are
  // named, the password step asks for the code by role, every session check
  // (API, device routes, realtime) holds a session that did not pass one to
  // setup-only or refuses it, and an administrator cannot remove the factor.
  // Whether it is IN FORCE is the switch's value, which this scanner never reads.
  control('mfa-required-for-admins',
    /process\.env\.MFA_REQUIRED_FOR_ADMINS === 'true'/.test(adminMfaSrc)
      && /ADMIN_ROLES[^=]*= \[UserRole\.SUPER_ADMIN, UserRole\.CLUB_ADMIN\]/.test(adminMfaSrc)
      && /await loginSecondFactor\(user\.id, user\.role\)/.test(loginBody)
      && has('src/auth-prod/mfa-enforcement.service.ts', /roleRequiresMfa\(role\) && isEnrolled\(s\)/)
      && /assertSessionMayProceed\(mfaState, req\.method/.test(authMwSrc)
      && /resolveSessionMfaState\(user\.id, user\.role, passedCode\)\) !== 'full'/.test(authMwSrc)
      && has('src/middleware/device-auth.middleware.ts', /assertSessionMayProceed\(/)
      && has('src/auth-prod/mfa.service.ts', /if \(roleRequiresMfa\(actor\.role\)\)/)
      && /issueTokens\(user, \{ passedCode: true \}\)/.test(authServiceSrc)
      ? 'PRESENT' : 'ABSENT', ADMIN_MFA,
    'Administrators give a code at sign-in, or get a setup-only session until they enrol; in force only while MFA_REQUIRED_FOR_ADMINS=true.'),
  // R7: enforced, before the password is checked, and every outcome recorded.
  control('login-lockout',
    /await assertNotLocked\([\s\S]*verifyPassword\(/.test(loginBody) && /recordAttempt\(/.test(loginBody)
      && has('src/security/login-attempt.service.ts', /throw new TooManyRequestsError\(/)
      ? 'PRESENT' : exists('src/security/login-attempt.service.ts') ? 'PARTIAL' : 'ABSENT',
    cite('src/security/login-attempt.service.ts'),
    `Enforced in loginUser() before the password is checked; ${lockoutCallers} caller(s) outside the lockout service.`),
  control('login-lockout-shadow',
    has('src/middleware/rate-limit.middleware.ts', /recordShadowLoginOutcome\(req, email, res\.statusCode\)/)
      && exists('src/cyber-defense/lockout-shadow.ts') ? 'PRESENT' : 'ABSENT',
    cite('src/cyber-defense/lockout-shadow.ts'),
    'Every sign-in is measured against the lockout thresholds and a would-be refusal is recorded; nothing is refused.'),
  // Step 8: what is WRITTEN is only the hash, and a lookup starts from the hash.
  control('refresh-token-hashed-at-rest',
    /refreshToken\.create\(\{\s*data:\s*\{\s*tokenHash:\s*hashRefreshToken\(refreshToken\)/.test(authServiceSrc)
      && !/refreshToken\.create\(\{\s*data:\s*\{[^}]*\btoken:/.test(authServiceSrc)
      && /findUnique\(\{\s*where:\s*\{\s*tokenHash:\s*hashRefreshToken\(token\)/.test(authServiceSrc)
      ? 'PRESENT' : 'ABSENT', AUTH_SERVICE,
    'New refresh tokens are stored and looked up as a SHA-256 only.'),
  // Final Security Closure, Task 1: nobody creates an account in a club by
  // naming it. The public register handler refuses without reading the body,
  // the service that created a club-linked account from a request is gone, and
  // the refusal is proven end to end on real PostgreSQL in CI.
  control('self-registration-closed',
    (() => {
      const ctl = read(cite('src/controllers/auth.controller.ts')) || '';
      const reg = ctl.slice(ctl.indexOf('export async function register('), ctl.indexOf('\n}', ctl.indexOf('export async function register(')));
      return /next\(new SelfRegistrationClosedError\(\)\)/.test(reg) && !/req\.body|authService\./.test(reg)
        && !/export async function registerUser\(/.test(authServiceSrc)
        && /tests\/security-closure-task1\.integration\.test\.ts/.test(read('.github/workflows/ci.yml') || '');
    })() ? 'PRESENT' : 'ABSENT', cite('src/controllers/auth.controller.ts'),
    'POST /auth/register answers 403 SELF_REGISTRATION_CLOSED before reading the body; a club account comes only from that club\'s invitation.'),
  // …and the one thing still standing from before it: the legacy raw column and
  // the dual-read fallback that keeps pre-Step-8 sessions alive.
  control('refresh-token-legacy-fallback-removed',
    /tokenHash:\s*null/.test(authServiceSrc) ? 'ABSENT' : 'PRESENT', AUTH_SERVICE,
    'Rows issued before Step 8 keep their raw value until rotated, revoked or expired (7 days at most).'),
  control('jwt-algorithm-pinned',
    jwtDirectSites.length === 0 && jwtVerifySites.length > 0
      && jwtVerifySites.every((v) => /algorithms: \[JWT_ALGORITHM\]/.test(v))
      && /JWT_ALGORITHM = 'HS256'/.test(jwtTokensSrc)
      && /decoded\.header\.alg !== JWT_ALGORITHM/.test(jwtTokensSrc)
      && /algorithm: JWT_ALGORITHM/.test(jwtTokensSrc)
      ? 'PRESENT' : 'ABSENT', JWT_TOKENS,
    jwtDirectSites.length
      ? `jwt.sign/verify outside jwt-tokens.ts: ${jwtDirectSites.join(', ')}`
      : `HS256 on every sign and verify (${jwtVerifySites.length} verify site(s), one file); access, refresh, device and WebSocket tickets alike.`),
  control('jwt-issuer-validated',
    jwtDirectSites.length === 0
      && jwtVerifySites.some((v) => /issuer: ISSUER, audience: AUDIENCE\[kind\]/.test(v))
      && /issuer: ISSUER,\s*audience: AUDIENCE\[kind\]/.test(jwtTokensSrc.slice(jwtTokensSrc.indexOf('function signToken')))
      && /payload\.iss !== undefined \|\| payload\.aud !== undefined/.test(jwtTokensSrc)
      && !!jwtLegacyCutoff
      ? 'PRESENT' : 'ABSENT', JWT_TOKENS,
    `Issuer and a per-kind audience on every token; an unscoped token is honoured only if issued before ${jwtLegacyCutoff || '—'}.`),
  control('jwt-key-id',
    /keyid: active\.kid/.test(jwtTokensSrc) && /decoded\.header\.kid/.test(jwtTokensSrc)
      && /function keyring\(/.test(jwtTokensSrc) && /new TokenRejected\('unknown-key'\)/.test(jwtTokensSrc)
      ? 'PRESENT' : 'ABSENT', JWT_TOKENS,
    'Every token names its key (a fingerprint, never the secret); the keyring holds the active and, during a rotation, the previous key.'),
  control('websocket-token-outside-url',
    !/searchParams\.get\('token'\)/.test(realtimeSrc)
      && (realtimeSrc.match(/redeemWsTicket\(/g) || []).length >= 2
      && /'PX', TICKET_TTL_SECONDS \* 2000, 'NX'/.test(wsTicketSrc)
      ? 'PRESENT' : 'ABSENT', WS_TICKET,
    'Sockets open with a 30-second single-use ticket (?ticket=), never the session token.'),
  // R2: present only when it is APPLIED — every id parameter on every mounted
  // route guarded or exempted by name, no exemption left pointing at a route
  // that no longer needs it, and no router-wide `router.use(tenantGuard)` that
  // looks like a guard and checks nothing.
  control('tenant-guard',
    /export async function tenantGuard/.test(tenantMwSrc) && /export function tenantParam\(/.test(tenantMwSrc)
      && tenancy.unguarded.length === 0 && tenancy.staleExemptions.length === 0
      && tenancy.routerWideTenantGuardMounts.length === 0 && tenancy.unknownTenantResources.length === 0 ? 'PRESENT' : 'ABSENT',
    'src/middleware/tenant-guard.middleware.ts',
    `${tenancy.guarded} of ${tenancy.idParameters} route id parameter(s) checked against the caller's club before the handler; ${tenancy.exempt} exempted by name with a reason; ${tenancy.unguarded.length} unguarded.`),
  // Final Security Closure, Task 1: a franchise unit's write access is no
  // authority over a club the request names. Attaching needs the club's
  // president or the platform, moving needs write access to the unit the club
  // leaves, detaching only from the unit that holds it — each write
  // conditional on the unit read — and all of it is proven on real PostgreSQL.
  control('franchise-club-attach-authorised',
    has('src/services/franchise-unit.service.ts', /async function mayCommitClub\(/)
      && has('src/services/franchise-unit.service.ts', /role: 'CLUB_OWNER', isActive: true/)
      && has('src/services/franchise-unit.service.ts', /if \(current !== null && !mayReleaseFrom\(actor, current\)\)/)
      && has('src/services/franchise-unit.service.ts', /if \(current !== unitId\) throw new NotFoundError\('Club is not attached to this unit'\)/)
      && !has('src/services/franchise-unit.service.ts', /prisma\.club\.update\(\{\s*where: \{ id: clubId \}/)
      ? 'PRESENT' : 'ABSENT', 'src/services/franchise-unit.service.ts',
    'A club enters a franchise unit only by its president or the platform, leaves one only with write access to it, and is detached only from the unit that holds it.'),
  control('device-ingest-hmac', deviceIngestFailsClosed() ? 'PRESENT' : 'ABSENT', 'src/services/device-auth.service.ts',
    'Every signed device and camera path verifies in constant time against a credential that resolved, and refuses one that did not rather than checking it against an empty key anyone could sign with; frame ingest, activation, attestation and the device-session handshake refuse a replayed nonce.'),
  control('stripe-webhook-signature', has('src/services/stripe.service.ts', /webhooks\.constructEvent/) ? 'PRESENT' : 'ABSENT', 'src/services/stripe.service.ts'),
  control('versioned-keyring', has('src/fabric/secrets/keyring.ts', /ACTIVE_KEK_ENV/) ? 'PRESENT' : 'ABSENT', 'src/fabric/secrets/keyring.ts'),
  control('audit-hash-chain', auditChainCallers > 0 ? 'PRESENT' : 'ABSENT', cite('src/security/audit-chain.service.ts'),
    `${auditChainCallers} call site(s) append to the chain.`),
  control('security-event-log', securityEventCallers > 0 ? 'PRESENT' : 'ABSENT', cite('src/security/security-event.service.ts'),
    `${securityEventCallers} call site(s) record security events.`),
  control('ai-action-approval-gate', exists('src/security/ai-approval.service.ts') ? 'PRESENT' : 'ABSENT', cite('src/security/ai-approval.service.ts')),
  // ── Batch 5 · R3: the AI Gateway is the only egress, and it has a policy ──
  control('ai-single-egress',
    sdkImporters.length === 1 && sdkImporters[0] === AI_PROVIDER
      && AI_CALLERS.every((f) => /platform\/intelligence\/gateway/.test(read(f) || '') && !/@anthropic-ai\/sdk/.test(stripComments(read(f) || '')))
      ? 'PRESENT' : 'ABSENT', AI_PROVIDER,
    sdkImporters.length === 1
      ? 'Only the gateway\'s provider imports @anthropic-ai/sdk; ai.service, ai-llm.adapter and llm-adapter.service call the gateway.'
      : `@anthropic-ai/sdk imported by: ${sdkImporters.join(', ') || 'nothing'}`),
  control('ai-egress-classification',
    /highest\(dataClasses\) === 'RESTRICTED' && !\(await clubAiPolicy\(clubId\)\)\.restrictedEgress/.test(completeBody)
      && /: \['RESTRICTED'\]/.test(completeBody)
      && /pseudo\.apply\(req\.prompt\)/.test(completeBody) && /pseudo\.apply\(req\.system\)/.test(completeBody)
      && /dailyTokenBudget\(\)/.test(completeBody)
      && /req\.outputSchema\.parse\(/.test(completeBody)
      && gatewayCallSites.length >= AI_CALLERS.length && gatewayCallSites.every((c) => c.declares)
      ? 'PRESENT' : 'ABSENT', AI_GATEWAY,
    `RESTRICTED needs the club's opt-in; names are pseudonymised; a per-club daily budget; output validated. ${gatewayCallSites.length} call site(s), every one declaring its data classes.`),
  control('ai-call-audited',
    completeBody.indexOf('recorder.start({ ...base, pseudonymised })') > 0
      && completeBody.indexOf('recorder.start({ ...base, pseudonymised })') < completeBody.indexOf('provider.complete(')
      && !/prompt|text|answer/.test(recorderCreate) && !/\b(prompt|response|answer)\b/.test(egressModel)
      ? 'PRESENT' : 'ABSENT', AI_GATEWAY,
    'An AiEgressRecord is written before the provider is called (no record, no call) and completed after; it never holds the prompt or the answer.'),
  // ── Batch 5 · R8: agents, model registry, federated learning, training data ──
  control('recommendation-signed',
    (() => {
      const rec = stripComments(read(cite('src/security-n/signed-recommendations.service.ts')) || '');
      return /export const SIGNER_VERSION = 'n2'/.test(rec)
        && /Object\.keys\(o\)[\s\S]{0,80}\.sort\(\)\.map\(\(k\) => `\$\{JSON\.stringify\(k\)\}:\$\{canonical\(o\[k\]\)\}`/.test(rec)
        && !/JSON\.stringify\(payload, Object\.keys/.test(rec)
        && /if \(signerVersion !== SIGNER_VERSION\) return false/.test(rec)
        && /row\.clubId !== clubId/.test(rec);
    })() ? 'PRESENT' : 'ABSENT', cite('src/security-n/signed-recommendations.service.ts'),
    'Recommendation signatures cover the whole payload (keys sorted at every depth); a pre-fix n1 signature never verifies; a signature is read only by its own club.'),
  control('ai-actions-gated',
    workerSrc.indexOf('authorizeAgentJob(job)') > 0
      && workerSrc.indexOf('authorizeAgentJob(job)') < workerSrc.indexOf('getJobApproval(job.id)')
      && /if \(!authz\.allowed\) \{[\s\S]{0,600}?return;/.test(workerSrc)
      && /DELETE_DATA: 'deleteData'/.test(agentJobsSrc) && /autonomy: AutonomyLevel\.APPROVE/.test(agentJobsSrc)
      && /decisionActs\(existing\.recommendation\)[\s\S]{0,200}generatedByUserId === actor\.userId/.test(orchestratorSrc)
      && /existing\.clubId !== actor\.scope\.clubId/.test(orchestratorSrc)
      && exists('src/security/ai-approval.service.ts')
      ? 'PRESENT' : 'ABSENT', cite('src/platform/intelligence/agent-jobs.ts'),
    'Every agent job is put to the tool registry as its agent before it runs; an action needs approval and stops at the kill switch; accepting a decision that acts takes a second person.'),
  control('model-artifact-signed',
    /sign\(null, signedStatement\(/.test(promotionSrc) && /verify\(null, signedStatement\(/.test(promotionSrc)
      && /p\.requestedById === actor\.userId/.test(promotionSrc)
      && (aiFnBody(registrySrc, 'resolveModel').match(/await assertModelVerified\(/g) || []).length === 2
      && /const verified = await verifyModel\(existing\)/.test(aiFnBody(registrySrc, 'activateModel'))
      && /input\.isActive === true && !existing\.isActive/.test(registrySrc)
      && !/data:\s*\{[^}]*isActive:\s*true/.test(seedSrc) && /requestPromotion\(/.test(seedSrc)
      ? 'PRESENT' : 'ABSENT', cite('src/services/ai-model-promotion.service.ts'),
    'A model becomes ACTIVE only through a promotion a second person approves, Ed25519-signed over the artifact SHA-256; every decision verifies it.'),
  control('federated-default-deny',
    /if \(!trust \|\| !trust\.trusted\)/.test(fedSrc) && /\.trainingUse\)/.test(aiFnBody(fedSrc, 'submitGradient'))
      && /if \(!actor\.isPlatformOwner && actor\.clubId !== job\.initiatorClubId\)/.test(aiFnBody(fedSrc, 'aggregate'))
      && /await assertPlatformOwner\(/.test(aiFnBody(fedSrc, 'publishTrust'))
      ? 'PRESENT' : 'ABSENT', cite('src/federated/federated.service.ts'),
    'A club contributes only when trusted by the platform owner and when it has allowed training use; a round is aggregated by its initiator or the owner.'),
  control('federated-server-side-norm',
    /gradientHash\(g\) !== dto\.payloadHash/.test(fedSrc) && /const norm = l2Norm\(g\)/.test(fedSrc)
      && /normValue:\s+norm,/.test(fedSrc) && !/normValue:\s+dto\.normValue/.test(fedSrc)
      && /outlierFactor\(\)/.test(aiFnBody(fedSrc, 'aggregate')) && /maxContributionsPerDay\(\)/.test(aiFnBody(fedSrc, 'submitGradient'))
      ? 'PRESENT' : 'ABSENT', cite('src/federated/federated.service.ts'),
    'The gradient is hashed and its norm computed by the server; the client\'s figure is ignored; per-club caps and outlier rejection apply.'),
  control('training-data-classified',
    featureKeys.length > 0 && unclassifiedFeatures.length === 0 && factorNames.length > 0 && unclassifiedFactors.length === 0
      && /if \(!policy\.trainingUse\)/.test(trainingSrc) && /policy\.restrictedEgress && !minor/.test(trainingSrc)
      && /\?\? 'RESTRICTED'/.test(dataClassesSrc)
      ? 'PRESENT' : 'ABSENT', cite('src/platform/intelligence/data-classes.ts'),
    unclassifiedFeatures.length || unclassifiedFactors.length
      ? `Unclassified: ${[...unclassifiedFeatures, ...unclassifiedFactors].join(', ')}`
      : `${featureKeys.length} features and ${factorNames.length} factors classified; training needs the club's consent and never uses a minor's RESTRICTED data.`),
  control('no-unsafe-raw-sql', unsafeRawSql === 0 ? 'PRESENT' : 'ABSENT', 'src/', `${unsafeRawSql} unsafe raw query call(s).`),
  // R14: database row-level security. PRESENT only when PostgreSQL enforces
  // it (the latest familista_rls_enforced() returns true) AND the application
  // carries the context (DB_RLS_CONTEXT=on in render.yaml); the pilot shipped
  // with both off is PARTIAL, never PRESENT.
  control('db-row-level-security', rlsStatus().status, 'prisma/migrations', rlsStatus().note),
  // R9: the database itself refuses to rewrite the evidence tables — a
  // BEFORE UPDATE OR DELETE and a BEFORE TRUNCATE trigger on each, never
  // dropped by a later migration, and proven on real PostgreSQL in CI.
  control('db-audit-append-only',
    AUDIT_APPEND_ONLY_TABLES.every((t) => new RegExp(`CREATE TRIGGER "${t}_append_only"\\s+BEFORE UPDATE OR DELETE ON "${t}"`).test(migrationsSql)
      && new RegExp(`CREATE TRIGGER "${t}_no_truncate"\\s+BEFORE TRUNCATE ON "${t}"`).test(migrationsSql))
      && !/DROP TRIGGER[^;]*_(append_only|no_truncate)/i.test(migrationsSql)
      && /tests\/audit-append-only\.integration\.test\.ts/.test(read('.github/workflows/ci.yml') || '')
      && /AUDIT_DB_REQUIRED:\s*'1'/.test(read('.github/workflows/ci.yml') || '') ? 'PRESENT' : 'ABSENT',
    'prisma/migrations/20261003100000_audit_append_only/migration.sql',
    `${AUDIT_APPEND_ONLY_TABLES.join(', ')} refuse UPDATE, DELETE and TRUNCATE in the database (SecurityEvent: DELETE after 90 days; AiEgressRecord: one completion), proven on real PostgreSQL in CI.`),
];

// ── 3 · secrets and configuration — names and HOW they are supplied, never values

const RENDER = cite('render.yaml');
const renderLines = (read(RENDER) || '').split('\n');
// TOKEN only as a whole segment: `GITHUB_TOKEN` names a credential,
// `AI_LLM_MAX_TOKENS` names a count.
const SECRET_NAME = /(SECRET|PASSWORD|_PASS$|(?:^|_)TOKEN(?:_|$)|API_KEY|PRIVATE_KEY|KEK|ACCESS_KEY|DATABASE_URL|REDIS_URL)/;
const envVars = [];
for (let i = 0; i < renderLines.length; i += 1) {
  const k = renderLines[i].match(/^\s*-\s*key:\s*([A-Z0-9_]+)\s*$/);
  if (!k) continue;
  // Look only at the few lines that belong to this entry, and only at WHICH
  // field is present. No capture group ever reaches a value.
  let supply = 'unknown';
  for (let j = i + 1; j < Math.min(i + 6, renderLines.length); j += 1) {
    const l = renderLines[j];
    if (/^\s*-\s*key:/.test(l)) break;
    if (/^\s*sync:\s*false\b/.test(l)) { supply = 'dashboard'; break; }
    if (/^\s*generateValue:/.test(l)) { supply = 'generated'; break; }
    if (/^\s*(fromDatabase|fromService):/.test(l)) { supply = 'linked'; break; }
    if (/^\s*value:/.test(l)) { supply = 'inline'; break; }
  }
  envVars.push({ name: k[1], supply, secretNamed: SECRET_NAME.test(k[1]) });
}
envVars.sort((a, b) => a.name.localeCompare(b.name));
const secretNamedInline = envVars.filter((v) => v.secretNamed && v.supply === 'inline').map((v) => v.name);

const datastores = [];
for (let i = 0; i < renderLines.length; i += 1) {
  const t = renderLines[i].match(/^\s*-\s*type:\s*(redis)\s*$/) || (/^databases:/.test(renderLines[i]) ? [null, 'postgres'] : null);
  if (!t) continue;
  let name = null; let privateOnly = false;
  for (let j = i + 1; j < Math.min(i + 12, renderLines.length); j += 1) {
    const n = renderLines[j].match(/^\s*-?\s*name:\s*([\w-]+)/);
    if (n && !name) name = n[1];
    if (/^\s*ipAllowList:\s*\[\s*\]/.test(renderLines[j])) { privateOnly = true; break; }
  }
  datastores.push({ kind: t[1], name, privateNetworkOnly: privateOnly });
}

// ── 4 · cryptography in use — what the Post-Quantum Center will start from ──

const cryptoUse = new Map();
const note = (primitive, algorithm, file) => {
  const key = `${primitive}|${algorithm}`;
  if (!cryptoUse.has(key)) cryptoUse.set(key, { primitive, algorithm, files: new Set() });
  cryptoUse.get(key).files.add(file);
};
srcFiles.forEach((f, i) => {
  const s = allSrc[i];
  for (const m of s.matchAll(/createHash\(\s*'([a-z0-9-]+)'/g)) note('hash', m[1], f);
  for (const m of s.matchAll(/createHmac\(\s*'([a-z0-9-]+)'/g)) note('hmac', m[1], f);
  for (const m of s.matchAll(/createCipheriv\(\s*'([a-z0-9-]+)'/g)) note('cipher', m[1], f);
  if (/createCipheriv\(\s*[A-Z_a-z]+[,)]/.test(s)) note('cipher', 'via-constant', f);
  if (/\bjwt\.sign\(/.test(s)) note('jwt-sign', /algorithm\s*:/.test(s) ? 'explicit' : 'library-default-hs256', f);
  if (/\bjwt\.verify\(/.test(s)) note('jwt-verify', /algorithms\s*:/.test(s) ? 'pinned' : 'not-pinned', f);
  if (/\bbcrypt(?:js)?\.hash\(|native\.hash\(/.test(s)) note('password-hash', 'bcrypt', f);
  if (/\b(pbkdf2|scrypt|hkdf)(Sync)?\(/.test(s)) note('kdf', (s.match(/\b(pbkdf2|scrypt|hkdf)(?:Sync)?\(/) || [])[1], f);
  if (/\btimingSafeEqual\(/.test(s)) note('constant-time-compare', 'timingSafeEqual', f);
});
const crypto = [...cryptoUse.values()]
  .map((c) => ({ primitive: c.primitive, algorithm: c.algorithm, files: [...c.files].sort() }))
  .sort((a, b) => `${a.primitive}${a.algorithm}`.localeCompare(`${b.primitive}${b.algorithm}`));

// ── 5 · supply chain ─────────────────────────────────────────────────────────

const lock = (() => { try { return JSON.parse(read(cite('package-lock.json')) || 'null'); } catch (_) { return null; } })();
const lockPackages = lock && lock.packages ? Object.entries(lock.packages).filter(([k]) => k.startsWith('node_modules/')) : [];
const registries = {};
let withIntegrity = 0;
for (const [, p] of lockPackages) {
  if (p.integrity) withIntegrity += 1;
  if (typeof p.resolved === 'string') {
    const host = (p.resolved.match(/^https?:\/\/([^/]+)/) || [])[1] || 'other';
    registries[host] = (registries[host] || 0) + 1;
  }
}
const ciSrc = read(cite('.github/workflows/ci.yml')) || '';
const deploySrc = read(cite('.github/workflows/deploy.yml')) || '';
const backupWorkflowSrc = read(cite('.github/workflows/backup.yml')) || '';
// Every workflow file, not a named few: a workflow added later is held to the
// same least-privilege, pinning and injection checks the day it lands.
const allWorkflowSrcs = fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).sort()
  .map((f) => read(cite(`.github/workflows/${f}`)) || '');
const workflowUses = [...allWorkflowSrcs.join('\n').matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
const supplyChain = {
  lockfilePackages: lockPackages.length,
  lockfileIntegrity: withIntegrity,
  registries: Object.fromEntries(Object.entries(registries).sort()),
  auditInCi: /npm audit/.test(ciSrc),
  auditBlocksCi: /npm audit/.test(ciSrc) && !/npm audit[^\n]*\|\|\s*true/.test(ciSrc),
  actions: workflowUses.length,
  actionsPinnedBySha: workflowUses.filter((u) => /@[0-9a-f]{40}$/.test(u)).length,
  ciPermissionsDeclared: /^permissions:/m.test(ciSrc),
  dependencyUpdates: exists('.github/dependabot.yml') || exists('renovate.json') || exists('.github/renovate.json'),
  codeowners: exists('.github/CODEOWNERS') || exists('CODEOWNERS'),
  securityPolicy: exists('SECURITY.md') || exists('.github/SECURITY.md'),
};

// Cyber Defense, Step 9 — the CI and supply-chain controls, derived from the
// files that define them, so a later edit that loosens one fails the posture
// test rather than passing unnoticed.
const dependabotSrc = read(cite('.github/dependabot.yml')) || '';
const gitleaksIgnore = read(cite('.gitleaksignore')) || '';
// The defaults missed a Neon connection string and a JWT secret in `.evn`; the
// repository's own rules are part of the control, so dropping one is ABSENT.
const gitleaksConfig = read(cite('.gitleaks.toml')) || '';
const GITLEAKS_OWN_RULES = ['postgres-connection-string', 'neon-password', 'neon-endpoint-credentials', 'committed-env-file', 'env-file-secret-value'];
const workflowSrcs = allWorkflowSrcs.filter(Boolean);
const { expressionInScript: hasExpressionInScript, leastPrivilege } = require('./lib/workflow-checks');
const expressionInScript = workflowSrcs.some(hasExpressionInScript);
controls.push(
  control('ci-least-privilege', workflowSrcs.every(leastPrivilege) ? 'PRESENT' : 'ABSENT', '.github/workflows',
    'Every workflow declares permissions: contents: read and grants no write scope.'),
  control('ci-actions-sha-pinned',
    supplyChain.actions > 0 && supplyChain.actionsPinnedBySha === supplyChain.actions ? 'PRESENT' : 'ABSENT', '.github/workflows',
    `${supplyChain.actionsPinnedBySha} of ${supplyChain.actions} action reference(s) pinned to a full commit SHA.`),
  control('ci-audit-blocking', supplyChain.auditBlocksCi && /npm audit --audit-level=(high|critical)/.test(ciSrc) ? 'PRESENT' : 'ABSENT', '.github/workflows/ci.yml',
    'npm audit fails the build on a high or critical advisory.'),
  control('ci-secret-scanning',
    /gitleaks[^\n]* git \. --config \.gitleaks\.toml[^\n]*--redact[^\n]*--exit-code 1/.test(ciSrc) && /fetch-depth:\s*0/.test(ciSrc)
      && /sha256sum --check --strict/.test(ciSrc) && !/gitleaks[^\n]*\|\|\s*true/.test(ciSrc)
      && /\[extend\]\s*\nuseDefault = true/.test(gitleaksConfig)
      && GITLEAKS_OWN_RULES.every((id) => gitleaksConfig.includes(`id = "${id}"`)) ? 'PRESENT' : 'ABSENT', '.github/workflows/ci.yml',
    `Full-history gitleaks scan, pinned and checksum-verified, blocking, with the default rules plus the repository's own for PostgreSQL connection strings, Neon passwords and committed environment files; ${gitleaksIgnore.split('\n').filter((l) => /^[0-9a-f]{40}:/.test(l)).length} reviewed finding(s) baselined.`),
  control('ci-no-expression-injection', expressionInScript ? 'ABSENT' : 'PRESENT', '.github/workflows',
    'No ${{ }} expression is expanded inside a run: script; values reach scripts through env.'),
  control('dependency-updates',
    /package-ecosystem:\s*npm/.test(dependabotSrc) && /package-ecosystem:\s*github-actions/.test(dependabotSrc) ? 'PRESENT' : 'ABSENT', '.github/dependabot.yml',
    'Dependabot proposes npm and GitHub Actions updates as reviewed pull requests.'),
  control('codeowners', supplyChain.codeowners ? 'PRESENT' : 'ABSENT', '.github/CODEOWNERS'),
);

// ── backups (Cyber Defense, Step 10) ─────────────────────────────────────────

// The daily backup at €0/month: a GitHub Actions schedule asks the running
// service, over an HMAC-signed request, to run its fixed backup. Present when
// the workflow runs daily and on demand with a read-only token, holds exactly
// one secret (the trigger's), never names the database or a backup key, and
// the paid Render cron job is gone from the blueprint.
function backupScheduled() {
  const wf = backupWorkflowSrc;
  if (!wf) return false;
  const secretsUsed = [...new Set([...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
  const forbidden = /DATABASE_URL|BACKUP_S3_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)|BACKUP_SIGNING_PRIVATE_KEY|BACKUP_ENCRYPTION_PRIVATE_KEY/;
  const raw = read(RENDER) || '';
  return /^\s+-\s*cron:\s*'[0-9*/,\- ]+'\s*$/m.test(wf)
    && /^\s+workflow_dispatch:/m.test(wf)
    && leastPrivilege(wf)
    && !hasExpressionInScript(wf)
    && secretsUsed.length === 1 && secretsUsed[0] === 'BACKUP_TRIGGER_SECRET'
    && !forbidden.test(wf)
    && /run:\s*node scripts\/backup-trigger\.js\s*$/m.test(wf)
    && !/^[ \t]*-[ \t]*type:[ \t]*cron[ \t]*$/m.test(raw)
    && !/-[ \t]*key:[ \t]*BACKUP_ENCRYPTION_PRIVATE_KEY\b/.test(raw);
}

// The trigger's door: HMAC-SHA256 over method, path and timestamp, compared in
// constant time within a freshness window, closed without a secret; one run at
// a time by advisory lock; none within 12 hours of a success; and the routes
// mounted with the rate limiter and the check in front of the handler.
function backupTriggerProtected() {
  const t = read(cite('src/security/backup/backup-trigger.ts')) || '';
  const c = read(cite('src/controllers/internal-backup.controller.ts')) || '';
  const st = read(cite('src/security/backup/backup-run-store.ts')) || '';
  return /createHmac\('sha256'/.test(t) && /timingSafeEqual\(/.test(t) && /TRIGGER_WINDOW_SECONDS\s*=\s*300\b/.test(t)
    && /MIN_INTERVAL_MS\s*=\s*12\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(t) // R10: tightened from 20 hours
    && /return raw\.length >= MIN_SECRET_LENGTH \? Buffer\.from\(raw, 'utf8'\) : null/.test(t)
    && /pg_try_advisory_xact_lock/.test(st)
    && /backup trigger is not configured/.test(c) && /this endpoint takes no parameters/.test(c)
    && /app\.post\('\/internal\/backups\/run', \.\.\.internalBackup\.run\)/.test(appSrc)
    && /app\.get\('\/internal\/backups\/runs\/:id', \.\.\.internalBackup\.status\)/.test(appSrc)
    && /run: \[runLimiter, auth, runHandler\(deps\)\]/.test(c) && /status: \[statusLimiter, auth, statusHandler\(deps\)\]/.test(c);
}


// R1a: the transcode callback is a worker's, never a user session's. It is an
// app-level route outside every API router, authenticated by an HMAC over the
// method, path, timestamp and raw body (constant-time, 5-minute window), closed
// without its secret, and the service keeps every storage key inside the
// asset's own club folder whoever calls it.
// R1c: a realtime connection is authenticated like a request and closed when
// its session ends.
function realtimeSessionsWatched() {
  const mw = read(cite('src/middleware/auth.middleware.ts')) || '';
  const sw = read(cite('src/realtime/session-watch.ts')) || '';
  const ms = read(cite('src/services/membership.service.ts')) || '';
  const code = (f) => (read(cite(f)) || '').replace(/\/\/[^\n]*/g, '');
  const endSession = (() => { const i = ms.indexOf('export async function endClubSession'); return i < 0 ? '' : ms.slice(i, ms.indexOf('\nexport ', i + 10)); })();
  // R7: the sockets authenticate with a single-use ticket, redeemed through
  // the same session rule (realtimeSessionFor) that verifySessionToken uses.
  const byTicket = ['src/realtime/match-ws.ts', 'src/realtime/market-ws.ts'];
  const direct = ['src/realtime/match-sse.ts'];
  const ticket = code('src/realtime/ws-ticket.ts');
  const viaRequest = ['src/routes/data-pulse.routes.ts', 'src/routes/infrastructure.routes.ts', 'src/routes/owner-trace.routes.ts', 'src/controllers/vision-engine.controller.ts'];
  return /export async function verifySessionToken/.test(mw) && /export async function sessionStillValid/.test(mw)
    && /claimed !== \(user\.tokenVersion \?\? 0\)/.test(mw.slice(mw.indexOf('export async function verifySessionToken')))
    && /onIdentityForgotten\(/.test(sw) && /setInterval\(/.test(sw) && /sessionStillValid\(/.test(sw)
    && /forgetIdentity\(userId\)/.test(endSession)
    && /return realtimeSessionFor\(verified\.sub/.test(mw)
    && /realtimeSessionFor\(claims\.sub, claims\.tv/.test(ticket)
    && direct.every((f) => /verifySessionToken\(/.test(code(f)) && /watchSession\(/.test(code(f)) && !/jwt\.verify\(/.test(code(f)))
    && byTicket.every((f) => /redeemWsTicket\(/.test(code(f)) && /watchSession\(/.test(code(f)) && !/jwt\.verify\(/.test(code(f)))
    && viaRequest.every((f) => /watchRequestSession\(req, res,/.test(code(f)));
}

// R1b: a URL a user supplied is fetched only through the outbound guard.
function outboundGuardProtected() {
  const g = read(cite('src/security/outbound-url-guard.ts')) || '';
  const n = read(cite('src/notifications/notifications.service.ts')) || '';
  const w = read(cite('src/workers/notification-dispatch.worker.ts')) || '';
  const register = (() => { const i = n.indexOf('export async function registerChannel'); return i < 0 ? '' : n.slice(i, n.indexOf('\nexport ', i + 10)); })();
  return ['127.0.0.0', '10.0.0.0', '172.16.0.0', '192.168.0.0', '169.254.0.0', '100.64.0.0', 'fc00::', 'fe80::', '::1', '64:ff9b::']
      .every((net) => g.includes(`['${net}',`))
    && /url\.protocol !== 'https:'/.test(g) && /lookup: guardedLookup\(/.test(g)
    && /'redirect-refused'/.test(g) && /maxResponseBytes/.test(g)
    && /=== 'WEBHOOK'[\s\S]{0,200}await assertOutboundUrl\(dto\.target\)/.test(register)
    && /t\.kind === 'WEBHOOK'[\s\S]{0,200}postJsonGuarded\(t\.url/.test(w)
    && !/bodyText/.test(w) && /redirect: 'manual'/.test(w);
}

function workerCallbackProtected() {
  const w = read(cite('src/security/worker-callback.ts')) || '';
  const c = read(cite('src/controllers/internal-video.controller.ts')) || '';
  const v = read(cite('src/video/video-asset.service.ts')) || '';
  const routesSrc = fs.readdirSync(path.join(ROOT, 'src/routes')).filter((f) => f.endsWith('.ts'))
    .map((f) => read(`src/routes/${f}`) || '').join('\n');
  const handler = (() => { const i = v.indexOf('export async function handleTranscodeCallback'); return i < 0 ? '' : v.slice(i, v.indexOf('\nexport ', i + 10)); })();
  return /createHmac\('sha256'/.test(w) && /timingSafeEqual\(/.test(w)
    && /createHash\('sha256'\)\.update\(body\)/.test(w)
    && /return raw\.length >= MIN_SECRET_LENGTH \? Buffer\.from\(raw, 'utf8'\) : null/.test(w)
    && /worker callback is not configured/.test(c) && /express\.raw\(/.test(c)
    && /requireWorkerCallback\(deps\),\s*transcodeCallbackHandler\(deps\)/.test(c)
    && /app\.post\('\/internal\/video\/transcode-callback', \.\.\.transcodeCallbackRoute\(\)\)/.test(appSrc)
    && appSrc.indexOf("app.post('/internal/video/transcode-callback'") < appSrc.indexOf('app.use(express.json(')
    && !/router\.\w+\s*\(\s*'[^']*transcode-callback/.test(routesSrc)
    && /assertKeyWithinAsset\(asset, dto\.hlsManifestKey/.test(handler) && /assertKeyWithinAsset\(asset, dto\.thumbStorageKey/.test(handler)
    && /clubs\/\$\{asset\.clubId\}\/videos\/\$\{asset\.id\}\//.test(v);
}

// R4: production moves only after CI. Every Render service that builds from
// the repository has auto-deploy off, and the deploy workflow fires only on a
// successful 'ci' run on main (for the commit that is still main's head) or by
// hand — and fails, rather than passing green, when it cannot deploy.
// Algorithms, Step 1: no algorithmic change reaches production without a human
// approval of that exact code, and the room that shows them can change none.
//   · every registered algorithm is READ_ANALYZE, and its approval names the
//     fingerprint of the code as it is now (computed fresh, not read from the
//     committed manifest);
//   · on the loop, DEPLOY is reachable only from HUMAN_APPROVAL;
//   · the routes are owner-guarded and have no write handler;
//   · the registry is code-owned, so the approval edit itself is reviewed.
function algorithmChangeGate() {
  const reg = read(cite('src/algorithms/registry.ts')) || '';
  const loop = stripComments(read(cite('src/algorithms/loop.ts')) || '');
  const routes = stripComments(read(cite('src/routes/algorithms.routes.ts')) || '');
  const owners = read('.github/CODEOWNERS') || '';
  if (!reg || !loop || !routes) return false;
  let fresh;
  try { fresh = require('./algorithms-discover').buildManifest().algorithms; } catch (_) { return false; }
  const entries = reg.split(/\n  \{\n    key: '/).slice(1);
  if (!entries.length || entries.length !== Object.keys(fresh).length) return false;
  for (const e of entries) {
    const key = e.slice(0, e.indexOf("'"));
    const mode = (e.match(/\bmode: '([A-Z_]+)'/) || [])[1];
    // An approval is a baseline or a change (Step 5), and names the entry's own
    // version; a change writes its version and fingerprint first, so both read
    // from one place.
    const version = (e.match(/\n {4}version: '([^']+)',\n/) || [])[1];
    const approval = e.match(/\n {4}approval: baseline\('([^']+)', '([0-9a-f]{64})'\),\n/)
      || e.match(/\n {4}approval: change\(\{\n {6}version: '([^']+)', fingerprint: '([0-9a-f]{64})',\n/) || [];
    if (mode !== 'READ_ANALYZE' || !version || approval[1] !== version) return false;
    if (!fresh[key] || !fresh[key].fingerprint || approval[2] !== fresh[key].fingerprint) return false;
  }
  const edges = loop.slice(loop.indexOf('LOOP_EDGES'), loop.indexOf('};', loop.indexOf('LOOP_EDGES')));
  const intoDeploy = [...edges.matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)].filter((m) => /'DEPLOY'/.test(m[2])).map((m) => m[1]);
  return intoDeploy.length === 1 && intoDeploy[0] === 'HUMAN_APPROVAL'
    && /export const ALGORITHM_MODES = \['READ_ANALYZE'\] as const;/.test(loop)
    && /assertPlatformOwner\(/.test(routes) && !/router\.(post|put|patch|delete|all)\(/.test(routes)
    && /^\/?src\/algorithms\/\s+@/m.test(owners);
}

// Algorithms, Step 2: production telemetry of the registered algorithms holds
// no personal data, has one writer, and is read only by the platform owner.
//   · the AlgorithmTelemetryBucket model has exactly its aggregate columns —
//     none for a club, team, player, user, request, input or message;
//   · its migration refuses free text in every identifier column (CHECK);
//   · src/algorithms/telemetry-store.ts is the only source that names the table
//     and the only file in src/algorithms that imports a database client;
//   · the recorder refuses a workflow outside its closed list;
//   · the room's routes are owner-guarded with no write handler;
//   · the real-PostgreSQL proof runs in CI, where it cannot be skipped.
const ALGORITHM_TELEMETRY_COLUMNS = [
  'id', 'algorithmKey', 'version', 'fingerprint', 'source', 'bucketStart',
  'executions', 'failures', 'outputs', 'outOfContract', 'latencySumUs', 'latencyMaxUs',
  'latencyBins', 'outputBins', 'qualityOk', 'qualityPartial', 'qualityEmpty',
  'freshnessFresh', 'freshnessStale', 'firstAt', 'lastAt', 'lastFailureAt', 'lastFailureKind', 'updatedAt',
];
function algorithmTelemetryPrivate() {
  const schema = read(cite('prisma/schema.prisma')) || '';
  const block = (schema.match(/^model AlgorithmTelemetryBucket \{([\s\S]*?)^\}/m) || [])[1];
  if (!block) return false;
  const cols = [...block.matchAll(/^\s+([A-Za-z]\w*)\s+\S/gm)].map((m) => m[1]);
  if (JSON.stringify([...cols].sort()) !== JSON.stringify([...ALGORITHM_TELEMETRY_COLUMNS].sort())) return false;
  const migration = migrationFilesSorted().find((m) => /CREATE TABLE "AlgorithmTelemetryBucket"/.test(m.sql));
  if (!migration) return false;
  const checks = ['_key_shape', '_version_shape', '_fingerprint_shape', '_source_shape', '_failure_kind_shape', '_counts_sane', '_bins_bounded'];
  if (!checks.every((c) => migration.sql.includes(`"AlgorithmTelemetryBucket${c}" CHECK`))) return false;
  const STORE = 'src/algorithms/telemetry-store.ts';
  const naming = srcFiles.filter((f, i) => /AlgorithmTelemetryBucket|algorithmTelemetryBucket/.test(stripComments(allSrc[i])));
  if (naming.length !== 1 || naming[0] !== STORE) return false;
  const dbInAlgorithms = srcFiles.filter((f, i) => f.startsWith('src/algorithms/')
    && /config\/database|@prisma\/client|rls-client|db-context/.test(stripComments(allSrc[i])));
  if (dbInAlgorithms.length !== 1 || dbInAlgorithms[0] !== STORE) return false;
  const recorder = stripComments(read(cite('src/algorithms/telemetry.ts')) || '');
  if (!/!\(source in SOURCES\) \|\| !spec\.sources\.includes\(source\)/.test(recorder)) return false;
  const routes = stripComments(read(cite('src/routes/algorithms.routes.ts')) || '');
  const ci = read('.github/workflows/ci.yml') || '';
  return /assertPlatformOwner\(/.test(routes) && !/router\.(post|put|patch|delete|all)\(/.test(routes)
    && /tests\/algorithm-telemetry\.integration\.test\.ts/.test(ci) && /ALGO_TELEMETRY_DB_REQUIRED:\s*'1'/.test(ci);
}

// Algorithms, Step 3: learning is synthetic only, labelled as such, and reads
// nothing real.
//   · the four learning modules exist; none imports a database client or the
//     telemetry recorder, and none names a club, match, injury or workload
//     model — synthetic runs can neither read club data nor enter production
//     telemetry;
//   · the real-world lane is declared DISABLED and every synthetic object
//     carries evidence 'SYNTHETIC', in the code and in the API contract;
//   · only xG and xGOT have synthetic checks, and the four algorithms whose
//     outcomes would be health data are declared EXCLUDED_HEALTH;
//   · the approved functions are imported from where the platform keeps them;
//   · the run is bounded: a busy-time budget that stops it, and slices;
//   · the room's routes are owner-guarded with no write handler, and the
//     learning reads are GETs.
const LEARNING_FILES = ['src/algorithms/learning-spec.ts', 'src/algorithms/learning-stats.ts', 'src/algorithms/learning-synthetic.ts', 'src/algorithms/learning.ts'];
const HEALTH_EXCLUDED = ['medical-risk', 'training-load', 'biomechanical-load', 'tactical-attrition'];
function algorithmLearningSeparated() {
  const code = LEARNING_FILES.map((f) => stripComments(read(cite(f)) || ''));
  if (code.some((c) => !c)) return false;
  for (const c of code) {
    if (/config\/database|@prisma\/client|rls-client|db-context|\bprisma\.|\$queryRaw|\$executeRaw/.test(c)) return false;
    if (/from '\.\/telemetry(?:-store)?'|\bobserved(?:Async)?\(|recordOutputs\(/.test(c)) return false;
    if (/\b(?:MatchEvent|matchEvent|PlayerInjury|playerInjury|InjuryRecord|injuryRecord|WorkloadRecord|workloadRecord|PlayerMatchStats|playerMatchStats)\b/.test(c)) return false;
  }
  const [spec, , synthetic, view] = code;
  const contracts = stripComments(read(cite('src/contracts/owner-api.contracts.ts')) || '');
  const routes = stripComments(read(cite('src/routes/algorithms.routes.ts')) || '');
  const realWorld = (spec.match(/export const REAL_WORLD = \{[\s\S]*?\n\} as const;/) || [''])[0];
  return /state: 'DISABLED' as const/.test(realWorld) && !/'ENABLED'|'ACTIVE'/.test(spec)
    && /realWorld: \{ state: 'DISABLED' \}/.test(view) && /evidence: \{ synthetic: 'SYNTHETIC', realWorld: 'DISABLED' \}/.test(view)
    && (synthetic.match(/evidence: 'SYNTHETIC'/g) || []).length >= 3
    && /evidence: z\.literal\('SYNTHETIC'\)/.test(contracts) && /realWorld: z\.literal\('DISABLED'\)/.test(contracts)
    && /export const SYNTHETIC_KEYS: readonly SyntheticKey\[\] = \['xg', 'xgot'\];/.test(spec)
    && HEALTH_EXCLUDED.every((k) => new RegExp(`key: '${k}', status: 'EXCLUDED_HEALTH'`).test(spec))
    && /from '\.\.\/match-events\/xg-model\.service'/.test(synthetic)
    && /busyBudgetMs/.test(spec) && /class BudgetExceeded/.test(synthetic) && /setImmediate/.test(synthetic)
    && /assertPlatformOwner\(/.test(routes) && !/router\.(post|put|patch|delete|all)\(/.test(routes)
    && /router\.get\('\/learning'/.test(routes) && /router\.get\('\/:key\/learning'/.test(routes);
}

// Step 4: a candidate — a proposed new version of an approved algorithm —
// never runs in production. Its code and the engine that compares it live in
// lab/, outside the build; each runs in a child process the parent kills; the
// server only reads the evidence file, through its schema.
const LAB_FILES = tsFiles('lab/algorithms');
/** Blank the contents of string and template literals, keeping the quotes. */
const stripStrings = (t) => t.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m) => m[0] + m[0]);
const CANDIDATE_FORBIDDEN = /\b(?:require|process|globalThis|global|eval|Function|Reflect|Proxy|prototype|__proto__|setTimeout|setInterval|setImmediate|queueMicrotask|fetch|XMLHttpRequest|WebSocket|Date|Buffer|module|exports)\b|\bimport\s*\(|Math\.random/;
function algorithmCandidateIsolation() {
  // The build compiles src/ only, so nothing under lab/ can reach dist/.
  let tsconfig = null;
  try { tsconfig = JSON.parse(read(cite('tsconfig.json')) || ''); } catch (_) { return false; }
  if (!tsconfig || tsconfig.compilerOptions.rootDir !== './src' || JSON.stringify(tsconfig.include) !== JSON.stringify(['src/**/*'])) return false;
  const pkg = JSON.parse(read('package.json') || '{}');
  if (/\blab\//.test((pkg.scripts && pkg.scripts.build) || '')) return false;
  // Nothing in src/ imports the lab.
  if (srcFiles.some((f, i) => /(?:from\s+|require\(\s*|import\(\s*)['"][^'"]*\blab\//.test(stripComments(allSrc[i])))) return false;
  // The lab itself: present, and it reads no database or telemetry.
  if (!LAB_FILES.includes('lab/algorithms/runner.ts') || !LAB_FILES.includes('lab/algorithms/candidates/index.ts')) return false;
  for (const f of LAB_FILES) {
    if (/config\/database|@prisma\/client|\bprisma\.|algorithms\/telemetry/.test(stripComments(read(cite(f)) || ''))) return false;
  }
  // A candidate file imports types only, and has no capability beyond computing.
  for (const f of LAB_FILES.filter((x) => x.startsWith('lab/algorithms/candidates/') && !x.endsWith('/index.ts'))) {
    const code = stripStrings(stripComments(read(cite(f)) || ''));
    const imports = code.match(/^\s*import\b[^;]*;/gm) || [];
    if (imports.some((l) => !/^\s*import\s+type\s/.test(l)) || CANDIDATE_FORBIDDEN.test(code)) return false;
  }
  // Every job in its own process: killed by process group at the parent's deadline, an empty environment, capped heap and output.
  const runner = stripComments(read(cite('lab/algorithms/runner.ts')) || '');
  if (!(/detached: GROUPS/.test(runner) && /process\.kill\(-child\.pid, 'SIGKILL'\)/.test(runner)
    && /setTimeout\(\(\) => \{ if \(!limit\) \{ limit = 'TIMED_OUT'; killGroup\(child\); \} \}, limits\.timeoutMs\)/.test(runner)
    && /env: \{ \.\.\.CHILD_ENV, \.\.\.\(opts\.env \?\? \{\}\) \}/.test(runner) && !/\.\.\.process\.env/.test(runner)
    && /--max-old-space-size=/.test(runner) && /outBytes > limits\.maxStdoutBytes/.test(runner) && /liveGroupMembers\(/.test(runner))) return false;
  // Candidates only where a synthetic generator exists, never on health data.
  const spec = stripComments(read(cite('lab/algorithms/spec.ts')) || '');
  const algs = (((spec.match(/export const CANDIDATE_ALGORITHMS = \[([^\]]*)\] as const;/) || [])[1]) || '').match(/'[a-z0-9-]+'/g) || [];
  if (!algs.length || algs.some((a) => HEALTH_EXCLUDED.includes(a.slice(1, -1)))) return false;
  // The server: reads the evidence through its schema, runs nothing, and can call no candidate approved or deployable.
  const reader = stripComments(read(cite('src/algorithms/candidate-evidence.ts')) || '');
  const view = stripComments(read(cite('src/algorithms/candidates.ts')) || '');
  if (!/CandidateEvidenceSchema\.safeParse\(/.test(reader) || /child_process|\bspawn\(|\bfork\(|\bexec(?:File)?\(|\brequire\(/.test(reader + view)) return false;
  if (!(/evidence: z\.literal\('SYNTHETIC'\)/.test(reader) && /production: z\.literal\('NEVER_RUN'\)/.test(reader)
    && /status: z\.literal\('EXPERIMENTAL'\)/.test(reader) && /approval: z\.literal\('NOT_APPROVED'\)/.test(reader))) return false;
  if (!/deployable: false/.test(view) || !/deploymentGate\(/.test(view) || !/canAdvance\(/.test(view)) return false;
  // Only the evidence ships — data, never lab code.
  const assets = read(cite('scripts/copy-runtime-assets.js')) || '';
  if (!/'src\/algorithms\/generated\/candidate-evidence\.json'/.test(assets) || /['"]lab\//.test(assets)) return false;
  // Owner-only reads.
  const routes = stripComments(read(cite('src/routes/algorithms.routes.ts')) || '');
  return /router\.get\('\/candidates'/.test(routes) && /router\.get\('\/candidates\/:id'/.test(routes)
    && /assertPlatformOwner\(/.test(routes) && !/router\.(post|put|patch|delete|all)\(/.test(routes);
}

// Step 5: a CHANGE approval is bound, link by link, to the evidence it was
// judged on, and nothing between the approval and production is guessed.
//   · every approval is a baseline or a change in the registry's one shape;
//   · a change names a dossier in src/algorithms/approvals/ whose canonical
//     digest is the one it records — about this algorithm, candidate, version,
//     fingerprint and the version it replaced, its evidence digest intact,
//     its held-out Test passed — and an archive for rollback and
//     reproduction, whose candidate is held to the candidate rules;
//   · no dossier or archive belongs to no approval;
//   · the server reads dossiers through their schema, imports nothing from the
//     lab and runs nothing; its releases read is an owner-only GET whose deploy
//     and live states are fixed as not known here;
//   · the release tool needs a pull-request reference and never overwrites a
//     dossier; CI rehearses a promotion and its rollback; the deploy workflow
//     says that whether a deploy is live is a person's check.
const APPROVALS_DIR = 'src/algorithms/approvals';
const ARCHIVE_DIR = 'lab/algorithms/archive';
const CHANGE_APPROVAL = /\n {4}approval: change\(\{\n {6}version: '([^']+)', fingerprint: '([0-9a-f]{64})',\n {6}candidate: '([a-z0-9][a-z0-9.-]*)', baseline: \{ version: '([^']+)', fingerprint: '([0-9a-f]{64})' \},\n {6}dossier: \{ file: '(src\/algorithms\/approvals\/[a-z0-9][a-z0-9.-]*\.json)', digest: '([0-9a-f]{64})' \},\n {6}reference: '[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d{0,6}', approvedAt: '\d{4}-\d{2}-\d{2}',\n {4}\}\),\n/;
function algorithmReleaseBinding() {
  let core;
  try { core = require('../src/algorithms/dossier-core.js'); } catch (_) { return false; }
  const reg = read(cite('src/algorithms/registry.ts')) || '';
  const entries = reg.split(/\n  \{\n    key: '/).slice(1);
  if (!entries.length) return false;
  const changes = [];
  for (const e of entries) {
    const key = e.slice(0, e.indexOf("'"));
    const version = (e.match(/\n {4}version: '([^']+)',\n/) || [])[1];
    const base = e.match(/\n {4}approval: baseline\('([^']+)', '[0-9a-f]{64}'\),\n/);
    const chg = e.match(CHANGE_APPROVAL);
    if (!version || !!base === !!chg || (base ? base[1] : chg[1]) !== version) return false;
    if (chg) changes.push({ key, version: chg[1], fingerprint: chg[2], candidate: chg[3], baseline: { version: chg[4], fingerprint: chg[5] }, file: chg[6], digest: chg[7] });
  }
  for (const c of changes) {
    let d;
    try { d = JSON.parse(read(cite(c.file)) || ''); } catch (_) { return false; }
    if (core.digestOf(d) !== c.digest || core.digestOf(d.reproducible) !== d.evidenceDigest) return false;
    if (d.kind !== 'CHANGE_APPROVAL_DOSSIER' || d.evidence !== 'SYNTHETIC' || d.algorithm !== c.key) return false;
    if (!d.candidate || d.candidate.id !== c.candidate || d.candidate.version !== c.version || d.candidate.fingerprint !== c.fingerprint) return false;
    if (!d.promotion || d.promotion.promotedFingerprint !== c.fingerprint || !d.test || d.test.verdict !== 'PASSED') return false;
    if (!d.baseline || d.baseline.version !== c.baseline.version || d.baseline.fingerprint !== c.baseline.fingerprint) return false;
    const archived = ['json', 'approved.ts', 'candidate.ts'].map((x) => `${ARCHIVE_DIR}/${c.candidate}.${x}`);
    if (!archived.every((f) => read(cite(f)) !== null)) return false;
    const code = stripStrings(stripComments(read(archived[2]) || ''));
    const imports = code.match(/^\s*import\b[^;]*;/gm) || [];
    if (imports.some((l) => !/^\s*import\s+type\s/.test(l)) || CANDIDATE_FORBIDDEN.test(code)) return false;
  }
  const listed = (dir) => { try { return fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith('.json')); } catch (_) { return []; } };
  if (listed(APPROVALS_DIR).some((n) => !changes.some((c) => c.file === `${APPROVALS_DIR}/${n}`))) return false;
  if (listed(ARCHIVE_DIR).some((n) => !changes.some((c) => `${c.candidate}.json` === n))) return false;
  const release = stripComments(read(cite('src/algorithms/release.ts')) || '');
  const dossier = stripComments(read(cite('src/algorithms/approval-dossier.ts')) || '');
  const routes = stripComments(read(cite('src/routes/algorithms.routes.ts')) || '');
  const assets = read(cite('scripts/copy-runtime-assets.js')) || '';
  if (!/export function checkBinding\(/.test(release) || !/deploy: \{ requested: 'NOT_KNOWN_HERE', live: 'NOT_KNOWN_HERE' \}/.test(release)) return false;
  if (!/ApprovalDossierSchema\.safeParse\(/.test(dossier)) return false;
  if (/child_process|\bspawn\(|\bfork\(|\bexec(?:File)?\(|(?:from\s+|require\(\s*|import\(\s*)['"][^'"]*\blab\//.test(release + dossier)) return false;
  if (!/router\.get\('\/releases'/.test(routes) || !/assertPlatformOwner\(/.test(routes) || /router\.(post|put|patch|delete|all)\(/.test(routes)) return false;
  if (!/'src\/algorithms\/approvals'/.test(assets)) return false;
  const tool = stripComments(read(cite('lab/algorithms/release/workspace.ts')) || '');
  const tests = read(cite('tests/algorithms-release.unit.test.ts')) || '';
  if (!/PULL_REQUEST_REFERENCE\.test\(opts\.reference\)/.test(tool) || !/'ALREADY_PROMOTED'/.test(tool) || !/\brehearse\(/.test(tests)) return false;
  return /Not confirmed by this workflow/.test(deploySrc);
}

function deployGatedByCi() {
  const raw = read(RENDER) || '';
  const services = (raw.match(/^\s*-\s*type:\s*(?:web|worker|pserv|cron)\s*$/gm) || []).length;
  const off = (raw.match(/^\s+autoDeploy:\s*false\s*$/gm) || []).length;
  const wf = deploySrc;
  const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\npermissions:'));
  return services > 0 && off === services && !/autoDeploy:\s*true/.test(raw) && !/autoDeployTrigger:\s*(?!off\b)/.test(raw)
    && /workflow_run:\s*\n\s+workflows:\s*\['ci'\]\s*\n\s+types:\s*\[completed\]\s*\n\s+branches:\s*\[main\]/.test(on)
    && !/^\s+(?:push|pull_request|pull_request_target|schedule):/m.test(on)
    && /github\.event\.workflow_run\.conclusion == 'success' && github\.event\.workflow_run\.head_branch == 'main'/.test(wf)
    && /if: steps\.head\.outputs\.current == 'true'/.test(wf)
    && /if \[ -z "\$RENDER_DEPLOY_HOOK_URL" \]; then[\s\S]{0,200}exit 1\s*\n\s*fi/.test(wf);
}

// R6: security signals are emailed to the operator — by one leased process,
// to a mailbox declared without a value, with de-duplication and a cap.
function securityAlertDelivery() {
  const a = read(cite('src/security/security-alerts.ts')) || '';
  const w = read(cite('src/infra/background-workers.ts')) || '';
  const t = read(cite('src/platform/email/templates/security-alert.ts')) || '';
  const decl = envVars.find((v) => v.name === 'SECURITY_ALERT_EMAIL');
  return /process\.env\.SECURITY_ALERT_EMAIL/.test(a) && /export const DEDUPE_MS = 15 \* 60_000;/.test(a)
    && /export const HOURLY_CAP = \d+;/.test(a) && /send: sendEmail/.test(a)
    && /securityEvent\.groupBy\(/.test(a) && /fabricEventHistory\.groupBy\(/.test(a) && /backupRecord\.count\(/.test(a)
    && /\{ label: 'security-alerts',\s+start: startSecurityAlerts,\s+stop: stopSecurityAlerts \}/.test(w)
    && /alertSubject: 'Familista security alert'/.test(t)
    && !!decl && decl.supply === 'dashboard';
}

const backupCryptoSrc = read(cite('src/security/backup/backup-crypto.ts')) || '';
const backupConfigSrc = read(cite('src/security/backup/backup-config.ts')) || '';
const restoreDrillSrc = read(cite('src/security/backup/restore-drill.ts')) || '';
const backupShellSrc = ['scripts/backup.sh', 'scripts/restore.sh', 'scripts/rollback.sh'].map((f) => read(cite(f)) || '').join('\n');
const phaseORoutesSrc = read(cite('src/routes/phase-o.routes.ts')) || '';
const backupRouteLines = phaseORoutesSrc.split('\n').filter((l) => /^router\.\w+\s*\(\s*'\/monitoring\/backups'/.test(l));

// The automated restore drill: scheduled and on demand, on main only, its keys
// in an environment, never handed a production setting, restoring only into a
// container it made — and its pull-request self-test holds no secret at all.
const restoreDrillWorkflowSrc = read(cite('.github/workflows/restore-drill.yml')) || '';
const restoreDrillCiSrc = read(cite('scripts/restore-drill-ci.js')) || '';
const restoreDrillDockerfileSrc = read(cite('scripts/restore-drill/Dockerfile')) || '';
function restoreDrillAutomated() {
  const w = restoreDrillWorkflowSrc;
  const s = restoreDrillCiSrc;
  // Every image the drill runs is pinned to an immutable digest, and the drill
  // takes its server image from the Dockerfile rather than naming a tag itself.
  const froms = restoreDrillDockerfileSrc.split('\n').filter((l) => /^FROM /.test(l));
  const digestPinned = froms.length === 2 && froms.every((l) => /^FROM [a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}( AS \w+)?\s*$/.test(l))
    && /postgresImageFrom\(/.test(s) && !/'(postgres|node):\d+[\w.-]*'/.test(s);
  const selfTestJob = (w.split(/\n {2}self-test:\n/)[1] || '').split(/\n {2}drill:\n/)[0];
  const drillJob = w.split(/\n {2}drill:\n/)[1] || '';
  return /\n {4}- cron: '[^']+'/.test(w) && /\n {2}workflow_dispatch:/.test(w)
    && /node scripts\/restore-drill-ci\.js --self-test/.test(selfTestJob) && !/secrets\./.test(selfTestJob)
    && /if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/.test(drillJob)
    && /environment: restore-drill/.test(drillJob) && /run: node scripts\/restore-drill-ci\.js\s*$/.test(drillJob)
    && !/DATABASE_URL|DIRECT_URL|RENDER_|BACKUP_TRIGGER_SECRET/.test(w)
    && /const PRODUCTION_SETTINGS = \['DATABASE_URL', 'DIRECT_URL', 'BACKUP_DATABASE_URL'/.test(s)
    && /refuseProductionSettings\(env\);/.test(s) && /proveIsolated\(ctx\.docker, target\.name, ctx\.nonce, ctx\.pgImage\);/.test(s)
    && /assertLoopbackTarget\(url\);/.test(s) && /publishLoopback: false/.test(s)
    && /DRILL_CONFIRM_ISOLATED: 'yes'/.test(s) && /RESTORE DRILL/.test(s)
    && /fs\.writeFileSync\(file, [^\n]*mode: 0o600/.test(s) && digestPinned;
}
controls.push(
  control('backup-encrypted-authenticated',
    /'aes-256-gcm'/.test(backupCryptoSrc) && /'x25519'/.test(backupCryptoSrc) && /setAuthTag/.test(backupCryptoSrc)
      && !/\beval\b|aes-256-cbc|psql "\$\{?DATABASE_URL/.test(backupShellSrc) ? 'PRESENT' : 'ABSENT',
    'src/security/backup/backup-crypto.ts',
    'Backups are encrypted to an offline X25519 public key with chunked AES-256-GCM; the legacy optional CBC / eval / plain-SQL scripts are gone.'),
  control('backup-signed-manifest',
    /export function verifyManifest/.test(backupCryptoSrc) && /verifyManifest\(/.test(restoreDrillSrc) ? 'PRESENT' : 'ABSENT',
    'src/security/backup/restore-drill.ts',
    'Each backup carries an Ed25519-signed manifest (hash, size, key ids, schema head) verified before a restore.'),
  control('backup-runner-cannot-decrypt',
    /BACKUP_ENCRYPTION_PRIVATE_KEY must not be present/.test(backupConfigSrc) ? 'PRESENT' : 'ABSENT',
    'src/security/backup/backup-config.ts',
    'The backup runner refuses to start if the decryption key is in its environment.'),
  control('backup-restore-guarded',
    /NODE_ENV === 'production'/.test(backupConfigSrc) && /DRILL_CONFIRM_ISOLATED/.test(backupConfigSrc)
      && /is a production database/.test(restoreDrillSrc) && /is not empty/.test(restoreDrillSrc) ? 'PRESENT' : 'ABSENT',
    'src/security/backup/restore-drill.ts',
    'A restore never runs in production, never targets a protected database and never writes into a non-empty one.'),
  control('backup-restore-drill-in-ci',
    /tests\/backup-restore-drill\.integration\.test\.ts/.test(ciSrc) && /BACKUP_DRILL_REQUIRED:\s*'1'/.test(ciSrc) ? 'PRESENT' : 'ABSENT',
    '.github/workflows/ci.yml',
    'Every pull request takes a real backup and restores it into an empty PostgreSQL database.'),
  control('backup-restore-drill-automated', restoreDrillAutomated() ? 'PRESENT' : 'ABSENT', '.github/workflows/restore-drill.yml',
    'Every week, and on demand, GitHub Actions restores the newest backup into a throwaway PostgreSQL 18 with no published port and verifies signature, hashes, decryption, schema head and row-level-security rows; it refuses any production setting, runs only digest-pinned images, and pull requests run a secret-free self-test.'),
  control('backup-records-platform-only',
    backupRouteLines.length === 2 && backupRouteLines.every((l) => /requirePlatformAuthority/.test(l) && !/authorize\(/.test(l)) ? 'PRESENT' : 'ABSENT',
    'src/routes/phase-o.routes.ts',
    'Backup records are read and written by platform authority only, never by a club role.'),
  control('backup-scheduled', backupScheduled() ? 'PRESENT' : 'ABSENT', '.github/workflows/backup.yml',
    'GitHub Actions asks the running service daily, over a signed request, to run its fixed backup; the workflow holds only the trigger secret and no database or backup key.'),
  control('backup-trigger-authenticated', backupTriggerProtected() ? 'PRESENT' : 'ABSENT', 'src/security/backup/backup-trigger.ts',
    'The backup trigger takes no input, authenticates by HMAC-SHA256 with a 5-minute window and constant-time comparison, is closed without a secret, runs one backup at a time and none within 12 hours of a success.'),
  control('realtime-session-revocation', realtimeSessionsWatched() ? 'PRESENT' : 'ABSENT', 'src/realtime/session-watch.ts',
    'WebSockets and event streams verify the session exactly as a request does (signature, active user, token version), and every open one is closed when its session ends: at once on an identity change, and on a timer as a backstop.'),
  control('outbound-url-guard', outboundGuardProtected() ? 'PRESENT' : 'ABSENT', 'src/security/outbound-url-guard.ts',
    'A URL a user supplies (a notification webhook) is called only over https to a public address, checked at registration and again at the connection, with no redirects, a time and size limit, and no response body kept.'),
  // R11: every handler's authorization is known, and the ones that ask for no
  // role are a reviewed list; the platform-owner rooms are owner-only, whole.
  control('authz-declared-per-handler',
    authorization.handlers > 0 && authorization.memberUnreviewed.length === 0 && authorization.memberStale.length === 0 ? 'PRESENT' : 'ABSENT',
    'src/cyber-defense/posture-policy.json',
    `${authorization.handlers} handler(s) classified: ${Object.entries(authorization.byKind).map(([k, n]) => `${n} ${k}`).join(', ')}; every member-level handler reviewed by name.`),
  control('owner-rooms-pinned',
    Object.keys(ownerRoomsPolicy).length > 0 && authorization.ownerRoomViolations.length === 0 ? 'PRESENT' : 'ABSENT',
    'src/cyber-defense/posture-policy.json',
    `${Object.keys(ownerRoomsPolicy).length} platform-owner room(s) mounted where pinned, every handler in them owner-only.`),
  control('worker-callback-authenticated', workerCallbackProtected() ? 'PRESENT' : 'ABSENT', 'src/controllers/internal-video.controller.ts',
    'The transcode callback is reachable only outside the API with an HMAC-SHA256 over method, path, timestamp and raw body (5-minute window, constant-time), is closed without a secret, and cannot set a storage key outside the asset\'s own club folder.'),
  control('deploy-gated-by-ci', deployGatedByCi() ? 'PRESENT' : 'ABSENT', '.github/workflows/deploy.yml',
    'Render auto-deploy is off; production is deployed only by the deploy workflow after CI succeeded on main for the commit that is still main\'s head, or by a deliberate manual run, and a deploy that cannot happen fails instead of passing.'),
  control('algorithm-change-gate', algorithmChangeGate() ? 'PRESENT' : 'ABSENT', 'src/algorithms/registry.ts',
    'Every registered algorithm is read/analyze-only and runs only the exact code its recorded human approval names; on the Continuous Intelligence Loop, Deploy is reachable only from Human approval; the Algorithms room is owner-only and has no write handler; the registry is code-owned.'),
  control('algorithm-telemetry-private', algorithmTelemetryPrivate() ? 'PRESENT' : 'ABSENT', 'src/algorithms/telemetry-store.ts',
    'Production telemetry of the registered algorithms is aggregate counts, histograms and times only: its table has no column for a club, team, player, user, request, input or message, the database refuses free text in it, one file writes it, the recorder refuses any workflow outside its closed list, and only the platform owner reads it, read-only — proven on real PostgreSQL in CI.'),
  control('algorithm-learning-separation', algorithmLearningSeparated() ? 'PRESENT' : 'ABSENT', 'src/algorithms/learning.ts',
    'Algorithm learning is synthetic only: every synthetic result is labelled SYNTHETIC and none is presented as real-world accuracy; the real-world lane is disabled, no learning file reads a database, a club record or health data, and synthetic runs never enter production telemetry; a run is bounded by slices and a time budget; only the platform owner reads it, read-only.'),
  control('algorithm-candidate-isolation', algorithmCandidateIsolation() ? 'PRESENT' : 'ABSENT', 'src/algorithms/candidates.ts',
    'Algorithm candidates never run in production: their code and the comparison engine live in lab/, outside the build, and nothing in src/ imports them; each runs only in CI or on a developer machine, in a separate process with an empty environment, a capped heap and output, and a parent-enforced timeout that kills its whole process group; a candidate file imports types only and has no I/O, globals or clock; the server reads only the schema-validated evidence file, where every candidate is experimental and not approved, and none can pass the deployment gate; only the platform owner reads it, read-only.'),
  control('algorithm-release-binding', algorithmReleaseBinding() ? 'PRESENT' : 'ABSENT', 'src/algorithms/release.ts',
    'Every algorithm change approval is bound, link by link, to the evidence it was judged on: a dossier whose digest it records, about its candidate, version, fingerprint and the version it replaced, with an archive for rollback and reproduction; no dossier exists without its approval; the server only reads dossiers, through their schema, and never infers whether a deploy was requested or is live; the release tool writes a promotion only for a named pull request, and CI rehearses a promotion and its exact rollback on every pull request.'),
  control('security-alert-delivery', securityAlertDelivery() ? 'PRESENT' : 'ABSENT', 'src/security/security-alerts.ts',
    'Critical security events, cross-club access attempts, a broken audit chain, account lockouts, refresh-token reuse, brute-force runs and failed or stale backups are emailed to SECURITY_ALERT_EMAIL by one leased process, de-duplicated per rule (15 min) and capped per hour, with a daily digest; the email carries counts only.'),
);

// ── architecture coverage (Cyber Defense R5) ──────────────────────────────────
//
// Nothing may exist outside Cyber Defense. The components below are read from
// the code itself — not from a list somebody keeps — and every one must be
// declared in src/cyber-defense/coverage-map.json against the trust-boundary
// rows that govern it. A component the code has and the map does not, or the
// map has and the code no longer does, fails the posture test.
const builtins = new Set(require('module').builtinModules.flatMap((b) => [b, `node:${b}`]));
const packageOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
const importedPackages = new Set();
for (const src of allSrc) {
  for (const m of src.matchAll(/(?:from\s+|require\(\s*|import\(\s*)'([^'.\/][^']*)'/g)) {
    const pkg = packageOf(m[1]);
    if (!builtins.has(pkg) && !builtins.has(m[1])) importedPackages.add(pkg);
  }
}
const prismaSections = (() => {
  const lines = (read(cite('prisma/schema.prisma')) || '').split('\n');
  const rule = /^\/\/\s*[─═━-]{10,}\s*$/;
  const out = new Set();
  let cur = '(top)';
  for (let i = 0; i < lines.length; i += 1) {
    if (rule.test(lines[i]) && lines[i + 1] && lines[i + 1].startsWith('//') && !rule.test(lines[i + 1])) {
      let j = i + 1; const title = [];
      while (j < lines.length && lines[j].startsWith('//') && !rule.test(lines[j])) { title.push(lines[j].slice(2).trim()); j += 1; }
      if (j < lines.length && rule.test(lines[j])) { cur = title[0] || cur; i = j; continue; }
    }
    if (/^model \w+/.test(lines[i])) out.add(cur);
  }
  return out;
})();
const ownedWorkers = [...(read(cite('src/infra/background-workers.ts')) || '').matchAll(/\{\s*label:\s*'([\w-]+)'/g)].map((m) => m[1]);
const renderServices = [...(read(RENDER) || '').matchAll(/^\s*-\s*(?:type:\s*\w+\s*\n\s*)?name:\s*([\w-]+)\s*$/gm)].map((m) => m[1]);
const infraManifest = (() => { try { return JSON.parse(read('src/infra/generated/infrastructure-manifest.json') || '{}'); } catch (_) { return {}; } })();
const discoveredComponents = {
  routers: mounts.map((x) => x.module),
  srcDomains: fs.readdirSync(path.join(ROOT, 'src'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name),
  prismaSections: [...prismaSections],
  packages: [...importedPackages],
  outboundCallSites: [...outboundCallSites],
  realtimeEndpoints: [...realtimeEndpoints],
  leasedWorkers: ownedWorkers,
  workerFiles: fs.readdirSync(path.join(ROOT, 'src/workers')).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, '')),
  envVars: envVars.map((v) => v.name),
  renderServices,
  workflows: fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)),
  infrastructureComponents: (infraManifest.components || []).map((c) => c.id),
};
for (const k of Object.keys(discoveredComponents)) discoveredComponents[k] = [...new Set(discoveredComponents[k])].sort();

// ── Batch 7: row-level security pilot (R14) ─────────────────────────────────


function migrationFilesSorted() {
  const dir = path.join(ROOT, 'prisma/migrations');
  try {
    return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'migration.sql'))).sort()
      .map((d) => ({ name: d, sql: fs.readFileSync(path.join(dir, d, 'migration.sql'), 'utf8') }));
  } catch (_) { return []; }
}
function rlsPilotTables() { return Array.isArray(posturePolicyForScan.rlsPilotTables) ? posturePolicyForScan.rlsPilotTables : []; }
function rlsTableProtected(t) {
  return new RegExp(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`).test(migrationsSql)
    && new RegExp(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`).test(migrationsSql)
    && new RegExp(`CREATE POLICY "${t}_[A-Za-z_]+" ON "${t}"`).test(migrationsSql)
    && !new RegExp(`ALTER TABLE "${t}" (DISABLE|NO FORCE) ROW LEVEL SECURITY`).test(migrationsSql)
    && !new RegExp(`DROP POLICY[^;]*ON "${t}"`).test(migrationsSql);
}
/** The body of the newest definition of familista_rls_enforced(): 'true', 'false' or null. */
function rlsEnforcedInDatabase() {
  let latest = null;
  for (const m of migrationFilesSorted()) {
    const re = /FUNCTION public\.familista_rls_enforced\(\)[\s\S]*?\$\$\s*SELECT\s+(true|false)\s*\$\$/gi;
    let x; while ((x = re.exec(m.sql))) latest = x[1].toLowerCase();
  }
  return latest;
}
/** DB_RLS_CONTEXT as render.yaml declares it, or null when the blueprint leaves it to the service's own settings. */
function rlsContextInRender() {
  const yaml = read(cite('render.yaml')) || '';
  const m = yaml.match(/- key: DB_RLS_CONTEXT\s*\n\s*value:\s*["']?(\w+)/);
  return m ? m[1] : null;
}
function rlsPilotPresent() {
  const tables = rlsPilotTables();
  const ctxSrc = read(cite('src/security/db-context.ts')) || '';
  const clientSrc = read(cite('src/security/rls-client.ts')) || '';
  const dbSrc = read(cite('src/config/database.ts')) || '';
  const authSrc = read(cite('src/middleware/auth.middleware.ts')) || '';
  const runnerSrc = read(cite('src/security/backup/backup-runner.ts')) || '';
  const bcfgSrc = read(cite('src/security/backup/backup-config.ts')) || '';
  const ci = read('.github/workflows/ci.yml') || '';
  const modelsDeclared = (ctxSrc.match(/RLS_PILOT_MODELS[^=]*=\s*new Set\(\[([^\]]*)\]/) || [, ''])[1]
    .split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean).sort();
  return tables.length > 0 && tables.every(rlsTableProtected)
    && JSON.stringify(modelsDeclared) === JSON.stringify([...tables].sort())
    && /OR current_setting\('familista\.rls_mode', true\) = 'system'/.test(migrationsSql)
    && /NOT public\.familista_rls_enforced\(\)/.test(migrationsSql)
    && rlsEnforcedInDatabase() !== null
    && /set_config\('familista\.rls_mode', \$\{s\.mode\}, true\)/.test(clientSrc)
    && /withRlsContext\(basePrisma, RLS_MODE/.test(dbSrc)
    && /runInClubContext\(ctxUser\.clubId/.test(authSrc) && /runAsSystem\('platform-owner'/.test(authSrc)
    && /'--enable-row-security'/.test(runnerSrc) && /familista\.rls_mode=system/.test(bcfgSrc)
    && /tests\/rls-pilot\.integration\.test\.ts/.test(ci) && /RLS_DB_REQUIRED:\s*'1'/.test(ci);
}
function rlsStatus() {
  const pilot = rlsPilotPresent();
  const db = rlsEnforcedInDatabase();
  const app = rlsContextInRender();
  const tables = rlsPilotTables().join(', ');
  // The repository can prove the database side (the migrations switch
  // enforcement on, guarded). Whether the running service carries its context
  // is a runtime fact — DB_RLS_CONTEXT is set on the service, not here — and
  // the Cybersecurity control plane reads it live, with the database's own
  // switch and catalogue, before it calls the stage PROTECTED. A blueprint
  // that pins the context to anything but 'on' is refused here.
  const guarded = /RAISE EXCEPTION 'R14 enforcement refused/.test(migrationsSql) && /scripts\/rls\/rls-enforcement-off\.sql/.test(read('tests/rls-pilot.integration.test.ts') || '');
  if (pilot && db === 'true' && guarded && (app === null || app === 'on')) {
    return { status: 'PRESENT', note: `Enforced by PostgreSQL on ${tables} (20261006100000_rls_enforce, guarded: every table forced with its policy). The service's DB_RLS_CONTEXT and the database's switch and catalogue are verified live by the Cybersecurity control plane.` };
  }
  if (pilot) {
    return { status: 'PARTIAL', note: `Pilot on ${tables}: policies installed and proven on real PostgreSQL; enforcement in the database is ${db === 'true' ? 'on' : 'off'}${app ? ` and render.yaml pins DB_RLS_CONTEXT to ${app}` : ''}. Other club tables rely on the application.` };
  }
  return { status: 'ABSENT', note: 'Tenancy is enforced in the application only.' };
}
/** Every named system path in the source, and the reviewed list in the policy. */
function rlsSystemPaths() {
  const used = new Set();
  for (const src of allSrc) for (const m of src.matchAll(/runAsSystem\(\s*'([a-z][a-z0-9:-]+)'/g)) used.add(m[1]);
  const reviewed = posturePolicyForScan.rlsSystemPaths || {};
  return {
    used: [...used].sort(),
    unreviewed: [...used].filter((r) => !reviewed[r]).sort(),
    stale: Object.keys(reviewed).filter((r) => !used.has(r)).sort(),
  };
}

controls.push(
  control('db-rls-pilot', rlsPilotPresent() ? 'PRESENT' : 'ABSENT', 'prisma/migrations/20261004100000_rls_pilot/migration.sql',
    `Row-level security policies on ${rlsPilotTables().join(', ')} (forced, fail closed without a context), the request's club carried to PostgreSQL per transaction, backups read under the named system context, all proven on real PostgreSQL in CI. Table list is a ratchet in posture-policy.json.`),
  control('db-rls-system-paths-reviewed',
    (() => { const p = rlsSystemPaths(); return p.used.length > 0 && p.unreviewed.length === 0 && p.stale.length === 0 ? 'PRESENT' : 'ABSENT'; })(),
    'src/cyber-defense/posture-policy.json',
    `${rlsSystemPaths().used.length} named path(s) act across clubs (${rlsSystemPaths().used.join(', ')}); each is reviewed by name.`),
);

// ── Batch 6: platform hygiene (R10, R12, R13) ───────────────────────────────

// R10: every storage write is under its owner's prefix. Both legacy adapters
// guard put and delete, the fabric stores guard put, every writer that knows
// whose object it writes checks the owner, and the unsigned legacy store never
// hands a club object out as a public URL.
function storageKeysOwned() {
  const guard = read(cite('src/security/storage-keys.ts')) || '';
  const local = read(cite('src/lib/storage/storage-local.adapter.ts')) || '';
  const s3 = read(cite('src/lib/storage/storage-s3.adapter.ts')) || '';
  const store = read(cite('src/fabric/media/object-store.ts')) || '';
  const writers = [
    ['src/fabric/media/media-asset.service.ts', /assertClubKey\(/],
    ['src/video/video-asset.service.ts', /assertClubKey\(/],
    ['src/services/video-hls.service.ts', /assertClubKey\(/],
    ['src/services/admin-asset.service.ts', /assertWhiteLabelKey\(/],
  ];
  return /export function assertStorageKey/.test(guard) && /'\.\.'/.test(guard)
    && (local.match(/assertStorageKey\(/g) || []).length >= 2 && /safeResolve/.test(local)
    && (s3.match(/assertStorageKey\(/g) || []).length >= 2
    && (store.match(/assertStorageKey\(args\.key\)/g) || []).length >= 2
    && /clubIdFromKey\(key\)\)\s*\{\s*throw new StorageKeyRefused/.test(store)
    && writers.every(([f, re]) => re.test(read(cite(f)) || ''));
}

// R10: media and Redis have a written recovery decision, and the region-loss
// runbook exists.
function mediaDrDefined() {
  const dr = read(cite('docs/security/disaster-recovery.md')) || '';
  return /## Media: the decision/.test(dr) && /Recovery path: re-upload/.test(dr)
    && /## Redis: why there is no backup/.test(dr) && /## Region loss/.test(dr)
    && /Recovery time objective/.test(dr) && /Recovery point objective/.test(dr);
}

// R10: Redis is reachable on the private network only, through the linked
// URL, and every key this code writes is in a known, secret-free namespace.
const REDIS_NAMESPACES = ['ch', 'edge', 'lease', 'nonce', 'once', 'rl', 'ws-ticket'];
function redisPrivateOnly() {
  const yaml = read(cite('render.yaml')) || '';
  const redisBlock = (yaml.match(/- type: redis[\s\S]*?(?=\n  - type:|\n[a-z]|$)/) || [''])[0];
  const used = new Set();
  for (const src of allSrc) for (const m of src.matchAll(/\brkey\(\s*'([^']+)'/g)) used.add(m[1]);
  const rawKeys = allSrc.some((src) => /\b(client|redis)\.(set|get|setex|hset|lpush|rpush|sadd|incr|expire|publish|del)\(\s*['`]/.test(src));
  return /ipAllowList:\s*\[\]/.test(redisBlock)
    && /- key: REDIS_URL\s+fromService:\s+type: redis/.test(yaml)
    && used.size > 0 && [...used].every((n) => REDIS_NAMESPACES.includes(n)) && !rawKeys;
}

// R12: one redaction format, inside the logger's own format for both
// pipelines, so no transport can skip it.
function logRedaction() {
  const red = read(cite('src/utils/log-redaction.ts')) || '';
  const logger = read(cite('src/utils/logger.ts')) || '';
  return /export const redactFormat/.test(red) && /password/.test(red) && /authori\[sz\]ation/.test(red)
    && /eyJ/.test(red) && /maskEmail/.test(red)
    && /devFormat[\s\S]*?redactFormat\(\)[\s\S]*?colorize/.test(logger)
    && /prodFormat[\s\S]*?redactFormat\(\)[\s\S]*?json\(\)/.test(logger);
}

// R12: mail is never sent in the clear.
function emailTransportTls() {
  const smtp = read(cite('src/platform/email/providers/smtp.ts')) || '';
  return /requireTLS:\s*true/.test(smtp) && /minVersion:\s*'TLSv1\.2'/.test(smtp)
    && /rejectUnauthorized:\s*true/.test(smtp) && !/rejectUnauthorized:\s*false/.test(smtp);
}

// R12: every secret the service is given by hand has a rotation entry.
function secretRotationNames() {
  const yaml = read(cite('render.yaml')) || '';
  return [...yaml.matchAll(/- key:\s*([A-Z0-9_]+)\s*\n\s*sync:\s*false/g)].map((m) => m[1]);
}
function secretRotationRunbook() {
  const doc = read(cite('docs/security/secrets-rotation.md')) || '';
  const table = (doc.split(/^## /m).find((sec) => /^Render environment/.test(sec)) || '');
  const names = secretRotationNames();
  return names.length > 0 && names.every((n) => table.includes(`\`${n}\``));
}

// R13: the vision worker channel is signed both ways with the worker callback
// HMAC; the routes read the raw body; the old static-header check is gone.
function visionChannelSigned() {
  const mw = read(cite('src/middleware/vision-access.middleware.ts')) || '';
  const routes = read(cite('src/routes/vision-engine.routes.ts')) || '';
  const raw = read(cite('src/middleware/raw-body-paths.ts')) || '';
  const app = read(cite(APP)) || '';
  const inf = read(cite('src/services/vision-inference.adapter.ts')) || '';
  const clip = read(cite('src/services/vision-clip.adapter.ts')) || '';
  const webhookLines = routes.split('\n').filter((l) => /requireWebhookAuth\(/.test(l) && !/^\s*\/\//.test(l));
  return /verifyWorkerCallback\(secret/.test(mw) && /express\.raw\(/.test(mw) && /MIN_SECRET_LENGTH/.test(mw)
    && !/req\.headers\[headerName/.test(mw)
    && webhookLines.length === 3 && webhookLines.every((l) => /\.\.\.requireWebhookAuth\('VISION_(CLIP_)?WEBHOOK_TOKEN'\)/.test(l))
    && /vision\\\/webhooks/.test(raw) && /billing\\\/webhook/.test(raw)
    && app.indexOf('app.use(rawBodyForSignedWebhooks());') > 0
    && app.indexOf('app.use(rawBodyForSignedWebhooks());') < app.indexOf('app.use(express.json(')
    && /signedWorkerHeaders\(/.test(inf) && /signedWorkerHeaders\(/.test(clip);
}

// R13: a published way to report a vulnerability.
function securityPolicyPublished() {
  const policy = read(cite('SECURITY.md')) || '';
  return /Report a vulnerability/.test(policy) && /do not open a public issue/i.test(policy)
    && /Acknowledgement/.test(policy) && /Rules for testing/.test(policy);
}

controls.push(
  control('storage-key-club-prefixed', storageKeysOwned() ? 'PRESENT' : 'ABSENT', 'src/security/storage-keys.ts',
    'Every object is written under its owner\'s prefix (club, white-label config or archive); traversal, absolute and unowned keys are refused at every adapter, a writer cannot write under another club, and a club object is never handed out as an unsigned public URL.'),
  control('media-dr-defined', mediaDrDefined() ? 'PRESENT' : 'ABSENT', 'docs/security/disaster-recovery.md',
    'Media, Redis and region loss each have a written recovery decision, with a recovery time and point objective.'),
  control('redis-private-only', redisPrivateOnly() ? 'PRESENT' : 'ABSENT', 'render.yaml',
    `Redis is on the private network only (empty IP allow list, linked URL) and holds nothing persistent: every key is in one of ${REDIS_NAMESPACES.length} namespaces (${REDIS_NAMESPACES.join(', ')}).`),
  control('log-redaction', logRedaction() ? 'PRESENT' : 'ABSENT', 'src/utils/log-redaction.ts',
    'Every log line, dev and prod, passes one format that replaces secrets and personal fields by name and masks tokens, keys, URL credentials and e-mail addresses by shape.'),
  control('email-transport-tls', emailTransportTls() ? 'PRESENT' : 'ABSENT', 'src/platform/email/providers/smtp.ts',
    'SMTP requires TLS on every port (STARTTLS is not optional), verifies the certificate and refuses anything below TLS 1.2.'),
  control('secret-rotation-runbook', secretRotationRunbook() ? 'PRESENT' : 'ABSENT', 'docs/security/secrets-rotation.md',
    `Each of the ${secretRotationNames().length} variables set by hand in Render (sync: false) has an owner, an overlap and a check in the rotation runbook.`),
  control('worker-channel-authenticated', visionChannelSigned() ? 'PRESENT' : 'ABSENT', 'src/middleware/vision-access.middleware.ts',
    'Vision and clip worker callbacks are verified by HMAC-SHA256 over method, path, timestamp and the raw body (5-minute window, 32+ character secret, closed without one); jobs sent to a worker are signed the same way; signed webhooks bypass the global body parsers.'),
  control('security-policy-published', securityPolicyPublished() ? 'PRESENT' : 'ABSENT', 'SECURITY.md',
    'A private vulnerability-reporting channel, response targets and safe-harbour testing rules are published.'),
);

const coverageMap = (() => { try { return JSON.parse(read(cite('src/cyber-defense/coverage-map.json')) || '{}'); } catch (_) { return {}; } })();
const rows = coverageMap.boundaries || {};
const controlStatus = Object.fromEntries(controls.map((c) => [c.id, c.status]));
const { checkCoverage, ratchetHolds } = require('./lib/coverage-check');
const { counts: coverageCounts, ...architectureFindings } = checkCoverage(discoveredComponents, coverageMap, controlStatus, exists);
const ratchet = coverageMap.ratchet || {};
const architecture = {
  components: Object.fromEntries(Object.entries(discoveredComponents).map(([k, v]) => [k, v.length])),
  boundaries: Object.keys(rows).length,
  coverage: coverageCounts,
  ratchet,
  rows: Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, r.coverage])),
  ...architectureFindings,
};
controls.push(
  control('architecture-fully-mapped',
    Object.keys(rows).length > 0 && architectureFindings.unmapped.length === 0 && architectureFindings.stale.length === 0
      && architectureFindings.badRow.length === 0 && architectureFindings.rowProblems.length === 0 ? 'PRESENT' : 'ABSENT',
    'src/cyber-defense/coverage-map.json',
    `${Object.values(discoveredComponents).reduce((n, v) => n + v.length, 0)} discovered component(s) across ${Object.keys(discoveredComponents).length} kinds, each declared against the ${Object.keys(rows).length} trust-boundary rows; a covered row's controls are all present.`),
  control('coverage-ratchet',
    ratchetHolds(coverageCounts, ratchet) ? 'PRESENT' : 'ABSENT',
    'src/cyber-defense/coverage-map.json',
    `${coverageCounts.C} covered, ${coverageCounts.P} partial, ${coverageCounts.U} uncovered; uncovered may not exceed ${ratchet.U}, and partial + uncovered may not exceed ${(ratchet.P || 0) + (ratchet.U || 0)}.`),
);

// ── the manifest ─────────────────────────────────────────────────────────────

const pkg = (() => { try { return JSON.parse(read('package.json') || '{}'); } catch (_) { return {}; } })();
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  generator: 'scripts/security-discover.js',
  platform: { name: pkg.name || null, version: pkg.version || null },
  apiSurface: {
    mountedRouters: mounts.length,
    handlers: handlersTotal,
    publicHandlers: publicRoutes.length,
    publicRoutes,
    appLevelRoutes: appRoutes,
    mounts,
    dormantRouteModules,
    outboundCallSites,
    realtimeEndpoints,
    tenancy,
    authorization,
  },
  architecture,
  controls,
  secrets: {
    declared: envVars.length,
    secretNamed: envVars.filter((v) => v.secretNamed).length,
    secretNamedInline,
    envVars,
  },
  datastores,
  crypto,
  supplyChain,
  evidence: { filesRead: [...evidenceFiles].sort() },
  counts: {
    controlsPresent: controls.filter((c) => c.status === 'PRESENT').length,
    controlsPartial: controls.filter((c) => c.status === 'PARTIAL').length,
    controlsAbsent: controls.filter((c) => c.status === 'ABSENT').length,
    cryptoUses: crypto.length,
  },
};

const serialised = `${JSON.stringify(manifest, null, 2)}\n`;
assertNoSecrets(serialised);

if (PRINT) { process.stdout.write(serialised); process.exit(0); }

if (CHECK) {
  const current = (() => { try { return fs.readFileSync(OUT, 'utf8'); } catch (_) { return null; } })();
  if (!current) {
    console.error('security manifest is missing. Run: node scripts/security-discover.js');
    process.exit(1);
  }
  // `generatedAt` moves on every run and is not a drift signal. Everything else is.
  const strip = (s) => s.replace(/"generatedAt":\s*"[^"]*",?\n/, '');
  if (strip(current) !== strip(serialised)) {
    console.error('security manifest is STALE — the repository\'s security surface changed since it was generated.');
    console.error('Run: node scripts/security-discover.js, review the diff, and update src/cyber-defense/posture-policy.json if the change is intended.');
    process.exit(1);
  }
  console.log(`security manifest is current — ${manifest.apiSurface.handlers} handlers `
    + `(${manifest.apiSurface.publicHandlers} public), ${controls.length} controls, ${crypto.length} crypto uses.`);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, serialised);
console.log('security manifest written → src/cyber-defense/generated/security-manifest.json');
console.log(`  routers ${mounts.length} · handlers ${handlersTotal} · public ${publicRoutes.length} · app-level ${appRoutes.length} · dormant modules ${dormantRouteModules.length}`);
console.log(`  controls present ${manifest.counts.controlsPresent} · partial ${manifest.counts.controlsPartial} · absent ${manifest.counts.controlsAbsent}`);
console.log(`  env vars ${envVars.length} (secret-named ${manifest.secrets.secretNamed}, inline ${secretNamedInline.length}) · crypto uses ${crypto.length}`);
