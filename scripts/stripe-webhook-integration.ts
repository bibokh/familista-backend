// Familista — Stripe webhook production wiring
// File: src/webhooks/stripe.webhook.ts  (or wherever your existing handler lives)
//
// PASTE THE TWO SNIPPETS BELOW into your existing Stripe webhook handler.
// 1. Snippet A: top-of-file imports + planSource guard for subscription events
// 2. Snippet B: payment_intent.succeeded fan-out to franchise + investor engines
//
// Both snippets are additive — they do NOT replace your existing Financial row
// creation or any other side effects you already perform.

// ─── SNIPPET A: imports + planSource guard ──────────────────────────────────
//
// Add these imports near the top:

import { prisma } from '../lib/prisma';
import { computeAndRecordDistribution } from '../services/franchise-revenue.service';
import { computeRevenueShareAccruals } from '../services/investor-distribution.service';
import {
  getEntityByClub,
  getEntityByFranchiseUnit,
} from '../services/investor-entity.service';

// Helper — call this before mutating Club.plan / Club.subscriptionStatus
// from any Stripe subscription event (customer.subscription.updated, etc.)
async function shouldRespectStripeForClub(clubId: string): Promise<boolean> {
  // Soft cast: `planSource` lives on the Club model after the go-live merge.
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: ({ planSource: true } as unknown) as Record<string, true>,
  });
  const source = (club as unknown as { planSource?: 'STRIPE' | 'OVERRIDE' } | null)?.planSource;
  return source !== 'OVERRIDE';
}

// USAGE example inside your existing customer.subscription.updated handler:
//
//   if (!(await shouldRespectStripeForClub(clubId))) {
//     // Operator override is active — Stripe must not clobber Club.plan/status.
//     return res.status(200).send('skip: planSource=OVERRIDE');
//   }
//   // ...existing club update logic stays here

// ─── SNIPPET B: payment_intent.succeeded fan-out ────────────────────────────
//
// Inside your existing `payment_intent.succeeded` branch — AFTER you've
// looked up the Club from event metadata and inserted/updated the Financial
// row — append this block:

export async function fanOutPaymentToEngines(args: {
  clubId: string;
  amountMinor: number;                 // stripe's integer minor units (e.g. cents)
  currency: string;                    // 'EUR' | 'USD' | ...
  paymentIntentId: string;             // idempotency key
  financialId: string;                 // your Financial row id (after insert)
  category?: 'SUBSCRIPTION' | 'TRANSFER' | 'SPONSORSHIP' | 'MERCHANDISE' | 'ACADEMY_FEE' | 'MATCH_REVENUE' | 'BROADCAST' | 'OTHER';
}): Promise<void> {
  const { clubId, amountMinor, currency, paymentIntentId, financialId } = args;
  const category = args.category ?? 'SUBSCRIPTION';
  const amount = amountMinor / 100;
  const upper = currency.toUpperCase();

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: ({ franchiseUnitId: true } as unknown) as Record<string, true>,
  });
  const franchiseUnitId =
    (club as unknown as { franchiseUnitId?: string | null } | null)?.franchiseUnitId ?? null;

  // ── Franchise revenue split ────────────────────────────────────────────
  if (franchiseUnitId) {
    try {
      await computeAndRecordDistribution(null, {
        unitId: franchiseUnitId,
        clubId,
        category: category as never,
        sourceAmount: amount,
        sourceCurrency: upper,
        sourceFinancialId: financialId,
        sourceRef: paymentIntentId,             // idempotency
        trigger: 'PAYMENT_RECEIVED',
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[stripe→franchise] distribution failed', { paymentIntentId, err });
    }
  }

  // ── Investor revenue-share accruals ────────────────────────────────────
  const entity =
    (await getEntityByClub(clubId)) ??
    (franchiseUnitId ? await getEntityByFranchiseUnit(franchiseUnitId) : null);
  if (entity) {
    try {
      await computeRevenueShareAccruals(null, {
        entityId: entity.id,
        sourceAmount: amount,
        currency: upper,
        category,
        sourceRef: paymentIntentId,             // idempotency
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[stripe→investor] accrual failed', { paymentIntentId, err });
    }
  }
}

// USAGE — inside your existing payment_intent.succeeded handler, after the
// Financial row is created:
//
//   await fanOutPaymentToEngines({
//     clubId:          club.id,
//     amountMinor:     paymentIntent.amount,
//     currency:        paymentIntent.currency,
//     paymentIntentId: paymentIntent.id,
//     financialId:     financial.id,
//     category:        'SUBSCRIPTION',     // adjust per your event metadata
//   });

// ─── Stripe dashboard checklist ──────────────────────────────────────────
//
// In Stripe → Developers → Webhooks → your production endpoint:
//   • Events to send:
//       payment_intent.succeeded         (already wired)
//       customer.subscription.created    (already wired)
//       customer.subscription.updated    (already wired)
//       customer.subscription.deleted    (already wired)
//       invoice.payment_failed           (recommended)
//       invoice.payment_succeeded        (recommended)
//   • Signing secret matches STRIPE_WEBHOOK_SECRET in Render env
//   • After deploy, click "Send test webhook" and confirm 2xx in Render logs
