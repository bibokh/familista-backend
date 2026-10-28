// Execution definitions — a controlled execution, written down so that it can be run again
// ─────────────────────────────────────────────────────────────────────────────
// An AI-0.4 execution is a request and the operator steps that followed it:
// decisions, cancellations, the kill switch. A definition
// (familista.lab-definition/v1) is exactly that, in one reviewed file
// under lab/orchestrator/definitions/, with what each step must be answered.
//
//   applyDefinition    runs it through the AI-0.4 functions the lab:execute
//                      CLI calls (submitExecution, decideExecution,
//                      cancelExecution, the kill switch), in a store the caller
//                      gives, and fails on the first answer it did not expect
//
// Nothing in a definition is trusted to describe what happened: it holds only
// inputs (a synthetic plan, who did what, and when) and the answers expected,
// and the record is whatever the engine computes from them. The same
// definition over the same source gives the same record, byte for byte: the
// record holds no clock and no random value. That is what replay.ts and the
// publication gate rely on.

import { z } from 'zod';
import { engageKillSwitch, killSwitchEngaged, releaseKillSwitch } from '../../src/platform/intelligence/agents';
import { EXECUTION_OUTCOMES } from '../../src/platform/agents/execution-evidence';
import { DEFINITION_PATH, EXECUTION_DEFINITION_CONTRACT } from '../../src/platform/agents/execution-provenance';
import { digestOf } from '../../src/platform/agents/trace-chain';
import { ApprovalDecisionSchema } from './contracts';
import {
  cancelExecution, decideExecution, ExecutionOperatorSchema, ExecutionRequestSchema, haltOpenExecutions, submitExecution,
  type ExecutionDeps, type ExecutionOperator, type ExecutionRecord, type ExecutionResult,
} from './execution';
import { authorizeOperator, LAB_OPERATORS, type LabOperator } from './operators';

export { EXECUTION_DEFINITION_CONTRACT, DEFINITION_PATH };
export const DEFINITION_LIMITS = Object.freeze({ maxSteps: 16, maxBytes: 65_536 });

const Expect = z.object({
  status: z.enum(['ACCEPTED', 'REPLAYED', 'UPDATED', 'REFUSED', 'ENGAGED', 'RELEASED']),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/).nullable(),
}).strict();

const StepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('decide'), decision: ApprovalDecisionSchema, expect: Expect }).strict(),
  z.object({ action: z.literal('cancel'), operator: ExecutionOperatorSchema, expect: Expect }).strict(),
  z.object({ action: z.literal('kill-switch-engage'), operator: ExecutionOperatorSchema, reason: z.string().min(1).max(120), expect: Expect }).strict(),
  z.object({ action: z.literal('kill-switch-release'), operator: ExecutionOperatorSchema, expect: Expect }).strict(),
]);

export const ExecutionDefinitionSchema = z.object({
  contract: z.literal(EXECUTION_DEFINITION_CONTRACT),
  /** The file's own name, without `.json`. */
  name: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/),
  title: z.string().min(1).max(120),
  purpose: z.string().min(1).max(600),
  /** An AI-0.4 execution request, submitted as it stands. */
  request: ExecutionRequestSchema,
  steps: z.array(StepSchema).max(DEFINITION_LIMITS.maxSteps),
  expect: z.object({ submit: Expect, outcome: z.enum(EXECUTION_OUTCOMES) }).strict(),
}).strict();
export type ExecutionDefinition = z.infer<typeof ExecutionDefinitionSchema>;
export type DefinitionStep = ExecutionDefinition['steps'][number];

/** What a definition's digest covers: its JSON, canonically. A reformatted file is the same definition; an edited one is not. */
export const definitionDigest = (definition: unknown): string => digestOf(definition);

const firstIssue = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) => {
  const i = e.issues[0];
  return i ? `${i.path.map(String).join('.') || '(root)'}: ${i.message}` : 'invalid';
};

/** Parse a definition file's text, and check it is the file it says it is. */
export function parseDefinition(text: string, filePath?: string): { definition: ExecutionDefinition; digest: string } | { reason: string } {
  if (text.length > DEFINITION_LIMITS.maxBytes) return { reason: `the definition is ${text.length} bytes; at most ${DEFINITION_LIMITS.maxBytes}` };
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { reason: 'the definition is not JSON' }; }
  const parsed = ExecutionDefinitionSchema.safeParse(json);
  if (!parsed.success) return { reason: `definition: ${firstIssue(parsed.error)}` };
  if (filePath !== undefined && DEFINITION_PATH.exec(filePath)?.[1] !== parsed.data.name) {
    return { reason: `definition ${parsed.data.name} is not at lab/orchestrator/definitions/${parsed.data.name}.json (${filePath})` };
  }
  return { definition: parsed.data, digest: definitionDigest(json) };
}

// ── the kill switch, as the lab:execute CLI operates it ────────────────────────

export interface KillSwitchAnswer { status: 'ENGAGED' | 'RELEASED' | 'REFUSED'; code: string | null; message: string; halted: string[]; unreadable: string[] }

/** Any LAB operator may engage it; every execution that has not settled halts. */
export function engageLabKillSwitch(who: ExecutionOperator, reason: string, deps: ExecutionDeps, operators: readonly LabOperator[] = LAB_OPERATORS): KillSwitchAnswer {
  if (!operators.some((o) => o.userId === who.userId && o.role === who.role)) {
    return { status: 'REFUSED', code: 'OPERATOR_UNKNOWN', message: `${who.userId} (${who.role}) is not a LAB operator`, halted: [], unreadable: [] };
  }
  const text = `${reason} (by ${who.userId})`;
  engageKillSwitch(text);
  const swept = haltOpenExecutions(deps);
  return { status: 'ENGAGED', code: null, message: text, ...swept };
}

/** Only the Platform Owner's operator releases it, and releasing resumes nothing. */
export function releaseLabKillSwitch(who: ExecutionOperator, operators: readonly LabOperator[] = LAB_OPERATORS): KillSwitchAnswer {
  if (!operators.some((o) => o.userId === who.userId && o.role === who.role)) {
    return { status: 'REFUSED', code: 'OPERATOR_UNKNOWN', message: `${who.userId} (${who.role}) is not a LAB operator`, halted: [], unreadable: [] };
  }
  const denied = authorizeOperator(operators, who, 'CANCEL', { kind: 'PLATFORM' });
  if (denied) return { status: 'REFUSED', code: denied.code, message: `only the Platform Owner's operator releases the kill switch (${denied.message})`, halted: [], unreadable: [] };
  releaseKillSwitch();
  return { status: 'RELEASED', code: null, message: 'released; halted executions stay halted: submit again to continue', halted: [], unreadable: [] };
}

// ── running a definition ──────────────────────────────────────────────────────

export interface AppliedStep { n: number; action: 'submit' | DefinitionStep['action']; status: string; code: string | null; expected: { status: string; code: string | null } }

export type ApplyResult =
  | { ok: true; record: ExecutionRecord; steps: AppliedStep[] }
  | { ok: false; reason: string; steps: AppliedStep[]; record: ExecutionRecord | null };

/** Called when the kill switch changes, so the CLI can keep its state file; replays keep nothing. */
export interface KillSwitchHooks { engaged?: (reason: string) => void; released?: () => void }

const answerOf = (r: ExecutionResult) => ({ status: r.status, code: r.status === 'REFUSED' ? r.refusal.code : null });

/**
 * Run `definition` through the AI-0.4 functions, in `deps.store`, step by
 * step, and stop at the first answer it does not expect. The caller owns the
 * kill switch: it must be released when this starts.
 */
export function applyDefinition(definition: ExecutionDefinition, deps: ExecutionDeps, hooks: KillSwitchHooks = {}): ApplyResult {
  const steps: AppliedStep[] = [];
  const check = (n: number, action: AppliedStep['action'], got: { status: string; code: string | null }, expected: { status: string; code: string | null }): string | null => {
    steps.push({ n, action, status: got.status, code: got.code, expected: { ...expected } });
    return got.status === expected.status && got.code === expected.code ? null
      : `step ${n} (${action}) was answered ${got.status}${got.code ? ` ${got.code}` : ''}; the definition expects ${expected.status}${expected.code ? ` ${expected.code}` : ''}`;
  };
  if (killSwitchEngaged()) return { ok: false, reason: 'the kill switch is engaged: nothing starts, a definition neither', steps, record: null };

  const submitted = submitExecution(definition.request, deps);
  const executionId = submitted.record?.executionId ?? null;
  const first = check(0, 'submit', answerOf(submitted), definition.expect.submit);
  if (first) return { ok: false, reason: first, steps, record: submitted.record };
  if (!executionId) return { ok: false, reason: 'the submission recorded no execution', steps, record: null };

  for (const [i, step] of definition.steps.entries()) {
    const n = i + 1;
    let got: { status: string; code: string | null };
    switch (step.action) {
      case 'decide': got = answerOf(decideExecution(executionId, step.decision, deps)); break;
      case 'cancel': got = answerOf(cancelExecution(executionId, step.operator, deps)); break;
      case 'kill-switch-engage': {
        const a = engageLabKillSwitch(step.operator, step.reason, deps, deps.operators);
        if (a.status === 'ENGAGED') hooks.engaged?.(a.message);
        got = { status: a.status, code: a.code };
        break;
      }
      case 'kill-switch-release': {
        const a = releaseLabKillSwitch(step.operator, deps.operators);
        if (a.status === 'RELEASED') hooks.released?.();
        got = { status: a.status, code: a.code };
        break;
      }
    }
    const wrong = check(n, step.action, got, step.expect);
    if (wrong) return { ok: false, reason: wrong, steps, record: deps.store.get(executionId) };
  }
  const record = deps.store.get(executionId);
  if (!record) return { ok: false, reason: `execution ${executionId} is not in the store`, steps, record: null };
  if (record.run.outcome !== definition.expect.outcome) {
    return { ok: false, reason: `the execution ended ${record.run.outcome}; the definition expects ${definition.expect.outcome}`, steps, record };
  }
  return { ok: true, record, steps };
}
