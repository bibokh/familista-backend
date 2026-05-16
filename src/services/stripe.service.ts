import Stripe from 'stripe';
import { SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { config } from '../config';
import { NotFoundError, AppError, BadRequestError } from '../utils/errors';
import { logger } from '../utils/logger';

const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2024-12-18.acacia' });

const PLAN_PRICES: Record<string, string> = {
  BASIC:   config.stripe.prices.basic,
  PRO:     config.stripe.prices.pro,
  ACADEMY: config.stripe.prices.academy,
};

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
};

// ── Create checkout session ───────────────────────────────

export async function createCheckoutSession(
  clubId: string,
  plan: SubscriptionPlan,
  successUrl: string,
  cancelUrl: string
): Promise<{ url: string; sessionId: string }> {
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw new NotFoundError('Club');

  const priceId = PLAN_PRICES[plan];
  if (!priceId) throw new BadRequestError(`No price configured for plan: ${plan}`);

  // Get or create Stripe customer
  let customerId = club.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { clubId, clubName: club.name },
      name: club.name,
    });
    customerId = customer.id;
    await prisma.club.update({
      where: { id: clubId },
      data: { stripeCustomerId: customerId },
    });
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

  return { url: session.url!, sessionId: session.id };
}

// ── Create billing portal session ────────────────────────

export async function createPortalSession(
  clubId: string,
  returnUrl: string
): Promise<{ url: string }> {
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club?.stripeCustomerId) throw new BadRequestError('No billing info found');

  const session = await stripe.billingPortal.sessions.create({
    customer: club.stripeCustomerId,
    return_url: returnUrl,
  });

  return { url: session.url };
}

// ── Get subscription info ─────────────────────────────────

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

  return {
    plan: club.plan,
    status: club.subscriptionStatus,
    trialEndsAt: club.trialEndsAt,
    currentPeriodEnd: club.currentPeriodEnd,
    features: PLAN_FEATURES[club.plan] ?? PLAN_FEATURES.BASIC,
    isActive: ['ACTIVE', 'TRIALING'].includes(club.subscriptionStatus),
  };
}

// ── Handle Stripe webhooks ────────────────────────────────

export async function handleWebhook(
  rawBody: Buffer,
  signature: string
): Promise<void> {
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      config.stripe.webhookSecret
    );
  } catch (err) {
    logger.warn('Webhook signature verification failed', { err });
    throw new AppError('Invalid webhook signature', 400);
  }

  logger.info('Stripe webhook received', { type: event.type });

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === 'subscription' && session.metadata?.clubId) {
        await prisma.club.update({
          where: { id: session.metadata.clubId },
          data: {
            stripeSubscriptionId: session.subscription as string,
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            plan: (session.metadata.plan as SubscriptionPlan) ?? 'BASIC',
          },
        });
        logger.info('Subscription activated', { clubId: session.metadata.clubId });
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const clubId = sub.metadata?.clubId;
      if (clubId) {
        await prisma.club.update({
          where: { id: clubId },
          data: {
            subscriptionStatus: mapStripeStatus(sub.status),
            currentPeriodEnd: new Date(sub.current_period_end * 1000),
          },
        });
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
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
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = invoice.customer as string;
      await prisma.club.updateMany({
        where: { stripeCustomerId: customerId },
        data: { subscriptionStatus: SubscriptionStatus.PAST_DUE },
      });
      break;
    }

    default:
      logger.debug('Unhandled webhook event', { type: event.type });
  }
}

function mapStripeStatus(status: string): SubscriptionStatus {
  const map: Record<string, SubscriptionStatus> = {
    active:            SubscriptionStatus.ACTIVE,
    past_due:          SubscriptionStatus.PAST_DUE,
    canceled:          SubscriptionStatus.CANCELED,
    trialing:          SubscriptionStatus.TRIALING,
    incomplete:        SubscriptionStatus.INCOMPLETE,
    incomplete_expired:SubscriptionStatus.CANCELED,
    unpaid:            SubscriptionStatus.PAST_DUE,
  };
  return map[status] ?? SubscriptionStatus.INCOMPLETE;
}
