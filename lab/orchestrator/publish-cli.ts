// Familista — preparing an approved LAB publication, from the command line (AI-0.5)
// ─────────────────────────────────────────────────────────────────────────────
//   FAMILISTA_ENV=LAB npm run lab:publish -- candidate <execution-id> [--definition <file>]
//       Could this execution be published, and as what? With a definition, also
//       whether replaying it from nothing reproduces this execution. Writes nothing.
//   FAMILISTA_ENV=LAB npm run lab:publish -- replay <definition-file>
//       Run a definition again from nothing and print the record and dossier
//       digests it produces. Writes nothing.
//   FAMILISTA_ENV=LAB npm run lab:publish -- prepare <execution-id> --definition <file> --reference bibokh/familista-backend#<pr> [--revision <commit>]
//       Replay the definition and require it to reproduce this execution, byte
//       for byte; measure the execution's source at the commit (HEAD by default)
//       and require the working tree to be that source; then write the dossier,
//       its provenance record and an approval entry into
//       src/platform/agents/published/ for the pull request named, and read them
//       back as production will. Commits nothing; the publication gate replays
//       it again in CI, and the entry takes effect only when the Platform Owner
//       merges that pull request.
//   FAMILISTA_ENV=LAB npm run lab:publish -- verify
//       Read the publications directory exactly as the server will.
//   FAMILISTA_ENV=LAB npm run lab:publish -- rehearse <execution-id>
//       prepare → verify in a throwaway directory, with a pull request that
//       cannot exist; the server refuses what a rehearsal writes.
//   FAMILISTA_ENV=LAB npm run lab:publish -- demo
//       The AI-0.5 demonstration, end to end, stopping at the owner's boundary.
//   FAMILISTA_ENV=LAB npm run lab:publish -- gallery --out <file.json>
//       The rehearsed room view of one execution per outcome, for the room's tests.
//
// There is no approve and no publish, and no flag that names an approver: such a
// command or flag is refused before anything is read. Executions are read from
// lab/orchestrator/.executions (FAMILISTA_LAB_EXECUTIONS_DIR), the store the
// lab:execute CLI writes; FAMILISTA_LAB_PUBLICATIONS_DIR redirects prepare and
// verify, for tests. Nothing here prints an operation's input or output.
//
// Exit codes: 0 done, 2 refused (the refusal is printed), 1 could not run.

import '../../src/config/zod'; // zod 4 with zod 3's messages, as the server has them, before anything validates
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { platformAgentRegistry } from '../../src/platform/agents/catalog';
import { currentEnvironment } from '../../src/platform/environment';
import { readPublications, type PublicationsRead } from '../../src/platform/agents/execution-evidence';
import { DEFAULT_EXECUTIONS_DIR, FileExecutionStore } from './execution';
import { labExecutionOperations } from './operations';
import { executionPublicationCandidate, preparePublication, PUBLICATIONS_DIR, rehearsalProvenance, REHEARSAL_REFERENCE, type PublicationDeps } from './publication';
import { rehearsedRoomView, runPublicationDemonstration } from './publication-demo';
import { replayDefinition, type ReplayResult } from './replay';
import { executionSource } from './source';

const out = (s = '') => process.stdout.write(`${s}\n`);
const fail = (s: string, code = 1): never => { process.stderr.write(`${s}\n`); process.exit(code); };

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string): string | null => { const i = rest.indexOf(`--${name}`); return i >= 0 && i + 1 < rest.length ? rest[i + 1] : null; };
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

// Who approves is never something this tool is told. Refused before anything is read.
const IDENTITY_FLAGS = ['approved-by', 'approver', 'owner', 'by', 'as', 'operator', 'user', 'role', 'signed-by', 'platform-owner'];
const claimed = rest.filter((a) => a.startsWith('--') && IDENTITY_FLAGS.includes(a.slice(2).split('=')[0]));
if (claimed.length) {
  fail(`refused IDENTITY_NOT_ACCEPTED: ${claimed.join(', ')} — this tool takes no approver. Approval is the Platform Owner merging the reviewed pull request that carries the entry; a name given here would prove nothing.`, 2);
}
if (command === 'approve' || command === 'publish') {
  fail(`refused NO_APPROVAL_HERE: there is no ${command} command. Prepare the publication (prepare … --reference), open the pull request, and the Platform Owner approves it by merging; until then production shows nothing.`, 2);
}

const environment = currentEnvironment();
if (environment !== 'LAB') fail(`refused ENVIRONMENT_NOT_LAB: publications are prepared in the Lab only; this process is ${environment}`, 2);

const executionsDir = process.env.FAMILISTA_LAB_EXECUTIONS_DIR || DEFAULT_EXECUTIONS_DIR;
const publicationsDir = process.env.FAMILISTA_LAB_PUBLICATIONS_DIR || PUBLICATIONS_DIR;
const deps: PublicationDeps = { registry: platformAgentRegistry(), operations: labExecutionOperations() };

function recordOf(id: string | undefined): unknown {
  if (!id) fail('usage: an execution id (npm run lab:execute -- list)');
  const store = new FileExecutionStore(executionsDir, environment);
  let r: unknown;
  try { r = store.get(id as string); } catch (e) { fail(`refused RECORD_INVALID: ${e instanceof Error ? e.message : String(e)}`, 2); }
  if (!r) fail(`refused RECORD_UNKNOWN: no LAB execution is recorded as "${String(id).slice(0, 40)}" in ${executionsDir}`, 2);
  return r;
}

const ROOT = path.join(__dirname, '..', '..');
const repoPath = (file: string) => path.relative(ROOT, path.resolve(file)).split(path.sep).join('/');
const git = (...a: string[]): string | null => {
  try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
};

/** Replay the definition at `file` and print what it gives; exit 2 if it does not run as written. */
function replayOf(file: string | null | undefined): { replay: Extract<ReplayResult, { ok: true }>; at: string; text: string } {
  if (!file) fail('refused DEFINITION_REQUIRED: --definition lab/orchestrator/definitions/<name>.json, the definition that produced it; only an execution its definition reproduces is published', 2);
  const at = repoPath(file as string);
  let text: string;
  try { text = fs.readFileSync(path.join(ROOT, at), 'utf8'); } catch { return fail(`refused DEFINITION_UNKNOWN: ${at} cannot be read`, 2); }
  const r = replayDefinition(text, at, deps);
  if (!r.ok) fail(`refused NOT_REPRODUCIBLE: ${at} does not replay as written: ${r.reason}`, 2);
  const ok = r as Extract<ReplayResult, { ok: true }>;
  out(`replayed ${at} (${ok.definitionDigest.slice(0, 16)}) from nothing: ${ok.steps.map((st) => `${st.action} ${st.status}${st.code ? ` ${st.code}` : ''}`).join(', ')}`);
  out(`  ${ok.record.executionId} ${ok.record.run.outcome}   record ${ok.record.digest}`);
  out(`  ${ok.evidence.publicationId}   dossier ${ok.evidence.digest}`);
  return { replay: ok, at, text };
}

function printRead(read: PublicationsRead, where: string): void {
  if (read.state !== 'VERIFIED') { out(`${where}: ${read.state} — ${read.reason}`); }
  else {
    out(`${where}: VERIFIED — ${read.publications.length} approved publication(s), record ${read.recordDigest.slice(0, 16)}`);
    for (const p of read.publications) out(`  ${p.entry.publicationId}  ${p.evidence.run.outcome.padEnd(18)} ${p.entry.executionId}  ${p.entry.reference}  dossier ${p.entry.dossier.digest.slice(0, 16)}`);
  }
  if (read.unapproved.length) out(`  present without an approval entry (never read, never shown): ${read.unapproved.join(', ')}`);
}

switch (command) {
  case 'replay': {
    replayOf(positional[0]);
    out('  not published: nothing was written');
    break;
  }
  case 'candidate': {
    const definition = flag('definition');
    const record = recordOf(positional[0]) as { digest?: string };
    if (definition) {
      const { replay } = replayOf(definition);
      if (replay.record.digest !== record.digest) fail(`refused NOT_REPRODUCED: the replay gives record ${replay.record.digest.slice(0, 16)}; ${positional[0]} is ${String(record.digest).slice(0, 16)}`, 2);
      out('  reproduced: the replay is this execution, byte for byte');
    }
    const c = executionPublicationCandidate(record, deps);
    if (!c.evidence) fail(`refused NOT_A_CANDIDATE:\n  ${c.reasons.join('\n  ')}`, 2);
    const e = c.evidence as NonNullable<typeof c.evidence>;
    out(`${e.publicationId}  candidate for ${e.source.executionId} (${e.run.outcome})`);
    out(`  dossier digest ${e.digest}`);
    out(`  record ${e.source.recordDigest.slice(0, 16)}   run ${e.run.digest.slice(0, 16)}   ${e.run.trace.length} trace events, ${e.log.length} log events, ${e.decisions.length} decisions`);
    out('  not published: prepare it for a pull request; the Platform Owner approves by merging that pull request');
    break;
  }
  case 'prepare': {
    const reference = flag('reference');
    if (!reference) fail('refused REFERENCE_REQUIRED: --reference bibokh/familista-backend#<pull request> — the pull request that will carry this entry', 2);
    const record = recordOf(positional[0]) as { digest?: string };
    const { replay, at, text } = replayOf(flag('definition'));
    if (replay.record.digest !== record.digest) fail(`refused NOT_REPRODUCED: the replay gives record ${replay.record.digest.slice(0, 16)}; ${positional[0]} is ${String(record.digest).slice(0, 16)}. Only an execution its definition reproduces is published.`, 2);
    const revision = (git('rev-parse', flag('revision') ?? 'HEAD') ?? '').trim();
    if (!/^[0-9a-f]{40}$/.test(revision)) fail('refused SOURCE_UNKNOWN: the commit could not be resolved', 2);
    const tree = executionSource((p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return null; } });
    const committed = executionSource((p) => git('show', `${revision}:${p}`));
    if ('reason' in tree) fail(`refused SOURCE_UNKNOWN: ${tree.reason}`, 2);
    if ('reason' in committed || committed.digest !== (tree as { digest: string }).digest) fail(`refused SOURCE_UNCOMMITTED: the working tree's execution source is not ${revision.slice(0, 12)}'s; commit it, merge it to main, and prepare at that commit`, 2);
    if (git('show', `${revision}:${at}`) !== text) fail(`refused SOURCE_UNCOMMITTED: ${at} is not the file ${revision.slice(0, 12)} holds; the definition is reviewed and merged before it is published`, 2);
    if (git('merge-base', '--is-ancestor', revision, 'origin/main') === null) out(`  note: ${revision.slice(0, 12)} is not on origin/main yet; the publication gate refuses provenance from code that is not merged`);
    const source = tree as Exclude<typeof tree, { reason: string }>;
    const r = preparePublication(record, deps, {
      reference: reference as string, dir: publicationsDir, environment,
      provenance: {
        definition: { name: replay.definition.name, path: at, digest: replay.definitionDigest },
        source: { revision, digest: source.digest, files: source.files.length, packages: source.packages }, steps: replay.definition.steps.length,
      },
    });
    if (r.status === 'REFUSED') fail(`refused ${r.code}: ${r.message}`, 2);
    if (r.status !== 'PREPARED') break;
    out(`PREPARED — NOT APPROVED: ${r.entry.publicationId} for ${r.entry.reference}`);
    for (const f of r.files) out(`  wrote ${path.relative(process.cwd(), f)}`);
    printRead(r.read, '  read back as production will');
    out('  commit the three files to that pull request: the publication gate replays them in CI. The entry takes effect only when that pull request is merged; until then production shows nothing.');
    break;
  }
  case 'verify': {
    const read = readPublications(deps.registry, publicationsDir);
    printRead(read, path.relative(process.cwd(), publicationsDir) || publicationsDir);
    if (read.state === 'INVALID') process.exit(2);
    break;
  }
  case 'rehearse': {
    const dir = path.join(executionsDir, '.publication-rehearsal');
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      const r = preparePublication(recordOf(positional[0]), deps, { reference: REHEARSAL_REFERENCE, dir, environment, provenance: rehearsalProvenance('rehearsal', 0) });
      if (r.status === 'REFUSED') fail(`refused ${r.code}: ${r.message}`, 2);
      if (r.status !== 'PREPARED') break;
      out(`REHEARSED — ${r.entry.publicationId}, for a pull request that cannot exist (${REHEARSAL_REFERENCE})`);
      printRead(r.read, '  read back by production\'s rules, the rehearsal let through');
      printRead(r.production, '  as the server itself reads it');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    break;
  }
  case 'demo': {
    const dir = path.join(executionsDir, '.publication-demo');
    try {
      const steps = runPublicationDemonstration(dir);
      for (const s of steps) out(`${String(s.n).padStart(2)}. [${s.result}] ${s.step}\n      ${s.detail}`);
      out('\nStopped at the Platform Owner\'s boundary: nothing was approved, nothing was written to the tree production is built from.');
      if (steps.some((s) => s.result === 'REFUSED')) process.exit(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    break;
  }
  case 'gallery': {
    const file = flag('out');
    if (!file) fail('usage: gallery --out <file.json>');
    const dir = path.join(executionsDir, '.publication-gallery');
    try {
      const view = rehearsedRoomView(dir);
      fs.writeFileSync(file as string, `${JSON.stringify(view, null, 2)}\n`);
      out(`wrote ${file}: ${view.publications.length} rehearsed publications (${view.publications.map((p) => p.evidence.run.outcome).join(', ')}) — SIMULATED, none approved`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    break;
  }
  default:
    fail('usage: npm run lab:publish -- candidate <id> [--definition <file>] | replay <definition> | prepare <id> --definition <file> --reference <owner/repo#pr> | verify | rehearse <id> | demo | gallery --out <file>');
}
