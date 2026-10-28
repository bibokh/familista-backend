// Familista — controlled LAB execution, from the command line (AI-0.4)
// ─────────────────────────────────────────────────────────────────────────────
//   FAMILISTA_ENV=LAB npm run lab:execute -- submit <request.json>
//   FAMILISTA_ENV=LAB npm run lab:execute -- decide <execution-id> <task-id> APPROVED|REJECTED --by <lab-user> --role <ROLE> [--club <lab-club>]
//   FAMILISTA_ENV=LAB npm run lab:execute -- cancel <execution-id> --operator <lab-user> --role <ROLE>
//   FAMILISTA_ENV=LAB npm run lab:execute -- show <execution-id> [--trace]
//   FAMILISTA_ENV=LAB npm run lab:execute -- verify <execution-id>
//   FAMILISTA_ENV=LAB npm run lab:execute -- list
//   FAMILISTA_ENV=LAB npm run lab:execute -- kill-switch status | engage --reason <text> | release   --operator <lab-user> --role <ROLE>
//   FAMILISTA_ENV=LAB npm run lab:execute -- run <lab/orchestrator/definitions/<name>.json>
//   FAMILISTA_ENV=LAB npm run lab:execute -- demo
//
// `run` executes a definition (definition.ts): its request, then each step as
// the commands above would take it, stopping at the first answer it does not
// expect. It is the same execution a person typing those commands would make.
//
// The one way into controlled execution (execution.ts): a person at a LAB
// terminal, naming themselves as an operator on the roster. There is no
// endpoint, and outside the Lab every command refuses before it reads or writes
// anything. Records are kept in lab/orchestrator/.executions (git-ignored; set
// FAMILISTA_LAB_EXECUTIONS_DIR to keep them elsewhere). The kill switch is the
// platform's own flag; this process sets it from the LAB state file when it
// starts, so engaging it from one command holds for every later one. Nothing
// here prints an operation's output: states, agents, reasons and digests only.
//
// Exit codes: 0 done, 2 refused (the refusal is printed), 1 could not run.

import '../../src/config/zod'; // zod 4 with zod 3's messages, as the server has them, before anything validates
import * as fs from 'fs';
import * as path from 'path';
import { platformAgentRegistry } from '../../src/platform/agents/catalog';
import { currentEnvironment } from '../../src/platform/environment';
import { engageKillSwitch, killSwitchEngaged, killSwitchReason } from '../../src/platform/intelligence/agents';
import {
  cancelExecution, decideExecution, DEFAULT_EXECUTIONS_DIR, EXECUTION_LIMITS, FileExecutionStore,
  publicationCandidate, submitExecution, verifyExecution, type ExecutionDeps, type ExecutionRecord, type ExecutionResult,
} from './execution';
import { applyDefinition, engageLabKillSwitch, parseDefinition, releaseLabKillSwitch } from './definition';
import { runDemonstration } from './execution-scenarios';
import { labExecutionOperations } from './operations';

const out = (s = '') => process.stdout.write(`${s}\n`);
const fail = (s: string, code = 1): never => { process.stderr.write(`${s}\n`); process.exit(code); };

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string): string | null => { const i = rest.indexOf(`--${name}`); return i >= 0 && i + 1 < rest.length ? rest[i + 1] : null; };
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

const environment = currentEnvironment();
if (environment !== 'LAB') fail(`refused ENVIRONMENT_NOT_LAB: controlled execution runs in the Lab only; this process is ${environment}`);

const dir = process.env.FAMILISTA_LAB_EXECUTIONS_DIR || DEFAULT_EXECUTIONS_DIR;
const killFile = path.join(dir, 'kill-switch.json');

// The kill switch, as the Lab last left it. Unreadable state counts as engaged: when in doubt, nothing starts.
if (fs.existsSync(killFile)) {
  try {
    const state = JSON.parse(fs.readFileSync(killFile, 'utf8')) as { engaged?: unknown; reason?: unknown };
    if (state.engaged === true) engageKillSwitch(typeof state.reason === 'string' ? state.reason : 'engaged in the Lab');
  } catch {
    engageKillSwitch('the LAB kill switch state could not be read');
  }
}

const deps: ExecutionDeps = { registry: platformAgentRegistry(), operations: labExecutionOperations(), store: new FileExecutionStore(dir, environment), environment };

function printRecord(r: ExecutionRecord, withTrace = false): void {
  out(`${r.executionId}  ${r.run.outcome}  plan ${r.planId}  by ${r.operator.role} ${r.operator.userId}`);
  out(`  request ${r.requestId}   limit ${r.run.steps}/${r.limits.maxSteps} steps   context ${r.context.digest.slice(0, 16)}   run ${r.run.digest.slice(0, 16)}   record ${r.digest.slice(0, 16)}`);
  if (r.run.stop) out(`  stopped ${r.run.stop.outcome} ${r.run.stop.code}: ${r.run.stop.message}`);
  out('  routing');
  for (const x of r.routing) out(`    ${x.taskId.padEnd(14)} ${x.operation.padEnd(30)} via ${x.tool.padEnd(20)} → ${String(x.selected).padEnd(18)} ranked ${x.ranked.join(', ') || '-'}  (${x.passedOver.length} passed over)`);
  out('  tasks');
  for (const t of r.run.tasks) {
    const why = t.reason ? `  ${t.reason.code}: ${t.reason.message}` : t.approval && !t.approval.decision ? `  approvers: ${t.approval.eligibleRoles.join(', ') || 'none may read it'}` : '';
    const inputs = t.inputs.length ? `  ← ${t.inputs.map((i) => `${i.from} ${i.status}`).join(', ')}` : '';
    out(`    ${t.id.padEnd(14)} ${t.state.padEnd(18)} ${(t.agent?.id ?? '-').padEnd(18)} ${t.outputDigest ? t.outputDigest.slice(0, 12) : '-'.padEnd(12)}${inputs}${why}`);
  }
  out('  execution log');
  for (const e of r.log) out(`    ${String(e.seq).padStart(3)} ${e.type.padEnd(22)} ${(e.taskId ?? '').padEnd(14)} ${(e.code ?? '').padEnd(24)} ${e.detail}`);
  if (withTrace) {
    out('  run trace');
    for (const e of r.run.trace) out(`    ${String(e.seq).padStart(3)} ${e.type.padEnd(26)} ${(e.taskId ?? '').padEnd(14)} ${(e.code ?? '').padEnd(24)} ${e.detail}`);
  }
}

function report(r: ExecutionResult): never {
  if (r.status === 'REFUSED') {
    out(`refused ${r.refusal.code}${r.refusal.cause ? ` (${r.refusal.cause})` : ''}: ${r.refusal.message}`);
    if (r.record) printRecord(r.record);
    process.exit(2);
  }
  out(r.status.toLowerCase());
  printRecord(r.record);
  process.exit(0);
}

const operatorFlags = () => {
  const userId = flag('operator');
  const role = flag('role');
  if (!userId || !role) fail('name yourself: --operator <lab-user> --role <ROLE>');
  return { userId: userId as string, role: role as string };
};

switch (command) {
  case 'submit': {
    const file = positional[0];
    if (!file) fail('usage: submit <request.json>');
    const size = fs.statSync(file).size;
    if (size > EXECUTION_LIMITS.maxRequestBytes) fail(`refused REQUEST_TOO_LARGE: ${file} is ${size} bytes; at most ${EXECUTION_LIMITS.maxRequestBytes}`, 2);
    let request: unknown;
    try { request = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`refused REQUEST_INVALID: ${file} is not JSON`, 2); }
    report(submitExecution(request, deps));
    break;
  }
  case 'run': {
    // A definition, run step by step through the commands above, into this store: a genuine LAB execution.
    const file = positional[0];
    if (!file) fail('usage: run <lab/orchestrator/definitions/<name>.json>');
    const at = path.relative(path.join(__dirname, '..', '..'), path.resolve(file)).split(path.sep).join('/');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { fail(`refused DEFINITION_UNKNOWN: ${file} cannot be read`, 2); }
    const parsed = parseDefinition(text, at);
    if ('reason' in parsed) fail(`refused DEFINITION_INVALID: ${parsed.reason}`, 2);
    const def = parsed as Exclude<typeof parsed, { reason: string }>;
    const r = applyDefinition(def.definition, deps, {
      engaged: (reason) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(killFile, `${JSON.stringify({ engaged: true, reason })}\n`); },
      released: () => { if (fs.existsSync(killFile)) fs.unlinkSync(killFile); },
    });
    for (const st of r.steps) out(`  ${String(st.n).padStart(2)}. ${st.action.padEnd(20)} ${st.status}${st.code ? ` ${st.code}` : ''}${st.status === st.expected.status && st.code === st.expected.code ? '' : `   expected ${st.expected.status}${st.expected.code ? ` ${st.expected.code}` : ''}`}`);
    if (!r.ok) { out(`refused DEFINITION_NOT_AS_WRITTEN: ${r.reason}`); if (r.record) printRecord(r.record); process.exit(2); }
    out(`ran ${at} (${def.digest.slice(0, 16)}) as written`);
    printRecord(r.record);
    process.exit(0);
    break;
  }
  case 'decide': {
    const [id, taskId, decision] = positional;
    const by = flag('by');
    const role = flag('role');
    if (!id || !taskId || !decision || !by || !role) fail('usage: decide <execution-id> <task-id> APPROVED|REJECTED --by <lab-user> --role <ROLE> [--club <lab-club>]');
    report(decideExecution(id, { taskId, decision, by: { userId: by, role, clubId: flag('club') } }, deps));
    break;
  }
  case 'cancel': {
    const id = positional[0];
    if (!id) fail('usage: cancel <execution-id> --operator <lab-user> --role <ROLE>');
    report(cancelExecution(id, operatorFlags(), deps));
    break;
  }
  case 'show': case 'verify': {
    const id = positional[0];
    if (!id) fail(`usage: ${command} <execution-id>`);
    let r: ExecutionRecord | null = null;
    try { r = deps.store.get(id); } catch (e) { fail(`refused EXECUTION_TAMPERED: ${e instanceof Error ? e.message : String(e)}`, 2); }
    if (!r) fail(`refused EXECUTION_UNKNOWN: no LAB execution is recorded as "${id}"`, 2);
    const record = r as ExecutionRecord;
    const check = verifyExecution(record);
    if (command === 'show') { printRecord(record, rest.includes('--trace')); out(`  integrity ${check.ok ? 'verified' : `NOT verified: ${check.reasons.join('; ')}`}`); process.exit(check.ok ? 0 : 2); }
    out(`execution ${id}: ${check.ok ? 'verified (record digest, both chains, plan, routing and states agree)' : `NOT verified: ${check.reasons.join('; ')}`}`);
    const candidate = publicationCandidate(record, deps.operations);
    out(`publication: ${candidate.evidence ? 'a candidate production\'s verifier accepts; not published (that is a separate, approved step)' : `not a candidate: ${candidate.reasons.join('; ')}`}`);
    process.exit(check.ok ? 0 : 2);
    break;
  }
  case 'list': {
    for (const id of deps.store.list()) {
      try {
        const r = deps.store.get(id) as ExecutionRecord;
        out(`${id}  ${r.run.outcome.padEnd(18)} ${r.planId.padEnd(24)} ${r.operator.userId}  ${verifyExecution(r).ok ? 'verified' : 'NOT verified'}`);
      } catch { out(`${id}  unreadable`); }
    }
    out(`kill switch ${killSwitchEngaged() ? `engaged: ${killSwitchReason()}` : 'released'}`);
    process.exit(0);
    break;
  }
  case 'kill-switch': {
    const action = positional[0];
    if (action === 'status') { out(killSwitchEngaged() ? `engaged: ${killSwitchReason()}` : 'released'); process.exit(0); }
    const who = operatorFlags();
    if (action === 'engage') {
      const a = engageLabKillSwitch(who, flag('reason') ?? 'engaged in the Lab', deps);
      if (a.status === 'REFUSED') fail(`refused ${a.code}: ${a.message}`, 2);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(killFile, `${JSON.stringify({ engaged: true, reason: a.message })}\n`);
      out(`engaged: ${a.message}`);
      out(`halted ${a.halted.length} execution(s) that had not settled${a.halted.length ? `: ${a.halted.join(', ')}` : ''}`);
      if (a.unreadable.length) out(`unreadable, left as they are: ${a.unreadable.join(', ')}`);
      process.exit(0);
    }
    if (action === 'release') {
      // Only the Platform Owner's operator releases it, and releasing resumes nothing.
      const a = releaseLabKillSwitch(who);
      if (a.status === 'REFUSED') fail(`refused ${a.code}: ${a.message}`, 2);
      if (fs.existsSync(killFile)) fs.unlinkSync(killFile);
      out(a.message);
      process.exit(0);
    }
    fail('usage: kill-switch status | engage --reason <text> | release   --operator <lab-user> --role <ROLE>');
    break;
  }
  case 'demo': {
    if (killSwitchEngaged()) fail('refused KILL_SWITCH: release the LAB kill switch before the demonstration', 2);
    for (const s of runDemonstration()) {
      out(`\n${s.slug}: ${s.title}`);
      const task = (t: { id: string; state: string; agent: string | null; reason: string | null }) => out(`        ${t.id.padEnd(14)} ${t.state.padEnd(18)} ${(t.agent ?? '-').padEnd(18)} ${t.reason ?? ''}`);
      for (const st of s.steps) {
        out(`  · ${st.action}: ${st.status}${st.code ? ` ${st.code}` : ''}${st.outcome ? ` → ${st.outcome}` : ''}${st.detail ? `\n      ${st.detail}` : ''}`);
        st.tasks.forEach(task);
      }
      out('    where it ended');
      s.tasks.forEach(task);
      if (s.executionId) out(`    ${s.executionId}  record ${String(s.digest).slice(0, 16)}  ${s.verified ? 'verified' : 'NOT verified'}`);
    }
    process.exit(0);
    break;
  }
  default:
    fail('usage: submit | decide | cancel | show | verify | list | kill-switch | demo   (see the head of lab/orchestrator/execute-cli.ts)');
}
