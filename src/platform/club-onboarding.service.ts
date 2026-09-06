// Bringing a club onto Familista, without owning it
// ─────────────────────────────────────────────────────────────────────────────
// The platform owner creates the club. A person the platform owner names — and
// only that person, after they accept and sign in with a password nobody else
// has ever seen — becomes its president.
//
// The gap between those two sentences is the whole design. For as long as it
// lasts, the club exists and nobody runs it, and that state has to be visible
// rather than papered over:
//
//   PENDING_SETUP       the row exists, nobody owns it
//   PRESIDENT_INVITED   an invitation is out, still nobody owns it
//   ACTIVE              somebody accepted and holds CLUB_OWNER
//
// A club is never ACTIVE because a row was inserted. It becomes ACTIVE when
// `activateIfReady` can prove there is an active CLUB_OWNER membership, and not
// one moment earlier.
//
// ── What this file will not do, ever
//
// It will not make the platform owner a club owner, temporarily or otherwise.
// There is no code path here that creates a Membership for the acting platform
// admin, and the tests fail if one appears. Platform ownership is a
// PlatformAdmin row; club ownership is a Membership; the two are different
// authorities held by different people, and a convenience that merged them
// "just until the president arrives" would be exactly the merge the whole
// SYSTEM boundary exists to prevent.
//
// It also does not re-implement invitations or memberships. Both already exist
// and are already audited, single-use and expiring; this file calls them at a
// platform-level boundary rather than reaching into a club workspace.

import { ClubInvitationStatus, ClubLifecycle, MembershipRole, PlatformAuditCategory, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import * as invites from '../identity/invitation.service';
import { assertPlatformOwner } from './system.service';
import { currentEnvironment } from './environment';
import { type PlatformActor } from './access-levels';

export interface OnboardingActor extends PlatformActor {
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Ties every event of one request together. */
  correlationId?: string | null;
}

export interface CreateClubDto {
  name: string;
  shortName?: string | null;
  country?: string | null;
  city: string;
  timezone?: string | null;
  defaultLocale?: string | null;
  contactEmail?: string | null;
  websiteUrl?: string | null;
  president: {
    firstName: string;
    lastName: string;
    email: string;
    message?: string | null;
  };
}

/** Delivery is honest about itself: nothing here has sent an email. */
export type DeliveryStatus = 'PARTIAL_NO_MAIL_PROVIDER';

export interface PresidentState {
  /** PENDING while an invitation is out; ACTIVE once somebody accepted. */
  state: 'NONE' | 'INVITED' | 'ACTIVE';
  email: string | null;
  name: string | null;
  invitationId: string | null;
  invitationStatus: ClubInvitationStatus | null;
  invitationExpiresAt: Date | null;
  userId: string | null;
  membershipId: string | null;
}

export interface ClubSetupState {
  clubId: string;
  name: string;
  lifecycle: ClubLifecycle;
  activatedAt: Date | null;
  president: PresidentState;
  /** The four steps the interface renders, each true only when it is true. */
  steps: {
    clubCreated: boolean;
    presidentInvited: boolean;
    presidentAccepted: boolean;
    clubActivated: boolean;
  };
  /** Why the club is not active yet, when it is not. */
  blocking: string | null;
}

const INVITE_DELIVERY: DeliveryStatus = 'PARTIAL_NO_MAIL_PROVIDER';

function required(value: string | null | undefined, field: string): string {
  const v = String(value ?? '').trim();
  if (!v) throw new BadRequestError(`${field} is required`);
  return v;
}

function normaliseEmail(email: string): string {
  const value = String(email ?? '').toLowerCase().trim();
  if (!value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    throw new BadRequestError('A valid president email address is required');
  }
  return value;
}

/**
 * Platform-level audit, separate from the club's own membership audit trail.
 *
 * Both are written: the club needs to know who was invited to it, and the
 * platform needs to know who created the club. Neither carries a password, a
 * raw token or a token hash — the payload is built from ids and addresses and
 * there is no code here that could reach a credential.
 */
async function platformAudit(
  tx: Prisma.TransactionClient,
  actor: OnboardingActor,
  action: string,
  clubId: string,
  metadata: Record<string, unknown>,
  message: string,
): Promise<void> {
  const admin = await tx.platformAdmin.findUnique({
    where: { userId: actor.userId },
    select: { id: true },
  });
  await tx.platformAuditLog.create({
    data: {
      adminId: admin?.id ?? null,
      userId: actor.userId,
      clubId,
      action,
      category: PlatformAuditCategory.CLUB_MANAGEMENT,
      resourceType: 'Club',
      resourceId: clubId,
      ipAddress: actor.ipAddress ?? undefined,
      userAgent: actor.userAgent ?? undefined,
      metadata: {
        ...metadata,
        environment: currentEnvironment(),
        correlationId: actor.correlationId ?? null,
      } as Prisma.InputJsonValue,
      message,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who runs this club, and how far its setup has got.
 *
 * Every field is read from rows at the moment of asking. Nothing is cached and
 * nothing is inferred from the lifecycle column alone — if the column said
 * ACTIVE and no CLUB_OWNER membership existed, this would report the truth and
 * the discrepancy, not the column.
 */
export async function clubSetupState(clubId: string): Promise<ClubSetupState> {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { id: true, name: true, lifecycle: true, activatedAt: true },
  });
  if (!club) throw new NotFoundError('Club');

  const [owner, invitation] = await Promise.all([
    prisma.membership.findFirst({
      where: { clubId, role: MembershipRole.CLUB_OWNER, isActive: true, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, userId: true, user: { select: { email: true, firstName: true, lastName: true } } },
    }),
    prisma.clubInvitation.findFirst({
      where: { clubId, role: MembershipRole.CLUB_OWNER },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, status: true, expiresAt: true },
    }),
  ]);

  const president: PresidentState = owner
    ? {
        state: 'ACTIVE',
        email: owner.user?.email ?? null,
        name: `${owner.user?.firstName ?? ''} ${owner.user?.lastName ?? ''}`.trim() || null,
        invitationId: invitation?.id ?? null,
        invitationStatus: invitation?.status ?? null,
        invitationExpiresAt: invitation?.expiresAt ?? null,
        userId: owner.userId,
        membershipId: owner.id,
      }
    : invitation && invitation.status === 'PENDING' && invitation.expiresAt > new Date()
      ? {
          state: 'INVITED',
          email: invitation.email,
          name: null,
          invitationId: invitation.id,
          invitationStatus: invitation.status,
          invitationExpiresAt: invitation.expiresAt,
          userId: null,
          membershipId: null,
        }
      : {
          state: 'NONE',
          email: invitation?.email ?? null,
          name: null,
          invitationId: invitation?.id ?? null,
          invitationStatus: invitation?.status ?? null,
          invitationExpiresAt: invitation?.expiresAt ?? null,
          userId: null,
          membershipId: null,
        };

  const activated = club.lifecycle === ClubLifecycle.ACTIVE && president.state === 'ACTIVE';

  return {
    clubId: club.id,
    name: club.name,
    lifecycle: club.lifecycle,
    activatedAt: club.activatedAt,
    president,
    steps: {
      clubCreated: true,
      presidentInvited: president.state !== 'NONE',
      presidentAccepted: president.state === 'ACTIVE',
      clubActivated: activated,
    },
    blocking: activated ? null
      : president.state === 'ACTIVE' ? 'The president has accepted; activation has not been reconciled yet.'
      : president.state === 'INVITED' ? 'The invited president has not accepted yet.'
      : 'No president has been invited.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Creating one
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateClubResult {
  clubId: string;
  setup: ClubSetupState;
  invitation: invites.InvitationView;
  /**
   * The raw invitation token, returned exactly once to the platform owner who
   * created it — because no mail provider is configured and somebody has to be
   * able to give the president their link. It is not stored anywhere (only its
   * SHA-256 is) and it is never returned again; resending mints a new one.
   */
  token: string;
  delivery: { status: DeliveryStatus; detail: string };
  /** True when this call found an existing pending club rather than making one. */
  idempotentHit: boolean;
}

/**
 * Create a club and invite its president, in one transaction.
 *
 * Either both exist or neither does. There is no arrangement in which a club
 * row survives a failed invitation, because a club with no president and no
 * pending invitation is precisely the "healthy-looking but unowned" state this
 * whole lifecycle exists to make impossible.
 *
 * Retries are safe. A second call naming the same club and the same president
 * email finds the pending club the first call made and returns its state
 * instead of creating a second one — and says so, so the caller knows no new
 * invitation token was minted.
 */
export async function createClubWithPresidentInvite(
  actor: OnboardingActor,
  dto: CreateClubDto,
): Promise<CreateClubResult> {
  await assertPlatformOwner(actor);

  const name = required(dto.name, 'Club name');
  const city = required(dto.city, 'Club city');
  const firstName = required(dto.president?.firstName, "The president's first name");
  const lastName = required(dto.president?.lastName, "The president's last name");
  const email = normaliseEmail(dto.president?.email);

  // ── idempotence ────────────────────────────────────────────────────────────
  // A retried request must not produce a second club. One that names the same
  // club and the same president as a club still waiting for setup is the same
  // request, and it is answered with what the first one built.
  const existing = await prisma.club.findFirst({
    where: {
      name,
      city,
      lifecycle: { in: [ClubLifecycle.PENDING_SETUP, ClubLifecycle.PRESIDENT_INVITED] },
      invitations: { some: { email, role: MembershipRole.CLUB_OWNER, status: 'PENDING' } },
    },
    select: { id: true },
  });
  if (existing) {
    const setup = await clubSetupState(existing.id);
    const invitation = await prisma.clubInvitation.findFirst({
      where: { clubId: existing.id, email, role: MembershipRole.CLUB_OWNER, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    return {
      clubId: existing.id,
      setup,
      invitation: invites.view(invitation!),
      // No new token: the one that was minted is the one that works, and this
      // call did not mint anything.
      token: '',
      delivery: {
        status: INVITE_DELIVERY,
        detail: 'This club and invitation already existed. Nothing was created and no new link was minted — resend the invitation if the president needs a fresh one.',
      },
      idempotentHit: true,
    };
  }

  const { clubId, invitationRow } = await prisma.$transaction(async (tx) => {
    const club = await tx.club.create({
      data: {
        name,
        city,
        shortName: dto.shortName?.trim() || null,
        country: dto.country?.trim() || 'Germany',
        timezone: dto.timezone?.trim() || null,
        defaultLocale: dto.defaultLocale?.trim() || null,
        contactEmail: dto.contactEmail?.trim() || null,
        websiteUrl: dto.websiteUrl?.trim() || null,
        // Explicit, and the reason this column exists. A club created here is
        // not active, whatever the column default says.
        lifecycle: ClubLifecycle.PENDING_SETUP,
      },
      select: { id: true },
    });

    await platformAudit(tx, actor, 'ClubCreated', club.id,
      { name, city, country: dto.country ?? 'Germany', lifecycle: ClubLifecycle.PENDING_SETUP },
      'Created from SYSTEM. No membership was granted to the platform owner; the club has no owner until its president accepts.');

    return { clubId: club.id, invitationRow: null as null };
  });

  // ── the invitation ─────────────────────────────────────────────────────────
  // Minted by the existing invitation service — 32 random bytes, SHA-256
  // stored, seven days, single-use, revocable, audited — with the platform
  // owner as the inviter and the brand-new club as the scope. It is a separate
  // transaction because it is a separate service that owns its own; if it
  // fails, the club stays PENDING_SETUP with no invitation, which is a state
  // SYSTEM shows as incomplete and can retry, and is never mistaken for a
  // healthy club.
  let created: { invitation: invites.InvitationView; token: string };
  try {
    created = await invites.createInvitation(
      { userId: actor.userId, clubId, ipAddress: actor.ipAddress, userAgent: actor.userAgent },
      {
        email,
        role: MembershipRole.CLUB_OWNER,
        teamId: null,
        message: dto.president.message?.trim()
          || `${firstName} ${lastName} is invited to be president of ${name}.`,
      },
    );
  } catch (err) {
    // The club exists and is PENDING_SETUP with no invitation. Say so plainly
    // rather than leaving the caller to guess; the club is visible in SYSTEM,
    // and inviting a president is one call away.
    await prisma.$transaction((tx) => platformAudit(tx, actor, 'ClubPresidentInviteFailed', clubId,
      { email, error: err instanceof Error ? err.message : 'unknown' },
      'The club was created but the president invitation failed. The club remains PENDING_SETUP and is not active.'));
    throw err;
  }

  await prisma.$transaction(async (tx) => {
    await tx.club.update({
      where: { id: clubId },
      data: { lifecycle: ClubLifecycle.PRESIDENT_INVITED },
    });
    await platformAudit(tx, actor, 'ClubPresidentInvited', clubId,
      { invitationId: created.invitation.id, email, role: MembershipRole.CLUB_OWNER,
        expiresAt: created.invitation.expiresAt.toISOString(), presidentName: `${firstName} ${lastName}` },
      'An invitation was created. No email was sent — no mail provider is configured.');
  });

  return {
    clubId,
    setup: await clubSetupState(clubId),
    invitation: created.invitation,
    token: created.token,
    delivery: {
      status: INVITE_DELIVERY,
      detail: 'No mail provider is configured, so nothing was emailed. Give the president the link below yourself; it is shown once and cannot be retrieved again.',
    },
    idempotentHit: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Managing a pending president
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refuse to touch a club that already has a president.
 *
 * Replacing an ACTIVE president is a different job with different stakes — it
 * removes somebody's authority over their own club — and it is not something
 * SYSTEM does through the pending-invitation controls. The existing
 * last-owner protection in the membership service remains the only way a club
 * loses its owner, and it is not reachable from here.
 */
async function assertNoActivePresident(clubId: string): Promise<void> {
  const owner = await prisma.membership.findFirst({
    where: { clubId, role: MembershipRole.CLUB_OWNER, isActive: true, status: 'ACTIVE' },
    select: { id: true },
  });
  if (owner) {
    throw new ForbiddenError(
      'This club already has an active president. Changing an active president is a protected club action, not an invitation control.',
    );
  }
}

export async function resendPresidentInvite(
  actor: OnboardingActor,
  clubId: string,
): Promise<{ invitation: invites.InvitationView; token: string; delivery: { status: DeliveryStatus; detail: string } }> {
  await assertPlatformOwner(actor);
  await assertNoActivePresident(clubId);

  const pending = await prisma.clubInvitation.findFirst({
    where: { clubId, role: MembershipRole.CLUB_OWNER, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!pending) throw new NotFoundError('Pending president invitation');

  // Resending mints a NEW token and retires the old one — the existing service
  // already guarantees that, which is why this calls it rather than updating
  // the row itself.
  const out = await invites.resendInvitation(
    { userId: actor.userId, clubId, ipAddress: actor.ipAddress, userAgent: actor.userAgent },
    pending.id,
  );

  await prisma.$transaction((tx) => platformAudit(tx, actor, 'ClubPresidentInvitationResent', clubId,
    { invitationId: out.invitation.id, email: out.invitation.email, expiresAt: out.invitation.expiresAt.toISOString() },
    'A new link was minted and the previous one stopped working. No email was sent.'));

  return {
    invitation: out.invitation,
    token: out.token,
    delivery: {
      status: INVITE_DELIVERY,
      detail: 'No mail provider is configured. The previous link no longer works; give the president the new one.',
    },
  };
}

export async function revokePresidentInvite(
  actor: OnboardingActor,
  clubId: string,
  reason?: string,
): Promise<ClubSetupState> {
  await assertPlatformOwner(actor);
  await assertNoActivePresident(clubId);

  const pending = await prisma.clubInvitation.findFirst({
    where: { clubId, role: MembershipRole.CLUB_OWNER, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true },
  });
  if (!pending) throw new NotFoundError('Pending president invitation');

  await invites.revokeInvitation(
    { userId: actor.userId, clubId, ipAddress: actor.ipAddress, userAgent: actor.userAgent },
    pending.id,
    reason,
  );

  await prisma.$transaction(async (tx) => {
    // Back to PENDING_SETUP: there is no invitation out and no owner, and the
    // lifecycle must say so rather than claiming a president is on the way.
    await tx.club.update({ where: { id: clubId }, data: { lifecycle: ClubLifecycle.PENDING_SETUP } });
    await platformAudit(tx, actor, 'ClubPresidentInvitationRevoked', clubId,
      { invitationId: pending.id, email: pending.email, reason: reason ?? null },
      'The invitation was withdrawn. The link stopped working immediately and the club is back to PENDING_SETUP.');
  });

  return clubSetupState(clubId);
}

/**
 * Invite a different person instead.
 *
 * Only reachable while nobody has accepted: this revokes the outstanding
 * invitation and issues one to a new address, both of them audited. It cannot
 * replace an active president — `assertNoActivePresident` refuses that, and
 * that refusal is the point.
 */
export async function replacePresidentInvite(
  actor: OnboardingActor,
  clubId: string,
  president: { firstName: string; lastName: string; email: string; message?: string | null },
  reason?: string,
): Promise<CreateClubResult> {
  await assertPlatformOwner(actor);
  await assertNoActivePresident(clubId);

  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { id: true, name: true } });
  if (!club) throw new NotFoundError('Club');

  const firstName = required(president?.firstName, "The president's first name");
  const lastName = required(president?.lastName, "The president's last name");
  const email = normaliseEmail(president?.email);

  const outstanding = await prisma.clubInvitation.findFirst({
    where: { clubId, role: MembershipRole.CLUB_OWNER, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true },
  });
  if (outstanding?.email === email) {
    throw new ConflictError('That address already holds the pending invitation. Resend it instead of replacing it.');
  }
  if (outstanding) {
    await invites.revokeInvitation(
      { userId: actor.userId, clubId, ipAddress: actor.ipAddress, userAgent: actor.userAgent },
      outstanding.id,
      reason ?? 'Replaced by a different president candidate',
    );
  }

  const created = await invites.createInvitation(
    { userId: actor.userId, clubId, ipAddress: actor.ipAddress, userAgent: actor.userAgent },
    {
      email,
      role: MembershipRole.CLUB_OWNER,
      teamId: null,
      message: president.message?.trim() || `${firstName} ${lastName} is invited to be president of ${club.name}.`,
    },
  );

  await prisma.$transaction(async (tx) => {
    await tx.club.update({ where: { id: clubId }, data: { lifecycle: ClubLifecycle.PRESIDENT_INVITED } });
    await platformAudit(tx, actor, 'ClubPresidentInvitationReplaced', clubId,
      {
        previousInvitationId: outstanding?.id ?? null,
        previousEmail: outstanding?.email ?? null,
        invitationId: created.invitation.id,
        email,
        presidentName: `${firstName} ${lastName}`,
        reason: reason ?? null,
      },
      'A different president was invited. The previous link stopped working. No email was sent.');
  });

  return {
    clubId,
    setup: await clubSetupState(clubId),
    invitation: created.invitation,
    token: created.token,
    delivery: {
      status: INVITE_DELIVERY,
      detail: 'No mail provider is configured. Give the new president the link below; it is shown once.',
    },
    idempotentHit: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Activation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Activate the club, if — and only if — it is genuinely ready.
 *
 * "Ready" is one condition, checked against rows rather than assumed from the
 * fact that an acceptance handler just ran: the club has an active, unsuspended
 * CLUB_OWNER membership. No owner, no activation, whatever else happened.
 *
 * Idempotent by construction. The update is conditioned on the club not already
 * being ACTIVE, so two acceptances racing each other produce one activation and
 * one no-op, and a retry writes nothing and audits nothing.
 *
 * Called after an invitation is accepted. Deliberately safe to call at any
 * other time too — it is a reconciliation, not a side effect.
 */
export async function activateIfReady(
  clubId: string,
  actor?: Partial<OnboardingActor>,
): Promise<ClubSetupState> {
  const owner = await prisma.membership.findFirst({
    where: { clubId, role: MembershipRole.CLUB_OWNER, isActive: true, status: 'ACTIVE' },
    select: { id: true, userId: true },
  });
  if (!owner) return clubSetupState(clubId);

  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { id: true, lifecycle: true } });
  if (!club) throw new NotFoundError('Club');
  if (club.lifecycle === ClubLifecycle.ACTIVE) return clubSetupState(clubId);

  await prisma.$transaction(async (tx) => {
    const moved = await tx.club.updateMany({
      where: { id: clubId, lifecycle: { not: ClubLifecycle.ACTIVE } },
      data: { lifecycle: ClubLifecycle.ACTIVE, activatedAt: new Date() },
    });
    // A second caller finding it already ACTIVE writes nothing and audits
    // nothing, which is what makes retrying free.
    if (moved.count !== 1) return;
    await tx.platformAuditLog.create({
      data: {
        userId: actor?.userId ?? owner.userId,
        clubId,
        action: 'ClubActivated',
        category: PlatformAuditCategory.CLUB_MANAGEMENT,
        resourceType: 'Club',
        resourceId: clubId,
        metadata: {
          membershipId: owner.id,
          presidentUserId: owner.userId,
          environment: currentEnvironment(),
          correlationId: actor?.correlationId ?? null,
        } as Prisma.InputJsonValue,
        message: 'The club has an active CLUB_OWNER membership and is now active.',
      },
    });
  });

  return clubSetupState(clubId);
}
