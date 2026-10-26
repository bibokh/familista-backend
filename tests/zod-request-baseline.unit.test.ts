/**
 * The zod behaviour baseline — security migration zod 3 → 4 (GHSA-mrhx-c7xc-m3w5).
 *
 * tests/zod-baseline/baseline.json records what every top-level schema in src/ answered, on zod 3.25.76, to a fixed
 * corpus of inputs: valid, minimal, and per field missing, null, wrong type, past each bound, malformed formats and
 * unknown keys. Each answer is success and the parsed data, or the issues with their paths and messages, which is what
 * the API returns to a client. This test replays the stored inputs on the zod installed now and requires the same
 * answers, so a change of zod that changes what a request is told fails here, schema by schema.
 *
 * zod 4 answers a few kinds of input differently, and each kind is accepted below with its reason and its count. Every
 * difference the replay finds must be one of them, and the counts are pinned: a difference of any other kind (a value
 * accepted that was refused, other data, another message) or one more of an accepted kind fails.
 *
 * When a schema is changed on purpose, regenerate (`npm run zod:baseline`) and review the baseline's diff with it; a
 * baseline recorded on zod 4 has no zod 3 differences, and the accepted counts below fall to zero with it.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.join(__dirname, '..');
type Row = Record<string, any>;
const BASELINE: Row = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/zod-baseline/baseline.json'), 'utf8'));
const allCases = Object.values(BASELINE.schemas as Record<string, Row[]>).reduce((n, c) => n + c.length, 0);

describe('the zod behaviour baseline', () => {
  it('was recorded on zod 3.25.76 over every module that imports zod, with a passing valid input for every schema', () => {
    expect(BASELINE.zod).toBe('3.25.76');
    expect(BASELINE.modulesThatFailedToLoad).toEqual([]);
    const schemas = Object.entries(BASELINE.schemas as Record<string, Row[]>);
    expect(schemas.length).toBeGreaterThan(450);
    expect(allCases).toBeGreaterThan(15_000);
    const invalid = schemas.filter(([, cases]) => !cases.find((c) => c.name === 'valid:full')?.ok).map(([k]) => k);
    expect(invalid).toEqual([]);
    // Externally reachable request schemas are all in it.
    for (const dir of ['src/controllers/', 'src/utils/', 'src/routes/']) expect([dir, schemas.some(([k]) => k.startsWith(dir))]).toEqual([dir, true]);
  });

  it('answers every stored input as it did — the same success, data, issue paths and messages — but for the accepted zod 4 differences', () => {
    const run = spawnSync(process.execPath, [path.join(ROOT, 'tests/zod-baseline/collect.js')], {
      cwd: ROOT, encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: String(process.env.PATH), HOME: String(process.env.HOME ?? ''), ZOD_BASELINE_ALL: '1' },
    });
    expect(run.status).toBe(0);
    const line = run.stdout.split('\n').filter((l) => l.startsWith('{')).pop() as string;
    const result: Row = JSON.parse(line);
    expect(result.failed).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.compared).toBe(allCases);
    expect(result.diffs).toHaveLength(result.diffCount);
    const kinds: Record<string, number> = {};
    for (const d of result.diffs as Diff[]) kinds[classify(d)] = (kinds[classify(d)] ?? 0) + 1;
    // On a failure, the unexplained differences say which schema, which input, what it answered and what it answers now.
    const unexplained = (result.diffs as Diff[]).filter((d) => classify(d) === 'unexplained').slice(0, 5);
    expect({ kinds, unexplained }).toEqual({ kinds: ACCEPTED_ZOD4_DIFFERENCES, unexplained: [] });
  }, 300_000);
});

// ── the differences zod 4 makes, each accepted for a reason ─────────────────
type Issue = { path: Array<string | number>; message: string };
type Diff = { schema: string; case: string; value?: unknown; want: Row; got: Row };

/**
 * Against the zod 3 baseline. None accepts an input zod 3 refused or changes what a valid input parses to; each either
 * refuses what no column can store or changes only which issues a refused input is told.
 */
const ACCEPTED_ZOD4_DIFFERENCES: Record<string, number> = {
  // zod 4's .int() takes safe integers only. zod 3 accepted 1e21 and 2^53, which no integer column holds and which
  // JavaScript cannot tell from their neighbours; they are now refused as past ±(2^53 − 1). A tightening.
  unsafeIntegerRefused: 166,
  // The same values on a field that also has a range: refused before, now told the safe-integer bound first.
  unsafeIntegerAlsoOutOfRange: 295,
  // A wrong type that has a length (an array for a string, a string for an array) is also told the length bound.
  lengthCheckedAfterTypeFailure: 48,
  // zod 4 stops at a fraction given to .int(), and does not run an object's refinement once one of its fields has
  // failed: refused as before, with the same first issues, without the later ones.
  stopsEarlierOnRejectedInput: 20,
  // An array's own length issue and its elements' issues, the other way round.
  sameIssuesReordered: 1,
};

const SAFE_BOUND = new Set(['Number must be less than or equal to 9007199254740991', 'Number must be greater than or equal to -9007199254740991']);
const issueKey = (i: Issue) => JSON.stringify([i.path, i.message]);
const same = (a: Issue[], b: Issue[]) => JSON.stringify(a.map(issueKey)) === JSON.stringify(b.map(issueKey));
const fieldOf = (c: string) => { const f = c.slice(0, c.lastIndexOf(':')); return f === 'root' ? '' : f; };

function classify(d: Diff): string {
  const want: Issue[] = d.want.issues ?? [];
  const got: Issue[] = d.got.issues ?? [];
  if (d.want.threw || d.got.threw || d.got.ok) return 'unexplained';
  const field = fieldOf(d.case);
  const unsafe = typeof d.value === 'number' && Number.isInteger(d.value) && !Number.isSafeInteger(d.value);
  const safeBound = (i: Issue) => SAFE_BOUND.has(i.message) && i.path.join('.') === field;
  if (unsafe && d.want.ok && got.length === 1 && safeBound(got[0])) return 'unsafeIntegerRefused';
  if (d.want.ok) return 'unexplained';
  if (unsafe && got.some(safeBound) && same(got.filter((i) => !safeBound(i)), want)) return 'unsafeIntegerAlsoOutOfRange';
  const typeFailedAt = new Set(got.filter((i) => /^Expected .+, received \w+$/.test(i.message)).map((i) => i.path.join('.')));
  const lengthAfterType = (i: Issue) => /^(String|Array) must contain /.test(i.message) && typeFailedAt.has(i.path.join('.'));
  if (got.some(lengthAfterType) && same(got.filter((i) => !lengthAfterType(i)), want)) return 'lengthCheckedAfterTypeFailure';
  if (got.length > 0 && got.length < want.length && same(got, want.slice(0, got.length))) return 'stopsEarlierOnRejectedInput';
  if (got.length === want.length && !same(got, want) && same([...got].sort((a, b) => issueKey(a).localeCompare(issueKey(b))), [...want].sort((a, b) => issueKey(a).localeCompare(issueKey(b))))) return 'sameIssuesReordered';
  return 'unexplained';
}

describe('the classification of zod 4 differences', () => {
  const refused = (...issues: Issue[]) => ({ ok: false, issues });
  const at = (p: string, message: string): Issue => ({ path: p ? p.split('.') : [], message });
  it('names each accepted kind', () => {
    expect([
      classify({ schema: 's', case: 'body.n:big', value: 1e21, want: { ok: true, data: {} }, got: refused(at('body.n', 'Number must be less than or equal to 9007199254740991')) }),
      classify({ schema: 's', case: 'n:unsafe-int', value: 2 ** 53, want: refused(at('n', 'Number must be less than or equal to 200')), got: refused(at('n', 'Number must be less than or equal to 9007199254740991'), at('n', 'Number must be less than or equal to 200')) }),
      classify({ schema: 's', case: 'root:array', value: [], want: refused(at('', 'Expected string, received array')), got: refused(at('', 'Expected string, received array'), at('', 'Array must contain at least 1 element(s)')) }),
      classify({ schema: 's', case: 'n:fraction', value: 0.5, want: refused(at('n', 'Expected integer, received float'), at('n', 'Number must be greater than or equal to 8')), got: refused(at('n', 'Expected integer, received float')) }),
      classify({ schema: 's', case: 'a:bad-item', value: [{}], want: refused(at('a', 'x'), at('a.0', 'y')), got: refused(at('a.0', 'y'), at('a', 'x')) }),
    ]).toEqual(['unsafeIntegerRefused', 'unsafeIntegerAlsoOutOfRange', 'lengthCheckedAfterTypeFailure', 'stopsEarlierOnRejectedInput', 'sameIssuesReordered']);
  });

  it('leaves everything else unexplained: a value now accepted, other data, another message, a path, a safe integer refused', () => {
    expect([
      classify({ schema: 's', case: 'n:fraction', value: 0.5, want: refused(at('n', 'Expected integer, received float')), got: { ok: true, data: { n: 0.5 } } }),
      classify({ schema: 's', case: 'valid:full', want: { ok: true, data: { a: 1 } }, got: { ok: true, data: { a: 1, b: 'default' } } }),
      classify({ schema: 's', case: 'a:missing', want: refused(at('a', 'Required')), got: refused(at('a', 'Invalid input: expected string, received undefined')) }),
      classify({ schema: 's', case: 'a:missing', want: refused(at('a', 'Required')), got: refused(at('', 'Required')) }),
      classify({ schema: 's', case: 'n:big', value: 100, want: { ok: true, data: {} }, got: refused(at('n', 'Number must be less than or equal to 9007199254740991')) }),
      classify({ schema: 's', case: 'n:big', value: 1e21, want: { ok: true, data: {} }, got: refused(at('m', 'Number must be less than or equal to 9007199254740991')) }),
      classify({ schema: 's', case: 'a:wrong', value: 1, want: refused(at('a', 'x'), at('a', 'y')), got: refused() }),
    ]).toEqual(Array(7).fill('unexplained'));
  });
});

describe('one zod, imported one way', () => {
  it('nothing imports a version subpath (zod/v3, zod/v4, zod/mini): the migration is not done by a compatibility entry point', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'generated') walk(p); continue; }
        if (!/\.(ts|js|cjs|mjs)$/.test(p)) continue;
        // zod/package.json is the version number, not an entry point.
        if (/(from ['"]|require\(['"])zod\/(?!package\.json)/.test(fs.readFileSync(path.join(ROOT, p), 'utf8'))) offenders.push(p);
      }
    };
    for (const d of ['src', 'lab', 'scripts', 'tests']) walk(d);
    expect(offenders).toEqual([]);
  });

  it('where zod 4 means something else, the code says what zod 3 meant: no bare .partial(), z.nativeEnum() or .uuid()', () => {
    // .partial() fills defaults in zod 4 (partialUpdate does not); z.nativeEnum() loses zod 3's message (nativeEnum
    // keeps it); .uuid() is RFC-strict in zod 4 (.guid() is zod 3's .uuid()). All three live in src/config/zod.ts.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'generated') walk(p); continue; }
        if (!/\.ts$/.test(p) || p === 'src/config/zod.ts') continue;
        const code = fs.readFileSync(path.join(ROOT, p), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
        for (const m of code.match(/\.partial\(\)|z\.nativeEnum\(|\.uuid\(/g) ?? []) offenders.push(`${p}: ${m}`);
      }
    };
    for (const d of ['src', 'lab']) walk(d);
    expect(offenders).toEqual([]);
  });
});
