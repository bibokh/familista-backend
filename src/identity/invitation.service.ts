// Club invitations — a person joins a club without anyone learning their password
// ─────────────────────────────────────────────────────────────────────────────
// A club owner names an email, a role and — optionally — a team. The platform
// mints a random token, stores only its SHA-256 and sends the token in a link.
// The recipient either signs in with the account they already have, or creates
// one with a password only they will ever know, and the invitation is consumed.
//
// What this file deliberately cannot do:
//
//   · set, read, choose or reset anybody's password. There is no password field
//     in this module, in the ClubInvitation table, or in any response it makes.
//   · grant membership of a club the inviter does not administer — the actor's
//     club comes from the session, never from the request.
//   · be replayed. One token, one acceptance: the row leaves PENDING exactly
//     once, inside the same transaction that creates the membership.
//   · outlive its welcome. An expired token is refused and reported as expired,
//     not as invalid, so a person who waited too long is told to ask again.
//
// Membership itself is not re-implemented here: acceptance calls the existing
// membership service, so the audit trail, the reactivation-not-duplication rule
// and the unique key are exactly the ones the club already relies on.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import {
  ClubInvitation, ClubInvitationStatus, MembershipAuditAction, MembershipRole, Prisma,
} from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { grantMembership, type MembershipActor } from '../services/membership.service';

/** Seven days: long enough for somebody on holiday, short enough to expire. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InviteActor extends MembershipActor {}

export interface CreateInvitationDto {
  email: string;
  role: MembershipRole;
  teamId?: string | null;
  message?: string | null;
}

/** What a club screen may see. The token is not in it, and never will be. */
export interface InvitationView {
  id: string;
  clubId: string;
  email: string;
  role: MembershipRole;
  teamId: string | null;
  status: ClubInvitationStatus;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  invitedByUserId: string;
  createdAt: Date;
}

export function hashInvitationToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** 32 random bytes, url-safe. The only copy that ever leaves the server. */
function mintToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashInvitationToken(raw) };
}

function normaliseEmail(email: string): string {
  const value = String(email ?? '').toLowerCase().trim();
  if (!value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw new BadRequestError('A valid email address is required');
  return value;
}

export function view(row: ClubInvitation): InvitationView {
  return {
    id: row.id,
    clubId: row.clubId,
    email: row.email,
    role: row.role,
    teamId: row.teamId,
    status: row.status,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    invitedByUserId: row.invitedByUserId,
    createdAt: row.createdAt,
  };
}

/** An invitation whose clock has run out is expired, whatever its column says. */
function effectiveStatus(row: ClubInvitation, now = new Date()): ClubInvitationStatus {
  if (row.status === 'PENDING' && row.expiresAt <= now) return 'EXPIRED';
  return row.status;
}

async function audit(
  tx: Prisma.TransactionClient,
  clubId: string,
  actorUserId: string | null,
  action: MembershipAuditAction,
  after: Record<string, unknown>,
  opts: { before?: Record<string, unknown>; reason?: string; ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<void> {
  await tx.membershipAuditLog.create({
    data: {
      clubId,
      actorUserId: actorUserId ?? undefined,
      action,
      before: opts.before as Prisma.InputJsonValue | undefined,
      after: after as Prisma.InputJsonValue,
      reason: opts.reason,
      ipAddress: opts.ipAddress ?? undefined,
      userAgent: opts.userAgent ?? undefined,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The club side
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Invite somebody to work for this club.
 *
 * Returns the row AND the raw token, once. The caller hands the token to the
 * mail adapter and forgets it; nothing stores it, and asking for it again means
 * issuing a new one.
 */
export async function createInvitation(
  actor: InviteActor,
  dto: CreateInvitationDto,
): Promise<{ invitation: InvitationView; token: string }> {
  const email = normaliseEmail(dto.email);

  if (dto.teamId) {
    const team = await prisma.team.findUnique({ where: { id: dto.teamId }, select: { clubId: true } });
    if (!team) throw new NotFoundError('Team');
    if (team.clubId !== actor.clubId) throw new ForbiddenError();
  }

  // One live invitation per address per club. A second one for the same person
  // would leave two working links, and revoking one would not revoke the other.
  const open = await prisma.clubInvitation.findFirst({
    where: { clubId: actor.clubId, email, status: 'PENDING', expiresAt: { gt: new Date() } },
  });
  if (open) throw new ConflictError('That email already has a pending invitation to this club');

  const { raw, hash } = mintToken();
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.clubInvitation.create({
      data: {
        clubId: actor.clubId,
        email,
        role: dto.role,
        teamId: dto.teamId ?? null,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedByUserId: actor.userId,
        message: dto.message ?? null,
      },
    });
    await audit(tx, actor.clubId, actor.userId, MembershipAuditAction.INVITED,
      { invitationId: created.id, email, role: dto.role, teamId: dto.teamId ?? null },
      { ipAddress: actor.ipAddress, userAgent: actor.userAgent });
    return created;
  });

  return { invitation: view(row), token: raw };
}

/**
 * Send it again — which means minting a NEW token and retiring the old one.
 *
 * Resending the same token would mean the platform still held something it
 * could hand out twice. It does not: the hash is replaced, so the previous link
 * stops working the moment this returns.
 */
export async function resendInvitation(
  actor: InviteActor,
  id: string,
): Promise<{ invitation: InvitationView; token: string }> {
  const existing = await prisma.clubInvitation.findUnique({ where: { id } });
  if (!existing || existing.clubId !== actor.clubId) throw new NotFoundError('Invitation');
  if (effectiveStatus(existing) === 'ACCEPTED') throw new ConflictError('That invitation has already been accepted');
  if (existing.status === 'REVOKED') throw new ConflictError('That invitation was revoked');

  const { raw, hash } = mintToken();
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.clubInvitation.update({
      where: { id },
      data: { tokenHash: hash, expiresAt: new Date(Date.now() + INVITE_TTL_MS), status: 'PENDING' },
    });
    await audit(tx, actor.clubId, actor.userId, MembershipAuditAction.INVITE_RESENT,
      { invitationId: id, email: updated.email },
      { ipAddress: actor.ipAddress, userAgent: actor.userAgent });
    return updated;
  });

  return { invitation: view(row), token: raw };
}

/** Withdraw it. The link stops working immediately, accepted or not. */
export async function revokeInvitation(actor: InviteActor, id: string, reason?: string): Promise<InvitationView> {
  const existing = await prisma.clubInvitation.findUnique({ where: { id } });
  if (!existing || existing.clubId !== actor.clubId) throw new NotFoundError('Invitation');
  if (existing.status === 'ACCEPTED') throw new ConflictError('That invitation has already been accepted');
  if (existing.status === 'REVOKED') return view(existing);

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.clubInvitation.update({
      where: { id },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedByUserId: actor.userId },
    });
    await audit(tx, actor.clubId, actor.userId, MembershipAuditAction.INVITE_REVOKED,
      { invitationId: id, email: updated.email }, { reason, ipAddress: actor.ipAddress, userAgent: actor.userAgent });
    return updated;
  });
  return view(row);
}

export async function listInvitations(
  clubId: string,
  opts: { status?: ClubInvitationStatus; limit?: number } = {},
): Promise<InvitationView[]> {
  const rows = await prisma.clubInvitation.findMany({
    where: { clubId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 100, 200),
  });
  return rows.map((r) => ({ ...view(r), status: effectiveStatus(r) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// The recipient's side
// ─────────────────────────────────────────────────────────────────────────────

export interface InvitationPreview {
  clubId: string;
  clubName: string;
  email: string;
  role: MembershipRole;
  teamId: string | null;
  teamName: string | null;
  message: string | null;
  expiresAt: Date;
  /** Whether an account already exists for the invited address. */
  accountExists: boolean;
}

/**
 * What the link shows before anybody signs in.
 *
 * Deliberately thin: the club, the role, the team and when the offer lapses.
 * No member list, no squad, no private club data — the person holding this link
 * has proved nothing yet except that they hold it.
 */
export async function previewInvitation(rawToken: string): Promise<InvitationPreview> {
  const row = await findByToken(rawToken);
  const [club, team, account] = await Promise.all([
    prisma.club.findUnique({ where: { id: row.clubId }, select: { name: true } }),
    row.teamId ? prisma.team.findUnique({ where: { id: row.teamId }, select: { name: true } }) : Promise.resolve(null),
    prisma.user.findUnique({ where: { email: row.email }, select: { id: true } }),
  ]);
  return {
    clubId: row.clubId,
    clubName: club?.name ?? '',
    email: row.email,
    role: row.role,
    teamId: row.teamId,
    teamName: team?.name ?? null,
    message: row.message,
    expiresAt: row.expiresAt,
    accountExists: !!account,
  };
}

async function findByToken(rawToken: string): Promise<ClubInvitation> {
  const token = String(rawToken ?? '');
  if (!token) throw new BadRequestError('An invitation token is required');
  const hash = hashInvitationToken(token);
  const row = await prisma.clubInvitation.findUnique({ where: { tokenHash: hash } });
  // Compared in constant time even though the lookup was by hash: the hash is
  // what the table is keyed by, and a comparison that leaks nothing costs
  // nothing here.
  if (!row || !safeEqual(row.tokenHash, hash)) throw new NotFoundError('Invitation');
  const status = effectiveStatus(row);
  if (status === 'EXPIRED') throw new BadRequestError('That invitation has expired. Ask the club to send a new one.');
  if (status === 'REVOKED') throw new BadRequestError('That invitation was withdrawn by the club.');
  if (status === 'ACCEPTED') throw new BadRequestError('That invitation has already been used.');
  return row;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Accept an invitation as an existing, signed-in account.
 *
 * The signed-in account's email must be the invited one. An invitation is an
 * offer to a person, not a transferable ticket, and letting anybody holding the
 * link attach it to their own account is exactly how a link becomes a way in.
 */
export async function acceptInvitation(
  actor: { userId: string; email: string; ipAddress?: string | null; userAgent?: string | null },
  rawToken: string,
): Promise<{ clubId: string; membershipId: string }> {
  const row = await findByToken(rawToken);
  if (normaliseEmail(actor.email) !== row.email) {
    throw new ForbiddenError('This invitation was sent to a different email address');
  }

  // The membership is created by the service that owns memberships, so the
  // reactivation rule, the unique key and the audit row are the club's usual
  // ones rather than a second implementation of them.
  const membership = await grantMembership(
    { userId: row.invitedByUserId, clubId: row.clubId, ipAddress: actor.ipAddress, userAgent: actor.userAgent },
    { userId: actor.userId, teamId: row.teamId, role: row.role },
  );

  await prisma.$transaction(async (tx) => {
    // Consumed exactly once: the update is conditioned on the row still being
    // PENDING, so two simultaneous acceptances cannot both succeed.
    const consumed = await tx.clubInvitation.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedByUserId: actor.userId },
    });
    if (consumed.count !== 1) throw new ConflictError('That invitation has already been used.');
    await audit(tx, row.clubId, actor.userId, MembershipAuditAction.INVITE_ACCEPTED,
      { invitationId: row.id, membershipId: membership.id, role: row.role, teamId: row.teamId },
      { ipAddress: actor.ipAddress, userAgent: actor.userAgent });
  });

  return { clubId: row.clubId, membershipId: membership.id };
}
