/**
 * Familista Design Studio: functional acceptance and timing budgets are kept apart in the browser proof, auditably.
 *
 * tools/components/product-design-browser-proof.cjs judges its six timing budgets with `budget(...)`. By default a budget
 * gates like any other check. With PROOF_TIMING=report (CI, where WebGL is rendered in software on a shared runner) it is
 * printed as BUDGET MET / OVER outside the pass/fail count; a budget that was not measured fails in both modes. These
 * tests pin that behaviour, the thresholds, and the CI wiring, so none of them can be loosened without a test saying so.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const ROOT = path.join(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PROOF = read('tools/components/product-design-browser-proof.cjs');
const P16 = read('tools/components/product-design-3d-proof.cjs');
const CI = read('.github/workflows/ci.yml');

/** The proof's own budget helper, run with stubbed reporting, in the given mode. */
function helper(mode: string | undefined) {
  const code = PROOF.slice(PROOF.indexOf("const TIMING = process.env.PROOF_TIMING || 'gate';"), PROOF.indexOf('\n(async () => {'));
  const results: string[] = [], lines: string[] = [];
  const sandbox = {
    process: { env: mode === undefined ? {} : { PROOF_TIMING: mode }, exit: (c: number) => { throw new Error('exit ' + c); } },
    console: { log: (x: string) => lines.push(x), error: (x: string) => lines.push(x) },
    check: (name: string, ok: boolean) => results.push((ok ? 'PASS ' : 'FAIL ') + name),
    fail: (name: string) => results.push('FAIL ' + name),
  };
  const api = vm.runInNewContext(`(function () { ${code}\n return { budget, timings }; })()`, sandbox) as {
    budget: (name: string, values: Record<string, unknown>, ok: boolean, detail?: unknown) => void; timings: string[];
  };
  return { ...api, results, lines };
}

describe('the browser proof keeps timing budgets apart from functional checks', () => {
  it('by default a budget gates: met passes, over fails', () => {
    const h = helper(undefined);
    h.budget('a', { x: 10 }, true);
    h.budget('b', { x: 90 }, false);
    expect(h.results).toEqual(['PASS a', 'FAIL b']);
    expect(h.lines).toEqual([]);
  });

  it('with PROOF_TIMING=report a measured budget is reported MET or OVER and never counted as a pass or a failure', () => {
    const h = helper('report');
    h.budget('a', { x: 10 }, true, { x: 10 });
    h.budget('b', { x: 90 }, false, { x: 90 });
    expect(h.results).toEqual([]);
    expect(h.lines).toEqual(['BUDGET MET a :: {"x":10}', 'BUDGET OVER b :: {"x":90}']);
    expect(h.timings).toEqual(['MET', 'OVER']);
  });

  it.each([undefined, 'gate', 'report'])('a budget that was not measured fails, whatever the mode (%s)', (mode) => {
    const h = helper(mode);
    for (const v of [undefined, null, NaN, Infinity, -1, '60']) h.budget('t', { median: v }, true);
    expect(h.results).toHaveLength(6);
    expect(h.results.every((r) => r === 'FAIL t — not measured: median')).toBe(true);
  });

  it('refuses any other mode instead of guessing', () => {
    expect(() => helper('off')).toThrow('exit 2');
  });

  it('judges exactly six budgets, with the thresholds they always had, and prints the TIMING line after SUMMARY', () => {
    const calls = [...(PROOF + P16).matchAll(/\bbudget\('([^']+)'/g)].map((m) => m[1]);
    expect(calls).toHaveLength(6);
    expect(PROOF).toContain('{ readyMs }, readyMs <= 2500,');
    expect(PROOF).toContain('{ median: m7.editMsMedian }, m7.editMsMedian <= 16,');
    expect(PROOF).toContain('{ median: full.renderMsMedian }, full.renderMsMedian <= 50,');
    expect(P16).toContain('const orbitBudget = Math.min(66.7, perf.desktopFloor.medianMs + 33.3);');
    expect(P16).toContain('perf.pointer.beside.intervalMsMedian <= orbitBudget && perf.pointer.onGarment.intervalMsMedian <= orbitBudget,');
    expect(P16).toContain('perf.desktop.readyMs <= 4000 && perf.desktop.turntableIntervalMsMedian <= Math.min(66.7, perf.desktopFloor.medianMs + 33.3), perf.desktop);');
    expect(P16).toContain('readyMs <= 8000 && perf.mobile.turntableIntervalMsMedian <= Math.min(66.7, perf.mobileFloor.medianMs + 33.3), perf.mobile);');
    // What the split checks asserted besides time is still asserted, as functional checks.
    expect(P16).toContain('perf.pointer.beside.follows && perf.pointer.onGarment.follows && unchanged,');
    expect(P16).toContain("check('P16 phone, CPU slowed 4×: no page error while 3D opens and turns', l5.errors.length === 0,");
    expect(PROOF).toContain("check('P12 twenty keyboard edits in an open room are each committed and repainted', m7.edits - e0 >= 20,");
    const end = PROOF.indexOf('console.log(`SUMMARY');
    expect(end).toBeGreaterThan(0);
    expect(PROOF.indexOf("if (TIMING === 'report') console.log(`TIMING ")).toBeGreaterThan(end);
    expect(PROOF).toContain("process.exit(n('FAIL') ? 1 : 0);");
  });
});

describe('CI runs the Design Studio proof inside the required browser-proof job', () => {
  const job = CI.slice(CI.indexOf('  browser-proof:'), CI.indexOf('  secret-scan:'));
  const code = job.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const step = (name: string) => { const i = code.indexOf('- name: ' + name); expect(i).toBeGreaterThan(0); const j = code.indexOf('\n      - name: ', i + 1); return code.slice(i, j < 0 ? undefined : j); };

  it('on a real PostgreSQL 16, in the isolation shard, with timing report-only set on that one step and nowhere else', () => {
    expect(code).toMatch(/\n {4}services:\n {6}postgres:\n {8}image: postgres:16-alpine\n/);
    const run = step('Design Studio browser proof');
    expect(run).toContain("if: matrix.shard == 'isolation'");
    expect(run).toContain('PRODUCT_DESIGN_DB_DATABASE_URL: postgresql://familista_ci:familista_ci_pw@localhost:5432/postgres');
    expect(run).toContain('PROOF_TIMING: report');
    expect(run).toContain('node tools/components/product-design-browser-proof.cjs "$out" 2>&1 | tee "$RUNNER_TEMP/design-proof.log"');
    expect(CI.match(/PROOF_TIMING/g)).toHaveLength(2);   // the step, and the comment that explains it
  });

  it('gates on every functional check, with a floor so it cannot pass empty', () => {
    const gate = step('The Design Studio proof must have run, in full, with no functional check failed or skipped');
    expect(gate).toContain("grep -Eq ', 0 failed, 0 skipped$'");
    expect(gate).toMatch(/test "\$passed" -ge "\$DESIGN_FLOOR"/);
    expect(Number(/DESIGN_FLOOR: '(\d+)'/.exec(gate)![1])).toBeGreaterThanOrEqual(153);
  });

  it('reports every budget in the job summary, fails if any was not measured, and runs even when the functional gate failed', () => {
    const report = step('Design Studio timing budgets');
    expect(report).toContain("if: always() && matrix.shard == 'isolation' && steps.design.outcome != 'skipped'");
    expect(report).toContain('tee -a "$GITHUB_STEP_SUMMARY"');
    expect(report).toContain('test "$((met + over))" -eq 6');
    expect(code).not.toMatch(/continue-on-error|\|\|\s*true|playwright install|secrets\./);
    expect(code.indexOf('- name: Design Studio browser proof')).toBeLessThan(code.indexOf('- name: Performance budget report'));
  });
});
