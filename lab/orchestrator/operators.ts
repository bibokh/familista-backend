// LAB operators — who may submit and stop a controlled execution
// ─────────────────────────────────────────────────────────────────────────────
// Global Multi-Agent Intelligence, AI-0.4 (LAB). A controlled execution
// (execution.ts) runs only on an operator's explicit request, and an operator is
// someone this roster names: a synthetic `lab-…` person, the role they hold, the
// scope they may operate in and what they may do there. The roster is code, so
// a grant is added, widened or withdrawn in a reviewed pull request, never at
// run time, and nothing outside the Lab reads it.
//
//   SUBMIT   start an execution of a plan in the operator's scope
//   CANCEL   stop one that has not settled
//
// A PLATFORM operator (the Platform Owner's) may operate any synthetic scope; a
// CLUB operator only plans for their own club. Being an operator never makes a
// person an approver: who may decide an approval is the approver roles' rule,
// and an operator may never approve an execution they submitted.

import { z } from 'zod';
import { LAB_REF } from './contracts';
import type { PlanScope } from './contracts';

export const OPERATOR_PERMISSIONS = ['SUBMIT', 'CANCEL'] as const;
export type OperatorPermission = typeof OPERATOR_PERMISSIONS[number];

export const LabOperatorSchema = z.object({
  userId: z.string().regex(LAB_REF),
  role: z.string().min(1).max(40),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('PLATFORM') }).strict(),
    z.object({ kind: z.literal('CLUB'), clubId: z.string().regex(LAB_REF) }).strict(),
  ]),
  permissions: z.array(z.enum(OPERATOR_PERMISSIONS)).max(OPERATOR_PERMISSIONS.length),
}).strict();
export type LabOperator = z.infer<typeof LabOperatorSchema>;

/** The Lab's operators. Synthetic people; each grant is the least that lets them do their part. */
export const LAB_OPERATORS: readonly LabOperator[] = Object.freeze([
  { userId: 'lab-operator-platform', role: 'SUPER_ADMIN', scope: { kind: 'PLATFORM' }, permissions: ['SUBMIT', 'CANCEL'] },
  { userId: 'lab-user-head-coach', role: 'HEAD_COACH', scope: { kind: 'CLUB', clubId: 'lab-club-north' }, permissions: ['SUBMIT', 'CANCEL'] },
  { userId: 'lab-user-physio', role: 'MEDICAL_STAFF', scope: { kind: 'CLUB', clubId: 'lab-club-north' }, permissions: ['SUBMIT', 'CANCEL'] },
  { userId: 'lab-user-analyst', role: 'ANALYST', scope: { kind: 'CLUB', clubId: 'lab-club-north' }, permissions: [] },
  { userId: 'lab-operator-south', role: 'HEAD_COACH', scope: { kind: 'CLUB', clubId: 'lab-club-south' }, permissions: ['SUBMIT', 'CANCEL'] },
] satisfies LabOperator[]);

/** Every reason this roster is not one the Lab may use. Empty means it is. */
export function validateOperators(roster: readonly unknown[]): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  roster.forEach((entry, i) => {
    const parsed = LabOperatorSchema.safeParse(entry);
    if (!parsed.success) { reasons.push(`operator ${i}: ${parsed.error.issues[0]?.message ?? 'invalid'}`); return; }
    const o = parsed.data;
    if (seen.has(o.userId)) reasons.push(`operator ${o.userId} is listed twice`);
    seen.add(o.userId);
    if (new Set(o.permissions).size !== o.permissions.length) reasons.push(`operator ${o.userId} lists a permission twice`);
    if (o.scope.kind === 'PLATFORM' && o.role !== 'SUPER_ADMIN') reasons.push(`operator ${o.userId}: only the Platform Owner operates the platform scope`);
  });
  return reasons;
}

export type OperatorRefusalCode = 'OPERATOR_UNKNOWN' | 'OPERATOR_ROLE_MISMATCH' | 'OPERATOR_NOT_PERMITTED' | 'OPERATOR_SCOPE';

/** Whether this person may do this in this scope, by the roster; why not, if they may not. */
export function authorizeOperator(
  roster: readonly LabOperator[], who: { userId: string; role: string }, permission: OperatorPermission, scope: PlanScope,
): { code: OperatorRefusalCode; message: string } | null {
  const grant = roster.find((o) => o.userId === who.userId);
  if (!grant) return { code: 'OPERATOR_UNKNOWN', message: `${who.userId} is not a LAB operator` };
  if (grant.role !== who.role) return { code: 'OPERATOR_ROLE_MISMATCH', message: `${who.userId} operates as ${grant.role}, not ${who.role}` };
  if (!grant.permissions.includes(permission)) return { code: 'OPERATOR_NOT_PERMITTED', message: `${who.userId} may not ${permission.toLowerCase()} executions` };
  const covers = grant.scope.kind === 'PLATFORM' || (scope.kind === 'CLUB' && scope.clubId === grant.scope.clubId);
  if (!covers) {
    const target = scope.kind === 'CLUB' ? scope.clubId : 'the platform';
    return { code: 'OPERATOR_SCOPE', message: `${who.userId} operates for ${grant.scope.kind === 'CLUB' ? grant.scope.clubId : 'the platform'}, not ${target}` };
  }
  return null;
}
