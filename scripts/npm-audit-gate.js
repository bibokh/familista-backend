#!/usr/bin/env node
// Dependency audit gate — npm audit at HIGH, with reviewed, dated, advisory-specific exceptions
// ─────────────────────────────────────────────────────────────────────────────
// CI runs this instead of a bare `npm audit --audit-level=high`. It runs exactly
// that audit, reads its JSON, and fails the build on every HIGH or CRITICAL
// advisory, exactly as the bare command did, except an advisory that an entry
// in docs/security/npm-audit-exceptions.json names and still matches in full.
//
// It fails closed. The build fails when:
//   - the audit's output is missing, is not JSON, reports an error, or is not a
//     version-2 report whose counts agree with its own entries;
//   - any HIGH or CRITICAL advisory is not excepted;
//   - an exception does not match its advisory in full: id, package, severity,
//     vulnerable range and the installed version in package-lock.json (an
//     advisory that escalates to CRITICAL, or a different installed version,
//     needs a new review);
//   - an exception has expired, or runs longer than MAX_EXCEPTION_DAYS from its
//     approval, or is missing any part of its record;
//   - an exception matches nothing (fixed or withdrawn: it must be removed).
// Moderate and low advisories are printed and do not fail the build, as before.
//
// No flag lowers the threshold, skips the audit, or moves the clock. The test
// suite drives evaluate() directly; the CLI's --report/--policy/--lockfile
// arguments exist for those tests and are never passed by CI (pinned).

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const POLICY_FILE = path.join(ROOT, 'docs', 'security', 'npm-audit-exceptions.json');
const AUDIT_ARGS = Object.freeze(['audit', '--audit-level=high', '--json']);
const BLOCKING = new Set(['high', 'critical']);
const SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical']);
const MAX_EXCEPTION_DAYS = 31;
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const REQUIRED = ['id', 'package', 'severity', 'vulnerableRange', 'installedVersion', 'approvedOn', 'expires', 'owner', 'approvedBy', 'justification', 'compensatingControls', 'remediationPlan'];

const ghsaOf = (url) => { const m = /\/advisories\/(GHSA-[0-9a-z-]+)$/i.exec(String(url || '')); return m ? m[1] : null; };

/** The policy's exceptions, or the reasons it cannot be trusted. */
function readPolicy(policy) {
  const problems = [];
  if (!policy || typeof policy !== 'object' || !Array.isArray(policy.exceptions)) return { exceptions: [], problems: ['the exception policy is not { "exceptions": [...] }'] };
  const seen = new Set();
  for (const [i, e] of policy.exceptions.entries()) {
    const at = `exception ${i + 1}`;
    if (!e || typeof e !== 'object') { problems.push(`${at} is not an object`); continue; }
    const missing = REQUIRED.filter((k) => (k === 'compensatingControls' ? !Array.isArray(e[k]) || e[k].length === 0 || e[k].some((c) => typeof c !== 'string' || !c.trim()) : typeof e[k] !== 'string' || !e[k].trim()));
    if (missing.length) problems.push(`${at} (${e.id || 'no id'}) is missing ${missing.join(', ')}`);
    if (typeof e.id === 'string' && !GHSA.test(e.id)) problems.push(`${at}: "${e.id}" is not a GHSA id`);
    if (typeof e.id === 'string' && seen.has(e.id)) problems.push(`${at}: ${e.id} is listed twice`);
    seen.add(e.id);
    if (typeof e.severity === 'string' && !BLOCKING.has(e.severity)) problems.push(`${at}: only a high or critical advisory needs an exception, not "${e.severity}"`);
    const approved = Date.parse(e.approvedOn), expires = Date.parse(e.expires);
    if (!Number.isFinite(approved) || !Number.isFinite(expires)) problems.push(`${at}: approvedOn and expires must be ISO dates`);
    else if (expires <= approved) problems.push(`${at}: it expires before it was approved`);
    else if (expires - approved > MAX_EXCEPTION_DAYS * 86400000) problems.push(`${at}: it runs longer than ${MAX_EXCEPTION_DAYS} days from its approval`);
  }
  return { exceptions: policy.exceptions, problems };
}

/** Every advisory in a version-2 npm audit report, or why the report is not one. */
function readReport(report) {
  if (!report || typeof report !== 'object') return { problems: ['the audit printed no JSON report'] };
  if (report.error) return { problems: [`npm audit failed: ${String(report.error.summary || report.error.code || 'unknown error').slice(0, 200)}`] };
  const counts = report.metadata && report.metadata.vulnerabilities;
  if (report.auditReportVersion !== 2 || !report.vulnerabilities || typeof report.vulnerabilities !== 'object' || !counts) {
    return { problems: ['the audit report is not a version-2 npm audit report'] };
  }
  const problems = [];
  const advisories = new Map();
  const bySeverity = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const [name, v] of Object.entries(report.vulnerabilities)) {
    if (!v || !SEVERITIES.has(v.severity) || !Array.isArray(v.via)) { problems.push(`the audit entry for ${name} is malformed`); continue; }
    bySeverity[v.severity] += 1;
    for (const via of v.via) {
      if (typeof via === 'string') continue; // a package it is vulnerable through; that package has its own entry
      const id = ghsaOf(via && via.url);
      if (!id || !SEVERITIES.has(via.severity) || typeof via.name !== 'string') { problems.push(`an advisory on ${name} is malformed or has no GHSA id`); continue; }
      advisories.set(`${id}|${via.name}`, { id, package: via.name, severity: via.severity, range: String(via.range || ''), title: String(via.title || '') });
    }
  }
  for (const s of SEVERITIES) {
    if (Number(counts[s] || 0) !== bySeverity[s]) problems.push(`the audit report counts ${counts[s]} ${s} but lists ${bySeverity[s]}`);
  }
  // A HIGH entry vulnerable only through another package is judged by that package's advisories: it must be listed.
  for (const [name, v] of Object.entries(report.vulnerabilities)) {
    if (!v || !BLOCKING.has(v.severity) || !Array.isArray(v.via)) continue;
    const own = v.via.some((x) => x && typeof x === 'object' && BLOCKING.has(x.severity));
    const through = v.via.filter((x) => typeof x === 'string');
    if (!own && (through.length === 0 || through.some((dep) => !report.vulnerabilities[dep]))) {
      problems.push(`${name} is ${v.severity} through ${through.join(', ') || 'nothing'}, which the report does not list`);
    }
  }
  return { advisories: [...advisories.values()], bySeverity, problems };
}

/**
 * The verdict for one audit report, policy and lockfile at one moment.
 * @returns {{ ok: boolean, failures: string[], excepted: object[], informational: object[] }}
 */
function evaluate({ report, policy, lockfile, now }) {
  const failures = [];
  const r = readReport(report);
  failures.push(...r.problems);
  const p = readPolicy(policy);
  failures.push(...p.problems);
  if (!r.advisories) return { ok: false, failures, excepted: [], informational: [] };
  const installed = (pkg) => {
    const entry = lockfile && lockfile.packages && lockfile.packages[`node_modules/${pkg}`];
    return entry && typeof entry.version === 'string' ? entry.version : null;
  };
  const used = new Set();
  const excepted = [];
  for (const a of r.advisories.filter((x) => BLOCKING.has(x.severity))) {
    const e = p.problems.length ? null : p.exceptions.find((x) => x.id === a.id);
    if (!e) { failures.push(`${a.severity.toUpperCase()} ${a.id} in ${a.package} (${a.range}): ${a.title}`); continue; }
    used.add(e.id);
    const mismatch = [
      e.package !== a.package && `package ${a.package}, not ${e.package}`,
      e.severity !== a.severity && `severity ${a.severity}, not ${e.severity}`,
      e.vulnerableRange !== a.range && `range ${a.range}, not ${e.vulnerableRange}`,
      installed(a.package) !== e.installedVersion && `installed ${installed(a.package)}, not ${e.installedVersion}`,
    ].filter(Boolean);
    if (mismatch.length) { failures.push(`${a.id} no longer matches its exception (${mismatch.join('; ')}): review it again`); continue; }
    if (now >= Date.parse(e.expires)) { failures.push(`${a.id}: its exception expired on ${e.expires} — remediate it (${e.remediationPlan})`); continue; }
    excepted.push({ ...a, expires: e.expires, owner: e.owner, daysLeft: Math.floor((Date.parse(e.expires) - now) / 86400000) });
  }
  if (!p.problems.length) {
    for (const e of p.exceptions) {
      if (now >= Date.parse(e.expires) && !used.has(e.id)) failures.push(`${e.id}: its exception expired on ${e.expires}; remove it`);
      else if (!used.has(e.id)) failures.push(`${e.id}: its exception matches no advisory in this audit (fixed or withdrawn); remove it`);
    }
  }
  const informational = r.advisories.filter((x) => !BLOCKING.has(x.severity));
  return { ok: failures.length === 0, failures, excepted, informational };
}

function runAudit() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const out = spawnSync(npm, AUDIT_ARGS, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
  if (out.error) return { report: null, note: `npm audit could not run: ${out.error.message}` };
  try { return { report: JSON.parse(out.stdout), note: null }; } catch { return { report: null, note: `npm audit printed no JSON (exit ${out.status}): ${String(out.stderr || '').slice(0, 300)}` }; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const reportFile = arg('--report');
  const audit = reportFile ? { report: readJson(reportFile), note: null } : runAudit();
  const policyFile = arg('--policy') || POLICY_FILE;
  const policy = fs.existsSync(policyFile) ? readJson(policyFile) : { exceptions: [] };
  const lockfile = readJson(arg('--lockfile') || path.join(ROOT, 'package-lock.json'));
  const v = evaluate({ report: audit.report, policy, lockfile, now: Date.now() });
  if (audit.note) v.failures.unshift(audit.note);
  for (const a of v.informational) console.log(`  info   ${a.severity.padEnd(8)} ${a.id} ${a.package} ${a.range}`);
  for (const a of v.excepted) console.log(`  EXCEPT ${a.severity.padEnd(8)} ${a.id} ${a.package} ${a.range} — until ${a.expires} (${a.daysLeft} day(s) left), owner ${a.owner}`);
  for (const f of v.failures) console.log(`  FAIL   ${f}`);
  const ok = v.ok && !audit.note;
  console.log(ok ? `npm audit gate: passed (${v.excepted.length} excepted, ${v.informational.length} below high)` : `npm audit gate: FAILED (${v.failures.length})`);
  return ok ? 0 : 1;
}

module.exports = { evaluate, readPolicy, readReport, AUDIT_ARGS, MAX_EXCEPTION_DAYS, POLICY_FILE };

if (require.main === module) process.exit(main(process.argv.slice(2)));
