/**
 * The zod behaviour baseline — security migration zod 3 → 4 (GHSA-mrhx-c7xc-m3w5).
 *
 * tests/zod-baseline/baseline.json records what every top-level schema in src/ answered, on zod 3.25.76, to a fixed
 * corpus of inputs: valid, minimal, and per field missing, null, wrong type, past each bound, malformed formats and
 * unknown keys. Each answer is success and the parsed data, or the issues with their paths and messages, which is what
 * the API returns to a client. This test replays the stored inputs on the zod installed now and requires the same
 * answers, so a change of zod that changes what a request is told fails here, schema by schema.
 *
 * When a schema is changed on purpose, regenerate (`npm run zod:baseline`) and review the baseline's diff with it.
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

  it('answers every stored input exactly as it did: the same success, data, issue paths and messages', () => {
    const run = spawnSync(process.execPath, [path.join(ROOT, 'tests/zod-baseline/collect.js')], {
      cwd: ROOT, encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: String(process.env.PATH), HOME: String(process.env.HOME ?? '') },
    });
    expect(run.status).toBe(0);
    const line = run.stdout.split('\n').filter((l) => l.startsWith('{')).pop() as string;
    const result: Row = JSON.parse(line);
    expect(result.failed).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.compared).toBe(allCases);
    // On a failure, the first differences say which schema, which input, what it answered and what it answers now.
    expect({ diffCount: result.diffCount, first: result.diffs.slice(0, 5) }).toEqual({ diffCount: 0, first: [] });
  }, 300_000);
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
});
