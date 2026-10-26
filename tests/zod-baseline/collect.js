#!/usr/bin/env node
// Zod behaviour baseline — what every schema in src/ answers, recorded so a zod upgrade can be proved to change nothing
// ─────────────────────────────────────────────────────────────────────────────
// Security migration, zod 3 → 4 (GHSA-mrhx-c7xc-m3w5). Loads every module in src/ that imports zod (except the
// response contracts and the evidence readers, which their own suites exercise with real payloads), takes each
// top-level schema by name, and records what it answers to a fixed set of inputs: success and the parsed data, or
// the issues with their paths, codes and messages: what the API hands back to a client.
//
//   node tests/zod-baseline/collect.js --generate   write tests/zod-baseline/baseline.json (inputs built from the
//                                                    schemas as they are now, on the zod they run on now)
//   node tests/zod-baseline/collect.js              replay the stored inputs and print the differences as JSON
//
// The inputs are generated once and stored; a later zod only replays them, so the same input is asked of both.
// No source file is edited: the loader appends an export of each module's top-level names as it compiles it.

'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const BASELINE = path.join(__dirname, 'baseline.json');
const EXCLUDE = [/^src\/contracts\//, /^src\/algorithms\//, /^src\/platform\/agents\/orchestration-evidence\.ts$/];
const MAX_CASES = 80;

for (const [k, v] of Object.entries({
  NODE_ENV: 'test', DATABASE_URL: 'postgresql://baseline:baseline@127.0.0.1:1/baseline', DIRECT_URL: 'postgresql://baseline:baseline@127.0.0.1:1/baseline',
  JWT_ACCESS_SECRET: 'a'.repeat(48), JWT_REFRESH_SECRET: 'b'.repeat(48), JWT_SECRET: 'c'.repeat(48), LOG_LEVEL: 'error',
})) if (!process.env[k]) process.env[k] = v;

const ts = require('typescript');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const { z } = require('zod');
// The server loads zod's message configuration before anything validates; so does this (absent before the migration).
const ZOD_CONFIG = path.join(ROOT, 'src', 'config', 'zod.ts');
if (fs.existsSync(ZOD_CONFIG)) require(ZOD_CONFIG);
const ZOD_VERSION = require('zod/package.json').version;

// ── which modules, and the names each declares at its top level ─────────────
function targets() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) {
        const rel = path.relative(ROOT, p).split(path.sep).join('/');
        if (EXCLUDE.some((x) => x.test(rel))) continue;
        if (/from 'zod'/.test(fs.readFileSync(p, 'utf8'))) out.push(rel);
      }
    }
  })(path.join(ROOT, 'src'));
  return out.sort();
}
function topLevelNames(file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const names = [];
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
  }
  return names;
}
const NAMES = new Map(targets().map((f) => [path.join(ROOT, f), topLevelNames(f)]));
// Optional packages a module imports but this tree does not install (investor-pdf.service.ts: pdfkit, documented as
// optional). The baseline never calls them; a stub lets the module load so its schemas are recorded too.
const OPTIONAL_STUBS = new Set(['pdfkit']);
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (OPTIONAL_STUBS.has(request)) { try { return originalResolve.call(this, request, ...rest); } catch { return path.join(__dirname, 'optional-stub.js'); } }
  return originalResolve.call(this, request, ...rest);
};
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function (code, filename) {
  const names = NAMES.get(filename);
  if (names && names.length) {
    code += `\n;exports.__zodBaseline = {${names.map((n) => `${JSON.stringify(n)}: (typeof ${n} !== 'undefined' ? ${n} : exports[${JSON.stringify(n)}])`).join(',')}};\n`;
  }
  return originalCompile.call(this, code, filename);
};

function loadSchemas() {
  const schemas = new Map();
  const failed = [];
  for (const [abs] of NAMES) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    let mod;
    try { mod = require(abs); } catch (e) { failed.push(`${rel}: ${String(e && e.message).split('\n')[0]}`); continue; }
    const found = (mod && mod.__zodBaseline) || {};
    for (const [name, value] of Object.entries(found)) if (value instanceof z.ZodType) schemas.set(`${rel}#${name}`, value);
  }
  return { schemas, failed };
}

// ── inputs, built from a zod 3 schema (only --generate reads zod internals) ─
const UUID = '3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const REGEX_CANDIDATES = ['2026', '2026-01', '2026-Q1', '10.0.0.0/24', 'coach.example.com', 'abc', 'ABC', 'abc-def', 'a_b', '1', '12', '1-2', 'a.b', '#ffffff', '#fff', '+15551234567', '2026-01-02', '12:30', '03:04:05', '4-3-3', '4-2-3-1', 'AB12', 'ab12cd', 'v1.0', '1.0.0', 'x@y.zz', 'abc123', 'ABC_DEF', 'abc.def@1', 'tactics.opponent-profile@1', 'club.tactical', 'lab-club-north', 'GB', 'EUR', 'en', 'en-GB'];
/**
 * Values a field of this name is given, when its own schema accepts them, so that a refinement across fields (two ids
 * that must differ, an end after a start, percentages that sum to 100, a birth date in the past) holds in the valid
 * input and each mutation then tests one field alone.
 */
const FIELD_SEEDS = {
  toOwnerId: 'b6f0e7c2-3a41-4d5e-9f60-7a8b9c0d1e2f', toInvestorId: 'b6f0e7c2-3a41-4d5e-9f60-7a8b9c0d1e2f',
  endMs: 1000, dateOfBirth: '2005-06-01', crestUrl: 'https://example.org/crest.png', percent: 100, hostname: 'coach.example.com',
};
/** A string schema whose generated value fails its own refinements is given the first of these it accepts. */
const STRING_SEEDS = () => [...Object.values(FIELD_SEEDS).filter((v) => typeof v === 'string'), ...REGEX_CANDIDATES];
const tn = (s) => s && s._def && s._def.typeName;
function unwrap(s) {
  let cur = s;
  for (let i = 0; i < 12 && cur; i++) {
    const t = tn(cur);
    if (t === 'ZodOptional' || t === 'ZodNullable' || t === 'ZodDefault' || t === 'ZodCatch' || t === 'ZodBranded' || t === 'ZodReadonly') cur = cur._def.innerType || cur._def.type;
    else if (t === 'ZodEffects') cur = cur._def.schema;
    else if (t === 'ZodPipeline') cur = cur._def.in;
    else if (t === 'ZodLazy') cur = cur._def.getter();
    else break;
  }
  return cur;
}
const checks = (s, kind) => ((s._def.checks || []).find((c) => c.kind === kind));

function sample(s, depth = 0) {
  if (!s || depth > 8) return null;
  const t = tn(s);
  switch (t) {
    case 'ZodOptional': case 'ZodNullable': case 'ZodDefault': case 'ZodCatch': case 'ZodBranded': case 'ZodReadonly':
      return sample(s._def.innerType || s._def.type, depth + 1);
    case 'ZodEffects': return sample(s._def.schema, depth + 1);
    case 'ZodPipeline': return sample(s._def.in, depth + 1);
    case 'ZodLazy': return sample(s._def.getter(), depth + 1);
    case 'ZodObject': {
      const shape = s._def.shape();
      const o = {};
      for (const k of Object.keys(shape)) {
        const seeded = Object.prototype.hasOwnProperty.call(FIELD_SEEDS, k) && shape[k].safeParse(FIELD_SEEDS[k]).success;
        const v = seeded ? FIELD_SEEDS[k] : sample(shape[k], depth + 1);
        if (v !== undefined) o[k] = v;
      }
      return o;
    }
    case 'ZodString': return sampleString(s);
    case 'ZodNumber': {
      const min = checks(s, 'min'), max = checks(s, 'max'), int = checks(s, 'int');
      // 1 where the range allows it (a refinement often asks for more than 0), else the nearest bound inside it.
      let v = 1;
      if (min && (min.inclusive ? v < min.value : v <= min.value)) v = min.inclusive ? min.value : min.value + (int ? 1 : 0.5);
      if (max && (max.inclusive ? v > max.value : v >= max.value)) v = max.inclusive ? max.value : max.value - (int ? 1 : 0.5);
      if (int) v = Math.ceil(v);
      return s._def.coerce ? String(v) : v;
    }
    case 'ZodBigInt': return '1';
    case 'ZodBoolean': return s._def.coerce ? 'true' : true;
    case 'ZodDate': return '2026-01-02T03:04:05.000Z';
    case 'ZodEnum': return s._def.values[0];
    case 'ZodNativeEnum': { const vals = Object.values(s._def.values).filter((x) => typeof s._def.values[x] !== 'number'); return vals[0]; }
    case 'ZodLiteral': return s._def.value;
    case 'ZodNull': return null;
    case 'ZodUndefined': case 'ZodVoid': return undefined;
    case 'ZodAny': case 'ZodUnknown': return { any: 1 };
    case 'ZodArray': {
      const n = Math.max(1, (s._def.minLength && s._def.minLength.value) || 0, (s._def.exactLength && s._def.exactLength.value) || 0);
      return Array.from({ length: Math.min(n, 20) }, () => sample(s._def.type, depth + 1));
    }
    case 'ZodRecord': {
      const k = unwrap(s._def.keyType);
      const key = tn(k) === 'ZodEnum' ? k._def.values[0] : 'key1';
      return { [key]: sample(s._def.valueType, depth + 1) };
    }
    case 'ZodTuple': return s._def.items.map((i) => sample(i, depth + 1));
    case 'ZodUnion': case 'ZodDiscriminatedUnion': { const opts = s._def.options; return sample(Array.isArray(opts) ? opts[0] : [...opts.values()][0], depth + 1); }
    case 'ZodIntersection': { const a = sample(s._def.left, depth + 1), b = sample(s._def.right, depth + 1); return a && b && typeof a === 'object' && typeof b === 'object' ? { ...a, ...b } : a; }
    case 'ZodMap': case 'ZodSet': return [];
    default: return null;
  }
}
function sampleString(s) {
  const c = (k) => checks(s, k);
  let v = 'abc';
  if (c('uuid')) v = UUID;
  else if (c('email')) v = 'person@example.org';
  else if (c('url')) v = 'https://example.org/x';
  else if (c('datetime')) v = '2026-01-02T03:04:05.000Z';
  else if (c('date')) v = '2026-01-02';
  else if (c('time')) v = '03:04:05';
  else if (c('ip')) v = '10.0.0.1';
  else if (c('cuid')) v = 'cjld2cjxh0000qzrmn831i7rn';
  else if (c('ulid')) v = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  else if (c('regex')) { const re = c('regex').regex; v = REGEX_CANDIDATES.find((x) => { re.lastIndex = 0; return re.test(x); }) || 'abc'; }
  const min = c('min'), max = c('max'), len = c('length');
  if (len) v = v.padEnd(len.value, 'a').slice(0, len.value);
  if (min && v.length < min.value) v = v.padEnd(min.value, 'a');
  if (max && v.length > max.value) v = v.slice(0, max.value);
  return v;
}

/** One mutation set for a field: missing, null, wrong type, its boundaries and formats. */
function mutations(s) {
  const out = [];
  const inner = unwrap(s);
  const t = tn(inner);
  out.push(['missing', undefined], ['null', null]);
  if (t === 'ZodString') {
    out.push(['number', 12345], ['spaces', '  abc  ']);
    const min = checks(inner, 'min'), max = checks(inner, 'max');
    if (min && min.value > 0) out.push(['below-min', 'a'.repeat(min.value - 1)]);
    if (max && max.value <= 5000) out.push(['above-max', 'a'.repeat(max.value + 1)]);
    if (checks(inner, 'uuid')) out.push(['bad-uuid', 'not-a-uuid'], ['nil-like-uuid', '00000000-0000-0000-0000-000000000001'], ['upper-uuid', UUID.toUpperCase()], ['v1-uuid', 'a8098c1a-f86e-11da-bd1a-00112444be1e']);
    if (checks(inner, 'email')) out.push(['bad-email', 'not-an-email'], ['plus-email', 'first.last+tag@sub.example.co.uk'], ['quoted-email', '"a b"@example.org']);
    if (checks(inner, 'url')) out.push(['bad-url', 'notaurl'], ['ftp-url', 'ftp://example.org/x'], ['mailto-url', 'mailto:a@b.co']);
    if (checks(inner, 'datetime')) out.push(['bad-datetime', '2026-13-45'], ['offset-datetime', '2026-01-02T03:04:05+02:00'], ['no-ms-datetime', '2026-01-02T03:04:05Z']);
    if (checks(inner, 'regex')) out.push(['regex-miss', '!!!']);
  } else if (t === 'ZodNumber') {
    out.push(['string', inner._def.coerce ? 'abc' : '12'], ['big', 1e21]);
    const min = checks(inner, 'min'), max = checks(inner, 'max');
    if (min) out.push(['below-min', min.value - 1]);
    if (max) out.push(['above-max', max.value + 1]);
    if (checks(inner, 'int')) out.push(['fraction', 1.5], ['unsafe-int', 9007199254740993]);
  } else if (t === 'ZodBoolean') out.push(['string', 'yes'], ['zero', 0]);
  else if (t === 'ZodEnum' || t === 'ZodNativeEnum') out.push(['unknown-value', 'NOT_A_VALUE'], ['number', 3]);
  else if (t === 'ZodLiteral') out.push(['other', 'other-literal']);
  else if (t === 'ZodArray') {
    out.push(['string', 'x'], ['empty', []], ['bad-item', [{ bad: true }, 12345]]);
    const max = inner._def.maxLength;
    if (max && max.value <= 100) out.push(['above-max', Array.from({ length: max.value + 1 }, () => sample(inner._def.type))]);
  } else if (t === 'ZodObject' || t === 'ZodRecord') out.push(['string', 'x'], ['array', []]);
  else if (t === 'ZodDate') out.push(['bad-date', 'not-a-date'], ['number', 1700000000000]);
  return out;
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function setAt(root, p, value) {
  const copy = clone(root);
  let cur = copy;
  for (let i = 0; i < p.length - 1; i++) { if (cur == null || typeof cur !== 'object') return null; cur = cur[p[i]]; }
  if (cur == null || typeof cur !== 'object') return null;
  if (value === undefined) delete cur[p[p.length - 1]]; else cur[p[p.length - 1]] = clone(value);
  return copy;
}
/** Every field path below an object schema, with its schema, to depth 5. */
function fields(s, base = [], depth = 0, out = []) {
  const inner = unwrap(s);
  if (!inner || depth > 5) return out;
  if (tn(inner) === 'ZodObject') {
    const shape = inner._def.shape();
    for (const k of Object.keys(shape)) { out.push({ path: [...base, k], schema: shape[k], parent: inner }); fields(shape[k], [...base, k], depth + 1, out); }
  } else if (tn(inner) === 'ZodArray') fields(inner._def.type, [...base, 0], depth + 1, out);
  return out;
}
function minimal(s, depth = 0) {
  const inner = unwrap(s);
  if (!inner || depth > 8) return sample(s);
  if (tn(inner) !== 'ZodObject') return sample(s);
  const shape = inner._def.shape();
  const o = {};
  for (const k of Object.keys(shape)) {
    const f = shape[k];
    if (f.isOptional()) continue;
    o[k] = minimal(f, depth + 1);
  }
  return o;
}
/** Cases as stored: a root case holds its input; a field case holds a path and value against valid:full. */
function validFull(schema) {
  const full = sample(schema);
  if (typeof full !== 'string' || schema.safeParse(full).success) return full;
  return STRING_SEEDS().find((v) => schema.safeParse(v).success) ?? full;
}
function corpus(schema) {
  const cases = [];
  const add = (name, input, at, value) => {
    if (cases.length >= MAX_CASES || cases.some((c) => c.name === name)) return;
    cases.push(at ? { name, input, at, value } : { name, input });
  };
  const full = validFull(schema);
  add('root:undefined', undefined); add('root:null', null); add('root:string', 'x'); add('root:empty-object', {}); add('root:array', []);
  add('valid:full', full); add('valid:minimal', minimal(schema));
  if (full && typeof full === 'object' && !Array.isArray(full)) {
    for (const f of fields(schema)) {
      for (const [kind, value] of mutations(f.schema)) {
        const input = setAt(full, f.path, value);
        if (input !== null) add(`${f.path.join('.')}:${kind}`, input, f.path, value);
      }
      const p = unwrap(f.parent);
      if (tn(p) === 'ZodObject' && f.path.length && f === fields(schema).find((x) => x.parent === f.parent)) {
        const parentPath = f.path.slice(0, -1);
        const obj = parentPath.length ? parentPath.reduce((o, k) => (o == null ? o : o[k]), full) : full;
        if (obj && typeof obj === 'object') add(`${parentPath.join('.') || 'root'}:unknown-key`, setAt(full, [...parentPath, '__unknownKey'], 'x'), [...parentPath, '__unknownKey'], 'x');
      }
    }
  }
  return cases;
}

// ── what a schema answers ───────────────────────────────────────────────────
function canonical(v) {
  if (v instanceof Date) return { $date: Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString() };
  if (typeof v === 'bigint') return { $bigint: v.toString() };
  if (v instanceof Map) return { $map: [...v.entries()].map(([k, x]) => [canonical(k), canonical(x)]) };
  if (v instanceof Set) return { $set: [...v].map(canonical) };
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? { $undefined: true } : canonical(x)));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = canonical(v[k]); return o; }
  if (typeof v === 'number' && !Number.isFinite(v)) return { $number: String(v) };
  return v;
}
async function answer(schema, input) {
  let r;
  try { r = schema.safeParse(input); } catch (e) {
    if (/async/i.test(String(e && e.message))) r = await schema.safeParseAsync(input);
    else return { threw: String(e && e.message).split('\n')[0].slice(0, 200) };
  }
  if (r.success) return { ok: true, data: canonical(r.data) };
  return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)), code: i.code, message: i.message })) };
}
const enc = (v) => (v === undefined ? { $undefined: true } : v);
const dec = (v) => (v && typeof v === 'object' && !Array.isArray(v) && v.$undefined === true && Object.keys(v).length === 1 ? undefined : v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** What the API exposes: success, the parsed data, and each issue's path and message (codes are zod-internal). */
const visible = (r) => (r.threw ? { threw: r.threw } : r.ok ? { ok: true, data: r.data } : { ok: false, issues: r.issues.map((i) => ({ path: i.path, message: i.message })) });

/** One JSON line on stdout, flushed before the process exits (a pipe would otherwise lose its tail). */
const emit = (value) => new Promise((resolve) => process.stdout.write(`${JSON.stringify(value)}\n`, resolve));

async function main() {
  const generate = process.argv.includes('--generate');
  const { schemas, failed } = loadSchemas();
  if (generate) {
    const out = { zod: ZOD_VERSION, note: 'Generated on the zod named above; replayed on every later zod. Regenerate only in a reviewed change.', modulesThatFailedToLoad: failed, schemas: {} };
    for (const [key, schema] of [...schemas.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const cases = [];
      let full;
      for (const c of corpus(schema)) {
        if (c.name === 'valid:full') full = c.input;
        const first = await answer(schema, c.input);
        const second = await answer(schema, c.input);
        const stable = same(first, second);
        const stored = c.at ? { name: c.name, at: c.at, value: enc(c.value) } : { name: c.name, input: enc(c.input) };
        const result = stable ? first : { unstable: true, ok: first.ok, issues: first.issues, threw: first.threw };
        // Parsed data equal to the input it came from is stored as such, not twice.
        if (result.ok && result.data !== undefined && same(result.data, canonical(c.input))) { delete result.data; result.dataIsInput = true; }
        cases.push({ ...stored, ...result });
      }
      out.schemas[key] = cases;
    }
    fs.writeFileSync(BASELINE, `${JSON.stringify(out)}\n`);
    const n = Object.values(out.schemas).reduce((a, c) => a + c.length, 0);
    await emit({ wrote: path.relative(ROOT, BASELINE), zod: ZOD_VERSION, schemas: Object.keys(out.schemas).length, cases: n, failed });
    return;
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const diffs = [];
  const missing = Object.keys(base.schemas).filter((k) => !schemas.has(k));
  const unbaselined = [...schemas.keys()].filter((k) => !base.schemas[k]);
  let compared = 0;
  for (const [key, cases] of Object.entries(base.schemas)) {
    const schema = schemas.get(key);
    if (!schema) continue;
    const fullCase = cases.find((x) => x.name === 'valid:full');
    for (const c of cases) {
      const input = c.at ? setAt(dec(fullCase.input), c.at, dec(c.value)) : dec(c.input);
      if (c.dataIsInput) c.data = canonical(input);
      const now = await answer(schema, input);
      compared += 1;
      const want = c.unstable ? (c.threw ? { threw: c.threw } : c.ok ? { ok: true } : { ok: false, issues: c.issues.map((i) => ({ path: i.path, message: i.message })) }) : visible(c);
      const got = c.unstable ? (now.threw ? { threw: now.threw } : now.ok ? { ok: true } : visible(now)) : visible(now);
      if (!same(want, got)) diffs.push({ schema: key, case: c.name, value: c.at ? dec(c.value) : input, want, got, codes: { was: (c.issues || []).map((i) => i.code), now: (now.issues || []).map((i) => i.code) } });
    }
  }
  await emit({ zod: ZOD_VERSION, baselineZod: base.zod, schemas: schemas.size, compared, missing, unbaselined, failed, diffCount: diffs.length, diffs: process.env.ZOD_BASELINE_ALL ? diffs : diffs.slice(0, 400) });
}

main().then(() => process.exit(0), (e) => { process.stderr.write(`${e && e.stack}\n`); process.exit(2); });
