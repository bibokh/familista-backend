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

const ROUTE_RE = /router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]*)\2/g;

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
  const gate = src.search(/router\.use\(\s*authenticate\b/);
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
const jwtVerifySites = [authMwSrc, realtimeSrc].join('\n').match(/jwt\.verify\([^)]*\)/g) || [];
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

const lockoutCallers = callers(srcFiles, /\b(assertNotLocked|recordAttempt)\(/, 'src/security/login-attempt');
const auditChainCallers = allSrc.reduce((n, s) => n + (s.match(/appendAuditEvent(?:Async)?\(/g) || []).length, 0)
  - ((read('src/security/audit-chain.service.ts') || '').match(/appendAuditEvent(?:Async)?\(/g) || []).length;
const securityEventCallers = allSrc.reduce((n, s) => n + (s.match(/\blogSecurityEvent\(/g) || []).length, 0)
  - ((read('src/security/security-event.service.ts') || '').match(/\blogSecurityEvent\(/g) || []).length;
const unsafeRawSql = allSrc.reduce((n, s) => n + (s.match(/\$(?:queryRawUnsafe|executeRawUnsafe)\(/g) || []).length, 0);

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
    /await loginSecondFactor\(user\.id\)[\s\S]*if \(challenge\) return challenge;[\s\S]*issueTokens\(user\)/.test(loginBody)
      && has('src/routes/auth.routes.ts', /router\.post\('\/login\/mfa',\s*ctrl\.loginMfa\)/)
      && has('src/middleware/rate-limit.middleware.ts', /'\/login\/mfa'/)
      ? 'PRESENT' : 'ABSENT', AUTH_SERVICE,
    'An account whose owner switched it on gets no session from the password alone.'),
  // Required for EVERY account is a different, stricter claim. Opt-in per
  // owner is PARTIAL, and says so; nothing here can report it PRESENT.
  control('mfa-required-at-login', /loginSecondFactor\(/.test(loginBody) ? 'PARTIAL' : 'ABSENT', AUTH_SERVICE,
    /loginSecondFactor\(/.test(loginBody)
      ? 'Opt-in: required at sign-in only for an owner who switched it on (mfa-owner-enforcement-at-login).'
      : 'loginUser() issues tokens without asking for a second factor.'),
  control('login-lockout',
    lockoutCallers > 0 ? 'PRESENT' : exists('src/security/login-attempt.service.ts') ? 'PARTIAL' : 'ABSENT',
    cite('src/security/login-attempt.service.ts'),
    `${lockoutCallers} enforcing caller(s) outside the lockout service.`),
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
  // …and the one thing still standing from before it: the legacy raw column and
  // the dual-read fallback that keeps pre-Step-8 sessions alive.
  control('refresh-token-legacy-fallback-removed',
    /tokenHash:\s*null/.test(authServiceSrc) ? 'ABSENT' : 'PRESENT', AUTH_SERVICE,
    'Rows issued before Step 8 keep their raw value until rotated, revoked or expired (7 days at most).'),
  control('jwt-algorithm-pinned', jwtVerifySites.length && jwtVerifySites.every((s) => /algorithms/.test(s)) ? 'PRESENT' : 'ABSENT', AUTH_MW),
  control('jwt-issuer-validated', jwtVerifySites.length && jwtVerifySites.every((s) => /issuer/.test(s)) ? 'PRESENT' : 'ABSENT', AUTH_MW),
  control('websocket-token-outside-url', /searchParams\.get\('token'\)/.test(realtimeSrc) ? 'ABSENT' : 'PRESENT', 'src/realtime/match-ws.ts'),
  control('tenant-guard', /export async function tenantGuard/.test(read(cite('src/middleware/tenant-guard.middleware.ts')) || '') ? 'PRESENT' : 'ABSENT',
    'src/middleware/tenant-guard.middleware.ts'),
  control('device-ingest-hmac', has('src/services/device-auth.service.ts', /timingSafeEqual/) ? 'PRESENT' : 'ABSENT', 'src/services/device-auth.service.ts'),
  control('stripe-webhook-signature', has('src/services/stripe.service.ts', /webhooks\.constructEvent/) ? 'PRESENT' : 'ABSENT', 'src/services/stripe.service.ts'),
  control('versioned-keyring', has('src/fabric/secrets/keyring.ts', /ACTIVE_KEK_ENV/) ? 'PRESENT' : 'ABSENT', 'src/fabric/secrets/keyring.ts'),
  control('audit-hash-chain', auditChainCallers > 0 ? 'PRESENT' : 'ABSENT', cite('src/security/audit-chain.service.ts'),
    `${auditChainCallers} call site(s) append to the chain.`),
  control('security-event-log', securityEventCallers > 0 ? 'PRESENT' : 'ABSENT', cite('src/security/security-event.service.ts'),
    `${securityEventCallers} call site(s) record security events.`),
  control('ai-action-approval-gate', exists('src/security/ai-approval.service.ts') ? 'PRESENT' : 'ABSENT', cite('src/security/ai-approval.service.ts')),
  control('no-unsafe-raw-sql', unsafeRawSql === 0 ? 'PRESENT' : 'ABSENT', 'src/', `${unsafeRawSql} unsafe raw query call(s).`),
  control('db-row-level-security', /ROW LEVEL SECURITY|CREATE POLICY/i.test(migrationsSql) ? 'PRESENT' : 'ABSENT', 'prisma/migrations'),
  control('db-audit-append-only', /REVOKE\s+(UPDATE|DELETE)|CREATE (OR REPLACE )?TRIGGER[\s\S]{0,200}audit/i.test(migrationsSql) ? 'PRESENT' : 'ABSENT', 'prisma/migrations'),
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
const workflowUses = [...`${ciSrc}\n${deploySrc}`.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
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
const workflowSrcs = [ciSrc, deploySrc];
const { expressionInScript: hasExpressionInScript, leastPrivilege } = require('./lib/workflow-checks');
const expressionInScript = workflowSrcs.some(hasExpressionInScript);
controls.push(
  control('ci-least-privilege', leastPrivilege(ciSrc) && leastPrivilege(deploySrc) ? 'PRESENT' : 'ABSENT', '.github/workflows',
    'Every workflow declares permissions: contents: read and grants no write scope.'),
  control('ci-actions-sha-pinned',
    supplyChain.actions > 0 && supplyChain.actionsPinnedBySha === supplyChain.actions ? 'PRESENT' : 'ABSENT', '.github/workflows',
    `${supplyChain.actionsPinnedBySha} of ${supplyChain.actions} action reference(s) pinned to a full commit SHA.`),
  control('ci-audit-blocking', supplyChain.auditBlocksCi && /npm audit --audit-level=(high|critical)/.test(ciSrc) ? 'PRESENT' : 'ABSENT', '.github/workflows/ci.yml',
    'npm audit fails the build on a high or critical advisory.'),
  control('ci-secret-scanning',
    /gitleaks[^\n]* git \.[^\n]*--redact[^\n]*--exit-code 1/.test(ciSrc) && /fetch-depth:\s*0/.test(ciSrc)
      && /sha256sum --check --strict/.test(ciSrc) && !/gitleaks[^\n]*\|\|\s*true/.test(ciSrc) ? 'PRESENT' : 'ABSENT', '.github/workflows/ci.yml',
    `Full-history gitleaks scan, pinned and checksum-verified, blocking; ${gitleaksIgnore.split('\n').filter((l) => /^[0-9a-f]{40}:/.test(l)).length} reviewed fixture(s) baselined.`),
  control('ci-no-expression-injection', expressionInScript ? 'ABSENT' : 'PRESENT', '.github/workflows',
    'No ${{ }} expression is expanded inside a run: script; values reach scripts through env.'),
  control('dependency-updates',
    /package-ecosystem:\s*npm/.test(dependabotSrc) && /package-ecosystem:\s*github-actions/.test(dependabotSrc) ? 'PRESENT' : 'ABSENT', '.github/dependabot.yml',
    'Dependabot proposes npm and GitHub Actions updates as reviewed pull requests.'),
  control('codeowners', supplyChain.codeowners ? 'PRESENT' : 'ABSENT', '.github/CODEOWNERS'),
);

// ── backups (Cyber Defense, Step 10) ─────────────────────────────────────────

// The backup cron job, read from render.yaml's shape: it must exist, run the
// backup on a schedule in the database's region, take the database URL by
// link, take every credential from the dashboard (never a value in git), and
// never declare the decryption key. The bucket's region is stated, and a custom
// (S3-compatible) endpoint, when there is one, is https.
function backupScheduled() {
  const raw = read(RENDER) || '';
  const start = raw.search(/^[ \t]*-[ \t]*type:[ \t]*cron[ \t]*$/m);
  if (start < 0) return false;
  const rest = raw.slice(start);
  const firstNl = rest.indexOf('\n');
  const next = rest.slice(firstNl).search(/\n[ \t]{0,4}-[ \t]*type:|\ndatabases:/);
  const block = next < 0 ? rest : rest.slice(0, firstNl + next);
  const dbRegion = (raw.slice(raw.search(/^databases:/m)).match(/^[ \t]*region:[ \t]*(\S+)/m) || [])[1];
  const region = (block.match(/^[ \t]*region:[ \t]*(\S+)/m) || [])[1];
  const unsynced = (key) => new RegExp(`-[ \\t]*key:[ \\t]*${key}[ \\t]*\\n[ \\t]*sync:[ \\t]*false`).test(block);
  return /^[ \t]*schedule:[ \t]*"?[0-9*/,\- ]+"?[ \t]*$/m.test(block)
    && /^[ \t]*startCommand:.*\bbash scripts\/backup\.sh\b/m.test(block)
    && !!region && region === dbRegion
    && /-[ \t]*key:[ \t]*DATABASE_URL[ \t]*\n[ \t]*fromDatabase:/.test(block)
    && ['BACKUP_ENCRYPTION_PUBLIC_KEY', 'BACKUP_SIGNING_PRIVATE_KEY', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'].every(unsynced)
    && /-[ \t]*key:[ \t]*BACKUP_S3_REGION[ \t]*\n[ \t]*value:[ \t]*\S+/.test(block)
    && (!/-[ \t]*key:[ \t]*BACKUP_S3_ENDPOINT\b/.test(block)
      || /-[ \t]*key:[ \t]*BACKUP_S3_ENDPOINT[ \t]*\n[ \t]*value:[ \t]*https:\/\/\S+/.test(block))
    && !/-[ \t]*key:[ \t]*BACKUP_ENCRYPTION_PRIVATE_KEY\b/.test(raw);
}


const backupCryptoSrc = read(cite('src/security/backup/backup-crypto.ts')) || '';
const backupConfigSrc = read(cite('src/security/backup/backup-config.ts')) || '';
const restoreDrillSrc = read(cite('src/security/backup/restore-drill.ts')) || '';
const backupShellSrc = ['scripts/backup.sh', 'scripts/restore.sh', 'scripts/rollback.sh'].map((f) => read(cite(f)) || '').join('\n');
const phaseORoutesSrc = read(cite('src/routes/phase-o.routes.ts')) || '';
const backupRouteLines = phaseORoutesSrc.split('\n').filter((l) => /^router\.\w+\s*\(\s*'\/monitoring\/backups'/.test(l));
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
  control('backup-records-platform-only',
    backupRouteLines.length === 2 && backupRouteLines.every((l) => /requirePlatformAuthority/.test(l) && !/authorize\(/.test(l)) ? 'PRESENT' : 'ABSENT',
    'src/routes/phase-o.routes.ts',
    'Backup records are read and written by platform authority only, never by a club role.'),
  control('backup-scheduled', backupScheduled() ? 'PRESENT' : 'ABSENT', 'render.yaml',
    'A Render cron job runs the encrypted backup daily, in the database\'s region, with the database linked, every credential unsynced and no decryption key.'),
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
  },
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
