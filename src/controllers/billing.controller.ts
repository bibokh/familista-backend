import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as stripeService from '../services/stripe.service';
import { sendSuccess } from '../utils/response';
import { config } from '../config';

const checkoutSchema = z.object({
  body: z.object({
    plan: z.enum(['BASIC', 'PRO', 'ACADEMY']),
  }),
});

export async function getPlans(_req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, stripeService.PLAN_FEATURES);
  } catch (err) { return next(err); }
}

export async function createCheckout(req: Request, res: Response, next: NextFunction) {
  try {
    await checkoutSchema.parseAsync({ body: req.body });
    const origin = req.headers.origin ?? config.cors.origin;
    const result = await stripeService.createCheckoutSession(
      req.user!.clubId,
      req.body.plan,
      `${origin}/billing/success`,
      `${origin}/billing/cancel`
    );
    return sendSuccess(res, result, 'Checkout session created');
  } catch (err) { return next(err); }
}

export async function createPortal(req: Request, res: Response, next: NextFunction) {
  try {
    const origin = req.headers.origin ?? config.cors.origin;
    const result = await stripeService.createPortalSession(
      req.user!.clubId,
      `${origin}/billing`
    );
    return sendSuccess(res, result);
  } catch (err) { return next(err); }
}

export async function getSubscription(req: Request, res: Response, next: NextFunction) {
  try {
    const info = await stripeService.getSubscriptionInfo(req.user!.clubId);
    return sendSuccess(res, info);
  } catch (err) { return next(err); }
}

// Raw body is needed for Stripe webhook verification
export async function handleWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const sig = req.headers['stripe-signature'] as string;
    await stripeService.handleWebhook(req.body as Buffer, sig);
    res.json({ received: true });
  } catch (err) { return next(err); }
}
