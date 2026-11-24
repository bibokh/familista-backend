/**
 * Familista Design Studio — the Platform Owner's rollout control (M8a): which clubs the Club Design Studio, and each of
 * its parts, is released to.
 *
 * The studio (`club_design_studio`) is off for every club and plan until the Owner releases it; its four parts follow it
 * (entitlements.ts). Until now the only way to release it was the dormant admin router, so no mounted route could. This
 * control reaches exactly these five keys of a club's limits and nothing else: each is set "on" (a club override that
 * enables it), "off" (one that disables it) or "default" (no override: the club's plan and the flag decide). Changes
 * are single SQL statements on the arrays (atomic, never a read-modify-write), and audited with the club.
 *
 * The Owner's alone: mounted behind authenticate and assertPlatformOwner (src/routes/product-design.routes.ts).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { NotFoundError } from '../../utils/errors';
import { isFeatureEnabled } from '../../services/admin-organization.service';
import { ownerAudit } from '../manufacturing/supplier.service';
import { DESIGN_PARTS, designParts, type DesignPart } from './entitlements';
import { CLUB_DESIGN_FEATURE } from './service';
import type { DesignActor } from './service';

export type RolloutKey = 'studio' | DesignPart;
export type Setting = 'on' | 'off' | 'default';
export const ROLLOUT_KEYS: Readonly<Record<RolloutKey, string>> = Object.freeze({ studio: CLUB_DESIGN_FEATURE, ...DESIGN_PARTS });
const ORDER: RolloutKey[] = ['studio', 'teamKit', 'brandKit', 'manufacturing', 'reviews'];
export const ROLLOUT_CLUB_LIMIT = 500;

function settingsOf(limits: { featuresEnabled: string[]; featuresDisabled: string[] } | null): Record<RolloutKey, Setting> {
  const out = {} as Record<RolloutKey, Setting>;
  for (const k of ORDER) {
    const key = ROLLOUT_KEYS[k];
    out[k] = limits?.featuresDisabled.includes(key) ? 'off' : limits?.featuresEnabled.includes(key) ? 'on' : 'default';
  }
  return out;
}

/** What each club has: its overrides for the five keys and what they amount to, with the same rules the routes enforce. */
async function effectiveOf(clubId: string) {
  const studio = await isFeatureEnabled(clubId, CLUB_DESIGN_FEATURE);
  return { studio, ...(await designParts(clubId)) };
}

export async function listRollout() {
  const clubs = await prisma.club.findMany({
    orderBy: [{ name: 'asc' }, { id: 'asc' }], take: ROLLOUT_CLUB_LIMIT,
    select: { id: true, name: true, plan: true, limits: { select: { featuresEnabled: true, featuresDisabled: true } } },
  });
  const flags = await prisma.featureFlag.findMany({ where: { key: { in: Object.values(ROLLOUT_KEYS) } }, select: { key: true, defaultEnabled: true, enabledForPlans: true } });
  const rows = await Promise.all(clubs.map(async (c) => ({ id: c.id, name: c.name, plan: c.plan, settings: settingsOf(c.limits), effective: await effectiveOf(c.id) })));
  return {
    keys: ORDER.map((k) => {
      const f = flags.find((x) => x.key === ROLLOUT_KEYS[k]);
      // A part's flag not in the database is on where the studio is; the studio's is off (entitlements.ts).
      return { key: k, feature: ROLLOUT_KEYS[k], plans: f ? f.enabledForPlans : [], defaultEnabled: f ? f.defaultEnabled : k !== 'studio', inDatabase: !!f };
    }),
    clubs: rows, truncated: clubs.length === ROLLOUT_CLUB_LIMIT, limit: ROLLOUT_CLUB_LIMIT,
  };
}

/** Sets some of a club's five keys; the others, and every other feature of the club, are left as they are. */
export async function setRollout(actor: DesignActor, clubId: string, changes: Partial<Record<RolloutKey, Setting>>) {
  const keys = ORDER.filter((k) => changes[k] !== undefined);
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { id: true } });
  if (!club) throw new NotFoundError('Club');
  await prisma.$transaction(async (tx) => {
    const before = settingsOf(await tx.organizationLimits.findUnique({ where: { clubId }, select: { featuresEnabled: true, featuresDisabled: true } }));
    await tx.organizationLimits.upsert({ where: { clubId }, create: { clubId }, update: {} });
    for (const k of keys) {
      const key = ROLLOUT_KEYS[k], to = changes[k] as Setting;
      // One statement per key: out of both arrays, then into the one its setting names.
      await tx.$executeRaw(Prisma.sql`UPDATE "OrganizationLimits"
        SET "featuresEnabled"  = CASE WHEN ${to} = 'on'  THEN array_append(array_remove("featuresEnabled", ${key}), ${key})  ELSE array_remove("featuresEnabled", ${key}) END,
            "featuresDisabled" = CASE WHEN ${to} = 'off' THEN array_append(array_remove("featuresDisabled", ${key}), ${key}) ELSE array_remove("featuresDisabled", ${key}) END
        WHERE "clubId" = ${clubId}`);
    }
    const changed = keys.filter((k) => before[k] !== changes[k]).map((k) => ({ key: ROLLOUT_KEYS[k], from: before[k], to: changes[k] }));
    if (changed.length) {
      await ownerAudit(tx, actor, { action: 'design.rollout.changed', resourceType: 'Club', resourceId: clubId, clubId,
        metadata: { changed }, message: 'The Club Design Studio’s release to a club was changed' });
    }
  });
  const limits = await prisma.organizationLimits.findUnique({ where: { clubId }, select: { featuresEnabled: true, featuresDisabled: true } });
  return { club: { id: clubId, settings: settingsOf(limits), effective: await effectiveOf(clubId) } };
}
