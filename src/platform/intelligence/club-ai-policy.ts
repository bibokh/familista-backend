// A club's two switches about its data and AI (Cyber Defense, R3 + R8)
// ─────────────────────────────────────────────────────────────────────────────
//   restrictedEgress  may RESTRICTED data (medical details, health-risk scores,
//                     minors' personal data) be sent to an AI provider for this
//                     club's analyses? Off: the AI Gateway refuses any call that
//                     declares RESTRICTED, and the callers leave it out.
//   trainingUse       may this club's data be used for training — today, its
//                     contributions to federated learning? Off: they are
//                     refused. A minor's RESTRICTED data is excluded even when
//                     it is on.
//
// Both are off until a club administrator turns them on. A missing row reads
// as both off. Every change is appended to the audit chain.

import { prisma } from '../../config/database';
import { appendAuditEventAsync } from '../../security/audit-chain.service';

export interface ClubAiPolicy { restrictedEgress: boolean; trainingUse: boolean }

const OFF: ClubAiPolicy = Object.freeze({ restrictedEgress: false, trainingUse: false });
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; policy: ClubAiPolicy }>();

/** The club's policy; both off when there is no row, when there is no club, or when it cannot be read. */
export async function clubAiPolicy(clubId: string | null | undefined): Promise<ClubAiPolicy> {
  if (!clubId) return OFF;
  const hit = cache.get(clubId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.policy;
  let policy: ClubAiPolicy = OFF;
  try {
    const row = await prisma.clubAiDataPolicy.findUnique({ where: { clubId } });
    if (row) policy = { restrictedEgress: row.restrictedEgress === true, trainingUse: row.trainingUse === true };
  } catch {
    return OFF; // fail closed, and do not cache the failure
  }
  cache.set(clubId, { at: Date.now(), policy });
  return policy;
}

export interface PolicyActor { userId: string; clubId: string; ipAddress?: string | null; userAgent?: string | null }

/** Set either switch for the actor's own club. Authorization (club administrator) is the route's. */
export async function setClubAiPolicy(actor: PolicyActor, patch: Partial<ClubAiPolicy>): Promise<ClubAiPolicy> {
  const data: Partial<ClubAiPolicy> = {};
  if (typeof patch.restrictedEgress === 'boolean') data.restrictedEgress = patch.restrictedEgress;
  if (typeof patch.trainingUse === 'boolean') data.trainingUse = patch.trainingUse;
  const before = await clubAiPolicy(actor.clubId);
  const row = await prisma.clubAiDataPolicy.upsert({
    where: { clubId: actor.clubId },
    create: { clubId: actor.clubId, ...OFF, ...data, updatedById: actor.userId },
    update: { ...data, updatedById: actor.userId },
  });
  const after: ClubAiPolicy = { restrictedEgress: row.restrictedEgress, trainingUse: row.trainingUse };
  cache.set(actor.clubId, { at: Date.now(), policy: after });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: actor.ipAddress ?? null, userAgent: actor.userAgent ?? null },
    action: 'CLUB_AI_POLICY_CHANGED',
    entityType: 'ClubAiDataPolicy',
    entityId: actor.clubId,
    payload: { before, after },
  });
  return after;
}

/** Tests only. */
export function __resetClubAiPolicyCache(): void { cache.clear(); }
