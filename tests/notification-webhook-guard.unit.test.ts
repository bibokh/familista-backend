/**
 * tests/notification-webhook-guard.unit.test.ts
 *
 * Cyber Defense, R1b — the two places a webhook URL enters: registering a
 * channel, and the dispatch worker sending to it. The worker is checked with
 * a target registered before the guard existed, the case the second check is
 * for, and with a request that must leave no response text anywhere.
 */

import dns from 'dns';

type Row = Record<string, any>;
const state: { channels: Row[]; notifications: Row[]; upserts: Row[] } = { channels: [], notifications: [], upserts: [] };

jest.mock('../src/config/database', () => ({
  prisma: {
    userNotificationChannel: {
      upsert: async (args: Row) => { state.upserts.push(args); return { id: 'ch-1', ...args.create }; },
      findMany: async () => state.channels,
    },
    userNotification: {
      findMany: async () => state.notifications,
      update: async ({ where, data }: Row) => {
        const n = state.notifications.find((x) => x.id === where.id)!;
        Object.assign(n, data);
        return n;
      },
    },
  },
}));

import { registerChannel } from '../src/notifications/notifications.service';
import { runNotificationDispatchTick } from '../src/workers/notification-dispatch.worker';
import { BadRequestError } from '../src/utils/errors';

const actor = { userId: 'u-1', clubId: 'c-1' };

beforeEach(() => { state.channels = []; state.notifications = []; state.upserts = []; });

describe('registering a webhook channel', () => {
  it.each([
    ['http://hooks.example.com/x', 'https-required'],
    ['https://169.254.169.254/latest/meta-data/iam/', 'blocked-address'],
    ['https://127.0.0.1/admin', 'blocked-address'],
    ['https://10.0.0.5/x', 'blocked-address'],
    ['https://[::1]/x', 'blocked-address'],
    ['https://[::ffff:a9fe:a9fe]/x', 'blocked-address'],
    ['https://familista-redis/x', 'internal-hostname'],
    ['https://localhost/x', 'internal-hostname'],
    ['https://hooks.example.com:6379/x', 'port-not-allowed'],
    ['https://user:pw@hooks.example.com/x', 'credentials-in-url'],
  ])('refuses %s (%s) and stores nothing', async (target, reason) => {
    await expect(registerChannel(actor, { channel: 'webhook', target })).rejects.toThrow(new BadRequestError(`webhook target refused: ${reason}`));
    expect(state.upserts).toEqual([]);
  });

  it('refuses a public-looking name that resolves inside', async () => {
    const spy = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '172.20.0.3', family: 4 }] as never);
    try {
      await expect(registerChannel(actor, { channel: 'WEBHOOK', target: 'https://hooks.attacker.example/x' }))
        .rejects.toThrow(/blocked-address/);
      expect(state.upserts).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('accepts a public https target, and leaves other channel kinds as they were', async () => {
    const spy = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    try {
      await registerChannel(actor, { channel: 'WEBHOOK', target: 'https://hooks.example.com/familista' });
      await registerChannel(actor, { channel: 'EMAIL', target: 'coach@example.com' });
      await registerChannel(actor, { channel: 'SMS', target: '+441234567890' });
      expect(state.upserts.map((u) => u.create.target)).toEqual(['https://hooks.example.com/familista', 'coach@example.com', '+441234567890']);
    } finally { spy.mockRestore(); }
  });
});

describe('the dispatch worker', () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  afterAll(() => fetchSpy.mockRestore());
  beforeEach(() => fetchSpy.mockReset());

  function queue(target: string) {
    state.channels = [{ id: 'ch-1', userId: 'u-1', channel: 'WEBHOOK', target, isActive: true }];
    state.notifications = [{ id: 'n-1', userId: 'u-1', title: 'Squad update', body: null, payload: {}, archived: false, readAt: null, createdAt: new Date() }];
  }

  it.each([
    'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://10.0.0.5:6379/',
    'https://familista-postgres/x',
  ])('refuses a pre-R1b stored target %s at send time, never through fetch, and records no response text', async (target) => {
    queue(target);
    const r = await runNotificationDispatchTick();
    expect(r).toEqual({ processed: 1, dispatched: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    const attempt = state.notifications[0].payload.dispatched[`WEBHOOK:${target}`][0];
    expect(attempt).toMatchObject({ channel: 'WEBHOOK', ok: false, status: 0 });
    expect(['blocked-address', 'https-required', 'internal-hostname', 'port-not-allowed']).toContain(attempt.message);
  });

  it('a name that resolves inside at send time is refused at the connection', async () => {
    queue('https://hooks.attacker.example/x');
    const spy = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    try {
      await runNotificationDispatchTick();
    } finally { spy.mockRestore(); }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.notifications[0].payload.dispatched['WEBHOOK:https://hooks.attacker.example/x'][0])
      .toMatchObject({ ok: false, status: 0, message: 'blocked-address' });
  });

  it('an operator-configured EMAIL provider keeps working, with no redirect followed and no body kept', async () => {
    const saved = process.env.NOTIFY_EMAIL_WEBHOOK;
    process.env.NOTIFY_EMAIL_WEBHOOK = 'https://mail-provider.example/send';
    state.channels = [{ id: 'ch-2', userId: 'u-1', channel: 'EMAIL', target: 'coach@example.com', isActive: true }];
    state.notifications = [{ id: 'n-2', userId: 'u-1', title: 'Squad update', body: null, payload: {}, archived: false, readAt: null, createdAt: new Date() }];
    fetchSpy.mockResolvedValue(new Response('PROVIDER-INTERNAL-DETAIL', { status: 202 }));
    try {
      const r = await runNotificationDispatchTick();
      expect(r.dispatched).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.NOTIFY_EMAIL_WEBHOOK; else process.env.NOTIFY_EMAIL_WEBHOOK = saved;
    }
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    const attempt = state.notifications[0].payload.dispatched['EMAIL:coach@example.com'][0];
    expect(attempt).toMatchObject({ ok: true, status: 202, message: 'delivered' });
    expect(JSON.stringify(state.notifications[0].payload)).not.toMatch(/PROVIDER-INTERNAL-DETAIL/);
  });
});
