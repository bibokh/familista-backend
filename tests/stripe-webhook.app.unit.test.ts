/**
 * tests/stripe-webhook.app.unit.test.ts
 *
 * Cyber Defense, R13 — the Stripe webhook, asked of the real application
 * (createApp). The route's own express.raw used to run after the global JSON
 * parser had consumed the body, so constructEvent received an object and
 * every genuine event was refused. Pinned here: a correctly signed event is
 * accepted, an edited, unsigned or wrongly signed one is not.
 */

import request from 'supertest';
import Stripe from 'stripe';
import type { Application } from 'express';
import { createApp } from '../src/app';
import { isRawBodyPath } from '../src/middleware/raw-body-paths';

jest.mock('../src/config/database', () => require('./helpers/stub-database').stubDatabase({
  id: '00000000-0000-0000-0000-000000000002',
  clubId: '00000000-0000-0000-0000-000000000001',
  role: 'CLUB_ADMIN',
}));

const WEBHOOK_SECRET = `whsec_${'t'.repeat(32)}`;
const PATH = '/api/v1/billing/webhook';
const payload = JSON.stringify({ id: 'evt_test_pin', object: 'event', type: 'customer.created', data: { object: { id: 'cus_test' } } });

const saved = { key: process.env.STRIPE_SECRET_KEY, hook: process.env.STRIPE_WEBHOOK_SECRET };
let app: Application;
beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = `sk_test_${'x'.repeat(24)}`;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  app = createApp();
});
afterAll(() => {
  for (const [k, v] of [['STRIPE_SECRET_KEY', saved.key], ['STRIPE_WEBHOOK_SECRET', saved.hook]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function signed(body: string, secret = WEBHOOK_SECRET): string {
  return Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
}

describe('the Stripe webhook in the real application', () => {
  it('accepts an event signed with the webhook secret over the exact bytes sent', async () => {
    const res = await request(app).post(PATH)
      .set('content-type', 'application/json').set('stripe-signature', signed(payload)).send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it('refuses a body edited after signing', async () => {
    const res = await request(app).post(PATH)
      .set('content-type', 'application/json').set('stripe-signature', signed(payload))
      .send(payload.replace('customer.created', 'checkout.session.completed'));
    expect(res.status).toBe(400);
  });

  it('refuses an event with no signature, or one signed with another secret', async () => {
    const none = await request(app).post(PATH).set('content-type', 'application/json').send(payload);
    expect(none.status).toBe(400);
    const other = await request(app).post(PATH)
      .set('content-type', 'application/json').set('stripe-signature', signed(payload, `whsec_${'o'.repeat(32)}`)).send(payload);
    expect(other.status).toBe(400);
  });

  it('only the signed webhook paths skip the global body parsers', () => {
    expect(isRawBodyPath(PATH)).toBe(true);
    expect(isRawBodyPath('/api/v1/vision/webhooks/clip/r1')).toBe(true);
    for (const p of ['/api/v1/billing/checkout', '/api/v1/auth/login', '/api/v1/billing/webhook/extra', '/billing/webhook', '/api/v1/vision/jobs']) {
      expect(isRawBodyPath(p)).toBe(false);
    }
  });
});
