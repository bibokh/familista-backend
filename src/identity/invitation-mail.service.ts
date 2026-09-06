// Delivering an invitation — the one place the two domains meet
// ─────────────────────────────────────────────────────────────────────────────
// The invitation service mints tokens and owns the invitation's life. The email
// gateway sends messages and owns delivery. This file is the seam: it takes a
// freshly minted invitation and its raw token, renders the right template in
// the right language, asks the gateway to send it, and records what happened on
// the invitation row.
//
// ── The raw token
//
// It exists in one process, for one function call, inside one URL. It is not
// persisted (only its SHA-256 is), not logged, not audited, and not returned by
// any list. This file receives it, renders it into a link, and lets it go.
//
// ── Delivery is not validity
//
// Nothing here can change an invitation's status. A send that fails writes
// deliveryState = FAILED and leaves a PENDING invitation exactly as it was, so
// a resend can carry the same offer again. That separation is enforced by this
// file only ever updating the delivery columns.

import { ClubInvitation, MembershipRole, PlatformAuditCategory, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { currentEnvironment } from '../platform/environment';
import { sendEmail, publicAppUrl, recipientRef, emailConfiguration } from '../platform/email/service';
import { renderInvitationEmail, resolveEmailLocale, type EmailLocale } from '../platform/email/templates';

/** The role, in words a person recognises, per language. */
const ROLE_LABELS: Record<EmailLocale, Partial<Record<MembershipRole, string>>> = {
  en: {
    CLUB_OWNER: 'President', CLUB_ADMIN: 'Club administrator', HEAD_COACH: 'Head coach',
    ASSISTANT_COACH: 'Assistant coach', ANALYST: 'Analyst', SCOUT: 'Scout',
    MEDICAL_STAFF: 'Medical staff', PARENT: 'Parent', PLAYER: 'Player',
  },
  de: {
    CLUB_OWNER: 'Präsident', CLUB_ADMIN: 'Vereinsadministrator', HEAD_COACH: 'Cheftrainer',
    ASSISTANT_COACH: 'Co-Trainer', ANALYST: 'Analyst', SCOUT: 'Scout',
    MEDICAL_STAFF: 'Medizinisches Personal', PARENT: 'Elternteil', PLAYER: 'Spieler',
  },
  ar: {
    CLUB_OWNER: 'الرئيس', CLUB_ADMIN: 'مسؤول النادي', HEAD_COACH: 'المدرب الرئيسي',
    ASSISTANT_COACH: 'المدرب المساعد', ANALYST: 'محلل', SCOUT: 'كشاف',
    MEDICAL_STAFF: 'الطاقم الطبي', PARENT: 'ولي أمر', PLAYER: 'لاعب',
  },
};

function roleLabel(role: MembershipRole, locale: EmailLocale): string {
  return ROLE_LABELS[locale][role] ?? ROLE_LABELS.en[role] ?? String(role).replace(/_/g, ' ').toLowerCase();
}

/**
 * The acceptance link.
 *
 * Built from configuration, so a deployment points at its own origin, and the
 * token is url-encoded into the query rather than a path segment — a path
 * segment ends up in more logs, more referrers and more places nobody expected.
 */
export function acceptanceUrl(rawToken: string): string {
  const base = publicAppUrl() || '';
  return `${base}/invite/accept?token=${encodeURIComponent(rawToken)}`;
}

export interface DeliveryOutcome {
  state: 'SENT' | 'FAILED';
  provider: string;
  failureClass: string | null;
  failureCode: string | null;
  locale: EmailLocale;
  /** True when nothing was even attempted because nothing is configured. */
  notConfigured: boolean;
}

export interface DeliverOptions {
  kind: 'PRESIDENT' | 'STAFF';
  invitation: ClubInvitation;
  /** The one copy of the token that exists. Consumed here and forgotten. */
  rawToken: string;
  inviterName?: string | null;
  resent?: boolean;
  actorUserId?: string | null;
  correlationId?: string | null;
}

/**
 * Send an invitation, and record what happened to it.
 *
 * Never throws. A delivery failure is a recorded fact, not an exception that
 * unwinds the transaction that created a perfectly good invitation.
 */
export async function deliverInvitation(opts: DeliverOptions): Promise<DeliveryOutcome> {
  const { invitation, rawToken } = opts;

  const [club, account] = await Promise.all([
    prisma.club.findUnique({
      where: { id: invitation.clubId },
      select: { name: true, defaultLocale: true },
    }),
    // The invited address may already have an account, in which case it has a
    // name and possibly a language. Selected narrowly: no credential column is
    // in this query and none may ever be added to it.
    prisma.user.findUnique({
      where: { email: invitation.email },
      select: { firstName: true, lastName: true },
    }),
  ]);

  const locale = resolveEmailLocale(club?.defaultLocale, 'en');
  const recipientName = account ? `${account.firstName ?? ''} ${account.lastName ?? ''}`.trim() || null : null;

  await prisma.clubInvitation.update({
    where: { id: invitation.id },
    data: { deliveryState: 'QUEUED', deliveryLocale: locale },
  });

  const rendered = renderInvitationEmail(opts.kind, {
    recipientName,
    clubName: club?.name ?? 'Familista',
    roleLabel: roleLabel(invitation.role, locale),
    inviterName: opts.inviterName ?? null,
    acceptUrl: acceptanceUrl(rawToken),
    expiresAt: invitation.expiresAt,
    locale,
    resent: !!opts.resent,
  });

  const result = await sendEmail({
    to: { address: invitation.email, name: recipientName },
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    locale,
    // The invitation id, never the token — this ends up in the delivery log.
    correlationId: opts.correlationId ?? invitation.id,
  });

  const state = result.ok ? 'SENT' : 'FAILED';
  await prisma.clubInvitation.update({
    where: { id: invitation.id },
    data: {
      deliveryState: state,
      deliveryProvider: result.providerName,
      deliveryMessageId: result.providerMessageId,
      deliveryFailureClass: result.failureClass,
      deliveryFailureCode: result.failureCode,
      deliveryAttemptedAt: new Date(),
      deliveryAttempts: { increment: 1 },
    },
  });

  await auditDelivery(opts, result.ok, result.providerName, result.failureCode);

  return {
    state,
    provider: result.providerName,
    failureClass: result.failureClass,
    failureCode: result.failureCode,
    locale,
    notConfigured: result.failureCode === 'EMAIL_NOT_CONFIGURED',
  };
}

/**
 * The audit row for a delivery attempt.
 *
 * Carries the actor, the club, the invitation, the role, the provider, the
 * environment and a safe failure code. It does NOT carry the raw token, the
 * token hash, the provider's key or the provider's response body — and there is
 * no parameter on this function through which one could arrive.
 */
async function auditDelivery(
  opts: DeliverOptions,
  ok: boolean,
  provider: string,
  failureCode: string | null,
): Promise<void> {
  const action = ok
    ? 'InvitationEmailSent'
    : failureCode === 'EMAIL_NOT_CONFIGURED' ? 'InvitationEmailNotConfigured' : 'InvitationEmailFailed';
  try {
    await prisma.platformAuditLog.create({
      data: {
        userId: opts.actorUserId ?? null,
        clubId: opts.invitation.clubId,
        action,
        category: PlatformAuditCategory.CLUB_MANAGEMENT,
        resourceType: 'ClubInvitation',
        resourceId: opts.invitation.id,
        metadata: {
          role: String(opts.invitation.role),
          kind: opts.kind,
          provider,
          resent: !!opts.resent,
          failureCode: failureCode ?? null,
          environment: currentEnvironment(),
          // A reference, so two rows about the same person can be correlated
          // without an address being written down.
          recipient: recipientRef(opts.invitation.email),
        } as Prisma.InputJsonValue,
        message: ok
          ? 'The invitation email was accepted by the provider. The invitation itself is unchanged.'
          : 'The invitation email was not delivered. The invitation remains valid and can be resent.',
      },
    });
  } catch (err) {
    // An audit failure must not fail a delivery that already happened.
    logger.warn('invitation delivery audit failed', { err: String(err) });
  }
}

/** What SYSTEM shows about email, with no secret in it. */
export function emailStatus() {
  return emailConfiguration();
}
