/**
 * The dependency audit gate (scripts/npm-audit-gate.js) and its one exception.
 *
 * The gate replaces a bare `npm audit --audit-level=high` in CI. It must block exactly what that did, except one
 * reviewed advisory, and fail closed on anything it cannot read or does not recognise. Each rule below is shown
 * holding and, from the same inputs with one thing changed, failing.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gate = require('../scripts/npm-audit-gate.js');
const ROOT = path.join(__dirname, '..');
type Row = Record<string, any>;

const POLICY: Row = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/security/npm-audit-exceptions.json'), 'utf8'));
const BEFORE = Date.parse('2026-10-26T00:00:00Z');
const LOCK = { packages: { 'node_modules/zod': { version: '3.25.76' }, 'node_modules/body-parser': { version: '1.20.9' }, 'node_modules/left-pad': { version: '1.0.0' } } };

const advisory = (name: string, ghsa: string, severity: string, range: string, title = 't') =>
  ({ source: 1, name, dependency: name, title, url: `https://github.com/advisories/${ghsa}`, severity, cwe: [], cvss: { score: 7.5 }, range });
/** A version-2 report whose counts agree with its entries, as npm prints it. */
function report(...entries: Array<{ name: string; severity: string; via: unknown[] }>): Row {
  const counts: Row = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const vulnerabilities: Row = {};
  for (const e of entries) { vulnerabilities[e.name] = { name: e.name, severity: e.severity, isDirect: true, via: e.via, effects: [], range: '*', nodes: [`node_modules/${e.name}`], fixAvailable: false }; counts[e.severity] += 1; }
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { ...counts, total: entries.length }, dependencies: {} } };
}
const ZOD = { name: 'zod', severity: 'high', via: [advisory('zod', 'GHSA-mrhx-c7xc-m3w5', 'high', '<4.6.6')] };
const BODY_PARSER = { name: 'body-parser', severity: 'high', via: [advisory('body-parser', 'GHSA-27r3-jxmh-p828', 'high', '<1.20.9')] };
const run = (r: unknown, over: Row = {}) => gate.evaluate({ report: r, policy: POLICY, lockfile: LOCK, now: BEFORE, ...over });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('the committed exception', () => {
  it('is one exception, for GHSA-mrhx-c7xc-m3w5 in zod 3.25.76 (<4.6.6, high), expiring 2026-11-01, with its full record', () => {
    expect(POLICY.exceptions).toHaveLength(1);
    const e = POLICY.exceptions[0];
    expect(e).toMatchObject({ id: 'GHSA-mrhx-c7xc-m3w5', cve: 'CVE-2023-54404', package: 'zod', severity: 'high', vulnerableRange: '<4.6.6', installedVersion: '3.25.76', expires: '2026-11-01T00:00:00Z' });
    expect(gate.readPolicy(POLICY).problems).toEqual([]);
    for (const k of ['owner', 'approvedBy', 'justification', 'remediationPlan']) expect(e[k].length).toBeGreaterThan(10);
    // Each compensating control it names exists in the repository.
    for (const c of e.compensatingControls.join(' ').match(/(src|tests|docs)\/[\w./-]+\.(ts|md|json)/g)) expect([c, fs.existsSync(path.join(ROOT, c))]).toEqual([c, true]);
  });

  it('names the version package-lock.json installs', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    expect(lock.packages['node_modules/zod'].version).toBe(POLICY.exceptions[0].installedVersion);
  });
});

describe('what it blocks, and the one thing it lets through', () => {
  it('passes the zod advisory alone, while the exception holds', () => {
    const v = run(report(ZOD));
    expect(v).toMatchObject({ ok: true, failures: [] });
    expect(v.excepted.map((a: Row) => a.id)).toEqual(['GHSA-mrhx-c7xc-m3w5']);
  });

  it('negative: every other HIGH or CRITICAL advisory still fails the build, beside the excepted one', () => {
    const bp = run(report(ZOD, BODY_PARSER));
    expect(bp.ok).toBe(false);
    expect(bp.failures).toEqual([expect.stringMatching(/^HIGH GHSA-27r3-jxmh-p828 in body-parser/)]);
    const crit = run(report(ZOD, { name: 'left-pad', severity: 'critical', via: [advisory('left-pad', 'GHSA-2222-3333-4444', 'critical', '<2.0.0')] }));
    expect(crit.failures).toEqual([expect.stringMatching(/^CRITICAL GHSA-2222-3333-4444/)]);
  });

  it('a package vulnerable only through zod is judged by zod\'s advisory; through body-parser, by body-parser\'s', () => {
    expect(run(report(ZOD, { name: 'zod-lib', severity: 'high', via: ['zod'] })).ok).toBe(true);
    const v = run(report(ZOD, BODY_PARSER, { name: 'express', severity: 'high', via: ['body-parser'] }));
    expect(v.failures).toEqual([expect.stringMatching(/^HIGH GHSA-27r3-jxmh-p828 in body-parser/)]);
  });

  it('moderate and low are reported, not blocking, as before', () => {
    const v = run(report(ZOD, { name: 'left-pad', severity: 'moderate', via: [advisory('left-pad', 'GHSA-2222-3333-4444', 'moderate', '<2.0.0')] }));
    expect(v.ok).toBe(true);
    expect(v.informational.map((a: Row) => a.id)).toEqual(['GHSA-2222-3333-4444']);
  });

  it('negative: the exception stops matching the moment the advisory or the install changes', () => {
    const critical = clone(ZOD); critical.severity = 'critical'; (critical.via[0] as Row).severity = 'critical';
    const widened = clone(ZOD); (widened.via[0] as Row).range = '<4.7.0';
    const elsewhere = { name: 'left-pad', severity: 'high', via: [advisory('left-pad', 'GHSA-mrhx-c7xc-m3w5', 'high', '<4.6.6')] };
    const cases: Array<[string, Row, Row]> = [
      ['escalated to critical', report(critical), {}],
      ['range changed', report(widened), {}],
      ['another package', report(elsewhere, ZOD), {}],
      ['another installed version', report(ZOD), { lockfile: { packages: { 'node_modules/zod': { version: '3.25.77' } } } }],
      ['no lockfile', report(ZOD), { lockfile: null }],
    ];
    for (const [name, r, over] of cases) {
      const v = run(r, over);
      expect([name, v.ok, v.failures.some((f: string) => /no longer matches its exception|GHSA-mrhx-c7xc-m3w5/.test(f))]).toEqual([name, false, true]);
    }
  });
});

describe('it expires, and it does not outlive its advisory', () => {
  it('holds until 2026-11-01T00:00:00Z and fails CI from that instant', () => {
    expect(run(report(ZOD), { now: Date.parse('2026-10-31T23:59:59Z') }).ok).toBe(true);
    const v = run(report(ZOD), { now: Date.parse('2026-11-01T00:00:00Z') });
    expect(v.ok).toBe(false);
    expect(v.failures).toEqual([expect.stringMatching(/GHSA-mrhx-c7xc-m3w5: its exception expired on 2026-11-01T00:00:00Z/)]);
  });

  it('negative: an expired exception fails even when the advisory is gone, and a stale one must be removed', () => {
    expect(run(report(), { now: Date.parse('2026-11-02T00:00:00Z') }).failures).toEqual([expect.stringMatching(/expired on .*; remove it/)]);
    expect(run(report()).failures).toEqual([expect.stringMatching(/matches no advisory in this audit .*remove it/)]);
  });
});

describe('it fails closed', () => {
  it('negative: no report, not JSON, an npm error, another format, or counts that disagree with the entries', () => {
    const inconsistent = report(ZOD); inconsistent.metadata.vulnerabilities.high = 2;
    const noUrl = report({ name: 'zod', severity: 'high', via: [{ ...advisory('zod', 'x', 'high', '<4.6.6'), url: 'https://example.invalid/x' }] });
    const cases: Array<[string, unknown]> = [
      ['null', null], ['empty object', {}], ['npm error', { error: { code: 'ENOTFOUND', summary: 'registry unreachable' } }],
      ['version 1', { ...report(ZOD), auditReportVersion: 1 }], ['inconsistent counts', inconsistent], ['advisory with no GHSA id', noUrl],
      ['high only through a package the report omits', report(ZOD, { name: 'express', severity: 'high', via: ['body-parser'] })],
      ['entry with an unknown severity',{ ...report(), vulnerabilities: { zod: { severity: 'severe', via: [] } }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }],
    ];
    for (const [name, r] of cases) expect([name, run(r).ok]).toEqual([name, false]);
  });

  it('negative: an exception policy that is not whole excepts nothing at all', () => {
    const e = POLICY.exceptions[0];
    const cases: Array<[string, Row]> = [
      ['no owner', { exceptions: [{ ...e, owner: '' }] }],
      ['no compensating controls', { exceptions: [{ ...e, compensatingControls: [] }] }],
      ['not a GHSA id', { exceptions: [{ ...e, id: 'CVE-2023-54404' }] }],
      ['listed twice', { exceptions: [e, e] }],
      ['longer than 31 days', { exceptions: [{ ...e, expires: '2026-12-31T00:00:00Z' }] }],
      ['expires before approval', { exceptions: [{ ...e, expires: '2026-10-01T00:00:00Z' }] }],
      ['not a date', { exceptions: [{ ...e, expires: 'soon' }] }],
      ['a moderate exception', { exceptions: [{ ...e, severity: 'moderate' }] }],
      ['not a policy', { rules: [] }],
    ];
    for (const [name, policy] of cases) {
      const v = run(report(ZOD), { policy });
      expect([name, v.ok, v.excepted.length]).toEqual([name, false, 0]);
    }
  });

  it('negative, end to end: the CLI exits non-zero on an empty report file, and zero on a passing one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-'));
    const write = (n: string, v: unknown) => { const p = path.join(dir, n); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); return p; };
    const cli = (args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/npm-audit-gate.js'), ...args], { encoding: 'utf8' });
    const lock = write('lock.json', LOCK);
    // The committed policy, before its expiry, cannot be tested against the real clock forever: use a copy dated from today.
    const today = new Date(); const later = new Date(today.getTime() + 7 * 86400000);
    const policy = write('policy.json', { exceptions: [{ ...POLICY.exceptions[0], approvedOn: today.toISOString(), expires: later.toISOString() }] });
    expect(cli(['--report', write('ok.json', report(ZOD)), '--policy', policy, '--lockfile', lock]).status).toBe(0);
    expect(cli(['--report', write('empty.json', ''), '--policy', policy, '--lockfile', lock]).status).toBe(1);
    const both = cli(['--report', write('both.json', report(ZOD, BODY_PARSER)), '--policy', policy, '--lockfile', lock]);
    expect(both.status).toBe(1);
    expect(both.stdout).toContain('FAIL   HIGH GHSA-27r3-jxmh-p828');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the security posture records it', () => {
  it('keeps ci-audit-blocking PRESENT through the gate, and names the exception and its expiry', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/cyber-defense/generated/security-manifest.json'), 'utf8'));
    const controls = JSON.stringify(manifest);
    expect(controls).toMatch(/"id":\s*"ci-audit-blocking"[^}]*"status":\s*"PRESENT"/);
    expect(controls).toContain('except GHSA-mrhx-c7xc-m3w5 (zod, until 2026-11-01T00:00:00Z)');
  });
});
