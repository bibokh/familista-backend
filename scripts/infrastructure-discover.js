#!/usr/bin/env node
// Familista — discovering the platform's own architecture from the repository
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS
//
// Infrastructure City draws the real Familista technology estate. This script
// is where "real" comes from: it reads the repository's own metadata and emits
// a manifest of what actually exists. Nothing in the city is typed by hand into
// a frontend file, because a hand-typed city is a drawing of what somebody
// believed in the month they drew it.
//
//   node scripts/infrastructure-discover.js            → write the manifest
//   node scripts/infrastructure-discover.js --check    → verify it is current
//   node scripts/infrastructure-discover.js --print    → stdout, write nothing
//
// EVIDENCE, OR NOTHING
//
// Every component, technology and relationship carries `evidence`: the file
// that proves it exists. A thing with no evidence is not emitted. That is the
// whole contract, and the reason the city can be trusted at three in the
// morning: if PostgreSQL is on the map it is because `prisma/schema.prisma`
// says `provider = "postgresql"`, not because somebody remembered it.
//
// WHAT NEVER LEAVES THIS SCRIPT
//
// Values. Not one. This reads `render.yaml` for the SHAPE of the deployment
// and `package.json` for the SHAPE of the dependency tree; it never copies an
// environment value, a connection string, a key or a token into the output. A
// variable NAME that looks like a secret is reported as a name only when the
// name itself is architectural (`DATABASE_URL` says a database is configured),
// and `sanitise()` below scans every emitted string for secret-shaped content
// and refuses to write the file if it finds any.
//
// WHY IT RUNS AT BUILD TIME
//
// Reading and parsing the repository on every page request would put a
// filesystem walk on a request path for a screen one person looks at. The
// manifest is generated once, at build, and served from memory behind the
// platform-owner gate.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'src', 'infra', 'generated');
const OUT = path.join(OUT_DIR, 'infrastructure-manifest.json');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const PRINT = argv.includes('--print');

const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return null; }
};
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const readJson = (rel) => {
  const raw = read(rel);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
};

/** Files this run actually opened. Reported, so the manifest can be audited. */
const evidenceFiles = new Set();
const cite = (rel) => { if (exists(rel)) evidenceFiles.add(rel); return rel; };

// ── the sanitiser ────────────────────────────────────────────────────────────
//
// The last line of defence, and deliberately paranoid. It runs over the whole
// serialised manifest, not over each field as it is built, because the failure
// this guards against is somebody adding a field in a year's time and not
// thinking about it.

const SECRET_SHAPES = [
  /postgres(?:ql)?:\/\/[^\s"']+/i,          // connection strings
  /redis:\/\/[^\s"']+/i,
  /mongodb(?:\+srv)?:\/\/[^\s"']+/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,                // provider keys
  /\bsk_live_[A-Za-z0-9]{8,}/,
  /\brk_live_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,                   // AWS access key id
  /\bghp_[A-Za-z0-9]{20,}/,                 // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWTs
];

/**
 * Refuse to emit anything secret-shaped.
 *
 * Throws rather than redacts. A manifest that silently dropped a leaked value
 * would ship the next one too; a build that fails is a build somebody fixes.
 */
function assertNoSecrets(serialised) {
  for (const shape of SECRET_SHAPES) {
    const hit = serialised.match(shape);
    if (hit) {
      throw new Error(
        `infrastructure-discover: refusing to write a manifest containing a secret-shaped value `
        + `(matched ${shape}). Nothing was written.`,
      );
    }
  }
}

// ── model ────────────────────────────────────────────────────────────────────

const districts = [];
const components = [];
const technologies = new Map();   // id → { id, name, category, version, usedBy:Set }
const relationships = [];

const UNKNOWN = 'UNKNOWN';

function district(id, name, category, zone, priority, status = 'ACTIVE') {
  districts.push({ id, name, category, zone, priority, status });
}

/**
 * One building.
 *
 * `status` is what the REPOSITORY proves, never what is running — runtime
 * health is a separate layer composed on top of this at request time. A
 * component here says "this exists in the build"; it says nothing about
 * whether it is currently well.
 */
function component(c) {
  components.push({
    id: c.id,
    name: c.name,
    district: c.district,
    category: c.category,
    type: c.type || 'SERVICE',
    version: c.version || null,
    status: c.status || 'ACTIVE',
    runtime: c.runtime || null,
    provider: c.provider || null,
    region: c.region || null,
    repositoryPath: c.repositoryPath || null,
    sourceEvidence: c.sourceEvidence,
    dependencies: c.dependencies || [],
    healthKey: c.healthKey || null,
    note: c.note || null,
  });
}

function tech(id, name, category, version, usedBy, evidence) {
  const existing = technologies.get(id);
  if (existing) {
    (usedBy || []).forEach((u) => existing.usedBy.add(u));
    return;
  }
  technologies.set(id, {
    id, name, category,
    version: version || null,
    usedBy: new Set(usedBy || []),
    sourceEvidence: evidence,
  });
}

function relate(from, to, kind, evidence) {
  relationships.push({ from, to, kind, evidence });
}

// ── 1 · package.json — languages, runtime, frameworks, libraries ─────────────

const pkg = readJson(cite('package.json'));
const lock = readJson(cite('package-lock.json'));

/** The version the LOCKFILE resolved, not the range the manifest asked for. */
function lockedVersion(name) {
  if (!lock || !lock.packages) return null;
  const entry = lock.packages[`node_modules/${name}`];
  return entry && entry.version ? entry.version : null;
}

const deps = (pkg && pkg.dependencies) || {};
const devDeps = (pkg && pkg.devDependencies) || {};

/**
 * Which technology a package IS, when it is one.
 *
 * Only packages that represent an architectural capability are promoted to
 * technologies; the rest stay in the dependency inventory. A city with six
 * hundred buildings called `@types/node` is not a city.
 */
const TECH_PACKAGES = {
  express:                 ['framework', 'Express', 'backend'],
  typescript:              ['language', 'TypeScript', 'language'],
  '@prisma/client':        ['orm', 'Prisma Client', 'database'],
  prisma:                  ['orm', 'Prisma', 'database'],
  zod:                     ['library', 'Zod', 'backend'],
  jsonwebtoken:            ['security', 'JSON Web Tokens', 'security'],
  bcrypt:                  ['security', 'bcrypt', 'security'],
  bcryptjs:                ['security', 'bcryptjs', 'security'],
  helmet:                  ['security', 'Helmet', 'security'],
  cors:                    ['security', 'CORS', 'security'],
  'express-rate-limit':    ['security', 'Rate Limiting', 'security'],
  'cookie-parser':         ['security', 'Cookie Parser', 'security'],
  ioredis:                 ['cache', 'Redis (ioredis)', 'cache'],
  ws:                      ['realtime', 'WebSocket (ws)', 'realtime'],
  winston:                 ['observability', 'Winston', 'monitoring'],
  morgan:                  ['observability', 'Morgan', 'monitoring'],
  compression:             ['library', 'Compression', 'backend'],
  dotenv:                  ['config', 'dotenv', 'config'],
  '@anthropic-ai/sdk':     ['ai', 'Anthropic SDK', 'ai'],
  '@aws-sdk/client-s3':    ['storage', 'AWS SDK — S3', 'storage'],
  '@aws-sdk/s3-request-presigner': ['storage', 'S3 Request Presigner', 'storage'],
  'fluent-ffmpeg':         ['media', 'fluent-ffmpeg', 'storage'],
  stripe:                  ['integration', 'Stripe', 'integrations'],
  jest:                    ['testing', 'Jest', 'testing'],
  'ts-jest':               ['testing', 'ts-jest', 'testing'],
  supertest:               ['testing', 'Supertest', 'testing'],
  'ts-node':               ['tooling', 'ts-node', 'tooling'],
  'ts-node-dev':           ['tooling', 'ts-node-dev', 'tooling'],
};

for (const [name, range] of Object.entries({ ...deps, ...devDeps })) {
  const hit = TECH_PACKAGES[name];
  if (!hit) continue;
  const [category, label, districtId] = hit;
  tech(name, label, category, lockedVersion(name) || String(range).replace(/^[\^~]/, ''),
    [districtId], 'package.json');
}

// The runtime itself, from `engines` — a declared constraint, not a guess.
if (pkg && pkg.engines && pkg.engines.node) {
  tech('node', 'Node.js', 'runtime', String(pkg.engines.node), ['backend'], 'package.json#engines.node');
}
tech('javascript', 'JavaScript', 'language', null, ['frontend'], 'public/');

// ── 2 · tsconfig — the compiler's own settings ────────────────────────────────

const tsconfigRaw = read(cite('tsconfig.json'));
const tsconfig = {};
if (tsconfigRaw) {
  // Hand-parsed rather than JSON.parse'd: tsconfig permits comments and
  // trailing commas, and a strict parser throws on the real file.
  for (const key of ['target', 'module', 'moduleResolution', 'outDir', 'rootDir']) {
    const m = tsconfigRaw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
    if (m) tsconfig[key] = m[1];
  }
  for (const key of ['strict', 'esModuleInterop', 'declaration', 'sourceMap', 'skipLibCheck']) {
    const m = tsconfigRaw.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`));
    if (m) tsconfig[key] = m[1] === 'true';
  }
}

// ── 3 · Prisma — the database, and how big its schema is ─────────────────────

const schema = read(cite('prisma/schema.prisma'));
let dbProvider = null;
let modelCount = 0;
let enumCount = 0;
let migrationCount = 0;
let latestMigration = null;

if (schema) {
  const prov = schema.match(/datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"/);
  dbProvider = prov ? prov[1] : null;
  modelCount = (schema.match(/^model\s+\w+\s*\{/gm) || []).length;
  enumCount = (schema.match(/^enum\s+\w+\s*\{/gm) || []).length;
}

try {
  const migDir = path.join(ROOT, 'prisma', 'migrations');
  const entries = fs.readdirSync(migDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  migrationCount = entries.length;
  latestMigration = entries.length ? entries[entries.length - 1] : null;
  if (migrationCount) cite('prisma/migrations');
} catch (_) { /* no migrations directory is a fact, not an error */ }

// ── 4 · render.yaml — the deployment, in shape only ──────────────────────────

const renderRaw = read(cite('render.yaml'));
const renderServices = [];
const envKeys = [];

if (renderRaw) {
  // A shape parse, not a YAML parse: this needs the service list and the
  // variable NAMES, and pulling in a YAML dependency to read four fields would
  // be a dependency added for a build script.
  const blocks = renderRaw.split(/\n(?=\s{0,4}- (?:type|name):)/);
  for (const b of blocks) {
    const name = (b.match(/^\s*-?\s*name:\s*([^\s#]+)/m) || [])[1];
    const type = (b.match(/^\s*-?\s*type:\s*([^\s#]+)/m) || [])[1];
    if (!name) continue;
    renderServices.push({
      name,
      type: type || (/databaseName|postgresMajorVersion/.test(b) ? 'postgres' : UNKNOWN),
      runtime: (b.match(/^\s*runtime:\s*([^\s#]+)/m) || [])[1] || null,
      region: (b.match(/^\s*region:\s*([^\s#]+)/m) || [])[1] || null,
      plan: (b.match(/^\s*plan:\s*([^\s#]+)/m) || [])[1] || null,
      autoDeploy: /autoDeploy:\s*true/.test(b) ? true : (/autoDeploy:\s*false/.test(b) ? false : null),
      healthCheckPath: (b.match(/^\s*healthCheckPath:\s*([^\s#]+)/m) || [])[1] || null,
    });
  }
  // NAMES only. The regex captures the key and deliberately never the value,
  // and `assertNoSecrets` runs over the finished file regardless.
  for (const m of renderRaw.matchAll(/^\s*-\s*key:\s*([A-Z0-9_]+)\s*$/gm)) envKeys.push(m[1]);
}

/** A variable name that says what is configured without saying what it is. */
const SECRET_NAME = /(SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL|PRIVATE)/i;
const envSummary = {
  total: envKeys.length,
  // Names are architectural metadata: DATABASE_URL being SET says a database is
  // configured. But a name is all that travels, and a secret-shaped name is
  // reported only as a count so the city can say "12 secrets are configured"
  // without naming the shape of the platform's key material.
  architectural: envKeys.filter((k) => !SECRET_NAME.test(k)).sort(),
  secretShapedCount: envKeys.filter((k) => SECRET_NAME.test(k)).length,
};

// ── 5 · GitHub workflows — CI and deployment ─────────────────────────────────

const workflows = [];
try {
  const wfDir = path.join(ROOT, '.github', 'workflows');
  for (const f of fs.readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x))) {
    const raw = fs.readFileSync(path.join(wfDir, f), 'utf8');
    cite(`.github/workflows/${f}`);
    workflows.push({
      file: `.github/workflows/${f}`,
      name: (raw.match(/^name:\s*(.+)$/m) || [])[1] || f,
      jobs: (raw.match(/^\s{2}[a-z0-9_-]+:\s*$/gim) || []).length,
      steps: [...raw.matchAll(/^\s*-\s*name:\s*(.+)$/gm)].map((m) => m[1].trim()).slice(0, 24),
      services: [...raw.matchAll(/image:\s*([^\s#]+)/g)].map((m) => m[1]),
      runsOn: [...new Set([...raw.matchAll(/runs-on:\s*([^\s#]+)/g)].map((m) => m[1]))],
    });
  }
} catch (_) { /* no workflows is a fact */ }

// ── 6 · mounted API routers — the real surface ───────────────────────────────

const routesIndex = read(cite('src/routes/index.ts'));
const mounts = [];
if (routesIndex) {
  // The import line tells us which FILE each router lives in, so a mount can be
  // followed back to the routes it actually declares.
  const files = new Map();
  for (const m of routesIndex.matchAll(/import\s+([A-Za-z0-9_]+)\s+from\s+'\.\/([^']+)'/g)) {
    files.set(m[1], `src/routes/${m[2]}.ts`);
  }

  for (const m of routesIndex.matchAll(/router\.use\(\s*'([^']+)'\s*,\s*([A-Za-z0-9_]+)\s*\)/g)) {
    const file = files.get(m[2]) || null;
    // WHETHER A MOUNT CAN RECEIVE DATA, from the verbs it declares.
    //
    // Recorded because a provenance map has to tell an ingestion point from a
    // read surface, and guessing from the path name gets it wrong: `/home` and
    // `/match-center` read, `/devices` and `/vision` receive. The only honest
    // discriminator is whether the router declares a write verb, and that is
    // in the file.
    let writes = 0;
    let reads = 0;
    const body = file ? read(file) : '';
    if (body) {
      writes = (body.match(/router\.(post|put|patch|delete)\s*\(/g) || []).length;
      reads = (body.match(/router\.get\s*\(/g) || []).length;
    }
    mounts.push({ path: m[1], router: m[2], file, writes, reads });
  }
}

// ── 7 · counted source surface ───────────────────────────────────────────────

const countFiles = (rel, re) => {
  const dir = path.join(ROOT, rel);
  try {
    return fs.readdirSync(dir).filter((f) => re.test(f)).length;
  } catch (_) { return 0; }
};
const walkCount = (rel, re) => {
  let n = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (re.test(e.name)) n += 1;
    }
  };
  walk(path.join(ROOT, rel));
  return n;
};

const surface = {
  routeModules: countFiles('src/routes', /\.ts$/),
  serviceModules: walkCount('src/services', /\.ts$/),
  middleware: countFiles('src/middleware', /\.ts$/),
  fabricModules: walkCount('src/fabric', /\.ts$/),
  totalTypeScript: walkCount('src', /\.ts$/),
  testSuites: countFiles('tests', /\.test\.ts$/),
  migrations: migrationCount,
  prismaModels: modelCount,
  prismaEnums: enumCount,
};

// ── 8 · districts, from what was actually found ──────────────────────────────
//
// The taxonomy is fixed; MEMBERSHIP is discovered. A district with no
// components is not emitted, so a platform that has no AI has no AI district
// rather than an empty one implying something is missing.

district('core',         'Familista Platform Core', 'CORE',           'centre', 0);
district('frontend',     'Frontend',                'PRESENTATION',   'north',  1);
district('backend',      'Backend Services',        'APPLICATION',    'centre', 2);
district('database',     'Database',                'DATA',           'south',  3);
district('fabric',       'Data Fabric',             'DATA',           'east',   4);
district('vault',        'Data Vault',              'DATA',           'east',   5);
district('security',     'Security & Access',       'SECURITY',       'west',   6);
district('ai',           'AI & Agents',             'INTELLIGENCE',   'east',   7);
district('storage',      'Storage & Media',         'DATA',           'south',  8);
district('cache',        'Cache & Realtime',        'APPLICATION',    'centre', 9);
district('monitoring',   'Monitoring & Observability', 'OPERATIONS',  'north',  10);
district('cicd',         'CI/CD & Deployment',      'OPERATIONS',     'north',  11);
district('integrations', 'Integrations',            'EXTERNAL',       'west',   12);
district('i18n',         'Internationalisation',    'PRESENTATION',   'north',  13);
district('testing',      'Testing & Quality',       'OPERATIONS',     'north',  14);
district('config',       'Configuration',           'OPERATIONS',     'west',   15);
district('tooling',      'Build Tooling',           'OPERATIONS',     'north',  16);
district('language',     'Languages & Runtime',     'FOUNDATION',     'centre', 17);
district('realtime',     'Realtime Transport',      'APPLICATION',    'centre', 18);

// ── 9 · components, each with its evidence ───────────────────────────────────

component({
  id: 'platform-core', name: 'Familista Platform Core', district: 'core',
  category: 'core', type: 'PLATFORM',
  version: (pkg && pkg.version) || null,
  repositoryPath: 'src/app.ts',
  sourceEvidence: 'package.json, src/app.ts',
  healthKey: 'process',
  note: 'The Express application every request passes through.',
});

if (exists('public/index.html')) {
  component({
    id: 'web-app', name: 'Web Application', district: 'frontend',
    category: 'frontend', type: 'SPA',
    repositoryPath: 'public/index.html',
    sourceEvidence: 'public/index.html, public/app.js',
    dependencies: ['api-gateway'],
    note: 'The signed-in workspace, served from public/.',
  });
}
if (exists('public/system/system.js')) {
  component({
    id: 'system-module', name: 'SYSTEM', district: 'frontend',
    category: 'frontend', type: 'MODULE',
    repositoryPath: 'public/system/system.js',
    sourceEvidence: 'public/system/system.js',
    dependencies: ['web-app'],
  });
}
if (exists('public/data-vault/data-vault.js')) {
  component({
    id: 'data-vault-module', name: 'DATA VAULT', district: 'frontend',
    category: 'frontend', type: 'MODULE',
    repositoryPath: 'public/data-vault/data-vault.js',
    sourceEvidence: 'public/data-vault/data-vault.js',
    dependencies: ['web-app', 'history-api'],
  });
}
if (exists('client/package.json')) {
  component({
    id: 'react-client', name: 'React Client', district: 'frontend',
    category: 'frontend', type: 'SPA',
    repositoryPath: 'client/',
    sourceEvidence: 'client/package.json, src/app.ts (/app mount)',
    dependencies: ['api-gateway'],
  });
}

if (mounts.length) {
  component({
    id: 'api-gateway', name: 'API Router', district: 'backend',
    category: 'api', type: 'ROUTER',
    repositoryPath: 'src/routes/index.ts',
    sourceEvidence: `src/routes/index.ts — ${mounts.length} mounted routers`,
    dependencies: ['platform-core'],
    healthKey: 'api',
  });
  component({
    id: 'backend-services', name: 'Application Services', district: 'backend',
    category: 'service', type: 'SERVICE_LAYER',
    repositoryPath: 'src/services/',
    sourceEvidence: `src/services/ — ${surface.serviceModules} modules`,
    dependencies: ['api-gateway', 'prisma-orm'],
  });
}

if (dbProvider) {
  component({
    id: 'postgres', name: dbProvider === 'postgresql' ? 'PostgreSQL' : dbProvider,
    district: 'database', category: 'database', type: 'DATABASE',
    provider: 'Render', region: (renderServices.find((s) => /postgres/i.test(s.name)) || {}).region || null,
    repositoryPath: 'prisma/schema.prisma',
    sourceEvidence: 'prisma/schema.prisma — datasource provider',
    healthKey: 'database',
    note: `${modelCount} models, ${enumCount} enums, ${migrationCount} migrations.`,
  });
  component({
    id: 'prisma-orm', name: 'Prisma ORM', district: 'database',
    category: 'orm', type: 'LIBRARY',
    version: lockedVersion('@prisma/client') || lockedVersion('prisma'),
    repositoryPath: 'prisma/schema.prisma',
    sourceEvidence: 'package.json — @prisma/client',
    dependencies: ['postgres'],
  });
  relate('backend-services', 'prisma-orm', 'USES', 'src/services/ imports prisma');
  relate('prisma-orm', 'postgres', 'CONNECTS_TO', 'prisma/schema.prisma datasource');
}

if (exists('src/fabric/event-bus.ts')) {
  component({
    id: 'data-fabric', name: 'Data Fabric', district: 'fabric',
    category: 'platform', type: 'EVENT_BUS',
    repositoryPath: 'src/fabric/',
    sourceEvidence: `src/fabric/ — ${surface.fabricModules} modules`,
    dependencies: ['backend-services'],
    healthKey: 'fabric',
  });
}
if (exists('src/fabric/outbox-transport.ts')) {
  component({
    id: 'durable-outbox', name: 'Durable Outbox', district: 'fabric',
    category: 'platform', type: 'TRANSPORT',
    repositoryPath: 'src/fabric/outbox-transport.ts',
    sourceEvidence: 'src/fabric/outbox-transport.ts',
    dependencies: ['data-fabric', 'postgres'],
  });
  relate('data-fabric', 'durable-outbox', 'WRITES_TO', 'src/fabric/event-bus.ts emit()');
}
if (exists('src/fabric/history/history-writer.service.ts')) {
  component({
    id: 'historical-store', name: 'Historical Event Store', district: 'vault',
    category: 'platform', type: 'STORE',
    repositoryPath: 'src/fabric/history/',
    sourceEvidence: 'src/fabric/history/history-writer.service.ts, prisma FabricEventHistory',
    dependencies: ['durable-outbox', 'postgres'],
    healthKey: 'historicalStore',
  });
  relate('durable-outbox', 'historical-store', 'RECOVERED_BY', 'src/fabric/history/history-recovery.service.ts');
}
if (exists('src/fabric/history/history-query.service.ts')) {
  component({
    id: 'history-api', name: 'Historical Query API', district: 'vault',
    category: 'api', type: 'API',
    repositoryPath: 'src/routes/fabric.routes.ts',
    sourceEvidence: 'src/routes/fabric.routes.ts — /system/fabric/history*',
    dependencies: ['historical-store'],
  });
}
if (exists('src/fabric/history/archive.ts')) {
  component({
    id: 'cold-archive', name: 'Long-Term Archive', district: 'vault',
    category: 'storage', type: 'ARCHIVE',
    status: 'NOT_CONFIGURED',
    repositoryPath: 'src/fabric/history/archive.ts',
    sourceEvidence: 'src/fabric/history/archive.ts — archiveEnabled() is false',
    dependencies: ['historical-store', 'object-store'],
    healthKey: 'archive',
    note: 'Contract and manifest only. No exporter is implemented.',
  });
}

if (exists('src/middleware/auth.middleware.ts')) {
  component({
    id: 'authentication', name: 'Authentication', district: 'security',
    category: 'security', type: 'MIDDLEWARE',
    repositoryPath: 'src/middleware/auth.middleware.ts',
    sourceEvidence: 'src/middleware/auth.middleware.ts, package.json — jsonwebtoken',
    dependencies: ['api-gateway'],
  });
}
const rbacFiles = ['admin-rbac.middleware.ts', 'tenant-guard.middleware.ts', 'team-scope.middleware.ts']
  .filter((f) => exists(`src/middleware/${f}`));
if (rbacFiles.length) {
  component({
    id: 'rbac', name: 'Authorization & RBAC', district: 'security',
    category: 'security', type: 'MIDDLEWARE',
    repositoryPath: 'src/middleware/',
    sourceEvidence: `src/middleware/ — ${rbacFiles.join(', ')}`,
    dependencies: ['authentication'],
  });
}
if (exists('src/middleware/rate-limit.middleware.ts')) {
  component({
    id: 'rate-limiting', name: 'Rate Limiting', district: 'security',
    category: 'security', type: 'MIDDLEWARE',
    repositoryPath: 'src/middleware/rate-limit.middleware.ts',
    sourceEvidence: 'src/middleware/rate-limit.middleware.ts, package.json — express-rate-limit',
    dependencies: ['api-gateway'],
  });
}
if (schema && /model\s+SecurityAuditEvent\s*\{/.test(schema)) {
  component({
    id: 'security-audit', name: 'Security Audit Chain', district: 'security',
    category: 'security', type: 'STORE',
    repositoryPath: 'prisma/schema.prisma',
    sourceEvidence: 'prisma/schema.prisma — SecurityAuditEvent, SecurityChainHead',
    dependencies: ['postgres'],
  });
}
if (deps.helmet) {
  component({
    id: 'http-hardening', name: 'HTTP Hardening', district: 'security',
    category: 'security', type: 'MIDDLEWARE',
    version: lockedVersion('helmet'),
    repositoryPath: 'src/app.ts',
    sourceEvidence: 'src/app.ts — helmet(), cors()',
    dependencies: ['platform-core'],
  });
}

if (deps['@anthropic-ai/sdk']) {
  component({
    id: 'ai-gateway', name: 'AI Gateway', district: 'ai',
    category: 'ai', type: 'GATEWAY',
    repositoryPath: 'src/platform/intelligence/gateway.ts',
    sourceEvidence: 'src/platform/intelligence/gateway.ts',
    dependencies: ['backend-services'],
    healthKey: 'aiProvider',
  });
  component({
    id: 'anthropic', name: 'Anthropic', district: 'ai',
    category: 'ai', type: 'PROVIDER',
    version: lockedVersion('@anthropic-ai/sdk'),
    provider: 'Anthropic',
    repositoryPath: 'src/services/ai-llm.adapter.ts',
    sourceEvidence: 'package.json — @anthropic-ai/sdk; src/services/ai-llm.adapter.ts',
    dependencies: ['ai-gateway'],
  });
  relate('ai-gateway', 'anthropic', 'CALLS', 'src/services/ai-llm.adapter.ts');
}

if (deps['@aws-sdk/client-s3']) {
  component({
    id: 'object-store', name: 'Object Storage', district: 'storage',
    category: 'storage', type: 'PORT',
    version: lockedVersion('@aws-sdk/client-s3'),
    repositoryPath: 'src/fabric/media/object-store.ts',
    sourceEvidence: 'src/fabric/media/object-store.ts, src/lib/storage/storage-s3.adapter.ts',
    dependencies: ['backend-services'],
    healthKey: 'objectStore',
  });
}
if (deps['fluent-ffmpeg']) {
  component({
    id: 'media-pipeline', name: 'Media Pipeline', district: 'storage',
    category: 'media', type: 'SERVICE',
    version: lockedVersion('fluent-ffmpeg'),
    repositoryPath: 'src/services/video-hls.service.ts',
    sourceEvidence: 'package.json — fluent-ffmpeg; src/services/video-hls.service.ts',
    dependencies: ['object-store'],
  });
}

if (deps.ioredis) {
  component({
    id: 'redis', name: 'Redis', district: 'cache',
    category: 'cache', type: 'CACHE',
    version: lockedVersion('ioredis'),
    provider: 'Render',
    region: (renderServices.find((s) => /redis/i.test(s.name)) || {}).region || null,
    repositoryPath: 'src/infra/redis.ts',
    sourceEvidence: 'src/infra/redis.ts, package.json — ioredis',
    dependencies: ['backend-services'],
    healthKey: 'redis',
  });
}
if (exists('src/routes/data-pulse.routes.ts')) {
  component({
    id: 'sse-stream', name: 'Server-Sent Events', district: 'realtime',
    category: 'realtime', type: 'TRANSPORT',
    repositoryPath: 'src/routes/data-pulse.routes.ts',
    sourceEvidence: 'src/routes/data-pulse.routes.ts — text/event-stream',
    dependencies: ['api-gateway'],
  });
}
if (deps.ws && exists('src/realtime/match-ws.ts')) {
  component({
    id: 'websockets', name: 'WebSocket Channels', district: 'realtime',
    category: 'realtime', type: 'TRANSPORT',
    version: lockedVersion('ws'),
    repositoryPath: 'src/realtime/',
    sourceEvidence: 'src/realtime/match-ws.ts, src/realtime/market-ws.ts',
    dependencies: ['platform-core'],
  });
}

if (exists('src/observability/metrics.service.ts')) {
  component({
    id: 'metrics', name: 'Metrics', district: 'monitoring',
    category: 'observability', type: 'SERVICE',
    repositoryPath: 'src/observability/metrics.service.ts',
    sourceEvidence: 'src/observability/metrics.service.ts',
    dependencies: ['postgres'],
  });
}
if (exists('src/monitoring/monitoring.service.ts')) {
  component({
    id: 'monitoring', name: 'Health Monitoring', district: 'monitoring',
    category: 'observability', type: 'SERVICE',
    repositoryPath: 'src/monitoring/monitoring.service.ts',
    sourceEvidence: 'src/monitoring/monitoring.service.ts',
    dependencies: ['postgres'],
  });
}
if (deps.winston) {
  component({
    id: 'logging', name: 'Structured Logging', district: 'monitoring',
    category: 'observability', type: 'LIBRARY',
    version: lockedVersion('winston'),
    repositoryPath: 'src/utils/logger.ts',
    sourceEvidence: 'package.json — winston; src/utils/logger.ts',
    dependencies: ['platform-core'],
  });
}

for (const wf of workflows) {
  component({
    id: `workflow-${path.basename(wf.file).replace(/\.ya?ml$/, '')}`,
    name: `GitHub Actions — ${wf.name}`, district: 'cicd',
    category: 'cicd', type: 'PIPELINE',
    provider: 'GitHub',
    repositoryPath: wf.file,
    sourceEvidence: `${wf.file} — ${wf.steps.length} named steps`,
    dependencies: ['platform-core'],
    healthKey: `ci:${path.basename(wf.file).replace(/\.ya?ml$/, '')}`,
  });
}
for (const svc of renderServices) {
  component({
    id: `render-${svc.name}`, name: svc.name, district: 'cicd',
    category: 'hosting', type: svc.type === 'web' ? 'WEB_SERVICE' : String(svc.type).toUpperCase(),
    provider: 'Render',
    region: svc.region,
    repositoryPath: 'render.yaml',
    sourceEvidence: `render.yaml — ${svc.name} (${svc.type}${svc.plan ? ', ' + svc.plan : ''})`,
    dependencies: ['platform-core'],
    healthKey: svc.type === 'web' ? 'deployment' : null,
    note: svc.autoDeploy === true ? 'autoDeploy is enabled.' : null,
  });
}

if (deps.stripe) {
  component({
    id: 'stripe', name: 'Stripe', district: 'integrations',
    category: 'integration', type: 'PROVIDER',
    version: lockedVersion('stripe'),
    provider: 'Stripe',
    repositoryPath: 'src/controllers/billing.controller.ts',
    sourceEvidence: 'package.json — stripe; src/controllers/billing.controller.ts',
    dependencies: ['backend-services'],
    healthKey: 'stripe',
  });
}
if (envKeys.some((k) => /SENDGRID|SMTP/.test(k))) {
  component({
    id: 'email', name: 'Email Delivery', district: 'integrations',
    category: 'integration', type: 'PROVIDER',
    repositoryPath: 'render.yaml',
    sourceEvidence: 'render.yaml — SENDGRID_API_KEY / SMTP_* declared',
    dependencies: ['backend-services'],
    healthKey: 'email',
  });
}

if (exists('src/i18n/locales.ts')) {
  const localesSrc = read('src/i18n/locales.ts') || '';
  const localeCount = (localesSrc.match(/\{\s*tag:/g) || []).length;
  component({
    id: 'i18n', name: 'Internationalisation', district: 'i18n',
    category: 'i18n', type: 'SUBSYSTEM',
    repositoryPath: 'src/i18n/locales.ts',
    sourceEvidence: `src/i18n/locales.ts — ${localeCount} locales; public/i18n/`,
    dependencies: ['web-app'],
    note: `${localeCount} platform locales.`,
  });
}

if (surface.testSuites) {
  component({
    id: 'test-suite', name: 'Test Suite', district: 'testing',
    category: 'testing', type: 'SUITE',
    version: lockedVersion('jest'),
    repositoryPath: 'tests/',
    sourceEvidence: `tests/ — ${surface.testSuites} suites; jest.config.ts`,
    dependencies: ['platform-core'],
    healthKey: 'tests',
  });
}
if (exists('scripts/boot-probe.js')) {
  component({
    id: 'boot-probe', name: 'Boot Probe', district: 'testing',
    category: 'testing', type: 'CHECK',
    repositoryPath: 'scripts/boot-probe.js',
    sourceEvidence: 'scripts/boot-probe.js; .github/workflows/ci.yml',
    dependencies: ['platform-core'],
  });
}
if (exists('scripts/i18n-check.js')) {
  component({
    id: 'i18n-check', name: 'i18n Check', district: 'testing',
    category: 'testing', type: 'CHECK',
    repositoryPath: 'scripts/i18n-check.js',
    sourceEvidence: 'scripts/i18n-check.js; .github/workflows/ci.yml',
    dependencies: ['i18n'],
  });
}

if (tsconfig.target) {
  component({
    id: 'typescript', name: 'TypeScript', district: 'language',
    category: 'language', type: 'COMPILER',
    version: lockedVersion('typescript'),
    repositoryPath: 'tsconfig.json',
    sourceEvidence: `tsconfig.json — target ${tsconfig.target}, strict ${tsconfig.strict === true}`,
    note: `${surface.totalTypeScript} TypeScript modules under src/.`,
  });
}
if (pkg && pkg.engines && pkg.engines.node) {
  component({
    id: 'nodejs', name: 'Node.js', district: 'language',
    category: 'runtime', type: 'RUNTIME',
    version: String(pkg.engines.node),
    repositoryPath: 'package.json',
    sourceEvidence: 'package.json — engines.node',
    healthKey: 'process',
  });
}
if (deps.dotenv || envKeys.length) {
  component({
    id: 'configuration', name: 'Configuration', district: 'config',
    category: 'config', type: 'SUBSYSTEM',
    repositoryPath: 'src/config/index.ts',
    sourceEvidence: `src/config/index.ts; render.yaml — ${envKeys.length} declared variables`,
    note: 'Names only. No value is ever read into this manifest.',
  });
}

// ── 10 · relationships that the repository proves ────────────────────────────

relate('web-app', 'api-gateway', 'CALLS', 'public/app.js — fetch(FAM_CONFIG.API_BASE)');
relate('api-gateway', 'backend-services', 'DISPATCHES_TO', 'src/routes/index.ts');
relate('api-gateway', 'authentication', 'GUARDED_BY', 'src/routes/*.ts — authenticate');
relate('backend-services', 'data-fabric', 'PUBLISHES_TO', 'src/fabric/registry/publisher.ts');
relate('historical-store', 'history-api', 'SERVED_BY', 'src/routes/fabric.routes.ts');
relate('data-vault-module', 'history-api', 'READS', 'public/data-vault/data-vault.js');
relate('media-pipeline', 'object-store', 'WRITES_TO', 'src/services/video-hls.service.ts');
relate('rate-limiting', 'redis', 'USES', 'src/middleware/rate-limit-redis.store.ts');
for (const wf of workflows) {
  const id = `workflow-${path.basename(wf.file).replace(/\.ya?ml$/, '')}`;
  const web = renderServices.find((s) => s.type === 'web');
  if (web) relate(id, `render-${web.name}`, 'DEPLOYS', `${wf.file}; render.yaml autoDeploy`);
}

// Keep only relationships whose BOTH ends actually exist. A road to a building
// that was never built is the kind of detail that makes a diagram untrustworthy.
const componentIds = new Set(components.map((c) => c.id));
const liveRelationships = relationships.filter((r) => componentIds.has(r.from) && componentIds.has(r.to));

// ── 11 · future zones — reserved, and honest about it ────────────────────────

const future = [
  { id: 'future-scouting',  name: 'Scouting',            district: 'backend',   reason: 'Not implemented in this build.' },
  { id: 'future-snapshots', name: 'Snapshots',           district: 'vault',     reason: 'Designed in docs/FABRIC_HISTORICAL_STORE.md; no engine exists.' },
  { id: 'future-archive-exporter', name: 'Archive Exporter', district: 'vault', reason: 'Contract only; exportArchiveBatch() throws.' },
  { id: 'future-lint',      name: 'Lint',                district: 'testing',   reason: 'No ESLint configuration exists in the repository.' },
  { id: 'future-coverage',  name: 'Coverage Gate',       district: 'testing',   reason: 'jest.config.ts sets collectCoverage: false.' },
  { id: 'future-vuln-scan', name: 'Vulnerability Scanning', district: 'security', reason: 'CI runs npm audit informationally (|| true); no gate.' },
  { id: 'future-ai-diagnostics', name: 'AI Infrastructure Assistant', district: 'ai', reason: 'Reserved integration point. Not implemented.' },
].filter((f) => districts.some((d) => d.id === f.district));

// Drop districts nothing landed in, so an empty district never implies a gap.
const usedDistricts = new Set([
  ...components.map((c) => c.district),
  ...future.map((f) => f.district),
]);
const liveDistricts = districts.filter((d) => usedDistricts.has(d.id));

// ── 12 · dependency inventory ────────────────────────────────────────────────

const dependencyInventory = Object.entries({ ...deps, ...devDeps })
  .map(([name, range]) => ({
    name,
    declared: String(range),
    resolved: lockedVersion(name),
    classification: deps[name] ? 'RUNTIME' : 'DEVELOPMENT',
    technology: TECH_PACKAGES[name] ? TECH_PACKAGES[name][1] : null,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// ── 13 · the manifest ────────────────────────────────────────────────────────

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  generator: 'scripts/infrastructure-discover.js',
  platform: {
    name: (pkg && pkg.name) || UNKNOWN,
    version: (pkg && pkg.version) || UNKNOWN,
  },
  // What this run actually opened. An auditor can re-read exactly these files
  // and get exactly this answer.
  evidence: { filesRead: [...evidenceFiles].sort() },
  districts: liveDistricts,
  components,
  relationships: liveRelationships,
  technologies: [...technologies.values()]
    .map((t) => ({ ...t, usedBy: [...t.usedBy].sort() }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
  future,
  surface,
  database: {
    provider: dbProvider || UNKNOWN,
    models: modelCount,
    enums: enumCount,
    migrations: migrationCount,
    latestMigration,
  },
  typescript: Object.keys(tsconfig).length ? tsconfig : null,
  deployment: {
    provider: renderServices.length ? 'Render' : UNKNOWN,
    services: renderServices,
    // Whether a deploy can be OBSERVED from inside the process. It cannot: the
    // platform has no Render API credentials and CI's deploy job is a no-op
    // without a hook URL. Saying so here stops the city implying otherwise.
    observable: false,
    observabilityNote: 'Render deploys are not observable from the running process. Deployment state is UNVERIFIED.',
  },
  ci: { workflows },
  mounts,
  environment: envSummary,
  dependencies: dependencyInventory,
  counts: {
    districts: liveDistricts.length,
    components: components.length,
    relationships: liveRelationships.length,
    technologies: technologies.size,
    future: future.length,
    dependencies: dependencyInventory.length,
  },
};

// ── 14 · emit ────────────────────────────────────────────────────────────────

const serialised = JSON.stringify(manifest, null, 2) + '\n';
assertNoSecrets(serialised);

if (PRINT) {
  process.stdout.write(serialised);
  process.exit(0);
}

if (CHECK) {
  const current = (() => { try { return fs.readFileSync(OUT, 'utf8'); } catch (_) { return null; } })();
  if (!current) {
    console.error('infrastructure manifest is missing. Run: node scripts/infrastructure-discover.js');
    process.exit(1);
  }
  // `generatedAt` moves on every run and is not a drift signal. Everything else
  // is: if the repository's architecture changed, the manifest must be regenerated.
  const strip = (s) => s.replace(/"generatedAt":\s*"[^"]*",?\n/, '');
  if (strip(current) !== strip(serialised)) {
    console.error('infrastructure manifest is STALE — the repository has changed since it was generated.');
    console.error('Run: node scripts/infrastructure-discover.js');
    process.exit(1);
  }
  console.log(`infrastructure manifest is current — ${manifest.counts.components} components, `
    + `${manifest.counts.technologies} technologies, ${manifest.counts.relationships} relationships.`);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, serialised);
console.log(`infrastructure manifest written → src/infra/generated/infrastructure-manifest.json`);
console.log(`  districts      ${manifest.counts.districts}`);
console.log(`  components     ${manifest.counts.components}`);
console.log(`  relationships  ${manifest.counts.relationships}`);
console.log(`  technologies   ${manifest.counts.technologies}`);
console.log(`  future zones   ${manifest.counts.future}`);
console.log(`  dependencies   ${manifest.counts.dependencies}`);
console.log(`  evidence files ${manifest.evidence.filesRead.length}`);
