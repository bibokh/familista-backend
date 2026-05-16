// Familista — Global Investor Layer
// File location: src/services/investor-performance.service.ts
//
// Portfolio analytics: per-investor positions, ROI/IRR estimation, dashboard
// aggregates, entity roll-ups (revenue/clubs/players across descendants).

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { NotFoundError } from '../utils/errors';
import { getDescendantUnitIds } from './franchise-unit.service';
import type {
  InvestorActor,
  InvestorDashboard,
  InvestorPortfolioPosition,
} from '../types/investor.types';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function yearsBetween(a: Date, b: Date): number {
  return Math.max(0.001, (b.getTime() - a.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
}

// Annualised return given commit date, funded amount, current value (mark-to-market
// plus realised distributions). Falls back to null if data is insufficient.
function estimateIrr(committedDate: Date, totalIn: number, totalOut: number): number | null {
  if (totalIn <= 0) return null;
  const years = yearsBetween(committedDate, new Date());
  const multiple = totalOut / totalIn;
  if (multiple <= 0) return -1;
  // CAGR proxy — good enough for dashboard estimation; full IRR requires per-cashflow timing
  return Math.pow(multiple, 1 / years) - 1;
}

async function markToMarket(
  entityId: string,
  shareClassId: string | null,
  shares: number | null,
): Promise<number | null> {
  if (shares == null || shares <= 0) return null;

  const entity = await prisma.investmentEntity.findUnique({
    where: { id: entityId },
    select: { currentValuation: true, totalSharesIssued: true, fullyDilutedShares: true },
  });
  if (!entity) return null;

  void shareClassId;

  const fd = Math.max(entity.fullyDilutedShares, entity.totalSharesIssued);
  if (!entity.currentValuation || fd <= 0) return null;

  return round2((shares / fd) * entity.currentValuation);
}

// ─────────────────────────────────────────────────────────────────────────────
// Portfolio + dashboard
// ─────────────────────────────────────────────────────────────────────────────

export async function getInvestorPortfolio(investorId: string): Promise<InvestorPortfolioPosition[]> {
  const investments = await prisma.investment.findMany({
    where: { investorId },
    include: {
      entity: { select: { id: true, name: true, type: true } },
      shareClass: { select: { id: true, name: true, code: true } },
    },
    orderBy: { commitDate: 'desc' },
  });

  const positions: InvestorPortfolioPosition[] = [];
  for (const inv of investments) {
    const distributions = await prisma.investorDistribution.aggregate({
      where: { investmentId: inv.id, status: { in: ['COMPUTED', 'PAID'] } },
      _sum: { amount: true },
    });
    const realized = distributions._sum.amount ?? 0;

    const captableSharesAgg = await prisma.capTableEntry.aggregate({
      where: { entityId: inv.entityId, investorId, originalInvestmentId: inv.id, effectiveTo: null },
      _sum: { shares: true },
    });
    const shares = captableSharesAgg._sum.shares;

    const currentValue = inv.status === 'EXITED'
      ? null
      : await markToMarket(inv.entityId, inv.shareClassId, shares);

    const totalIn = inv.fundedAmount > 0 ? inv.fundedAmount : inv.committedAmount;
    const totalOut = realized + (currentValue ?? 0);
    const unrealizedGain = currentValue != null ? round2(currentValue - totalIn + realized) : null;
    const irr = inv.fundedDate ? estimateIrr(inv.fundedDate, totalIn, totalOut) : null;
    const multiple = totalIn > 0 ? round2(totalOut / totalIn) : null;

    // Compute equity percent if applicable
    let equityPercent: number | null = null;
    if (shares && shares > 0) {
      const entityShares = await prisma.investmentEntity.findUnique({
        where: { id: inv.entityId },
        select: { totalSharesIssued: true, fullyDilutedShares: true },
      });
      const denom = Math.max(entityShares?.fullyDilutedShares ?? 0, entityShares?.totalSharesIssued ?? 0);
      if (denom > 0) equityPercent = round2((shares / denom) * 100);
    }

    positions.push({
      investmentId: inv.id,
      entityId: inv.entityId,
      entityName: inv.entity.name,
      entityType: inv.entity.type,
      instrumentType: inv.instrumentType,
      status: inv.status,
      committedAmount: round2(inv.committedAmount),
      fundedAmount: round2(inv.fundedAmount),
      currency: inv.currency,
      currentValue,
      unrealizedGain,
      realizedDistributions: round2(realized),
      netIrr: irr != null ? round2(irr * 100) / 100 : null,
      multiple,
      commitDate: inv.commitDate,
      shareClass: inv.shareClass?.code ?? null,
      shares,
      equityPercent,
    });
  }

  return positions;
}

export async function getInvestorDashboard(investorId: string): Promise<InvestorDashboard> {
  const investor = await prisma.investorProfile.findUnique({ where: { id: investorId } });
  if (!investor) throw new NotFoundError('Investor not found');

  const positions = await getInvestorPortfolio(investorId);

  const totals = positions.reduce(
    (acc, p) => {
      acc.committed += p.committedAmount;
      acc.funded += p.fundedAmount;
      acc.currentValue += p.currentValue ?? 0;
      acc.realizedDistributions += p.realizedDistributions;
      return acc;
    },
    { committed: 0, funded: 0, currentValue: 0, realizedDistributions: 0 },
  );

  const netReturn = totals.currentValue + totals.realizedDistributions - totals.funded;
  const multiple = totals.funded > 0 ? round2((totals.currentValue + totals.realizedDistributions) / totals.funded) : null;

  const [inflowAgg, lastDistribution, governance, expansion] = await Promise.all([
    prisma.investorDistribution.aggregate({
      where: { investorId, status: 'PAID' },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.investorDistribution.findFirst({
      where: { investorId, status: 'PAID' },
      orderBy: { paidAt: 'desc' },
      select: { paidAt: true },
    }),
    Promise.all([
      prisma.boardSeat.count({ where: { investorId, isActive: true } }),
      prisma.investorRight.count({ where: { investorId, isActive: true } }),
      prisma.investmentAgreement.count({ where: { investorId, status: 'EXECUTED' } }),
    ]),
    Promise.all([
      prisma.investment.count({ where: { investorId, linkedFranchiseUnitId: { not: null } } }),
      prisma.investment.count({ where: { investorId, linkedClubId: { not: null } } }),
      prisma.investment.count({
        where: { investorId, entity: { type: 'ACADEMY' } },
      }),
    ]),
  ]);

  return {
    investorId,
    investorName: investor.displayName,
    asOf: new Date(),

    totals: {
      committed: round2(totals.committed),
      funded: round2(totals.funded),
      currentValue: round2(totals.currentValue),
      realizedDistributions: round2(totals.realizedDistributions),
      unrealizedGain: round2(totals.currentValue + totals.realizedDistributions - totals.funded),
      netReturn: round2(netReturn),
      multiple,
      currency: positions[0]?.currency ?? 'EUR',
    },

    positions,

    cashFlow: {
      inflowsTotal: round2(inflowAgg._sum.amount ?? 0),
      inflowsCount: inflowAgg._count._all,
      lastDistributionAt: lastDistribution?.paidAt ?? null,
      nextEstimatedAt: null,
    },

    governance: {
      boardSeats: governance[0],
      rights: governance[1],
      activeAgreements: governance[2],
    },

    expansion: {
      franchiseUnits: expansion[0],
      clubs: expansion[1],
      academies: expansion[2],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity roll-up — total clubs, players, revenue across descendants
// ─────────────────────────────────────────────────────────────────────────────

export async function getEntityRollUp(entityId: string, opts?: { from?: Date; to?: Date }) {
  const entity = await prisma.investmentEntity.findUnique({ where: { id: entityId } });
  if (!entity) throw new NotFoundError('Entity not found');

  const from = opts?.from ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const to = opts?.to ?? new Date();

  let scopeFranchiseUnitIds: Set<string> | null = null;
  if (entity.type === 'FRANCHISE_UNIT' && entity.franchiseUnitId) {
    scopeFranchiseUnitIds = await getDescendantUnitIds([entity.franchiseUnitId]);
  } else if (entity.type === 'CLUB' && entity.clubId) {
    scopeFranchiseUnitIds = null;
  }

  const [clubs, players, users, revenueAgg] = await Promise.all([
    entity.clubId
      ? prisma.club.count({ where: { id: entity.clubId } })
      : scopeFranchiseUnitIds
        ? prisma.club.count({ where: ({ franchiseUnitId: { in: Array.from(scopeFranchiseUnitIds) } } as unknown) as Prisma.ClubWhereInput })
        : 0,
    entity.clubId
      ? prisma.player.count({ where: { clubId: entity.clubId } })
      : scopeFranchiseUnitIds
        ? prisma.player.count({ where: { club: ({ franchiseUnitId: { in: Array.from(scopeFranchiseUnitIds) } } as unknown) as Prisma.ClubWhereInput } })
        : 0,
    entity.clubId
      ? prisma.user.count({ where: { clubId: entity.clubId } })
      : scopeFranchiseUnitIds
        ? prisma.user.count({ where: { club: ({ franchiseUnitId: { in: Array.from(scopeFranchiseUnitIds) } } as unknown) as Prisma.ClubWhereInput } })
        : 0,
    prisma.revenueDistribution.aggregate({
      where: {
        unitId: scopeFranchiseUnitIds ? { in: Array.from(scopeFranchiseUnitIds) } : undefined,
        clubId: entity.clubId ?? undefined,
        status: { in: ['COMPUTED', 'EXECUTED'] },
        computedAt: { gte: from, lte: to },
      },
      _sum: { sourceAmount: true },
      _count: { _all: true },
    }),
  ]);

  return {
    entityId,
    entityName: entity.name,
    entityType: entity.type,
    from,
    to,
    clubs,
    players,
    users,
    revenueTotal: round2(revenueAgg._sum.sourceAmount ?? 0),
    revenueEventCount: revenueAgg._count._all,
    currentValuation: entity.currentValuation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// InvestorActor type is imported for future telemetry hooks (no-op reference
// keeps the import live in case it gets tree-shaken).
// ─────────────────────────────────────────────────────────────────────────────

export type _ActorRef = InvestorActor;
