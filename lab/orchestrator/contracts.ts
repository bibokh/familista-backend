// The orchestration contract — what a plan IS, version 1
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence, AI-0.2 (LAB). A plan is a small, bounded,
// acyclic set of tasks. Each task names one LAB operation (operations.ts) and
// the tasks whose outputs it consumes; the orchestrator (engine.ts) finds the
// registry agent allowed to perform each one (routing.ts), checks every
// handoff between them, stops at every action a person must approve, and
// records each decision in a hash-chained trace (trace.ts).
//
// Versioned from the first day: `contract` names the shape, and a consumer
// written against v1 must still read a v1 plan when v2 exists. The shape may
// grow under a new version; it never changes meaning under this one.
//
// Synthetic by construction: a club or a person in a LAB plan is a `lab-…`
// reference, so no real tenant's id can be placed in one, in the Lab or
// anywhere else.

import { z } from 'zod';
import type { DataClass } from '../../src/platform/intelligence/data-classes';
import type { AIRecordClass } from '../../src/security/ai-read-policy';

import { ORCHESTRATION_CONTRACT } from '../../src/platform/agents/trace-chain';

export { ORCHESTRATION_CONTRACT };

/** Every bound the orchestrator keeps. A plan beyond one is refused before anything runs. */
export const LIMITS = Object.freeze({
  maxTasks: 24,
  maxDependencies: 8,
  maxInputBytes: 8_192,
  maxOutputBytes: 16_384,
  maxTraceEvents: 400,
});

const ID = /^[a-z][a-z0-9-]{1,40}$/;
/** A synthetic LAB tenant or person. Nothing else may appear in a LAB plan. */
export const LAB_REF = /^lab-[a-z0-9][a-z0-9-]{0,40}$/;
/** `<area>.<name>@<version>`, e.g. `tactics.opponent-profile@1`. */
export const OPERATION_KEY = /^[a-z]+\.[a-z][a-z-]{1,40}@[1-9]\d*$/;

export const TaskSpecSchema = z.object({
  id: z.string().regex(ID),
  operation: z.string().regex(OPERATION_KEY),
  input: z.record(z.string(), z.unknown()),
  /** The tasks whose outputs this one consumes. An edge is a data handoff, never only an ordering. */
  dependsOn: z.array(z.string().regex(ID)).max(LIMITS.maxDependencies).default([]),
}).strict();

const LabRef = z.string().regex(LAB_REF);

export const PlanRequestSchema = z.object({
  contract: z.literal(ORCHESTRATION_CONTRACT),
  id: z.string().regex(ID),
  title: z.string().min(1).max(120),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('CLUB'), clubId: LabRef }).strict(),
    z.object({ kind: z.literal('PLATFORM') }).strict(),
  ]),
  requestedBy: z.object({ userId: LabRef, role: z.string().min(1), clubId: LabRef.nullable() }).strict(),
  tasks: z.array(TaskSpecSchema).min(1).max(LIMITS.maxTasks),
}).strict();

export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type PlanRequest = z.infer<typeof PlanRequestSchema>;
export type PlanScope = PlanRequest['scope'];

export const ApprovalDecisionSchema = z.object({
  taskId: z.string().regex(ID),
  decision: z.enum(['APPROVED', 'REJECTED']),
  by: z.object({ userId: LabRef, role: z.string().min(1), clubId: LabRef.nullable() }).strict(),
}).strict();
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * Where a task stands.
 *   PENDING            not yet reached: something it consumes has not succeeded yet
 *   AWAITING_APPROVAL  an action a person must approve before it happens
 *   SUCCEEDED          ran in the Lab, and its output validated
 *   FAILED             ran, or tried to, and did not produce a valid output
 *   REFUSED            not allowed: authorization, kill switch, tenancy, data class
 *   SKIPPED            something it consumes did not succeed, so it never ran
 *   REJECTED           a person declined the action
 *   CANCELLED          the run was stopped before this task finished (AI-0.4):
 *                      an operator cancelled it, or the kill switch, an
 *                      execution limit or a changed security context halted it
 */
export type TaskState = 'PENDING' | 'AWAITING_APPROVAL' | 'SUCCEEDED' | 'FAILED' | 'REFUSED' | 'SKIPPED' | 'REJECTED' | 'CANCELLED';
export const TERMINAL_FAILURES: ReadonlySet<TaskState> = new Set(['FAILED', 'REFUSED', 'SKIPPED', 'REJECTED', 'CANCELLED']);

/** CANCELLED: an operator stopped the run. HALTED: governance stopped it (kill switch, a limit, a changed context). */
export type RunOutcome = 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'AWAITING_APPROVAL' | 'REFUSED' | 'CANCELLED' | 'HALTED';

/** Why a run stopped before it settled on its own (AI-0.4). */
export type StopCode = 'KILL_SWITCH' | 'EXECUTION_LIMIT' | 'APPROVAL_CONTEXT_CHANGED' | 'CANCELLED_BY_OPERATOR';

export type PlanRefusalCode =
  | 'CONTRACT_INVALID' | 'ENVIRONMENT_NOT_LAB' | 'TASK_DUPLICATE' | 'DEPENDENCY_UNKNOWN' | 'DEPENDENCY_SELF'
  | 'CYCLE' | 'OPERATION_UNKNOWN' | 'HANDOFF_UNDECLARED' | 'REQUESTER_SCOPE' | 'REQUESTER_CANNOT_READ'
  | 'NO_ELIGIBLE_AGENT';

export type TaskReasonCode =
  | 'AUTHORIZATION' | 'KILL_SWITCH' | 'CROSS_TENANT' | 'INPUT_TOO_LARGE' | 'INPUT_HEALTH_DATA' | 'INPUT_INVALID'
  | 'HANDOFF_BLOCKED' | 'OPERATION_FAILED' | 'OUTPUT_INVALID' | 'OUTPUT_TOO_LARGE' | 'OUTPUT_MISLABELLED'
  | 'OUTPUT_ABOVE_CEILING' | 'DEPENDENCY_NOT_SUCCEEDED' | 'REJECTED_BY_APPROVER' | StopCode;

export type ApprovalRefusalCode =
  | 'APPROVAL_NOT_PENDING' | 'APPROVER_ROLE' | 'APPROVER_CLUB' | 'SEGREGATION_OF_DUTIES' | 'APPROVER_CANNOT_READ'
  | 'DECISION_INVALID';

export interface Reason<C extends string = string> { code: C; message: string }

export interface TaskApproval {
  /** The roles that may decide it: approvers who may also read everything it writes. */
  eligibleRoles: string[];
  decision: 'APPROVED' | 'REJECTED' | null;
  decidedBy: { userId: string; role: string } | null;
}

export interface TaskOutcome {
  id: string;
  operation: string;
  tool: string;
  state: TaskState;
  agent: { id: string; version: string; digest: string } | null;
  /** The registry agents that could have performed it, in the order routing ranked them. */
  eligibleAgents: string[];
  dataClass: DataClass | null;
  recordClass: AIRecordClass | null;
  output: unknown;
  outputDigest: string | null;
  approval: TaskApproval | null;
  reason: Reason<TaskReasonCode> | null;
  /** Each output this task consumed, in the order it was checked, and whether the handoff was allowed. */
  inputs: Array<{ from: string; status: 'ACCEPTED' | 'BLOCKED' }>;
}
