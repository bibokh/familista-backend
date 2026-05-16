// Familista — Franchise Expansion Engine
// File location: src/services/franchise-payout.adapter.ts
//
// Pluggable payout adapter for revenue distribution. The default implementation
// is `LEDGER_ONLY` — allocations are recorded as paid in the internal ledger
// (no external money movement). Production deployments typically swap in a
// Stripe Connect adapter for owner / investor payouts.
//
// Switch backend via env WL_PAYOUT_BACKEND:
//   LEDGER_ONLY      (default — internal accounting only)
//   STRIPE_CONNECT   (uses Stripe Connect transfers; requires stripe SDK)

import type { RevenueRecipientType } from '@prisma/client';

export type PayoutRequest = {
  allocationId: string;
  distributionId: string;
  recipientType: RevenueRecipientType;
  recipientUnitId: string | null;
  recipientOwnerId: string | null;
  recipientLabel: string | null;
  amount: number;
  currency: string;
};

export type PayoutResult = {
  method: string;
  ref: string | null;
};

export interface PayoutAdapter {
  readonly kind: string;
  payout(req: PayoutRequest): Promise<PayoutResult>;
}

// ─── Default: ledger-only ────────────────────────────────────────────────────

class LedgerOnlyAdapter implements PayoutAdapter {
  readonly kind = 'LEDGER_ONLY';

  async payout(req: PayoutRequest): Promise<PayoutResult> {
    // No external side effect. The allocation row's status=PAID is the
    // authoritative ledger entry. HQ-to-master flows usually live here.
    return { method: 'LEDGER', ref: req.allocationId };
  }
}

// ─── Stripe Connect (lazy-loaded) ────────────────────────────────────────────

class StripeConnectAdapter implements PayoutAdapter {
  readonly kind = 'STRIPE_CONNECT';
  private stripe: import('stripe').Stripe;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Stripe = require('stripe') as typeof import('stripe').Stripe;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY required for STRIPE_CONNECT adapter');
    this.stripe = new Stripe(key, { apiVersion: '2024-12-18.acacia' as never });
  }

  async payout(req: PayoutRequest): Promise<PayoutResult> {
    // Map our recipient to a connected Stripe account. The lookup table lives
    // either on FranchiseOwner.metadata or in OrganizationLimits — adjust to
    // your data model. Falls back to ledger if no Stripe account is mapped.
    const destination = await this.resolveStripeAccount(req);
    if (!destination) {
      return { method: 'LEDGER_FALLBACK', ref: req.allocationId };
    }

    const transfer = await this.stripe.transfers.create({
      amount: Math.round(req.amount * 100),
      currency: req.currency.toLowerCase(),
      destination,
      transfer_group: req.distributionId,
      metadata: {
        allocationId: req.allocationId,
        distributionId: req.distributionId,
        recipientType: req.recipientType,
        recipientUnitId: req.recipientUnitId ?? '',
        recipientOwnerId: req.recipientOwnerId ?? '',
      },
    });

    return { method: 'STRIPE_CONNECT', ref: transfer.id };
  }

  private async resolveStripeAccount(req: PayoutRequest): Promise<string | null> {
    // This stub returns null. Implementation typically reads from a mapping
    // table (FranchiseOwner.metadata.stripeAccountId or a dedicated payout
    // accounts table). Keeping it pluggable avoids a hard dep on your billing
    // schema choices.
    void req;
    return null;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

let cached: PayoutAdapter | null = null;

export function getPayoutAdapter(): PayoutAdapter {
  if (cached) return cached;
  const backend = (process.env.WL_PAYOUT_BACKEND ?? 'LEDGER_ONLY').toUpperCase();
  if (backend === 'STRIPE_CONNECT') {
    cached = new StripeConnectAdapter();
  } else {
    cached = new LedgerOnlyAdapter();
  }
  return cached;
}

export async function dispatchPayout(req: PayoutRequest): Promise<PayoutResult> {
  return await getPayoutAdapter().payout(req);
}

export function _resetPayoutAdapterForTests(): void {
  cached = null;
}
