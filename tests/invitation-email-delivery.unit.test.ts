/**
 * tests/invitation-email-delivery.unit.test.ts
 *
 * Getting an invitation to a person, without ever holding what it protects.
 *
 * The invitation's own security is unchanged and is re-proved here rather than
 * assumed: 32 random bytes, only the SHA-256 stored, expiring, single-use,
 * revocable, and the recipient choosing their own password. What is new is
 * delivery, and delivery brings its own ways to get things wrong:
 *
 *   · The raw token exists for one function call, inside one URL. It must not
 *     reach the database, a log, an audit row, or any list.
 *   · Delivery state is not invitation validity. A provider that refuses the
 *     message leaves a perfectly good PENDING invitation behind it.
 *   · With no provider, nothing may claim an email was sent.
 *   · A resend retires the old link before the new one leaves.
 *   · No product code may reach a provider SDK — that is what the gateway is.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { MembershipRole } from '@prisma/client';

type Row = Record<string, any>;

const CLUB = 'club-harta';
const OTHER_CLUB = 'club-elsewhere';

const state = {
  invitations: [] as Row[],
  memberships: [] as Row[],
  audits: [] as Row[],
  platformAudits: [] as Row[],
  users: [] as Row[],
  clubs: [] as Row[],
  teams: [] as Row[],
};

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;
const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) return row[k] !== v.not;
      if ('gt' in v) return row[k] > v.gt;
      if ('gte' in v) return row[k] >= v.gte;
      if ('lt' in v) return row[k] < v.lt;
      if ('lte' in v) return row[k] <= v.lte;
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
    }
    return row[k] === v;
  });

const invitationTable = {
  create: async ({ data }: Row) => {
    const r = {
      id: id('inv'), status: 'PENDING', acceptedAt: null, acceptedByUserId: null,
      revokedAt: null, revokedByUserId: null, message: null, teamId: null, createdAt: new Date(),
      deliveryState: 'CREATED', deliveryProvider: null, deliveryMessageId: null,
      deliveryFailureCode: null, deliveryFailureClass: null, deliveryAttemptedAt: null,
      deliveryAttempts: 0, deliveryLocale: null, ...data,
    };
    state.invitations.push(r);
    return r;
  },
  findFirst: async ({ where }: Row) => state.invitations.find((r) => match(r, where)) ?? null,
  findUnique: async ({ where }: Row) =>
    state.invitations.find((r) => (where.id ? r.id === where.id : r.tokenHash === where.tokenHash)) ?? null,
  findMany: async ({ where = {} }: Row = {}) => state.invitations.filter((r) => match(r, where)),
  count: async ({ where = {} }: Row = {}) => state.invitations.filter((r) => match(r, where)).length,
  update: async ({ where, data }: Row) => {
    const r = state.invitations.find((x) => x.id === where.id)!;
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in (v as Row)) r[k] = (r[k] ?? 0) + (v as Row).increment;
      else r[k] = v;
    }
    return r;
  },
  updateMany: async ({ where, data }: Row) => {
    const rows = state.invitations.filter((r) => match(r, where));
    rows.forEach((r) => Object.assign(r, data));
    return { count: rows.length };
  },
};

const db: Row = {
  clubInvitation: invitationTable,
  membership: {
    create: async ({ data }: Row) => {
      const r = { id: id('mem'), isActive: true, status: 'ACTIVE', createdAt: new Date(), ...data };
      state.memberships.push(r);
      return r;
    },
    findFirst: async ({ where }: Row) => state.memberships.find((m) => match(m, where)) ?? null,
    findMany: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)),
    findUnique: async ({ where }: Row) => state.memberships.find((m) => m.id === where.id) ?? null,
    count: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)).length,
    update: async ({ where, data }: Row) => {
      const m = state.memberships.find((x) => x.id === where.id)!;
      Object.assign(m, data);
      return m;
    },
  },
  membershipAuditLog: { create: async ({ data }: Row) => { state.audits.push(data); return data; } },
  platformAuditLog: { create: async ({ data }: Row) => { state.platformAudits.push(data); return data; } },
  platformAdmin: { findUnique: async ({ where }: Row) => (where.userId === 'u-owner' ? { id: 'pa', isActive: true } : null) },
  user: {
    findUnique: async ({ where }: Row) =>
      state.users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) ?? null,
  },
  club: { findUnique: async ({ where }: Row) => state.clubs.find((c) => c.id === where.id) ?? null },
  team: { findUnique: async ({ where }: Row) => state.teams.find((t) => t.id === where.id) ?? null },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import * as invites from '../src/identity/invitation.service';
import { resetInvitationThrottle, LIMITS } from '../src/identity/invitation-throttle';
import { acceptanceUrl } from '../src/identity/invitation-mail.service';
import {
  setEmailProvider, sendEmail, emailConfiguration, emailMetrics, resetEmailMetrics, recipientRef, selectProvider,
} from '../src/platform/email/service';
import { renderInvitationEmail, resolveEmailLocale, isRtl, EMAIL_LOCALES } from '../src/platform/email/templates';
import { UnconfiguredProvider } from '../src/platform/email/providers/unconfigured';
import { classifyHttpStatus, RETRYABLE, type EmailMessage, type EmailProvider } from '../src/platform/email/types';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** A provider that records what it was asked to send. */
class RecordingProvider implements EmailProvider {
  readonly name = 'recording';
  sent: EmailMessage[] = [];
  constructor(private readonly outcome: 'ok' | 'fail' = 'ok', private readonly failCode = 'HTTP_500') {}
  isConfigured() { return true; }
  configurationProblem() { return null; }
  async send(message: EmailMessage) {
    this.sent.push(message);
    return this.outcome === 'ok'
      ? { ok: true, providerName: this.name, providerMessageId: 'pm-1', failureClass: null, failureCode: null, latencyMs: 3 }
      : { ok: false, providerName: this.name, providerMessageId: null, failureClass: 'TEMPORARY' as const, failureCode: this.failCode, latencyMs: 3 };
  }
}

const OWNER = { userId: 'u-owner', clubId: CLUB };
const ADMIN = { userId: 'u-admin', clubId: CLUB };
let provider: RecordingProvider;

beforeEach(() => {
  seq = 0;
  state.invitations = [];
  state.memberships = [];
  state.audits = [];
  state.platformAudits = [];
  state.clubs = [
    { id: CLUB, name: 'HARTA BERLIN', defaultLocale: 'en-GB' },
    { id: OTHER_CLUB, name: 'Elsewhere FC', defaultLocale: null },
  ];
  state.teams = [{ id: 'team-a', clubId: CLUB }, { id: 'team-foreign', clubId: OTHER_CLUB }];
  state.users = [
    { id: 'u-owner', email: 'owner@harta.test', firstName: 'Club', lastName: 'Owner', isActive: true },
    { id: 'u-admin', email: 'admin@harta.test', firstName: 'Club', lastName: 'Admin', isActive: true },
    { id: 'u-known', email: 'known@person.test', firstName: 'Known', lastName: 'Person', isActive: true },
  ];
  provider = new RecordingProvider();
  setEmailProvider(provider);
  resetInvitationThrottle();
  resetEmailMetrics();
  process.env.PUBLIC_APP_URL = 'https://app.familista.test';
});

afterAll(() => { setEmailProvider(null); delete process.env.PUBLIC_APP_URL; });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ─────────────────────────────────────────────────────────────────────────────
// Sending
// ─────────────────────────────────────────────────────────────────────────────

describe('an invitation reaches the person it was written to', () => {
  it('sends the president invitation, to the invited address', async () => {
    const out = await invites.createInvitation(OWNER, { email: 'New.President@club.test', role: MembershipRole.CLUB_OWNER });

    expect(provider.sent).toHaveLength(1);
    // The address is normalised on the way in, so one person is one invitation.
    expect(provider.sent[0].to.address).toBe('new.president@club.test');
    expect(out.delivery).toMatchObject({ state: 'SENT', provider: 'recording', notConfigured: false });
    expect(state.invitations[0]).toMatchObject({
      deliveryState: 'SENT', deliveryProvider: 'recording', deliveryMessageId: 'pm-1', deliveryAttempts: 1,
    });
  });

  it('sends the staff invitation, with the club and the role in it', async () => {
    await invites.createInvitation(ADMIN, {
      email: 'coach@person.test', role: MembershipRole.HEAD_COACH, teamId: 'team-a', inviterName: 'Club Admin',
    });
    const message = provider.sent[0];
    expect(message.subject).toContain('HARTA BERLIN');
    expect(message.html).toContain('HARTA BERLIN');
    expect(message.html).toContain('Head coach');
    expect(message.text).toContain('Head coach');
    expect(message.html).toContain('Club Admin');
    // Both parts, always: a client that refuses HTML still gets the link.
    expect(message.text.length).toBeGreaterThan(100);
  });

  it('carries an acceptance link built from configuration', async () => {
    const out = await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });
    const expected = `https://app.familista.test/invite/accept?token=${encodeURIComponent(out.token)}`;
    expect(acceptanceUrl(out.token)).toBe(expected);
    expect(provider.sent[0].html).toContain(expected);
    expect(provider.sent[0].text).toContain(expected);
  });

  it('and never puts a password, a hash or a credential in one', async () => {
    const out = await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });
    const message = provider.sent[0];
    const body = `${message.subject}\n${message.html}\n${message.text}`;

    expect(body).not.toContain(sha(out.token));          // the tokenHash, never
    expect(body.toLowerCase()).not.toMatch(/passwordhash|refreshtoken|tokenhash/);
    // It says, in words, that the recipient chooses their own password.
    expect(body).toMatch(/choose your own password/i);
    expect(body).toMatch(/never email you a password/i);
    // The token is in the link and nowhere else — not in the subject, which
    // appears on a lock screen.
    expect(message.subject).not.toContain(out.token);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The raw token
// ─────────────────────────────────────────────────────────────────────────────

describe('the raw token exists at the delivery boundary and nowhere else', () => {
  it('is never persisted — only its SHA-256 is', async () => {
    const out = await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });
    expect(out.token).toHaveLength(43);                   // 32 random bytes, base64url
    expect(state.invitations[0].tokenHash).toBe(sha(out.token));
    expect(JSON.stringify(state.invitations)).not.toContain(out.token);
  });

  it('is never in an audit row, of either kind', async () => {
    const out = await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });
    const trail = JSON.stringify(state.audits) + JSON.stringify(state.platformAudits);
    expect(trail).not.toContain(out.token);
    expect(trail).not.toContain(state.invitations[0].tokenHash);
    expect(trail.toLowerCase()).not.toMatch(/tokenhash|password|"token"/);
  });

  it('is never in a list, or in the invitation view', async () => {
    const out = await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });
    const rows = await invites.listInvitations(CLUB);
    expect(JSON.stringify(rows)).not.toContain(out.token);
    expect(JSON.stringify(out.invitation)).not.toContain(out.token);
  });

  it('and the delivery log records a reference to the recipient, never the address', () => {
    const ref = recipientRef('Somebody@Example.test');
    expect(ref).toHaveLength(8);
    expect(ref).not.toContain('@');
    expect(ref).toBe(recipientRef('somebody@example.test'));   // case-insensitive
    // The service logs that reference, and there is no line logging an address.
    const SERVICE = read('src/platform/email/service.ts');
    expect(SERVICE).toContain('recipient: recipientRef(message.to.address)');
    expect(SERVICE).not.toMatch(/logger\.\w+\([^)]*message\.to\.address(?!\s*\))/);
    // Nor a subject, nor a body.
    expect(SERVICE).not.toMatch(/logger\.\w+\([^)]*message\.(subject|html|text)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delivery state is not invitation validity
// ─────────────────────────────────────────────────────────────────────────────

describe('an email that failed does not make an invitation invalid', () => {
  it('records FAILED and leaves the invitation PENDING and usable', async () => {
    setEmailProvider(new RecordingProvider('fail', 'HTTP_503'));
    const out = await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });

    expect(out.delivery.state).toBe('FAILED');
    expect(state.invitations[0].deliveryState).toBe('FAILED');
    expect(state.invitations[0].deliveryFailureCode).toBe('HTTP_503');
    // The invitation itself is untouched, and the link still works.
    expect(state.invitations[0].status).toBe('PENDING');
    await expect(invites.previewInvitation(out.token)).resolves.toMatchObject({ clubName: 'HARTA BERLIN' });
  });

  it('says EMAIL DELIVERY NOT CONFIGURED rather than pretending', async () => {
    setEmailProvider(new UnconfiguredProvider());
    const out = await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });

    expect(out.delivery).toMatchObject({ state: 'FAILED', notConfigured: true, failureCode: 'EMAIL_NOT_CONFIGURED' });
    expect(state.invitations[0].deliveryState).toBe('FAILED');
    // Nothing was sent, and the audit says which of the two it was.
    expect(state.platformAudits.map((a) => a.action)).toContain('InvitationEmailNotConfigured');
    // And the invitation is entirely valid.
    await expect(invites.previewInvitation(out.token)).resolves.toBeTruthy();

    const config = emailConfiguration();
    expect(config.configured).toBe(false);
    // It names the VARIABLE to set — that is the useful half — and carries no
    // variable's VALUE. The distinction is the whole test: an operator needs
    // "set SENDGRID_API_KEY"; nobody needs what is in it.
    expect(config.problem).toMatch(/No email provider is configured/);
    expect(config.problem).toMatch(/SENDGRID_API_KEY/);

    const secrets = { SENDGRID_API_KEY: 'SG.a-real-looking-secret-value', SMTP_PASS: 'hunter2-the-password' };
    const previous = { ...process.env };
    Object.assign(process.env, secrets);
    try {
      const withSecrets = JSON.stringify(emailConfiguration());
      for (const value of Object.values(secrets)) {
        expect(withSecrets).not.toContain(value);
      }
      // And the shape has no field a secret could be assigned to at all.
      expect(Object.keys(emailConfiguration()).sort()).toEqual([
        'configured', 'fromAddress', 'fromName', 'maxAttempts', 'problem', 'providerName', 'publicAppUrl', 'timeoutMs',
      ]);
    } finally {
      process.env = previous;
    }
  });

  it('and the two states are separate columns, not one', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).toContain('enum EmailDeliveryState');
    expect(schema).toContain('enum ClubInvitationStatus');
    const invitation = schema.slice(schema.indexOf('model ClubInvitation'), schema.indexOf('enum MembershipAuditAction'));
    expect(invitation).toMatch(/status\s+ClubInvitationStatus/);
    expect(invitation).toMatch(/deliveryState\s+EmailDeliveryState/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resend, revoke, expire
// ─────────────────────────────────────────────────────────────────────────────

describe('a resend retires the old link before the new one leaves', () => {
  it('invalidates the old token and emails a new one', async () => {
    const first = await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });
    const again = await invites.resendInvitation(OWNER, first.invitation.id);

    expect(again.token).not.toBe(first.token);
    await expect(invites.previewInvitation(first.token)).rejects.toThrow();
    await expect(invites.previewInvitation(again.token)).resolves.toBeTruthy();

    // One invitation row, two tokens over its life — never two live tokens.
    expect(state.invitations).toHaveLength(1);
    expect(state.invitations[0].tokenHash).toBe(sha(again.token));

    // The new email says the old link has stopped working.
    expect(provider.sent).toHaveLength(2);
    expect(provider.sent[1].html).toMatch(/earlier invitation link .* has stopped working/i);
    expect(again.delivery.state).toBe('SENT');
    expect(state.invitations[0].deliveryAttempts).toBe(2);
    expect(state.audits.map((a) => a.action)).toContain('INVITE_RESENT');
  });

  it('a revoked invitation cannot be used, whatever its delivery said', async () => {
    const out = await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });
    expect(state.invitations[0].deliveryState).toBe('SENT');
    await invites.revokeInvitation(OWNER, out.invitation.id, 'Wrong person');
    await expect(invites.previewInvitation(out.token)).rejects.toThrow(/withdrawn/i);
    await expect(invites.acceptInvitation({ userId: 'u-known', email: 'p@club.test' }, out.token)).rejects.toThrow();
  });

  it('an expired invitation cannot be used, and is reported as expired', async () => {
    const out = await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });
    state.invitations[0].expiresAt = new Date(Date.now() - 1000);
    await expect(invites.previewInvitation(out.token)).rejects.toThrow(/expired/i);
    const rows = await invites.listInvitations(CLUB);
    expect(rows[0].status).toBe('EXPIRED');
  });

  it('and a used invitation cannot be used twice', async () => {
    const out = await invites.createInvitation(OWNER, { email: 'known@person.test', role: MembershipRole.HEAD_COACH });
    await invites.acceptInvitation({ userId: 'u-known', email: 'known@person.test' }, out.token);
    await expect(invites.acceptInvitation({ userId: 'u-known', email: 'known@person.test' }, out.token))
      .rejects.toThrow(/already been used/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authorization and cross-club
// ─────────────────────────────────────────────────────────────────────────────

describe('an invitation cannot escape the club it belongs to', () => {
  it('refuses a team that belongs to another club', async () => {
    await expect(invites.createInvitation(OWNER, {
      email: 'x@club.test', role: MembershipRole.HEAD_COACH, teamId: 'team-foreign',
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(provider.sent).toHaveLength(0);
  });

  it('refuses to resend or revoke another club\'s invitation', async () => {
    const out = await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });
    const attacker = { userId: 'u-attacker', clubId: OTHER_CLUB };
    await expect(invites.resendInvitation(attacker, out.invitation.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(invites.revokeInvitation(attacker, out.invitation.id)).rejects.toMatchObject({ statusCode: 404 });
    // Nothing was emailed on the attacker's behalf.
    expect(provider.sent).toHaveLength(1);
  });

  it('and an invitation is an offer to one address, not a transferable ticket', async () => {
    const out = await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });
    await expect(invites.acceptInvitation({ userId: 'u-known', email: 'known@person.test' }, out.token))
      .rejects.toThrow(/different email address/i);
    expect(state.memberships).toHaveLength(0);
  });

  it('the club actor comes from the session, never the request', () => {
    const SRC = read('src/identity/invitation.service.ts');
    // Every club-side write is scoped by actor.clubId.
    expect(SRC).toContain('clubId: actor.clubId');
    expect(SRC).not.toMatch(/clubId:\s*dto\.clubId/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-abuse
// ─────────────────────────────────────────────────────────────────────────────

describe('the endpoint is not a spam relay', () => {
  it('limits how often one invitation may be resent', async () => {
    const first = await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });
    for (let i = 0; i < LIMITS.resend.capacity; i++) {
      await invites.resendInvitation(OWNER, first.invitation.id);
    }
    await expect(invites.resendInvitation(OWNER, first.invitation.id)).rejects.toThrow(/too many times/i);
    // The refused attempt never reached the provider.
    expect(provider.sent).toHaveLength(1 + LIMITS.resend.capacity);
  });

  it('limits how many invitations one club may send', async () => {
    for (let i = 0; i < LIMITS.clubInvite.capacity; i++) {
      await invites.createInvitation(OWNER, { email: `p${i}@club.test`, role: MembershipRole.ANALYST });
    }
    await expect(invites.createInvitation(OWNER, { email: 'one-too-many@club.test', role: MembershipRole.ANALYST }))
      .rejects.toThrow(/too many invitations/i);
  });

  it('limits brute-force acceptance per account, before the token is looked up', async () => {
    for (let i = 0; i < LIMITS.accept.capacity; i++) {
      await expect(invites.acceptInvitation({ userId: 'u-known', email: 'known@person.test' }, 'guess'))
        .rejects.toThrow();
    }
    await expect(invites.acceptInvitation({ userId: 'u-known', email: 'known@person.test' }, 'guess'))
      .rejects.toThrow(/too many invitation attempts/i);
  });

  it('and a preview tells a link-holder nothing about other accounts', async () => {
    const out = await invites.createInvitation(OWNER, { email: 'known@person.test', role: MembershipRole.ANALYST });
    const preview = await invites.previewInvitation(out.token);
    // It answers only about the address the link was issued to.
    expect(Object.keys(preview).sort()).toEqual([
      'accountExists', 'clubId', 'clubName', 'email', 'expiresAt', 'message', 'role', 'teamId', 'teamName',
    ]);
    expect(preview.email).toBe('known@person.test');
    // There is no endpoint that answers "does this arbitrary address exist".
    const routes = read('src/routes/invitation.routes.ts');
    expect(routes).not.toMatch(/exists|lookup|check-email/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

describe('three languages, and Arabic reads right to left', () => {
  const ctx = {
    recipientName: 'Alina Braun',
    clubName: 'HARTA BERLIN',
    roleLabel: 'President',
    inviterName: 'Familista',
    acceptUrl: 'https://app.familista.test/invite/accept?token=abc',
    expiresAt: new Date('2026-09-15T10:00:00Z'),
  };

  it('ships exactly English, German and Arabic', () => {
    expect(EMAIL_LOCALES).toEqual(['en', 'de', 'ar']);
  });

  it('renders English', () => {
    const mail = renderInvitationEmail('PRESIDENT', { ...ctx, locale: 'en' });
    expect(mail.subject).toMatch(/invited to lead HARTA BERLIN/i);
    expect(mail.html).toContain('lang="en"');
    expect(mail.html).toContain('dir="ltr"');
    expect(mail.html).toContain(ctx.acceptUrl);
    expect(mail.text).toContain(ctx.acceptUrl);
  });

  it('renders German', () => {
    const mail = renderInvitationEmail('PRESIDENT', { ...ctx, locale: 'de', roleLabel: 'Präsident' });
    expect(mail.subject).toMatch(/eingeladen/);
    expect(mail.html).toContain('lang="de"');
    expect(mail.html).toContain('Einladung annehmen');
    expect(mail.text).toContain('Einladung annehmen');
  });

  it('renders Arabic, right to left', () => {
    const mail = renderInvitationEmail('PRESIDENT', { ...ctx, locale: 'ar', roleLabel: 'الرئيس' });
    expect(isRtl('ar')).toBe(true);
    expect(mail.html).toContain('lang="ar"');
    expect(mail.html).toContain('dir="rtl"');
    // The direction is on the container too, not only the document — some
    // clients strip the <html> attributes entirely.
    expect(mail.html).toMatch(/<div dir="rtl"/);
    expect(mail.subject).toMatch(/[؀-ۿ]/);
    expect(mail.html).toMatch(/[؀-ۿ]/);
    // The URL block stays left-to-right, because a URL is not Arabic text.
    expect(mail.html).toMatch(/direction:ltr/);
  });

  it('chooses the language: recipient, then club, then English', () => {
    expect(resolveEmailLocale('de-AT', 'ar')).toBe('de');
    expect(resolveEmailLocale(null, 'ar-EG')).toBe('ar');
    expect(resolveEmailLocale(null, null)).toBe('en');
    // A language Familista's email does not speak falls through to English
    // rather than rendering a template that does not exist.
    expect(resolveEmailLocale('ja-JP', 'pt-BR')).toBe('en');
  });

  it('escapes what a club typed into its own name', () => {
    const mail = renderInvitationEmail('STAFF', { ...ctx, clubName: '<script>alert(1)</script>', locale: 'en' });
    expect(mail.html).not.toContain('<script>alert(1)</script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('and the SYSTEM catalogue is not asked to carry email copy', () => {
    // Email templates are server-rendered documents, not interface strings.
    // Thirty-one of them would be thirty-one things to keep correct.
    const catalogue = JSON.parse(read('public/system/i18n/en.json')) as Record<string, string>;
    expect(catalogue['You have been invited to lead %d on Familista']).toBeUndefined();
    expect(fs.readdirSync(path.join(ROOT, 'public/system/i18n')).sort()).toEqual(['ar.json', 'de.json', 'en.json']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The gateway itself
// ─────────────────────────────────────────────────────────────────────────────

describe('one gateway, and no product code past it', () => {
  it('no service reaches a provider SDK directly', () => {
    for (const file of [
      'src/identity/invitation.service.ts',
      'src/identity/invitation-mail.service.ts',
      'src/platform/club-onboarding.service.ts',
      'src/services/password-reset.service.ts',
      'src/lib/email.adapter.ts',
    ]) {
      const src = read(file);
      for (const sdk of ['sendgrid.com', 'nodemailer', 'createTransport', 'api.sendgrid']) {
        expect(`${file}:${sdk}:${src.includes(sdk)}`).toBe(`${file}:${sdk}:false`);
      }
    }
    // The adapters are the only files that name a provider at all.
    expect(read('src/platform/email/providers/sendgrid.ts')).toContain('api.sendgrid.com');
    expect(read('src/platform/email/providers/smtp.ts')).toContain('nodemailer');
  });

  it('bounds every attempt, and retries only what retrying could fix', async () => {
    expect(RETRYABLE.TEMPORARY).toBe(true);
    expect(RETRYABLE.RATE_LIMIT).toBe(true);
    expect(RETRYABLE.PERMANENT).toBe(false);
    expect(RETRYABLE.CONFIGURATION).toBe(false);
    expect(RETRYABLE.INVALID_RECIPIENT).toBe(false);

    expect(classifyHttpStatus(401)).toBe('CONFIGURATION');
    expect(classifyHttpStatus(429)).toBe('RATE_LIMIT');
    expect(classifyHttpStatus(422)).toBe('INVALID_RECIPIENT');
    expect(classifyHttpStatus(503)).toBe('TEMPORARY');

    // A permanent failure is attempted once; a temporary one more than once.
    let attempts = 0;
    setEmailProvider({
      name: 'p', isConfigured: () => true, configurationProblem: () => null,
      async send() {
        attempts += 1;
        return { ok: false, providerName: 'p', providerMessageId: null, failureClass: 'PERMANENT' as const, failureCode: 'HTTP_400', latencyMs: 1 };
      },
    });
    await sendEmail({ to: { address: 'a@b.test' }, subject: 's', html: 'h', text: 't' });
    expect(attempts).toBe(1);

    attempts = 0;
    setEmailProvider({
      name: 'p', isConfigured: () => true, configurationProblem: () => null,
      async send() {
        attempts += 1;
        return { ok: false, providerName: 'p', providerMessageId: null, failureClass: 'TEMPORARY' as const, failureCode: 'TIMEOUT', latencyMs: 1 };
      },
    });
    await sendEmail({ to: { address: 'a@b.test' }, subject: 's', html: 'h', text: 't' });
    expect(attempts).toBeGreaterThan(1);
    // And bounded — it does not retry forever.
    expect(attempts).toBeLessThanOrEqual(5);
  });

  it('never throws at the caller, whatever an adapter does', async () => {
    setEmailProvider({
      name: 'broken', isConfigured: () => true, configurationProblem: () => null,
      async send() { throw new Error('adapter exploded'); },
    });
    const result = await sendEmail({ to: { address: 'a@b.test' }, subject: 's', html: 'h', text: 't' });
    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe('ADAPTER_ERROR');
  });

  it('counts attempts, sends, failures and latency — with nobody in them', async () => {
    setEmailProvider(new RecordingProvider('ok'));
    await sendEmail({ to: { address: 'a@b.test' }, subject: 'Secret subject', html: 'h', text: 't' });
    setEmailProvider(new RecordingProvider('fail', 'HTTP_500'));
    await sendEmail({ to: { address: 'c@d.test' }, subject: 's', html: 'h', text: 't' });

    const m = emailMetrics();
    expect(m.attempted).toBe(2);
    expect(m.sent).toBe(1);
    expect(m.failed).toBe(1);
    expect(m.byFailureClass.TEMPORARY).toBe(1);
    expect(typeof m.averageLatencyMs).toBe('number');
    // No address, no subject, no token in the metric shape.
    const json = JSON.stringify(m);
    expect(json).not.toContain('@');
    expect(json).not.toContain('Secret subject');
  });

  it('selects the provider from configuration, and names one that is misconfigured', () => {
    setEmailProvider(null);
    const previous = process.env.EMAIL_PROVIDER;
    process.env.EMAIL_PROVIDER = 'sendgrid';
    const chosen = selectProvider();
    expect(chosen.name).toBe('sendgrid');
    // Named but unconfigured is NOT silently replaced by another adapter — an
    // operator who set the variable and forgot the key must be told.
    if (!process.env.SENDGRID_API_KEY) {
      expect(chosen.isConfigured()).toBe(false);
      expect(chosen.configurationProblem()).toMatch(/SENDGRID_API_KEY/);
    }
    if (previous === undefined) delete process.env.EMAIL_PROVIDER; else process.env.EMAIL_PROVIDER = previous;
    setEmailProvider(new RecordingProvider());
  });

  it('and the environment variables are documented, with no secret committed', () => {
    const example = read('.env.example');
    for (const key of ['EMAIL_PROVIDER', 'EMAIL_FROM', 'PUBLIC_APP_URL', 'SENDGRID_API_KEY', 'SMTP_HOST', 'EMAIL_TIMEOUT_MS']) {
      expect(`${key}:${example.includes(key)}`).toBe(`${key}:true`);
    }
    // Placeholders only — nothing that looks like a real key.
    expect(example).toMatch(/SENDGRID_API_KEY=\s*$/m);
    expect(example).not.toMatch(/SG\.[A-Za-z0-9_-]{20,}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit, and the club side
// ─────────────────────────────────────────────────────────────────────────────

describe('what is recorded, and what is not', () => {
  it('audits the delivery with actor, club, invitation, role, provider and environment', async () => {
    await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });
    const row = state.platformAudits.find((a) => a.action === 'InvitationEmailSent')!;
    expect(row).toBeDefined();
    expect(row.userId).toBe('u-owner');
    expect(row.clubId).toBe(CLUB);
    expect(row.resourceType).toBe('ClubInvitation');
    expect(row.resourceId).toBe(state.invitations[0].id);
    expect(row.metadata).toMatchObject({ role: 'CLUB_OWNER', kind: 'PRESIDENT', provider: 'recording' });
    expect(row.metadata.environment).toMatch(/PRODUCTION|STAGING|LAB|PREVIEW/);
    // The recipient is a reference, not an address.
    expect(row.metadata.recipient).toHaveLength(8);
    expect(JSON.stringify(row)).not.toContain('p@club.test');
  });

  it('audits a failure with a safe code and nothing else', async () => {
    setEmailProvider(new RecordingProvider('fail', 'HTTP_429'));
    await invites.createInvitation(OWNER, { email: 'p@club.test', role: MembershipRole.CLUB_OWNER });
    const row = state.platformAudits.find((a) => a.action === 'InvitationEmailFailed')!;
    expect(row.metadata.failureCode).toBe('HTTP_429');
    // A provider's body can quote the message it refused, so it is never here.
    expect(JSON.stringify(row).length).toBeLessThan(1200);
  });

  it('CLUBS uses the same invitation domain, never a second implementation', () => {
    const clubController = read('src/controllers/invitation.controller.ts');
    const systemService = read('src/platform/club-onboarding.service.ts');
    // Both call the same service.
    expect(clubController).toContain("from '../identity/invitation.service'");
    expect(systemService).toContain("from '../identity/invitation.service'");
    // And neither mints a token of its own.
    for (const src of [clubController, systemService]) {
      expect(src).not.toMatch(/randomBytes|createHash|tokenHash/);
    }
  });

  it('and the club routes still enforce exactly the gates they did', () => {
    const routes = read('src/routes/invitation.routes.ts');
    expect(routes).toContain("router.post('/',           authorize('CLUB_ADMIN', 'SUPER_ADMIN'), requireMembership('CLUB_ADMIN'), ctrl.create);");
    expect(routes).toContain("router.post('/:id/resend', authorize('CLUB_ADMIN', 'SUPER_ADMIN'), requireMembership('CLUB_ADMIN'), ctrl.resend);");
    expect(routes).toContain("router.delete('/:id',      authorize('CLUB_ADMIN', 'SUPER_ADMIN'), requireMembership('CLUB_ADMIN'), ctrl.revoke);");
    // The recipient's side is unchanged too.
    expect(routes).toContain("router.get('/preview', ctrl.preview);");
  });
});
