'use strict';
// Familista Design Universe — M3/S3.2: the browser proof's performance budget report.
//
// The browser proof (lab-browser-proof.cjs) prints one `METRIC {json}` line for each measurement it owes this report.
// This module reads those lines, checks every one against the closed list below and writes a Markdown table for the
// GitHub Actions job summary. It is pure: no network, no environment, no database; the command line reads one file.
//
// What it decides, and nothing more:
//   - An OFFICIAL metric is PASS or OVER against its approved budget. Timing is report-only (owner decision M3/S3.2 D2):
//     an OVER is shown and never fails this step. Memory, listener, detached-node and DOM growth are enforced by the
//     proof's own checks, which this report neither replaces nor relaxes.
//   - An OFFICIAL metric that is missing or invalid fails this step (D3): a measurement that was not taken is not a pass.
//   - A DIAGNOSTIC metric is INFO, or "INFO (above reference)" when it has a reference and exceeds it (D6). It never
//     carries an official status, and a budget is never applied to a measurement it was not approved for.
//   - An unknown id, a duplicate id, a malformed line, a wrong unit, a non-finite number or a negative duration fails
//     this step, whichever class the metric is.

/** Section ids, as the proof's PROOF_ONLY names them. */
const S = { NAV: '11', COMPARE_DIAG: '10', BUDGET: '12', MEMORY: '13' };

const ms = (v) => ({ op: '<=', value: v, unit: 'ms' });

/**
 * The closed list. Order is report order. Budgets are the owner-approved values and may change only with the owner's
 * approval (tests/design-system-lab.unit.test.ts pins them).
 */
const METRICS = Object.freeze([
  { id: 'nav.component.median', cls: 'OFFICIAL', kind: 'value', unit: 'ms', duration: true, section: S.NAV, budget: ms(50),
    name: 'Navigation median', method: 'Section 11 component navigation: cached steps round the rail, click to the second animation frame; median = sorted[floor(n/2)]' },
  { id: 'nav.component.p95', cls: 'OFFICIAL', kind: 'value', unit: 'ms', duration: true, section: S.NAV, budget: ms(80),
    name: 'Navigation p95', method: 'Section 11 component navigation, the same samples; p95 = sorted[floor(0.95 n)]' },
  { id: 'compare.open.p95', cls: 'OFFICIAL', kind: 'value', unit: 'ms', duration: true, section: S.BUDGET, budget: ms(100),
    name: 'Compare opening p95', method: 'Section 12 budget block: a fresh page, 40 openings after 3 warm-ups, click to the second animation frame; p95 = sorted[floor(0.95 n)]' },
  { id: 'fit.recalc.p95', cls: 'OFFICIAL', kind: 'value', unit: 'ms', duration: true, section: S.BUDGET, budget: ms(100),
    name: 'Fit recalculation p95', method: 'Section 12 budget block: Fit on in Compare, 40 width changes after 3 warm-ups, click to the second animation frame; p95 = sorted[floor(0.95 n)]' },
  { id: 'mem.app.growth', cls: 'OFFICIAL', kind: 'value', unit: 'KB', duration: false, section: S.MEMORY, budget: { op: '<=', value: 32, unit: 'KB' },
    name: 'Application-memory growth', method: 'Section 13: one unmeasured pass over every fixture, then three measured, after garbage collection; also enforced by the proof' },
  { id: 'mem.listeners.growth', cls: 'OFFICIAL', kind: 'value', unit: 'count', duration: false, integer: true, section: S.MEMORY, budget: { op: '=', value: 0, unit: '' },
    name: 'Listener growth', method: 'Section 13, the same three passes: document-level listeners added; also enforced by the proof' },
  { id: 'mem.detached.growth', cls: 'OFFICIAL', kind: 'value', unit: 'count', duration: false, integer: true, section: S.MEMORY, budget: { op: '<=', value: 0, unit: '' },
    name: 'Detached-node growth', method: 'Section 13, the same three passes: detached DOM nodes added; also enforced by the proof' },
  { id: 'dom.growth', cls: 'OFFICIAL', kind: 'value', unit: 'count', duration: false, integer: true, section: S.MEMORY, budget: { op: '<=', value: 0, unit: '' },
    name: 'DOM growth', method: 'Section 13, the same three passes: page nodes added; the node-count checks of sections 4, 8, 10, 11 and 13 enforce it' },

  { id: 'diag.nav.component.app.median', cls: 'DIAGNOSTIC', kind: 'value', unit: 'ms', duration: true, section: S.NAV,
    name: 'Navigation: the Lab’s own work, median', method: 'Section 11, the same samples: the Lab’s switchMs, measured inside its click handler' },
  { id: 'diag.nav.component.browser.median', cls: 'DIAGNOSTIC', kind: 'value', unit: 'ms', duration: true, section: S.NAV,
    name: 'Navigation: browser time, median', method: 'Section 11, the same samples: wall time minus the Lab’s own work, per sample (rendering and frame waiting together)' },
  { id: 'diag.nav.component.frames', cls: 'DIAGNOSTIC', kind: 'frames', unit: 'frames', section: S.NAV,
    name: 'Navigation: frames per step', method: 'Section 11, the same samples, each rounded to whole frames of the interval measured on the page after the loop' },
  { id: 'diag.nav.fixture.median', cls: 'DIAGNOSTIC', kind: 'value', unit: 'ms', duration: true, section: S.NAV,
    name: 'Fixture navigation median', method: 'Section 11 fixture navigation: cached steps round the strip; not the official navigation measurement (D1)' },
  { id: 'diag.nav.fixture.p95', cls: 'DIAGNOSTIC', kind: 'value', unit: 'ms', duration: true, section: S.NAV,
    name: 'Fixture navigation p95', method: 'Section 11 fixture navigation, the same samples; p95 = sorted[floor(0.95 n)]' },
  { id: 'diag.compare.open.frames', cls: 'DIAGNOSTIC', kind: 'frames', unit: 'frames', section: S.BUDGET,
    name: 'Compare opening: frames per opening', method: 'Section 12, the official samples, each rounded to whole frames of the interval measured on the page after the loops' },
  { id: 'diag.fit.recalc.frames', cls: 'DIAGNOSTIC', kind: 'frames', unit: 'frames', section: S.BUDGET,
    name: 'Fit recalculation: frames per change', method: 'Section 12, the official samples, each rounded to whole frames of the same interval' },
  { id: 'diag.compare.open.s10.p95', cls: 'DIAGNOSTIC', kind: 'value', unit: 'ms', duration: true, section: S.COMPARE_DIAG, reference: 100,
    name: 'Compare opening p95, section 10', method: 'Section 10: 40 toggles, no warm-up, after the section’s earlier interactions and Lab remounts, with the browser’s Performance and HeapProfiler domains on; the 100 ms budget does not apply' },
  { id: 'diag.compare.open.s10.median', cls: 'DIAGNOSTIC', kind: 'value', unit: 'ms', duration: true, section: S.COMPARE_DIAG,
    name: 'Compare opening median, section 10', method: 'Section 10, the same samples; median = sorted[floor(n/2)]' },
  { id: 'diag.compare.open.s10.app.median', cls: 'DIAGNOSTIC', kind: 'value', unit: 'ms', duration: true, section: S.COMPARE_DIAG,
    name: 'Compare opening, section 10: the Lab’s own work, median', method: 'Section 10, the same samples: the Lab’s modeMs, measured inside its click handler' },
  { id: 'diag.compare.open.s10.browser.median', cls: 'DIAGNOSTIC', kind: 'value', unit: 'ms', duration: true, section: S.COMPARE_DIAG,
    name: 'Compare opening, section 10: browser time, median', method: 'Section 10, the same samples: wall time minus the Lab’s own work, per sample' },
  { id: 'diag.compare.open.s10.frames', cls: 'DIAGNOSTIC', kind: 'frames', unit: 'frames', section: S.COMPARE_DIAG,
    name: 'Compare opening, section 10: frames per opening', method: 'Section 10, the same samples, each rounded to whole frames of the interval measured on the page after the loops' },
].map((m) => Object.freeze({ ...m, budget: m.budget ? Object.freeze({ ...m.budget }) : null, reference: m.reference ?? null })));

const BY_ID = new Map(METRICS.map((m) => [m.id, m]));
const SUMMARY_RE = /^(\d+) passed, (\d+) failed, (\d+) skipped$/;

/** What may be shown of a string the report did not write: an id's own alphabet, and not much of it. */
const safeId = (v) => String(v).replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 64) || '(empty)';
/** Markdown and HTML neutralised: nothing the report prints can open a tag, a link or a table cell. */
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/[`*_[\]]/g, (c) => '\\' + c).replace(/[\r\n]+/g, ' ');

/** The proof's log, read as data: METRIC lines and its SUMMARY line. `text` null means there was no log at all. */
function parseLog(text) {
  if (typeof text !== 'string') return { present: false, records: [], errors: ['no proof log was found'], summary: null };
  const records = [], errors = [];
  let summary = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SUMMARY ')) summary = line.slice(8).trim();
    if (!line.startsWith('METRIC ')) continue;
    let rec;
    try { rec = JSON.parse(line.slice(7)); } catch (_) { errors.push('a METRIC line is not valid JSON'); continue; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { errors.push('a METRIC line is not a JSON object'); continue; }
    records.push(rec);
  }
  return { present: true, records, errors, summary: summary !== null && SUMMARY_RE.test(summary) ? summary : summary === null ? null : 'unreadable' };
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Why a record cannot be trusted, or null. */
function problemOf(def, rec) {
  if (rec.unit !== def.unit) return `unit "${safeId(rec.unit)}", expected "${def.unit}"`;
  if (rec.n !== undefined && !(Number.isInteger(rec.n) && rec.n > 0)) return 'n is not a positive whole number';
  if (def.kind === 'frames') {
    if (!Number.isInteger(rec.n) || rec.n <= 0) return 'n is missing';
    if (!finite(rec.interval) || rec.interval <= 0) return 'the frame interval is not a positive number';
    const d = rec.distribution;
    if (!d || typeof d !== 'object' || Array.isArray(d) || !Object.keys(d).length) return 'the distribution is missing';
    let sum = 0;
    for (const [k, c] of Object.entries(d)) {
      if (!/^[1-9]\d{0,3}$/.test(k)) return 'a frame count is not a positive whole number';
      if (!Number.isInteger(c) || c < 0) return 'a frame tally is not a whole number';
      sum += c;
    }
    if (sum !== rec.n) return `the distribution counts ${sum} samples, n is ${rec.n}`;
    return null;
  }
  if (!finite(rec.value)) return 'the value is not a finite number';
  if (def.duration && rec.value < 0) return 'a duration is negative';
  if (def.integer && !Number.isInteger(rec.value)) return 'the value is not a whole number';
  if (rec.max !== undefined) {
    if (!finite(rec.max)) return 'max is not a finite number';
    if (def.duration && rec.max < 0) return 'max is negative';
    if (rec.max < rec.value) return 'max is below the value';
  }
  return null;
}

const meets = (b, v) => (b.op === '<=' ? v <= b.value : b.op === '=' ? v === b.value : false);

/**
 * Every metric's status. `sections` lists the proof sections this run executed (null: all of them); a metric whose section
 * did not run is "NOT IN THIS SHARD", never PASS.
 */
function evaluate(parsed, { sections = null } = {}) {
  const errors = [...parsed.errors];
  const seen = new Map();
  for (const rec of parsed.records) {
    const id = typeof rec.id === 'string' ? rec.id : '';
    if (!BY_ID.has(id)) { errors.push(`unknown metric id "${safeId(id)}"`); continue; }
    if (seen.has(id)) { errors.push(`duplicate metric id "${id}"`); seen.get(id).duplicate = true; continue; }
    seen.set(id, { rec });
  }
  const rows = METRICS.map((def) => {
    const ran = !sections || sections.includes(def.section);
    const got = seen.get(def.id);
    if (!got) return { def, status: !ran ? 'NOT IN THIS SHARD' : def.cls === 'OFFICIAL' ? 'MISSING' : 'NOT MEASURED' };
    if (!ran) return { def, rec: got.rec, status: 'INVALID', problem: 'reported by a section this run did not execute' };
    if (got.duplicate) return { def, rec: got.rec, status: 'INVALID', problem: 'reported more than once' };
    const problem = problemOf(def, got.rec);
    if (problem) return { def, rec: got.rec, status: 'INVALID', problem };
    if (def.cls === 'OFFICIAL') return { def, rec: got.rec, status: meets(def.budget, got.rec.value) ? 'PASS' : 'OVER' };
    return { def, rec: got.rec, status: def.reference !== null && got.rec.value > def.reference ? 'INFO (above reference)' : 'INFO' };
  });
  const failures = [
    ...errors,
    ...rows.filter((r) => r.status === 'INVALID').map((r) => `${r.def.id}: ${r.problem}`),
    ...rows.filter((r) => r.status === 'MISSING').map((r) => `${r.def.id}: the official measurement is missing`),
  ];
  return { rows, failures, ok: failures.length === 0, summary: parsed.summary, present: parsed.present, sections };
}

const num = (v, unit) => {
  const n = Object.is(v, -0) ? 0 : v;
  return unit === 'count' ? String(n) : n.toFixed(1) + ' ' + unit;
};
const budgetText = (def) => {
  if (def.budget) return (def.budget.op === '<=' ? '≤ ' : '= ') + def.budget.value + (def.budget.unit ? ' ' + def.budget.unit : '');
  if (def.reference !== null) return 'reference ' + def.reference + ' ' + def.unit + ' (no budget)';
  return '—';
};
const valueText = (r) => {
  if (!r.rec || r.status === 'INVALID') return r.status === 'INVALID' ? 'not used: ' + r.problem : '—';
  const parts = [num(r.rec.value, r.def.unit)];
  if (r.rec.n !== undefined) parts.push('n ' + r.rec.n);
  if (r.rec.max !== undefined) parts.push('max ' + num(r.rec.max, r.def.unit));
  return parts.join(', ');
};
const framesText = (r) => {
  if (!r.rec || r.status === 'INVALID') return r.status === 'INVALID' ? 'not used: ' + r.problem : '—';
  const d = r.rec.distribution;
  return Object.keys(d).map(Number).sort((a, b) => a - b).map((f) => f + ': ' + d[f]).join(' · ');
};

/** The job-summary Markdown. Every string in it is the report's own or has passed through esc(). */
function toMarkdown(result) {
  const out = [];
  const shard = result.sections ? 'sections ' + result.sections.join(', ') : 'all sections';
  out.push(`### Performance budgets — browser proof (${esc(shard)})`, '');
  out.push(result.present ? `Proof: ${result.summary ? esc(result.summary) : 'no SUMMARY line — the proof did not finish'}` : 'Proof: **no proof log was found** — nothing below was measured.');
  const counts = result.summary ? SUMMARY_RE.exec(result.summary) : null;
  if (counts && (Number(counts[2]) > 0 || Number(counts[3]) > 0)) {
    out.push('', `**The proof itself did not pass (${counts[2]} failed, ${counts[3]} skipped).** Its own pass/fail step fails this job, whatever this report says.`);
  }
  out.push('');
  out.push('Timing budgets are report-only: an OVER is shown here and does not fail the build. Memory, listener, detached-node and DOM growth are enforced by the proof’s own checks. A missing or invalid official measurement fails this step.', '');
  out.push('| Metric | Class | Value | Budget | Status | Method |', '|---|---|---|---|---|---|');
  for (const r of result.rows.filter((x) => x.def.kind === 'value')) {
    out.push(`| ${esc(r.def.name)} (\`${r.def.id}\`) | ${r.def.cls} | ${esc(valueText(r))} | ${esc(budgetText(r.def))} | **${r.status}** | ${esc(r.def.method)} |`);
  }
  const frames = result.rows.filter((x) => x.def.kind === 'frames');
  out.push('', '#### Frame diagnostics', '', '| Measurement | Frame interval | Frames per sample : samples | n | Status |', '|---|---|---|---|---|');
  for (const r of frames) {
    const ok = r.rec && r.status !== 'INVALID';
    out.push(`| ${esc(r.def.name)} (\`${r.def.id}\`) | ${ok ? esc(r.rec.interval.toFixed(2) + ' ms') : '—'} | ${esc(framesText(r))} | ${ok ? r.rec.n : '—'} | **${r.status}** |`);
  }
  out.push('');
  if (result.ok) out.push('Report: every official measurement is present and valid.');
  else out.push('Report: **failed** — ' + result.failures.length + ' problem(s):', '', ...result.failures.map((f) => '- ' + esc(f)));
  out.push('');
  return out.join('\n');
}

/** The whole report for one log: Markdown and whether the step passes. */
function report(text, opts) {
  const result = evaluate(parseLog(text), opts);
  return { ...result, markdown: toMarkdown(result) };
}

module.exports = { METRICS, parseLog, evaluate, toMarkdown, report, esc, safeId };

// Command line, for CI:  node tools/components/budget-report.cjs <proof log> [--sections 1,2,...]
if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--sections');
  const sections = at >= 0 ? String(args[at + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null;
  let text = null;
  try { text = require('fs').readFileSync(args[0], 'utf8'); } catch (_) { text = null; }
  const r = report(text, { sections: sections && sections.length ? sections : null });
  process.stdout.write(r.markdown + '\n');
  process.exitCode = r.ok ? 0 : 1;
}
