/**
 * Familista billing (P6) — subscriptions, invoices and payment state, independent of any payment provider.
 *
 *   free plan (no price, or 0)   requesting it activates it at once; nothing is invoiced
 *   paid plan                    requesting it opens a PENDING subscription and an OPEN invoice for one period; the
 *                                subscription becomes ACTIVE only when a payment provider reports the invoice paid
 *                                (applyPaymentEvent). No provider is configured, so a checkout says so and nothing else.
 *   Owner grant                  the Platform Owner activates a plan for a tenant outright (no invoice), for a number of
 *                                months or open-ended, with a note in the audit
 *   cancel                       a pending subscription ends at once (its open invoice is voided); an active paid one at
 *                                the end of its period; a free one at once; an Owner grant only by the Owner
 *
 * Every change is one transaction with its audit entry. Tax is not computed (taxMinor stays null): which taxes apply is
 * a decision for the Owner's advisers, and an invoice says so rather than inventing a figure.
 */
import { CommercialInvoiceStatus as IS, CommercialSubscriptionSource as SRC, CommercialSubscriptionStatus as SS, PaymentEventStatus, PlanAudience, PlanInterval, Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { runAsSystem } from '../../security/db-context';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { ownerAudit } from '../manufacturing/supplier.service';
import { tenantAudit } from '../product-design/club-audit';
import type { DesignActor } from '../product-design/service';
import { clubTenant, creatorTenant, ownerColumns, tenantOf, tenantWhere, type Tenant } from '../tenancy/tenant';
import { paymentsConfiguration, PaymentsNotConfiguredError, selectPaymentProvider, type VerifiedPaymentEvent } from './payment-provider';
import { entitlementsFor, offeredPlans } from './plans.service';

export class SubscriptionRefusedError extends ConflictError {
  readonly code = 'SUBSCRIPTION_REFUSED';
  constructor(readonly reason: 'unknown-plan' | 'wrong-audience' | 'already-on-plan' | 'active-paid' | 'owner-grant' | 'nothing-to-cancel' | 'not-open' | 'bad-note' | 'bad-months' | 'unknown-tenant' | 'concurrent') {
    super(`subscription refused: ${reason}`);
  }
}

type Tx = Prisma.TransactionClient;
const SUB_SELECT = { id: true, status: true, source: true, currentPeriodStart: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, canceledAt: true, createdAt: true,
  plan: { select: { id: true, key: true, name: true, priceMinor: true, currency: true, interval: true } } } as const;
const INVOICE_SELECT = { id: true, number: true, status: true, currency: true, subtotalMinor: true, taxMinor: true, totalMinor: true, lines: true,
  periodStart: true, periodEnd: true, issuedAt: true, paidAt: true, voidedAt: true, subscriptionId: true } as const;
const audienceOf = (t: Tenant) => (t.kind === 'club' ? PlanAudience.CLUB : PlanAudience.CREATOR);
const isFree = (p: { priceMinor: number | null }) => p.priceMinor === null || p.priceMinor === 0;
function periodEnd(start: Date, interval: PlanInterval | null, months?: number | null): Date | null {
  const d = new Date(start);
  if (months) { d.setUTCMonth(d.getUTCMonth() + months); return d; }
  if (interval === PlanInterval.MONTH) { d.setUTCMonth(d.getUTCMonth() + 1); return d; }
  if (interval === PlanInterval.YEAR) { d.setUTCFullYear(d.getUTCFullYear() + 1); return d; }
  return null;
}
async function audit(tx: Tx, t: Tenant, actor: DesignActor, action: string, resourceId: string, metadata: Record<string, unknown>, message: string) {
  await tenantAudit(tx, t, actor, { action, resourceType: 'CommercialSubscription', resourceId, metadata, message });
}

/** End the tenant's live subscription now (and void its open invoices), inside a change that replaces it. */
async function endLive(tx: Tx, t: Tenant, why: 'CANCELED' | 'EXPIRED' = 'CANCELED'): Promise<string | null> {
  const live = await tx.commercialSubscription.findFirst({ where: { ...tenantWhere(t), status: { in: [SS.PENDING, SS.ACTIVE] } }, select: { id: true } });
  if (!live) return null;
  await tx.commercialInvoice.updateMany({ where: { subscriptionId: live.id, status: IS.OPEN }, data: { status: IS.VOID, voidedAt: new Date() } });
  await tx.commercialSubscription.update({ where: { id: live.id }, data: { status: why, canceledAt: new Date() } });
  return live.id;
}
/**
 * Two changes to one workspace's plan at the same moment: the database keeps one live subscription per workspace (a
 * partial unique index), so the second is refused there. It is answered as the conflict it is, for the reader to see the
 * plan as it now stands, never as a server error.
 */
async function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (err) {
    // In the two transactions this wraps, the only unique rule a concurrent request can meet is that index (invoice
    // numbers come from a sequence, ids are random), and Prisma often names no target for a partial index.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new SubscriptionRefusedError('concurrent');
    throw err;
  }
}
async function nextNumber(tx: Tx): Promise<string> {
  const [{ n }] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('"CommercialInvoice_number_seq"') AS n`;
  return `FAM-${new Date().getUTCFullYear()}-${String(n).padStart(6, '0')}`;
}

/** The tenant's plan, its subscription and invoices, the plans on offer, and whether online payment is available. */
export async function myBilling(t: Tenant) {
  const [entitlements, offered, subscription, invoices] = await Promise.all([
    entitlementsFor(t), offeredPlans(audienceOf(t)),
    prisma.commercialSubscription.findFirst({ where: { ...tenantWhere(t) }, orderBy: { createdAt: 'desc' }, select: SUB_SELECT }),
    prisma.commercialInvoice.findMany({ where: { ...tenantWhere(t) }, orderBy: { issuedAt: 'desc' }, take: 50, select: INVOICE_SELECT }),
  ]);
  return { entitlements, offered, subscription, invoices, payments: { configured: paymentsConfiguration().configured } };
}

/** Ask for a plan: a free one is active at once; a paid one waits for its payment, with an open invoice. */
export async function requestPlan(t: Tenant, actor: DesignActor, planKey: string) {
  const plan = await prisma.commercialPlan.findUnique({ where: { key: String(planKey || '') }, select: { id: true, key: true, name: true, audience: true, active: true, priceMinor: true, currency: true, interval: true } });
  if (!plan || !plan.active) throw new SubscriptionRefusedError('unknown-plan');
  if (plan.audience !== audienceOf(t)) throw new SubscriptionRefusedError('wrong-audience');
  await oneAtATime(() => prisma.$transaction(async (tx) => {
    const live = await tx.commercialSubscription.findFirst({ where: { ...tenantWhere(t), status: { in: [SS.PENDING, SS.ACTIVE] } }, select: { id: true, planId: true, status: true, source: true, plan: { select: { priceMinor: true } } } });
    if (live && live.planId === plan.id) throw new SubscriptionRefusedError('already-on-plan');
    if (live && live.status === SS.ACTIVE && live.source === SRC.OWNER_GRANT) throw new SubscriptionRefusedError('owner-grant');
    if (live && live.status === SS.ACTIVE && !isFree(live.plan)) throw new SubscriptionRefusedError('active-paid');
    await endLive(tx, t);
    const now = new Date();
    if (isFree(plan)) {
      const sub = await tx.commercialSubscription.create({ data: { ...ownerColumns(t), planId: plan.id, status: SS.ACTIVE, source: SRC.SELF, currentPeriodStart: now, createdById: actor.userId }, select: { id: true } });
      await audit(tx, t, actor, 'commercial.subscription.activated', sub.id, { plan: plan.key, free: true }, 'A free plan was chosen and is active');
      return;
    }
    const sub = await tx.commercialSubscription.create({ data: { ...ownerColumns(t), planId: plan.id, status: SS.PENDING, source: SRC.SELF, createdById: actor.userId }, select: { id: true } });
    const end = periodEnd(now, plan.interval) as Date;
    const inv = await tx.commercialInvoice.create({ data: {
      number: await nextNumber(tx), subscriptionId: sub.id, ...ownerColumns(t), currency: plan.currency as string, subtotalMinor: plan.priceMinor as number, taxMinor: null,
      totalMinor: plan.priceMinor as number, periodStart: now, periodEnd: end,
      lines: [{ description: plan.name, plan: plan.key, interval: plan.interval, amountMinor: plan.priceMinor }] as unknown as Prisma.InputJsonValue,
    }, select: { id: true, number: true } });
    await audit(tx, t, actor, 'commercial.subscription.requested', sub.id, { plan: plan.key, invoice: inv.number, totalMinor: plan.priceMinor, currency: plan.currency }, 'A paid plan was requested; its invoice is open');
  }));
  return myBilling(t);
}

/** Cancel the tenant's own subscription: a pending one at once; an active paid one at the end of its period. */
export async function cancelPlan(t: Tenant, actor: DesignActor) {
  await prisma.$transaction(async (tx) => {
    const live = await tx.commercialSubscription.findFirst({ where: { ...tenantWhere(t), status: { in: [SS.PENDING, SS.ACTIVE] } }, select: { id: true, status: true, source: true, currentPeriodEnd: true, plan: { select: { key: true, priceMinor: true } } } });
    if (!live) throw new SubscriptionRefusedError('nothing-to-cancel');
    if (live.source === SRC.OWNER_GRANT) throw new SubscriptionRefusedError('owner-grant');
    if (live.status === SS.ACTIVE && !isFree(live.plan) && live.currentPeriodEnd) {
      await tx.commercialSubscription.update({ where: { id: live.id }, data: { cancelAtPeriodEnd: true } });
      await audit(tx, t, actor, 'commercial.subscription.cancel-scheduled', live.id, { plan: live.plan.key, endsAt: live.currentPeriodEnd.toISOString() }, 'A subscription will end with its period');
      return;
    }
    await endLive(tx, t);
    await audit(tx, t, actor, 'commercial.subscription.canceled', live.id, { plan: live.plan.key, status: live.status }, 'A subscription was cancelled');
  });
  return myBilling(t);
}

/** Pay an open invoice online. With no payment provider configured this always says so; nothing is charged here. */
export async function checkout(t: Tenant, invoiceId: string): Promise<{ url: string }> {
  const inv = await prisma.commercialInvoice.findFirst({ where: { id: invoiceId, ...tenantWhere(t) }, select: { id: true, number: true, status: true, totalMinor: true, currency: true, lines: true } });
  if (!inv) throw new NotFoundError('Invoice');
  if (inv.status !== IS.OPEN) throw new SubscriptionRefusedError('not-open');
  const provider = selectPaymentProvider();
  if (!provider.isConfigured()) throw new PaymentsNotConfiguredError(provider.configurationProblem() ?? '');
  const desc = Array.isArray(inv.lines) && inv.lines[0] && typeof (inv.lines[0] as { description?: unknown }).description === 'string' ? (inv.lines[0] as { description: string }).description : inv.number;
  const s = await provider.createCheckout({ id: inv.id, number: inv.number, totalMinor: inv.totalMinor, currency: inv.currency, description: desc });
  return { url: s.url };
}

/**
 * The only path that settles an invoice: a provider's verified event. Recorded once (a repeated event is answered as
 * already applied); a SUCCEEDED event for exactly the invoice's total and currency marks it PAID and activates its
 * subscription for the invoice's period. The database refuses PAID without the recorded event, whatever calls it.
 */
export async function applyPaymentEvent(e: VerifiedPaymentEvent): Promise<{ applied: boolean; invoice: string | null }> {
  return runAsSystem('payment-events', () => prisma.$transaction(async (tx) => {
    const inv = await tx.commercialInvoice.findUnique({ where: { id: e.invoiceId }, select: { id: true, number: true, status: true, totalMinor: true, currency: true, clubId: true, creatorId: true, subscriptionId: true, periodStart: true, periodEnd: true } });
    if (!inv) throw new NotFoundError('Invoice');
    // A redelivered event is the normal case for webhooks: answer it without provoking the unique index (which still
    // decides a concurrent duplicate below).
    if (await tx.paymentEvent.findFirst({ where: { provider: e.provider, providerEventId: e.providerEventId }, select: { id: true } })) return { applied: false, invoice: inv.number };
    try {
      await tx.paymentEvent.create({ data: { invoiceId: inv.id, clubId: inv.clubId, creatorId: inv.creatorId, provider: e.provider, providerEventId: e.providerEventId, status: e.status as PaymentEventStatus,
        amountMinor: e.amountMinor, currency: e.currency, occurredAt: e.occurredAt } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { applied: false, invoice: inv.number };
      throw err;
    }
    const t = tenantOf(inv);
    // Recorded on the tenant's own audit as the provider's report (for a creator, under the creator's own id).
    const actor = { userId: inv.creatorId ?? 'payment-provider' };
    if (e.status === 'SUCCEEDED' && inv.status === IS.OPEN && e.amountMinor === inv.totalMinor && e.currency === inv.currency) {
      await tx.commercialInvoice.update({ where: { id: inv.id }, data: { status: IS.PAID, paidAt: e.occurredAt } });
      await tx.commercialSubscription.updateMany({ where: { id: inv.subscriptionId, status: { in: [SS.PENDING, SS.ACTIVE] } },
        data: { status: SS.ACTIVE, currentPeriodStart: inv.periodStart, currentPeriodEnd: inv.periodEnd, providerRef: e.providerEventId } });
      await audit(tx, t, actor, 'commercial.invoice.paid', inv.subscriptionId, { invoice: inv.number, provider: e.provider, amountMinor: e.amountMinor, currency: e.currency }, 'An invoice was paid, reported by the payment provider');
      return { applied: true, invoice: inv.number };
    }
    await audit(tx, t, actor, 'commercial.payment.recorded', inv.subscriptionId, { invoice: inv.number, provider: e.provider, status: e.status, amountMinor: e.amountMinor, currency: e.currency }, 'A payment event was recorded without settling the invoice');
    return { applied: false, invoice: inv.number };
  }));
}

// ── the Platform Owner's side ─────────────────────────────────────────────────────────────────────────────────────────

/** Every tenant's subscriptions and invoices, newest first, with the tenant's name. */
export async function ownerOverview() {
  const [subs, invoices] = await Promise.all([
    prisma.commercialSubscription.findMany({ orderBy: { createdAt: 'desc' }, take: 200, select: { ...SUB_SELECT, clubId: true, creatorId: true, note: true } }),
    prisma.commercialInvoice.findMany({ orderBy: { issuedAt: 'desc' }, take: 200, select: { ...INVOICE_SELECT, clubId: true, creatorId: true } }),
  ]);
  const clubIds = [...new Set([...subs, ...invoices].map((x) => x.clubId).filter(Boolean))] as string[];
  const creatorIds = [...new Set([...subs, ...invoices].map((x) => x.creatorId).filter(Boolean))] as string[];
  const [clubs, creators] = await Promise.all([
    prisma.club.findMany({ where: { id: { in: clubIds } }, select: { id: true, name: true } }),
    prisma.creatorAccount.findMany({ where: { id: { in: creatorIds } }, select: { id: true, displayName: true } }),
  ]);
  const name = new Map<string, string | null>([...clubs.map((c) => [c.id, c.name] as [string, string]), ...creators.map((c) => [c.id, c.displayName] as [string, string | null])]);
  const who = (x: { clubId: string | null; creatorId: string | null }) => ({ kind: x.clubId ? 'club' : 'creator', id: (x.clubId ?? x.creatorId) as string, name: name.get((x.clubId ?? x.creatorId) as string) ?? null });
  return { subscriptions: subs.map((s) => ({ ...s, tenant: who(s) })), invoices: invoices.map((i) => ({ ...i, tenant: who(i) })), payments: paymentsConfiguration() };
}

function tenantFrom(kind: unknown, id: unknown): Tenant {
  if (typeof id !== 'string' || !id) throw new SubscriptionRefusedError('unknown-tenant');
  return kind === 'club' ? clubTenant(id) : creatorTenant(id);
}

/** Activate a plan for a tenant outright, for some months or open-ended; any live subscription ends. */
export async function ownerGrant(actor: DesignActor, input: { tenantKind: unknown; tenantId: unknown; planKey: unknown; months?: unknown; note: unknown }) {
  const t = tenantFrom(input.tenantKind, input.tenantId);
  const note = typeof input.note === 'string' ? input.note.normalize('NFC').trim() : '';
  if (note.length < 5 || note.length > 300) throw new SubscriptionRefusedError('bad-note');
  const months = input.months === null || input.months === undefined || input.months === '' ? null : Number(input.months);
  if (months !== null && (!Number.isInteger(months) || months < 1 || months > 36)) throw new SubscriptionRefusedError('bad-months');
  const plan = await prisma.commercialPlan.findUnique({ where: { key: String(input.planKey || '') }, select: { id: true, key: true, audience: true, active: true } });
  if (!plan || !plan.active) throw new SubscriptionRefusedError('unknown-plan');
  if (plan.audience !== audienceOf(t)) throw new SubscriptionRefusedError('wrong-audience');
  const exists = t.kind === 'club' ? await prisma.club.findUnique({ where: { id: t.clubId }, select: { id: true } }) : await prisma.creatorAccount.findFirst({ where: { id: t.creatorId, status: 'ACTIVE' }, select: { id: true } });
  if (!exists) throw new SubscriptionRefusedError('unknown-tenant');
  return oneAtATime(() => prisma.$transaction(async (tx) => {
    await endLive(tx, t);
    const now = new Date();
    const sub = await tx.commercialSubscription.create({ data: { ...ownerColumns(t), planId: plan.id, status: SS.ACTIVE, source: SRC.OWNER_GRANT, currentPeriodStart: now,
      currentPeriodEnd: months ? periodEnd(now, null, months) : null, note, createdById: actor.userId }, select: { id: true } });
    await ownerAudit(tx, actor, { action: 'commercial.subscription.granted', resourceType: 'CommercialSubscription', resourceId: sub.id, clubId: t.kind === 'club' ? t.clubId : null,
      metadata: { plan: plan.key, months, note, creatorId: t.kind === 'creator' ? t.creatorId : null }, message: 'The Platform Owner granted a plan' });
    return { subscription: { id: sub.id } };
  }));
}

/** End any subscription now, with a note. */
export async function ownerEnd(actor: DesignActor, id: string, noteIn: unknown) {
  const note = typeof noteIn === 'string' ? noteIn.normalize('NFC').trim() : '';
  if (note.length < 5 || note.length > 300) throw new SubscriptionRefusedError('bad-note');
  return prisma.$transaction(async (tx) => {
    const s = await tx.commercialSubscription.findUnique({ where: { id }, select: { id: true, status: true, clubId: true, creatorId: true } });
    if (!s) throw new NotFoundError('Subscription');
    if (s.status !== SS.PENDING && s.status !== SS.ACTIVE) throw new SubscriptionRefusedError('nothing-to-cancel');
    await tx.commercialInvoice.updateMany({ where: { subscriptionId: id, status: IS.OPEN }, data: { status: IS.VOID, voidedAt: new Date() } });
    await tx.commercialSubscription.update({ where: { id }, data: { status: SS.CANCELED, canceledAt: new Date() } });
    await ownerAudit(tx, actor, { action: 'commercial.subscription.ended', resourceType: 'CommercialSubscription', resourceId: id, clubId: s.clubId, metadata: { note, creatorId: s.creatorId }, message: 'The Platform Owner ended a subscription' });
    return { ended: true };
  });
}

/** Void an open invoice (its subscription, if pending, is cancelled with it). */
export async function ownerVoid(actor: DesignActor, invoiceId: string) {
  return prisma.$transaction(async (tx) => {
    const inv = await tx.commercialInvoice.findUnique({ where: { id: invoiceId }, select: { id: true, number: true, status: true, subscriptionId: true, clubId: true } });
    if (!inv) throw new NotFoundError('Invoice');
    if (inv.status !== IS.OPEN) throw new SubscriptionRefusedError('not-open');
    await tx.commercialInvoice.update({ where: { id: inv.id }, data: { status: IS.VOID, voidedAt: new Date() } });
    await tx.commercialSubscription.updateMany({ where: { id: inv.subscriptionId, status: SS.PENDING }, data: { status: SS.CANCELED, canceledAt: new Date() } });
    await ownerAudit(tx, actor, { action: 'commercial.invoice.voided', resourceType: 'CommercialInvoice', resourceId: inv.id, clubId: inv.clubId, metadata: { invoice: inv.number }, message: 'An open invoice was voided' });
    return { voided: true };
  });
}

/** Housekeeping: subscriptions past their period end are marked EXPIRED (entitlements already ignore them). */
export async function ownerExpireDue(actor: DesignActor, dryRun: boolean) {
  const due = await prisma.commercialSubscription.findMany({ where: { status: SS.ACTIVE, currentPeriodEnd: { lte: new Date() } }, select: { id: true } });
  if (dryRun || !due.length) return { dryRun, due: due.length };
  await prisma.$transaction(async (tx) => {
    await tx.commercialSubscription.updateMany({ where: { id: { in: due.map((d) => d.id) }, status: SS.ACTIVE }, data: { status: SS.EXPIRED } });
    await ownerAudit(tx, actor, { action: 'commercial.subscription.expired', resourceType: 'CommercialSubscription', resourceId: 'due', metadata: { count: due.length }, message: 'Subscriptions past their period were marked expired' });
  });
  return { dryRun, due: due.length };
}
