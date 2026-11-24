/**
 * Familista Creator Studio (P2) — personal creator accounts: invitation, sign-up, sign-in, sessions, address
 * verification, password reset, profile. A creator is not a club user: its own table, its own token audience
 * ('creator'), its own session rows, its own lockout counters. Nothing here reads or writes a club.
 *
 * Sign-up is by invitation only. The Platform Owner issues a code (optionally bound to one address); without a valid code
 * no account can be opened, so the Creator Studio is not public until the Owner decides it is.
 *
 * Secrets are never kept: an invitation code, a refresh token and an emailed link are random, shown once, and stored as
 * a SHA-256 hash under a domain prefix. A refresh token is replaced on every use (rotation); one replaced more than a
 * moment ago and presented again ends its whole family of sessions, because only a copy could present it.
 *
 * Age: the person confirms they are at least the configured minimum age (CREATOR_MINIMUM_AGE; the restrictive default
 * is 18, so no child's account exists until a qualified decision lowers it). No date of birth is asked for or kept.
 *
 * Every account-level change is audited (PlatformAuditLog with creatorId), never with a password, code or token.
 */
import { createHash, randomBytes, randomUUID } from 'crypto';
import { CreatorEmailPurpose, CreatorStatus, PlatformAuditCategory, Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { runAsSystem } from '../../security/db-context';
import { signToken } from '../../security/jwt-tokens';
import { assertNotLocked, recordAttempt } from '../../security/login-attempt.service';
import { logSecurityEvent } from '../../security/security-event.service';
import { hashPassword, verifyPassword } from '../../utils/password';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../utils/errors';
import { emailConfiguration, publicAppUrl, sendEmail } from '../email/service';
import { renderCreatorEmail, type CreatorEmailKind } from '../email/templates/creator';
import { resolveEmailLocale } from '../email/templates';
import { currentEnvironment } from '../environment';
import { isSupportedLocale } from '../../i18n/locales';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;
/** A replaced refresh token presented again within this window is two tabs racing, not a stolen copy. */
export const ROTATION_GRACE_MS = 10_000;
export const INVITE_MAX_DAYS = 90;

/** The minimum age a creator confirms, from CREATOR_MINIMUM_AGE (13–21); anything else is the restrictive 18. */
export function minimumAge(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.CREATOR_MINIMUM_AGE);
  return Number.isInteger(n) && n >= 13 && n <= 21 ? n : 18;
}

const digest = (purpose: string, raw: string) => createHash('sha256').update(`familista:creator:${purpose}:v1:`).update(raw).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** An invitation code people can type: FAM-XXXX-XXXX-XXXX-XXXX, 80 bits from an unambiguous alphabet. */
function inviteCode(): string {
  const b = randomBytes(16);
  const chars = Array.from(b, (x) => LETTERS[x % LETTERS.length]);
  return `FAM-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}-${chars.slice(12, 16).join('')}`;
}
export const normaliseInviteCode = (raw: string) => raw.trim().toUpperCase().replace(/\s+/g, '');
export const normaliseEmail = (raw: string) => raw.trim().toLowerCase();

const CONTROL = /[\u0000-\u001F\u007F]/;
export class CreatorInputError extends Error {
  readonly code = 'CREATOR_INVALID';
  constructor(readonly reason: string, readonly path: string) { super(`${reason} at ${path}`); this.name = 'CreatorInputError'; }
}
export class CreatorInviteError extends ForbiddenError {
  readonly code = 'CREATOR_INVITE_REFUSED';
  constructor(readonly reason: 'invalid' | 'expired') { super(reason === 'expired' ? 'This invitation has expired' : 'This invitation code is not valid'); }
}
export class CreatorEmailTakenError extends ConflictError {
  readonly code = 'CREATOR_EMAIL_TAKEN';
  constructor() { super('An account with this email address already exists'); }
}
export class CreatorLinkError extends ForbiddenError {
  readonly code = 'CREATOR_LINK_REFUSED';
  constructor() { super('This link is not valid any more; ask for a new one'); }
}

export function validDisplayName(v: unknown): string {
  const s = typeof v === 'string' ? v.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
  if (!s || Array.from(s).length > 60 || CONTROL.test(s)) throw new CreatorInputError('bad-name', 'displayName');
  return s;
}
export function validPassword(v: unknown, email: string): string {
  if (typeof v !== 'string' || Array.from(v).length < 10) throw new CreatorInputError('password-short', 'password');
  // bcrypt reads 72 bytes; a longer password would be silently cut, so it is refused instead.
  if (Buffer.byteLength(v, 'utf8') > 72) throw new CreatorInputError('password-long', 'password');
  if (v.trim().toLowerCase() === email) throw new CreatorInputError('password-is-email', 'password');
  return v;
}
function validEmail(v: unknown): string {
  const s = typeof v === 'string' ? normaliseEmail(v) : '';
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/.test(s) || s.endsWith('@invalid')) throw new CreatorInputError('bad-email', 'email');
  return s;
}
const localeOf = (v: unknown) => (typeof v === 'string' && isSupportedLocale(v) ? v : 'en-GB');

export interface Ctx { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null }
export interface CreatorView { id: string; email: string; displayName: string; locale: string; emailVerified: boolean; createdAt: Date; minimumAge: number }
export interface CreatorSessionTokens { accessToken: string; expiresIn: number; refreshToken: string; refreshExpiresAt: Date }

type Tx = Prisma.TransactionClient;
type Row = { id: string; email: string; displayName: string | null; locale: string; emailVerifiedAt: Date | null; createdAt: Date; ageConfirmedMinimum: number; tokenVersion: number };
const ROW = { id: true, email: true, displayName: true, locale: true, emailVerifiedAt: true, createdAt: true, ageConfirmedMinimum: true, tokenVersion: true } as const;
export const viewOf = (r: Row): CreatorView => ({ id: r.id, email: r.email, displayName: r.displayName ?? '', locale: r.locale, emailVerified: !!r.emailVerifiedAt, createdAt: r.createdAt, minimumAge: r.ageConfirmedMinimum });

/** One audit entry of a creator account change, in the change's transaction. Never a secret; counts and states only. */
export async function creatorAudit(tx: Tx, creatorId: string | null, ctx: Ctx, entry: { action: string; resourceId: string; metadata?: Record<string, unknown>; message: string; userId?: string | null; adminId?: string | null }) {
  await tx.platformAuditLog.create({
    data: {
      adminId: entry.adminId ?? null, userId: entry.userId ?? null, clubId: null, creatorId, action: entry.action, category: PlatformAuditCategory.ACCESS,
      resourceType: 'CreatorAccount', resourceId: entry.resourceId, ipAddress: ctx.ipAddress ?? undefined, userAgent: ctx.userAgent ?? undefined,
      metadata: { ...(entry.metadata ?? {}), environment: currentEnvironment(), correlationId: ctx.correlationId ?? null } as Prisma.InputJsonValue,
      message: entry.message,
    },
  });
}

function accessToken(r: { id: string; tokenVersion: number }, sid: string): string {
  return signToken('creator', { sub: r.id, tv: r.tokenVersion, sid }, { expiresIn: ACCESS_TTL_SECONDS });
}
async function openSession(tx: Tx, r: { id: string; tokenVersion: number }, familyId: string = randomUUID(), expiresAt: Date = new Date(Date.now() + SESSION_TTL_MS)): Promise<CreatorSessionTokens> {
  const raw = secret();
  const s = await tx.creatorSession.create({ data: { creatorId: r.id, familyId, tokenHash: digest('refresh', raw), expiresAt }, select: { id: true } });
  return { accessToken: accessToken(r, s.id), expiresIn: ACCESS_TTL_SECONDS, refreshToken: raw, refreshExpiresAt: expiresAt };
}

// ── sign-up ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RegisterInput { inviteCode: string; email: string; password: string; displayName: string; locale?: string; ageConfirmed: boolean }

/** Open an account with a valid invitation. Signed in at once; the address still needs confirming (an email is sent). */
export async function register(input: RegisterInput, ctx: Ctx): Promise<{ creator: CreatorView; session: CreatorSessionTokens; verification: EmailOutcome }> {
  const email = validEmail(input.email);
  const displayName = validDisplayName(input.displayName);
  const password = validPassword(input.password, email);
  if (input.ageConfirmed !== true) throw new CreatorInputError('age-not-confirmed', 'ageConfirmed');
  const passwordHash = await hashPassword(password);
  const codeHash = digest('invite', normaliseInviteCode(input.inviteCode ?? ''));
  const out = await runAsSystem('creator-signup', () => prisma.$transaction(async (tx) => {
    const invite = await tx.creatorInvite.findUnique({ where: { codeHash }, select: { id: true, email: true, expiresAt: true, revokedAt: true, uses: true, maxUses: true } });
    if (!invite || invite.revokedAt || invite.uses >= invite.maxUses || (invite.email && invite.email !== email)) throw new CreatorInviteError('invalid');
    if (invite.expiresAt.getTime() <= Date.now()) throw new CreatorInviteError('expired');
    if (await tx.creatorAccount.findUnique({ where: { email }, select: { id: true } })) throw new CreatorEmailTakenError();
    // The use is taken conditionally, so two sign-ups racing on a single-use code cannot both land.
    const took = await tx.creatorInvite.updateMany({ where: { id: invite.id, revokedAt: null, uses: { lt: invite.maxUses } }, data: { uses: { increment: 1 } } });
    if (took.count !== 1) throw new CreatorInviteError('invalid');
    let row: Row;
    try {
      row = await tx.creatorAccount.create({
        data: { email, passwordHash, displayName, locale: localeOf(input.locale), ageConfirmedAt: new Date(), ageConfirmedMinimum: minimumAge(), inviteId: invite.id },
        select: ROW,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new CreatorEmailTakenError();
      throw err;
    }
    const session = await openSession(tx, row);
    await creatorAudit(tx, row.id, ctx, { action: 'creator.account.created', resourceId: row.id, metadata: { inviteId: invite.id, minimumAge: row.ageConfirmedMinimum, locale: row.locale }, message: 'A creator account was opened with an invitation' });
    return { row, session };
  }));
  const verification = await sendLink(out.row, 'verify', ctx);
  return { creator: viewOf(out.row), session: out.session, verification };
}

// ── sign-in, sessions ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A hash to compare against when there is no account, so a missing address takes as long as a wrong password. */
let dummyHash: Promise<string> | null = null;

export async function login(input: { email: string; password: string }, ctx: Ctx): Promise<{ creator: CreatorView; session: CreatorSessionTokens }> {
  const email = typeof input.email === 'string' ? normaliseEmail(input.email) : '';
  const lockKey = `creator:${email}`;
  await assertNotLocked(lockKey, ctx.ipAddress);
  const row = await runAsSystem('creator-signin', () => prisma.creatorAccount.findUnique({ where: { email }, select: { ...ROW, passwordHash: true, status: true } }));
  const hash = row?.passwordHash ?? await (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));
  const ok = await verifyPassword(String(input.password ?? ''), hash);
  if (!row || !ok || row.status === CreatorStatus.DELETED) {
    recordAttempt({ email: lockKey, success: false, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
    throw new UnauthorizedError('The email address or password is not correct');
  }
  if (row.status === CreatorStatus.SUSPENDED) throw new ForbiddenError('This creator account is suspended');
  recordAttempt({ email: lockKey, success: true, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, actorId: row.id });
  const session = await runAsSystem('creator-signin', () => prisma.$transaction(async (tx) => {
    await tx.creatorAccount.update({ where: { id: row.id }, data: { lastLoginAt: new Date() } });
    return openSession(tx, row);
  }));
  return { creator: viewOf(row), session };
}

/** Replace a refresh token with a new one in the same family (and the same absolute expiry). */
export async function refresh(raw: string): Promise<CreatorSessionTokens> {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) throw new UnauthorizedError('Sign in again');
  const out = await runAsSystem('creator-session', () => prisma.$transaction(async (tx): Promise<CreatorSessionTokens | 'refused'> => {
    const s = await tx.creatorSession.findUnique({ where: { tokenHash: digest('refresh', raw) }, select: { id: true, creatorId: true, familyId: true, expiresAt: true, revokedAt: true, creator: { select: { id: true, status: true, tokenVersion: true } } } });
    if (!s) return 'refused';
    if (s.revokedAt) {
      // A replaced token presented again, after the moment two tabs could race: only a copy could present it. The whole
      // family ends, and that has to be committed: the refusal is answered after the transaction, not thrown inside it.
      if (Date.now() - s.revokedAt.getTime() > ROTATION_GRACE_MS) {
        await tx.creatorSession.updateMany({ where: { familyId: s.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        logSecurityEvent({ kind: 'CUSTOM', severity: 'CRITICAL', actorId: s.creatorId, payload: { type: 'security.refresh.reused', surface: 'creator' } });
      }
      return 'refused';
    }
    if (s.expiresAt.getTime() <= Date.now() || s.creator.status !== CreatorStatus.ACTIVE) return 'refused';
    const claimed = await tx.creatorSession.updateMany({ where: { id: s.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (claimed.count !== 1) return 'refused';
    return openSession(tx, s.creator, s.familyId, s.expiresAt);
  }));
  if (out === 'refused') throw new UnauthorizedError('Sign in again');
  return out;
}

/** End this device's session (its whole family). Unknown tokens are ignored: signing out always succeeds. */
export async function logout(raw: string | undefined): Promise<void> {
  if (typeof raw !== 'string' || !raw) return;
  await runAsSystem('creator-session', async () => {
    const s = await prisma.creatorSession.findUnique({ where: { tokenHash: digest('refresh', raw) }, select: { familyId: true } });
    if (s) await prisma.creatorSession.updateMany({ where: { familyId: s.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
}

/** What authenticateCreator needs on every request: is the account live, and is the token's version its current one. */
export async function sessionAccount(id: string): Promise<{ id: string; tokenVersion: number; status: CreatorStatus; emailVerified: boolean; locale: string } | null> {
  const r = await runAsSystem('creator-session', () => prisma.creatorAccount.findUnique({ where: { id }, select: { id: true, tokenVersion: true, status: true, emailVerifiedAt: true, locale: true } }));
  return r ? { id: r.id, tokenVersion: r.tokenVersion, status: r.status, emailVerified: !!r.emailVerifiedAt, locale: r.locale } : null;
}

export async function me(id: string): Promise<{ creator: CreatorView }> {
  const r = await runAsSystem('creator-session', () => prisma.creatorAccount.findUnique({ where: { id }, select: ROW }));
  if (!r) throw new NotFoundError('Creator account');
  return { creator: viewOf(r) };
}

export async function updateProfile(id: string, input: { displayName?: unknown; locale?: unknown }, ctx: Ctx): Promise<{ creator: CreatorView }> {
  const data: Prisma.CreatorAccountUpdateInput = {};
  if (input.displayName !== undefined) data.displayName = validDisplayName(input.displayName);
  if (input.locale !== undefined) { if (typeof input.locale !== 'string' || !isSupportedLocale(input.locale)) throw new CreatorInputError('bad-locale', 'locale'); data.locale = input.locale; }
  return runAsSystem('creator-account', () => prisma.$transaction(async (tx) => {
    const r = await tx.creatorAccount.update({ where: { id }, data, select: ROW });
    await creatorAudit(tx, id, ctx, { action: 'creator.profile.updated', resourceId: id, metadata: { fields: Object.keys(data) }, message: 'A creator updated their profile' });
    return { creator: viewOf(r) };
  }));
}

/** A new password, with the current one. Every other session ends; this device gets a fresh one. */
export async function changePassword(id: string, input: { currentPassword: string; newPassword: string }, ctx: Ctx): Promise<{ session: CreatorSessionTokens }> {
  const row = await runAsSystem('creator-account', () => prisma.creatorAccount.findUnique({ where: { id }, select: { email: true, passwordHash: true } }));
  if (!row?.passwordHash || !(await verifyPassword(String(input.currentPassword ?? ''), row.passwordHash))) throw new UnauthorizedError('The current password is not correct');
  const passwordHash = await hashPassword(validPassword(input.newPassword, row.email));
  return runAsSystem('creator-account', () => prisma.$transaction(async (tx) => {
    const r = await tx.creatorAccount.update({ where: { id }, data: { passwordHash, tokenVersion: { increment: 1 } }, select: { id: true, tokenVersion: true } });
    await tx.creatorSession.updateMany({ where: { creatorId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await creatorAudit(tx, id, ctx, { action: 'creator.password.changed', resourceId: id, message: 'A creator changed their password; every other session ended' });
    return { session: await openSession(tx, r) };
  }));
}

// ── links by email ────────────────────────────────────────────────────────────────────────────────────────────────────

/** What became of an email: sent, or not, and whether the platform can send email at all. Never the link. */
export interface EmailOutcome { sent: boolean; configured: boolean; failure: string | null }

async function sendLink(r: { id: string; email: string; displayName: string | null; locale: string }, kind: CreatorEmailKind, ctx: Ctx): Promise<EmailOutcome> {
  const purpose = kind === 'verify' ? CreatorEmailPurpose.VERIFY_EMAIL : CreatorEmailPurpose.RESET_PASSWORD;
  const raw = secret();
  await runAsSystem('creator-account', () => prisma.$transaction(async (tx) => {
    await tx.creatorEmailToken.deleteMany({ where: { creatorId: r.id, purpose, usedAt: null } });
    await tx.creatorEmailToken.create({ data: { creatorId: r.id, purpose, tokenHash: digest(kind, raw), expiresAt: new Date(Date.now() + (kind === 'verify' ? VERIFY_TTL_MS : RESET_TTL_MS)) } });
  }));
  const conf = emailConfiguration();
  const url = `${publicAppUrl()}/creator#${kind === 'verify' ? 'verify' : 'reset'}=${encodeURIComponent(raw)}`;
  const mail = renderCreatorEmail(kind, resolveEmailLocale(r.locale, 'en'), { name: r.displayName ?? '', url });
  const result = await sendEmail({ to: { address: r.email, name: r.displayName }, subject: mail.subject, html: mail.html, text: mail.text, locale: mail.locale, correlationId: ctx.correlationId ?? r.id });
  return { sent: result.ok, configured: conf.configured, failure: result.ok ? null : result.failureCode };
}

/** Send (again) the link that confirms the address. */
export async function requestVerification(id: string, ctx: Ctx): Promise<{ alreadyVerified: boolean; email: EmailOutcome | null }> {
  const r = await runAsSystem('creator-account', () => prisma.creatorAccount.findUnique({ where: { id }, select: { id: true, email: true, displayName: true, locale: true, emailVerifiedAt: true } }));
  if (!r) throw new NotFoundError('Creator account');
  if (r.emailVerifiedAt) return { alreadyVerified: true, email: null };
  return { alreadyVerified: false, email: await sendLink(r, 'verify', ctx) };
}

async function claimLink(tx: Tx, kind: CreatorEmailKind, raw: string) {
  const purpose = kind === 'verify' ? CreatorEmailPurpose.VERIFY_EMAIL : CreatorEmailPurpose.RESET_PASSWORD;
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) throw new CreatorLinkError();
  const t = await tx.creatorEmailToken.findUnique({ where: { tokenHash: digest(kind, raw) }, select: { id: true, creatorId: true, purpose: true, usedAt: true, expiresAt: true } });
  if (!t || t.purpose !== purpose || t.usedAt || t.expiresAt.getTime() <= Date.now()) throw new CreatorLinkError();
  const used = await tx.creatorEmailToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
  if (used.count !== 1) throw new CreatorLinkError();
  return t.creatorId;
}

export async function verifyEmail(raw: string, ctx: Ctx): Promise<{ verified: true }> {
  return runAsSystem('creator-account', () => prisma.$transaction(async (tx) => {
    const id = await claimLink(tx, 'verify', raw);
    const n = await tx.creatorAccount.updateMany({ where: { id, status: CreatorStatus.ACTIVE }, data: { emailVerifiedAt: new Date() } });
    if (n.count !== 1) throw new CreatorLinkError();
    await creatorAudit(tx, id, ctx, { action: 'creator.email.verified', resourceId: id, message: 'A creator confirmed their email address' });
    return { verified: true as const };
  }));
}

/** Always answers the same, whether or not the address has an account. */
export async function requestPasswordReset(emailIn: string, ctx: Ctx): Promise<{ accepted: true }> {
  const email = typeof emailIn === 'string' ? normaliseEmail(emailIn) : '';
  const r = await runAsSystem('creator-account', () => prisma.creatorAccount.findUnique({ where: { email }, select: { id: true, email: true, displayName: true, locale: true, status: true } }));
  if (r && r.status === CreatorStatus.ACTIVE) await sendLink(r, 'reset', ctx);
  return { accepted: true };
}

export async function resetPassword(raw: string, newPassword: string, ctx: Ctx): Promise<{ reset: true }> {
  // The link is claimed and the password set in one transaction: a password that does not pass leaves the link unused.
  return runAsSystem('creator-account', () => prisma.$transaction(async (tx) => {
    const id = await claimLink(tx, 'reset', raw);
    const row = await tx.creatorAccount.findUnique({ where: { id }, select: { email: true, status: true } });
    if (!row || row.status !== CreatorStatus.ACTIVE) throw new CreatorLinkError();
    const passwordHash = await hashPassword(validPassword(newPassword, row.email));
    await tx.creatorAccount.update({ where: { id }, data: { passwordHash, tokenVersion: { increment: 1 } } });
    await tx.creatorSession.updateMany({ where: { creatorId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await creatorAudit(tx, id, ctx, { action: 'creator.password.reset', resourceId: id, message: 'A creator reset their password by email; every session ended' });
    return { reset: true as const };
  }));
}

// ── the Platform Owner's side ─────────────────────────────────────────────────────────────────────────────────────────

export interface InviteView { id: string; email: string | null; note: string | null; maxUses: number; uses: number; expiresAt: Date; revokedAt: Date | null; createdAt: Date; state: 'open' | 'used' | 'expired' | 'revoked' }
const INVITE_SELECT = { id: true, email: true, note: true, maxUses: true, uses: true, expiresAt: true, revokedAt: true, createdAt: true } as const;
function inviteView(i: Omit<InviteView, 'state'>): InviteView {
  const state = i.revokedAt ? 'revoked' : i.uses >= i.maxUses ? 'used' : i.expiresAt.getTime() <= Date.now() ? 'expired' : 'open';
  return { ...i, state };
}

/** Issue an invitation. The code is returned once, here, and never again: only its hash is kept. */
export async function createInvite(actor: { userId: string }, input: { email?: string | null; note?: string | null; maxUses?: number; days?: number }, ctx: Ctx): Promise<{ invite: InviteView; code: string }> {
  const email = input.email ? validEmail(input.email) : null;
  const note = input.note ? String(input.note).normalize('NFC').trim() : null;
  if (note && (Array.from(note).length > 200 || CONTROL.test(note))) throw new CreatorInputError('bad-note', 'note');
  const maxUses = input.maxUses ?? 1;
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000 || (email && maxUses !== 1)) throw new CreatorInputError('bad-uses', 'maxUses');
  const days = input.days ?? 14;
  if (!Number.isInteger(days) || days < 1 || days > INVITE_MAX_DAYS) throw new CreatorInputError('bad-days', 'days');
  const code = inviteCode();
  return prisma.$transaction(async (tx) => {
    const i = await tx.creatorInvite.create({ data: { codeHash: digest('invite', code), email, note, maxUses, expiresAt: new Date(Date.now() + days * 86_400_000), createdById: actor.userId }, select: INVITE_SELECT });
    const admin = await tx.platformAdmin.findUnique({ where: { userId: actor.userId }, select: { id: true } });
    await creatorAudit(tx, null, ctx, { action: 'creator.invite.created', resourceId: i.id, userId: actor.userId, adminId: admin?.id ?? null, metadata: { bound: !!email, maxUses, days }, message: 'A creator invitation was issued' });
    return { invite: inviteView(i), code };
  });
}

export async function listInvites(): Promise<{ invites: InviteView[] }> {
  const rows = await prisma.creatorInvite.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 200, select: INVITE_SELECT });
  return { invites: rows.map(inviteView) };
}

export async function revokeInvite(actor: { userId: string }, id: string, ctx: Ctx): Promise<{ invite: InviteView }> {
  return prisma.$transaction(async (tx) => {
    const n = await tx.creatorInvite.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
    const i = await tx.creatorInvite.findUnique({ where: { id }, select: INVITE_SELECT });
    if (!i) throw new NotFoundError('Invitation');
    if (n.count === 1) {
      const admin = await tx.platformAdmin.findUnique({ where: { userId: actor.userId }, select: { id: true } });
      await creatorAudit(tx, null, ctx, { action: 'creator.invite.revoked', resourceId: id, userId: actor.userId, adminId: admin?.id ?? null, message: 'A creator invitation was revoked' });
    }
    return { invite: inviteView(i) };
  });
}

/** The creators, for the Owner: who they are and the state of their account. Never a password or a session. */
export async function listCreators(): Promise<{ creators: Array<{ id: string; displayName: string | null; email: string | null; status: CreatorStatus; emailVerified: boolean; createdAt: Date; lastLoginAt: Date | null }>; total: number }> {
  const [rows, total] = await Promise.all([
    prisma.creatorAccount.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 200, select: { id: true, displayName: true, email: true, status: true, emailVerifiedAt: true, createdAt: true, lastLoginAt: true } }),
    prisma.creatorAccount.count(),
  ]);
  return { creators: rows.map((r) => ({ id: r.id, displayName: r.displayName, email: r.status === CreatorStatus.DELETED ? null : r.email, status: r.status, emailVerified: !!r.emailVerifiedAt, createdAt: r.createdAt, lastLoginAt: r.lastLoginAt })), total };
}
