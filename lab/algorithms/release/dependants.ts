// Familista — what a promotion does to the algorithms that depend on it
// ─────────────────────────────────────────────────────────────────────────────
// Two halves, in two processes.
//
// CLASSIFY (parent, static — the code is read as text, never run). For every
// registered algorithm, does its own code reach a declaration the promotion
// changes?
//
//   reach   the changed declarations, and every top-level declaration of the
//           same file that names one of them, repeatedly — so a helper that
//           calls the changed function counts as changed too
//   CODE    the dependant's declarations name something in that reach — in the
//           same file, or imported from it (a name imported from the changed
//           file seeds the same closure in the dependant's own file). The
//           promoted version changes its output, so it must be simulated.
//   DATA    they name nothing in it: it reads values something else stored.
//           Promoting changes none of its inputs today, so nothing is run.
//
// This reads names, not a call graph: a name that merely appears counts as a
// call, which can only make a dependant CODE when it is DATA — never the
// reverse. A registered algorithm that reaches the changed code without being
// declared a dependant (registry `dependsOn`) stops the release; so does a CODE
// dependant the release tool cannot run (release/spec.ts).
//
// SIMULATE (child, through jobs.ts — never in the parent). The dependant's
// function from the approved module and from the promoted module, on the
// held-out probes and shots the changed algorithm was judged on: the same
// seeds, the same streams, property by property.

import * as fs from 'fs';
import * as path from 'path';
import type { ShotFeatures } from '../../../src/match-events/xg-model.service';
import type { LabPropertyResult } from '../../../src/algorithms/candidate-evidence';
import { ALGORITHMS, algorithmOf } from '../../../src/algorithms/registry';
import { PROBE_SETS, PROPERTIES, SCENARIOS, STREAM_OFFSET, type CandidateAlgorithm } from '../spec';
import { dependantsOf } from '../engine/code';
import { propertyResult, type Counter } from '../engine/compare';
import { runProperty } from '../engine/properties';
import { drawShot, seeded, type Fn } from '../engine/shots';
import { DEPENDANT_PROPERTIES, DEPENDANT_SIMULATIONS } from './spec';

interface FingerprintCore { stripComments(src: string): string; declarationOf(cleanSrc: string, name: string): string | null }
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core: FingerprintCore = require('../../../src/algorithms/fingerprint-core.js');

export interface DependantPlan {
  key: string;
  path: 'CODE' | 'DATA';
  /** What its code names that reaches the changed declarations, as its own file spells it. */
  calls: string[];
  /** CODE, and the release tool can run it for everything it calls. */
  simulated: boolean;
}

const TOP_LEVEL = /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+)([A-Za-z_$][\w$]*)/gm;
const names = (clean: string) => [...new Set([...clean.matchAll(TOP_LEVEL)].map((m) => m[1]))];
const escape = (s: string) => s.replace(/[$]/g, '\\$');
const mentions = (text: string, name: string) => new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`).test(text);

/** The top-level declarations of one file that name anything in `seeds`, repeatedly — `seeds` included. */
function closure(clean: string, seeds: Iterable<string>): Set<string> {
  const reach = new Set(seeds);
  const decls = names(clean).map((n) => ({ n, d: core.declarationOf(clean, n) ?? '' }));
  for (let grew = true; grew;) {
    grew = false;
    for (const { n, d } of decls) {
      if (reach.has(n)) continue;
      if ([...reach].some((r) => mentions(d, r))) { reach.add(n); grew = true; }
    }
  }
  return reach;
}

const modulePath = (file: string) => file.replace(/\.(?:ts|js)$/, '');
const resolvesTo = (file: string, spec: string, target: string) =>
  spec.startsWith('.') && modulePath(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))) === target;

/**
 * The local names through which `file` (comment-free text `clean`) can reach
 * the declarations in `reach` of the module `target`: a named import of one of
 * them; a default or namespace import of the module (anything in it); and any
 * top-level declaration that requires or dynamically imports it. Type-only
 * imports are erased and reach nothing.
 */
function entryNames(file: string, clean: string, target: string, reach: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of clean.matchAll(/(?:^|[;\n])\s*import\s+(type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1] || !resolvesTo(file, m[3], target)) continue;
    const braces = /\{([^}]*)\}/.exec(m[2]);
    for (const part of (braces ? braces[1].split(',') : []).map((p) => p.trim()).filter(Boolean)) {
      if (/^type\s/.test(part)) continue;
      const [orig, local] = part.split(/\s+as\s+/).map((x) => x.trim());
      if (reach.has(orig)) out.push(local ?? orig);
    }
    for (const b of m[2].replace(/\{[^}]*\}/, '').split(',').map((p) => p.trim()).filter(Boolean)) out.push(b.replace(/^\*\s*as\s+/, ''));
  }
  const loads = [...clean.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].filter((m) => resolvesTo(file, m[1], target)).map((m) => m[0]);
  if (loads.length) {
    for (const n of names(clean)) if (loads.some((l) => (core.declarationOf(clean, n) ?? '').includes(l))) out.push(n);
  }
  return out;
}

/**
 * Every registered algorithm whose code reaches what a promotion of
 * `algorithm` changes, and every one the registry declares a dependant of it.
 * `declared` is false for one that reaches the changed code although the
 * registry does not say it depends on it.
 */
export function classifyDependants(root: string, algorithm: string, changed: readonly string[]): Array<DependantPlan & { declared: boolean }> {
  const decl = algorithmOf(algorithm);
  if (!decl) throw new Error(`algorithm ${algorithm} is not registered`);
  const read = (f: string) => core.stripComments(fs.readFileSync(path.join(root, f), 'utf8'));
  const home = read(decl.source.file);
  const reach = closure(home, changed);
  const declared = new Set(dependantsOf(algorithm).map((d) => d.key));
  const out: Array<DependantPlan & { declared: boolean }> = [];
  for (const a of ALGORITHMS) {
    if (a.key === algorithm) continue;
    const same = a.source.file === decl.source.file;
    const clean = same ? home : read(a.source.file);
    const local = same ? reach : closure(clean, entryNames(a.source.file, clean, modulePath(decl.source.file), reach));
    const own = new Set(a.source.symbols);
    const text = a.source.symbols.map((s) => core.declarationOf(clean, s) ?? '').join('\n');
    const calls = [...local].filter((n) => !own.has(n) && mentions(text, n)).sort();
    if (!calls.length && !declared.has(a.key)) continue;
    const sim = DEPENDANT_SIMULATIONS[a.key];
    out.push({
      key: a.key,
      path: calls.length ? 'CODE' : 'DATA',
      calls,
      simulated: calls.length > 0 && !!sim && calls.every((c) => sim.covers.includes(c)),
      declared: declared.has(a.key),
    });
  }
  return out;
}

// ── the child's half ────────────────────────────────────────────────────────

export interface DependantRun {
  key: string;
  properties: Array<LabPropertyResult & { title: string }>;
  scenarios: Array<{ id: string; shots: number; changed: number; maxIncrease: number; maxDecrease: number; invalid: { approved: number; candidate: number } }>;
}

const isValid = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;

/** One dependant, approved module against promoted module, on the held-out probes and shots. Runs in a child only. */
export function simulateDependant(
  algorithm: CandidateAlgorithm, key: string, approvedModule: Record<string, unknown>, promotedModule: Record<string, unknown>, counter: Counter,
): DependantRun {
  const sim = DEPENDANT_SIMULATIONS[key];
  const decls = DEPENDANT_PROPERTIES[key];
  if (!sim || !decls) throw new Error(`no simulation is declared for ${key}`);
  const a = approvedModule[sim.entry];
  const c = promotedModule[sim.entry];
  if (typeof a !== 'function' || typeof c !== 'function') throw new Error(`${sim.entry} is not exported`);
  // The shot alone: whatever else the function accepts is left out, exactly as `covers` assumes.
  const approved: Fn = (f: ShotFeatures) => (a as Fn)(f);
  const promoted: Fn = (f: ShotFeatures) => (c as Fn)(f);
  const held = PROBE_SETS.find((p) => p.phase === 'HELD_OUT');
  if (!held) throw new Error('no held-out probe set');
  // Property k of the changed algorithm draws from seed + 1000·k; a dependant's property of the same id draws from the same stream.
  const order: string[] = PROPERTIES[algorithm].map((p) => p.id);
  const properties = decls.map((d) => {
    const k = order.indexOf(d.id);
    if (k < 0) throw new Error(`${d.id} is not one of ${algorithm}'s properties`);
    const run = runProperty(d, approved, promoted, seeded(held.seed + 1_000 * k), held.instances, counter);
    return { ...propertyResult(run, d.kind), title: d.title };
  });
  const scenarios = SCENARIOS.filter((s) => s.phase === 'HELD_OUT').map((s) => {
    const rng = seeded(s.seed + STREAM_OFFSET.shots);
    const shot: ShotFeatures = { x: 0, y: 0 };
    let changed = 0; let up = 0; let down = 0; let invalidA = 0; let invalidC = 0;
    for (let i = 0; i < s.shots; i += 1) {
      drawShot(s.mix, rng, shot);
      const pa = approved(shot);
      const pc = promoted(shot);
      if (!isValid(pa)) invalidA += 1;
      if (!isValid(pc)) invalidC += 1;
      if (!isValid(pa) || !isValid(pc)) continue;
      const d = pc - pa;
      if (d !== 0) { changed += 1; if (d > up) up = d; if (d < down) down = d; }
    }
    counter.predictions += 2 * s.shots;
    return { id: s.id, shots: s.shots, changed, maxIncrease: up, maxDecrease: down, invalid: { approved: invalidA, candidate: invalidC } };
  });
  return { key, properties, scenarios };
}
