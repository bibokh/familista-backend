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
import { UserRole } from '@prisma/client';
import { assertMayAppointPresident, grantMembership, type MembershipActor } from '../services/membership.service';
import { registerInvitedUser } from '../services/auth.service';
import { deliverInvitation, type DeliveryOutcome } from './invitation-mail.service';
import { consume } from './invitation-throttle';
import { allTeamIds } from './invitation-teams';

/** Seven days: long enough for somebody on holiday, short enough to expire. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export { allTeamIds } from './invitation-teams';

export interface InviteActor extends MembershipActor {}

export interface CreateInvitationDto {
  email: string;
  role: MembershipRole;
  teamId?: string | null;
  /**
   * Every team this invitation grants, when the club picked more than one.
   *
   * Preferred over `teamId`, which stays for the single-team callers that
   * predate this. An empty list (or omitting it) with no `teamId` is what
   * club-wide means — it is not a default that leaks, because a club-wide
   * membership is only ever created when nothing named a team.
   */
  teamIds?: string[] | null;
  message?: string | null;
  /** Shown in the email as who is inviting. A name, never an address. */
  inviterName?: string | null;
}

/** What a club screen may see. The token is not in it, and never will be. */
export interface InvitationView {
  id: string;
  clubId: string;
  email: string;
  role: MembershipRole;
  teamId: string | null;
  /** Every team the invitation grants. Empty means club-wide. */
  teamIds: string[];
  status: ClubInvitationStatus;
  /**
   * Whether the email got out. A DIFFERENT fact from `status`: a FAILED
   * delivery leaves a PENDING invitation, and a SENT one does not make an
   * invitation accepted.
   */
  deliveryState: string;
  deliveryProvider: string | null;
  deliveryFailureCode: string | null;
  deliveryAttempts: number;
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
    teamIds: allTeamIds(row),
    status: row.status,
    deliveryState: String(row.deliveryState),
    deliveryProvider: row.deliveryProvider,
    deliveryFailureCode: row.deliveryFailureCode,
    deliveryAttempts: row.deliveryAttempts,
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
/**
 * The teams an invitation is being written for, checked against its own club.
 *
 * De-duplicated and order-preserving, so "First Team, U13, First Team" is two
 * memberships rather than a unique-constraint failure at acceptance time, and
 * the first team named stays the one in `teamId`.
 *
 * Every id is verified to belong to the inviting club before it is stored. A
 * team id is not a capability: naming another club's team here must fail at the
 * moment of invitation rather than mint a membership across a tenant boundary
 * a week later when somebody accepts.
 */
async function resolveInvitedTeams(clubId: string, dto: CreateInvitationDto): Promise<string[]> {
  const asked = [
    ...(dto.teamId ? [dto.teamId] : []),
    ...(Array.isArray(dto.teamIds) ? dto.teamIds : []),
  ].map((id) => String(id ?? '').trim()).filter(Boolean);

  const wanted = Array.from(new Set(asked));
  if (!wanted.length) return [];   // club-wide, which is the only thing it can mean

  const rows = await prisma.team.findMany({
    where: { id: { in: wanted } },
    select: { id: true, clubId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r.clubId]));
  for (const id of wanted) {
    const owner = byId.get(id);
    if (!owner) throw new NotFoundError('Team');
    if (owner !== clubId) throw new ForbiddenError();
  }
  return wanted;
}

export async function createInvitation(
  actor: InviteActor,
  dto: CreateInvitationDto,
): Promise<{ invitation: InvitationView; token: string; delivery: DeliveryOutcome }> {
  const email = normaliseEmail(dto.email);

  // ── appointing a president ─────────────────────────────────────────────────
  // A club's president is the one role that outranks the person who invites
  // people, so it is the one role an administrator may not hand out. Only a
  // sitting president of THIS club, or platform authority onboarding it, may
  // appoint one — which is also the only way a CLUB_OWNER membership comes into
  // existence anywhere in Familista now that creating a club grants nothing.
  //
  // Checked here rather than on the route, because this service is what every
  // caller goes through and a rule written on one route is a rule the next
  // route forgets.
  if (dto.role === MembershipRole.CLUB_OWNER) await assertMayAppointPresident(actor);

  const teamIds = await resolveInvitedTeams(actor.clubId, dto);

  // ── anti-abuse ─────────────────────────────────────────────────────────────
  // An invitation endpoint sends email to an address the caller chooses, so it
  // is a spam relay unless it is counted. Two buckets: one club cannot invite
  // the world, and one account cannot do it across many clubs.
  if (!consume('clubInvite', actor.clubId)) {
    throw new ConflictError('This club has sent too many invitations recently. Try again later.');
  }
  if (!consume('actorInvite', actor.userId)) {
    throw new ConflictError('You have sent too many invitations recently. Try again later.');
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
        teamId: teamIds[0] ?? null,
        additionalTeamIds: teamIds.slice(1),
        tokenHash: hash,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedByUserId: actor.userId,
        message: dto.message ?? null,
      },
    });
    await audit(tx, actor.clubId, actor.userId, MembershipAuditAction.INVITED,
      { invitationId: created.id, email, role: dto.role, teamIds },
      { ipAddress: actor.ipAddress, userAgent: actor.userAgent });
    return created;
  });

  // The email goes out after the row is committed, never inside the
  // transaction: a mail provider taking four seconds must not hold a database
  // transaction open for four seconds, and a delivery failure must not roll
  // back an invitation that is perfectly valid.
  const delivery = await deliverInvitation({
    kind: dto.role === MembershipRole.CLUB_OWNER ? 'PRESIDENT' : 'STAFF',
    invitation: row,
    rawToken: raw,
    inviterName: dto.inviterName ?? null,
    actorUserId: actor.userId,
  });

  return { invitation: view(row), token: raw, delivery };
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
  opts?: { inviterName?: string | null },
): Promise<{ invitation: InvitationView; token: string; delivery: DeliveryOutcome }> {
  const existing = await prisma.clubInvitation.findUnique({ where: { id } });
  if (!existing || existing.clubId !== actor.clubId) throw new NotFoundError('Invitation');
  if (effectiveStatus(existing) === 'ACCEPTED') throw new ConflictError('That invitation has already been accepted');
  if (existing.status === 'REVOKED') throw new ConflictError('That invitation was revoked');
  // Counted per invitation: repeatedly pressing "resend" is the shape of both
  // an impatient person and a script, and neither should reach the provider.
  if (!consume('resend', id)) {
    throw new ConflictError('That invitation has been resent too many times recently. Try again later.');
  }

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

  // A new link, and the old one already stopped working — the tokenHash was
  // replaced inside the transaction above. The email says so in words.
  const delivery = await deliverInvitation({
    kind: row.role === MembershipRole.CLUB_OWNER ? 'PRESIDENT' : 'STAFF',
    invitation: row,
    rawToken: raw,
    inviterName: opts?.inviterName ?? null,
    resent: true,
    actorUserId: actor.userId,
  });

  return { invitation: view(row), token: raw, delivery };
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
  /** Every team this grants, named. Empty means the whole club. */
  teams: Array<{ id: string; name: string }>;
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
  const ids = allTeamIds(row);
  const [club, teamRows, account] = await Promise.all([
    prisma.club.findUnique({ where: { id: row.clubId }, select: { name: true } }),
    ids.length
      ? prisma.team.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    prisma.user.findUnique({ where: { email: row.email }, select: { id: true } }),
  ]);
  // Named in the order the club picked them, not the order the database
  // happened to return.
  const byId = new Map(teamRows.map((t) => [t.id, t.name]));
  const teams = ids.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id)! }));
  return {
    clubId: row.clubId,
    clubName: club?.name ?? '',
    email: row.email,
    role: row.role,
    teamId: row.teamId,
    teamName: teams.length === 1 ? teams[0].name : null,
    teams,
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
): Promise<{ clubId: string; membershipId: string; membershipIds: string[] }> {
  // Counted before the token is even looked up, so a brute-force costs the
  // attacker their budget whether they guess right or wrong.
  if (!consume('accept', normaliseEmail(actor.email))) {
    throw new ForbiddenError('Too many invitation attempts for this account. Try again later.');
  }
  const row = await findByToken(rawToken);
  if (normaliseEmail(actor.email) !== row.email) {
    throw new ForbiddenError('This invitation was sent to a different email address');
  }

  // The memberships are created by the service that owns memberships, so the
  // reactivation rule, the unique key and the audit row are the club's usual
  // ones rather than a second implementation of them.
  //
  // One row per team, which is what the schema means. An invitation naming
  // three teams grants three team-scoped memberships and NOT one club-wide
  // one — a club-wide membership is a different, larger thing, and arriving at
  // it by way of a convenience would hand a U13 coach the first team.
  // `teamId: null` here happens only when the invitation named no team at all.
  const grantActor = {
    userId: row.invitedByUserId, clubId: row.clubId,
    ipAddress: actor.ipAddress, userAgent: actor.userAgent,
  };
  const teamIds = allTeamIds(row);
  const memberships: Array<{ id: string }> = [];
  for (const teamId of (teamIds.length ? teamIds : [null])) {
    memberships.push(await grantMembership(grantActor, { userId: actor.userId, teamId, role: row.role }));
  }
  const membership = memberships[0];

  await prisma.$transaction(async (tx) => {
    // Consumed exactly once: the update is conditioned on the row still being
    // PENDING, so two simultaneous acceptances cannot both succeed.
    const consumed = await tx.clubInvitation.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedByUserId: actor.userId },
    });
    if (consumed.count !== 1) throw new ConflictError('That invitation has already been used.');
    await audit(tx, row.clubId, actor.userId, MembershipAuditAction.INVITE_ACCEPTED,
      {
        invitationId: row.id, membershipId: membership.id, role: row.role,
        teamIds, membershipIds: memberships.map((m) => m.id),
      },
      { ipAddress: actor.ipAddress, userAgent: actor.userAgent });
  });

  return { clubId: row.clubId, membershipId: membership.id, membershipIds: memberships.map((m) => m.id) };
}

/**
 * Accept an invitation as somebody who does not have an account yet.
 *
 * The one door a signed-out invited person walks through, and it is deliberately
 * narrow. The caller supplies a name and a password. Everything that decides
 * WHERE they land — the address, the club, the role — is read from the
 * invitation their token resolves to, so a person holding a link for one club
 * cannot register into another, cannot choose their own role, and cannot claim
 * an address the invitation was not written to.
 *
 * The acceptance itself is not re-implemented: this calls the same
 * `acceptInvitation` a signed-in person uses, so the single-use consumption, the
 * membership grant, the audit row and the last-owner rules are all exactly the
 * ones the club already relies on. If that call fails, the account still exists
 * and the invitation is still PENDING — the person can sign in and accept, which
 * is a recoverable state rather than a corrupt one.
 */
export async function registerAndAccept(
  rawToken: string,
  input: { firstName: string; lastName: string; password: string },
  meta: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<{ user: unknown; tokens: unknown; clubId: string; membershipId: string; membershipIds: string[] }> {
  // Resolves the token, and refuses an expired, revoked or already-used one
  // with the same messages every other path gives.
  const row = await findByToken(rawToken);

  const firstName = String(input?.firstName ?? '').trim();
  const lastName = String(input?.lastName ?? '').trim();
  const password = String(input?.password ?? '');
  if (!firstName || !lastName) throw new BadRequestError('A first and last name are required');
  if (password.length < 8) throw new BadRequestError('Password must be at least 8 characters');

  const existing = await prisma.user.findUnique({ where: { email: row.email }, select: { id: true } });
  if (existing) {
    // Not "email already registered" as a bare conflict: the useful thing to
    // say is what to do instead, and it tells them nothing they did not
    // already know — they are holding a link written to this address.
    throw new ConflictError('An account already exists for this address. Sign in to accept the invitation.');
  }

  const created = await registerInvitedUser({
    email: row.email,
    clubId: row.clubId,
    accountRole: accountRoleFor(row.role),
    firstName,
    lastName,
    password,
  });

  const accepted = await acceptInvitation(
    { userId: created.user.id, email: row.email, ipAddress: meta.ipAddress, userAgent: meta.userAgent },
    rawToken,
  );

  return { user: created.user, tokens: created.tokens, ...accepted };
}

/**
 * The account-level role an invited membership implies.
 *
 * `Membership` is what actually grants authority over a club — that is settled
 * elsewhere and unchanged. `User.role` is the older account-level field that
 * some club routes still check, so it has to be something coherent rather than
 * a default that locks the invited person out of the very club they were
 * invited to run.
 *
 * A president gets CLUB_ADMIN, which is what administering one club means.
 * Nobody gets SUPER_ADMIN: platform authority is a PlatformAdmin row, it is
 * never implied by a club invitation, and there is no branch here that could
 * produce it.
 */
function accountRoleFor(role: MembershipRole): UserRole {
  if (role === MembershipRole.CLUB_OWNER) return UserRole.CLUB_ADMIN;
  const names = Object.values(UserRole) as string[];
  if (names.includes(String(role)) && String(role) !== 'SUPER_ADMIN') return String(role) as UserRole;
  return UserRole.COACH;
}

