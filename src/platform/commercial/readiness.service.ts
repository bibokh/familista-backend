/**
 * Familista commercial experience (P8) — what is ready, measured rather than claimed.
 *
 *   gettingStarted(t)   a workspace's own first steps, from its own records: a saved design, brand colours, a roster, a
 *                       collection, a quotation request (and, for a creator, a confirmed address)
 *   publicOffer()       what the Creator Studio's sign-in page may show anyone: the plans on offer to creators and which
 *                       external services are configured. Nothing about any account, club, supplier or person.
 *   ownerReadiness()    the Platform Owner's view of what commercial access still depends on: email, payments,
 *                       verified suppliers, plans, creators and clubs the studio is released to
 *
 * Every figure is a count of what the database holds or a configuration the server reads; nothing is estimated.
 */
import { CreatorStatus, ManufacturingSupplierStatus, PlanAudience } from '@prisma/client';
import { prisma } from '../../config/database';
import { runAsSystem } from '../../security/db-context';
import { emailConfiguration } from '../email/service';
import { tenantWhere, type Tenant } from '../tenancy/tenant';
import { paymentsConfiguration } from './payment-provider';
import { entitlementsFor, offeredPlans } from './plans.service';

/** A workspace's first steps, each done or not, from its own records (row-level security holds them to it). */
export async function gettingStarted(t: Tenant) {
  const w = tenantWhere(t);
  const [designs, kit, rosters, collections, requests, entitlements, creator] = await Promise.all([
    prisma.designProject.count({ where: { ...w, archivedAt: null } }),
    prisma.designBrandKit.findFirst({ where: w, select: { colours: true } }),
    prisma.designRoster.count({ where: { ...w, archivedAt: null } }),
    prisma.designCollection.count({ where: { ...w, archivedAt: null } }),
    prisma.manufacturingRequest.count({ where: w }),
    entitlementsFor(t),
    t.kind === 'creator' ? prisma.creatorAccount.findUnique({ where: { id: t.creatorId }, select: { emailVerifiedAt: true } }) : Promise.resolve(null),
  ]);
  const colours = kit && Array.isArray(kit.colours) ? kit.colours.length : 0;
  return {
    steps: {
      address: t.kind === 'creator' ? !!creator?.emailVerifiedAt : null,
      design: designs > 0, brand: colours > 0, roster: rosters > 0, collection: collections > 0, request: requests > 0,
    },
    counts: { designs, colours, rosters, collections, requests },
    features: entitlements.features,
  };
}

/** The services a customer's experience depends on, as configured now: never a promise about later. */
async function services() {
  const verified = await prisma.manufacturingSupplier.count({ where: { status: ManufacturingSupplierStatus.VERIFIED } });
  return { email: emailConfiguration().configured, payments: paymentsConfiguration().configured, quotations: verified > 0 };
}

/** What the Creator Studio's sign-in page shows anyone: the creator plans on offer and the services configured. */
export async function publicOffer() {
  return runAsSystem('public-offer', async () => {
    const plans = (await offeredPlans(PlanAudience.CREATOR)).map((p) => ({ key: p.key, name: p.name, description: p.description, features: p.features,
      limits: { projects: p.maxProjects, collections: p.maxCollections, shares: p.maxShares }, priceMinor: p.priceMinor, currency: p.currency, interval: p.interval, isDefault: p.isDefault }));
    return { plans, services: await services() };
  });
}

/** The Owner's readiness view: what commercial access depends on, each a count or a configuration. */
export async function ownerReadiness() {
  const [svc, suppliers, plans, creators, released] = await Promise.all([
    services(),
    prisma.manufacturingSupplier.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.commercialPlan.findMany({ where: { active: true }, select: { audience: true, isDefault: true, priceMinor: true } }),
    prisma.creatorAccount.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.organizationLimits.count({ where: { featuresEnabled: { has: 'club_design_studio' } } }),
  ]);
  const bySupplier = Object.fromEntries(suppliers.map((s) => [s.status, s._count._all]));
  const byCreator = Object.fromEntries(creators.map((c) => [c.status, c._count._all]));
  const plansOf = (a: PlanAudience) => plans.filter((p) => p.audience === a);
  return {
    email: { configured: svc.email, provider: emailConfiguration().providerName },
    payments: paymentsConfiguration(),
    suppliers: { verified: bySupplier.VERIFIED ?? 0, prospects: bySupplier.PROSPECT ?? 0, suspended: bySupplier.SUSPENDED ?? 0 },
    plans: {
      creator: plansOf(PlanAudience.CREATOR).length, club: plansOf(PlanAudience.CLUB).length,
      paid: plans.filter((p) => p.priceMinor !== null && p.priceMinor > 0).length,
      creatorDefault: plansOf(PlanAudience.CREATOR).some((p) => p.isDefault), clubDefault: plansOf(PlanAudience.CLUB).some((p) => p.isDefault),
    },
    creators: { active: byCreator[CreatorStatus.ACTIVE] ?? 0, suspended: byCreator[CreatorStatus.SUSPENDED] ?? 0 },
    clubsReleased: released,
  };
}
