// Familista — Stripe service (boot-safe)
//
// Rebuilt from zero. Reads Stripe configuration directly from process.env so a
// missing or malformed `config.stripe` cannot crash the server at startup.
// Stripe is optional: if STRIPE_SECRET_KEY is unset, every Stripe-touching
// function returns a clean 400 ("Stripe disabled") instead of throwing at
// module load. The default export shape is unchanged so billing.controller.ts
// keeps working without modification.

import Stripe from 'stripe';
import { SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, BadRequestError, AppError } from '../utils/errors';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Env-driven configuration (no dependency on config.stripe.*)
// ─────────────────────────────────────────────────────────────────────────────

const STRIPE_API_VERSION = '2024-12-18.acacia' as const;

function envStr(key: string): string {
  const v = process.env[key];
  return typeof v === 'string' ? v.trim() : '';
}

function getSecretKey():      string { return envStr('STRIPE_SECRET_KEY'); }
function getWebhookSecret():  string { return envStr('STRIPE_WEBHOOK_SECRET'); }
function getPriceId(plan: SubscriptionPlan): string {
  // Each plan has its own env var: STRIPE_PRICE_BASIC / STRIPE_PRICE_PRO / STRIPE_PRICE_ACADEMY
  return envStr(`STRIPE_PRICE_${plan}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lazy Stripe client — never instantiated at module load
// ─────────────────────────────────────────────────────────────────────────────

let _stripe: Stripe | null = null;
let _warned = false;

export function isStripeEnabled(): boolean {
  return getSecretKey().length > 0;
}

function getStripe(): Stripe | null {
  if (_stripe) return _stripe;
  const key = getSecretKey();
  if (!key) {
    if (!_warned) {
      logger.warn('Stripe disabled — STRIPE_SECRET_KEY missing. Billing endpoints will return 400 until configured.');
      _warned = true;
    }
    return null;
  }
  try {
    _stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION as unknown as Stripe.LatestApiVersion });
    return _stripe;
  } catch (err) {
    logger.error('Failed to initialise Stripe client', { err });
    return null;
  }
}

function requireStripe(): Stripe {
  const s = getStripe();
  if (!s) throw new BadRequestError('Billing is not configured on this environment.');
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Static plan catalogue (does not depend on Stripe at all)
// ─────────────────────────────────────────────────────────────────────────────

export const PLAN_FEATURES = {
  BASIC: {
    name: 'Basic',
    price: 199,
    currency: 'EUR',
    players: 20,
    gpsDevices: 5,
    aiInsights: 50,
    features: ['GPS Tracking', 'Match Analytics', 'Basic AI', '5 GPS Devices'],
  },
  PRO: {
    name: 'Pro',
    price: 499,
    currency: 'EUR',
    players: 50,
    gpsDevices: 20,
    aiInsights: 500,
    features: ['Everything in Basic', 'Advanced Analytics', 'Unlimited AI', '20 GPS Devices', 'Scouting Module'],
  },
  ACADEMY: {
    name: 'Academy',
    price: 999,
    currency: 'EUR',
    players: 200,
    gpsDevices: 50,
    aiInsights: -1, // unlimited
    features: ['Everything in Pro', 'Multi-team', '50 GPS Devices', 'Priority Support', 'Custom Reports'],
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Checkout session
// ─────────────────────────────────────────────────────────────────────────────

export async function createCheckoutSession(
  clubId: string,
  plan: SubscriptionPlan,
  successUrl: string,
  cancelUrl: string,
): Promise<{ url: string; sessionId: string }> {
  const stripe = requireStripe();

  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw new NotFoundError('Club');

  const priceId = getPriceId(plan);
  if (!priceId) {
    throw new BadRequestError(`No Stripe price configured for plan: ${plan} (set STRIPE_PRICE_${plan})`);
  }

  let customerId = club.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { clubId, clubName: club.name },
      name: club.name,
    });
    customerId = customer.id;
    await prisma.club.update({ where: { id: clubId }, data: { stripeCustomerId: customerId } });
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { clubId, plan },
    subscription_data: {
      metadata: { clubId, plan },
      trial_period_days: 14,
    },
  });

  if (!session.url) throw new AppError('Stripe checkout session returned no URL', 502);
  return { url: session.url, sessionId: session.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Billing portal
// ─────────────────────────────────────────────────────────────────────────────

export async function createPortalSession(
  clubId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  const stripe = requireStripe();

  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club?.stripeCustomerId) throw new BadRequestError('No billing info found');

  const session = await stripe.billingPortal.sessions.create({
    customer: club.stripeCustomerId,
    return_url: returnUrl,
  });

  return { url: session.url };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription info — works WITHOUT Stripe (reads only DB)
// ─────────────────────────────────────────────────────────────────────────────

export async function getSubscriptionInfo(clubId: string) {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      plan: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
      stripeSubscriptionId: true,
    },
  });
  if (!club) throw new NotFoundError('Club');

  const features =
    (PLAN_FEATURES as unknown as Record<string, typeof PLAN_FEATURES.BASIC>)[club.plan] ?? PLAN_FEATURES.BASIC;

  return {
    plan:             club.plan,
    status:           club.subscriptionStatus,
    trialEndsAt:      club.trialEndsAt,
    currentPeriodEnd: club.currentPeriodEnd,
    features,
    isActive:         (['ACTIVE', 'TRIALING'] as SubscriptionStatus[]).includes(club.subscriptionStatus),
    billingEnabled:   isStripeEnabled(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook handler — short-circuits cleanly if Stripe disabled
// ─────────────────────────────────────────────────────────────────────────────

export async function handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
  const stripe = getStripe();
  const secret = getWebhookSecret();

  if (!stripe || !secret) {
    logger.warn('Stripe webhook received but Stripe is disabled — ignoring');
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    logger.warn('Webhook signature verification failed', { err });
    throw new AppError('Invalid webhook signature', 400);
  }

  logger.info('Stripe webhook received', { type: event.type });

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const clubId  = session.metadata?.clubId;
      if (session.mode === 'subscription' && clubId) {
        await prisma.club.update({
          where: { id: clubId },
          data: {
            stripeSubscriptionId: session.subscription as string,
            subscriptionStatus:   SubscriptionStatus.ACTIVE,
            plan: (session.metadata?.plan as SubscriptionPlan) ?? SubscriptionPlan.BASIC,
          },
        });
        logger.info('Subscription activated', { clubId });
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub    = event.data.object as Stripe.Subscription;
      const clubId = sub.metadata?.clubId;
      if (clubId) {
        await prisma.club.update({
          where: { id: clubId },
          data: {
            subscriptionStatus: mapStripeStatus(sub.status),
            currentPeriodEnd:   new Date(sub.current_period_end * 1000),
          },
        });
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub    = event.data.object as Stripe.Subscription;
      const clubId = sub.metadata?.clubId;
      if (clubId) {
        await prisma.club.update({
          where: { id: clubId },
          data: { subscriptionStatus: SubscriptionStatus.CANCELED },
        });
        logger.info('Subscription canceled', { clubId });
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice    = event.data.object as Stripe.Invoice;
      const customerId = invoice.customer as string | null;
      if (customerId) {
        await prisma.club.updateMany({
          where: { stripeCustomerId: customerId },
          data:  { subscriptionStatus: SubscriptionStatus.PAST_DUE },
        });
      }
      break;
    }

    default:
      logger.debug('Unhandled webhook event', { type: event.type });
  }
}

function mapStripeStatus(status: string): SubscriptionStatus {
  const map: Record<string, SubscriptionStatus> = {
    active:             SubscriptionStatus.ACTIVE,
    past_due:           SubscriptionStatus.PAST_DUE,
    canceled:           SubscriptionStatus.CANCELED,
    trialing:           SubscriptionStatus.TRIALING,
    incomplete:         SubscriptionStatus.INCOMPLETE,
    incomplete_expired: SubscriptionStatus.CANCELED,
    unpaid:             SubscriptionStatus.PAST_DUE,
  };
  return map[status] ?? SubscriptionStatus.INCOMPLETE;
}
