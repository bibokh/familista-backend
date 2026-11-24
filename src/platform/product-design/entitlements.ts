/**
 * Familista Design Studio — what a club's plan includes (M7a). Entitlements are configuration, enforced on the server;
 * no price is invented or shown here.
 *
 * `club_design_studio` is the studio itself, off for every club and plan until the Platform Owner releases it
 * (isFeatureEnabled: a club override, then the club's plan, then the flag's default; a flag not in the database is off).
 * Inside it, three parts can each be restricted by plan or by a club override:
 *   club_design_team_kit       team rosters, collections and their order sheet (M3)
 *   club_design_brand_kit      the brand kit: colours and logos (M2c)
 *   club_design_manufacturing  requests for quotation and orders (M4)
 *   club_design_reviews        comments on a saved version, and a club administrator's approval (M7b)
 * A part is evaluated in the same order as any feature, with one difference: a part whose flag is not in the database is
 * on, since it is part of a studio the club is already entitled to. So the parts change nothing until the Owner sets
 * them, and a part is never on where the studio is off.
 */
import { prisma } from '../../config/database';
import { isFeatureEnabled } from '../../services/admin-organization.service';
import { CLUB_DESIGN_FEATURE } from './service';

export const DESIGN_PARTS = Object.freeze({
  teamKit: 'club_design_team_kit',
  brandKit: 'club_design_brand_kit',
  manufacturing: 'club_design_manufacturing',
  reviews: 'club_design_reviews',
} as const);
export type DesignPart = keyof typeof DESIGN_PARTS;
export interface DesignParts { teamKit: boolean; brandKit: boolean; manufacturing: boolean; reviews: boolean }
export const NO_PARTS: Readonly<DesignParts> = Object.freeze({ teamKit: false, brandKit: false, manufacturing: false, reviews: false });

/** Whether one part is included for the club, assuming the studio is (the caller checks the studio). */
export async function designPartEnabled(clubId: string, part: DesignPart): Promise<boolean> {
  const key = DESIGN_PARTS[part];
  const limits = await prisma.organizationLimits.findUnique({ where: { clubId }, select: { featuresEnabled: true, featuresDisabled: true } });
  if (limits?.featuresDisabled.includes(key)) return false;
  if (limits?.featuresEnabled.includes(key)) return true;
  const flag = await prisma.featureFlag.findUnique({ where: { key }, select: { defaultEnabled: true, enabledForPlans: true } });
  if (!flag) return true;
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { plan: true } });
  if (!club) return false;
  return flag.enabledForPlans.includes(club.plan) || flag.defaultEnabled;
}

/** Every part, for the session's capabilities: all off where the studio is off. */
export async function designParts(clubId: string): Promise<DesignParts> {
  if (!(await isFeatureEnabled(clubId, CLUB_DESIGN_FEATURE))) return { ...NO_PARTS };
  const [teamKit, brandKit, manufacturing, reviews] = await Promise.all([
    designPartEnabled(clubId, 'teamKit'), designPartEnabled(clubId, 'brandKit'), designPartEnabled(clubId, 'manufacturing'), designPartEnabled(clubId, 'reviews'),
  ]);
  return { teamKit, brandKit, manufacturing, reviews };
}
