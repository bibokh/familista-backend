/**
 * tests/fabric-registry.smoke.test.ts
 *
 * The registry endpoints, exercised through the real Express app.
 *
 * The unit tests read `fabric.routes.ts` and assert that the guard is there.
 * This file proves the guard actually REFUSES — a middleware can be present,
 * correctly written, and mounted in an order that lets a request past it, and
 * only a request finds that out.
 *
 * No database: every assertion here is resolved by the JWT verify step inside
 * `authenticate`, before any query runs. That is the same gate `auth.smoke`
 * relies on, and it is exactly the boundary worth testing — an unauthenticated
 * caller must not reach a platform registry at all.
 */

import request from 'supertest';
import { createApp } from '../src/app';
import type { Application } from 'express';

let app: Application;

beforeAll(() => {
  app = createApp();
});

const ROUTES = [
  '/api/v1/system/fabric/sources',
  '/api/v1/system/fabric/sources?visible=1',
  '/api/v1/system/fabric/events/catalog',
  '/api/v1/system/fabric/events/catalog?source=users',
  '/api/v1/system/fabric/schemas',
];

describe('the fabric registry is mounted and guarded', () => {
  it.each(ROUTES)('%s refuses a request with no token', async (route) => {
    const res = await request(app).get(route);
    // 401, not 404: the route exists and declined to serve it. A 404 here would
    // mean the router never mounted, and the test would be passing for the
    // wrong reason.
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it.each(ROUTES)('%s refuses a malformed bearer token', async (route) => {
    const res = await request(app).get(route).set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('leaks nothing about the registry in a refusal', async () => {
    const res = await request(app).get('/api/v1/system/fabric/events/catalog');
    const body = JSON.stringify(res.body);
    for (const leak of ['player.updated', 'medical', 'RESTRICTED', 'eventDomains']) {
      expect(`${leak} in refusal: ${body.includes(leak)}`).toBe(`${leak} in refusal: false`);
    }
  });

  it('exposes no write verb on any registry path', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[method]('/api/v1/system/fabric/sources').send({ id: 'pirate' });
      // Either the router has no such handler (404) or auth declines first
      // (401). What must never happen is a 2xx.
      expect(`${method} status: ${res.status < 300}`).toBe(`${method} status: false`);
    }
  });
});
