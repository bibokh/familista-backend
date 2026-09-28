// Familista — Multi-Factor Authentication (Phase O)
// ─────────────────────────────────────────────────────────────────────────
// RFC 6238 TOTP using built-in `crypto` (HMAC-SHA1, 30-sec step, 6 digits).
// No external dependencies. Secret is base32-encoded, stored encrypted with
// a key derived from `config.mfa.encryptionKey` (AES-GCM via createCipheriv).
// The encryption key MUST be distinct from JWT secrets — set MFA_ENCRYPTION_KEY.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { MFAChallenge, MfaMethod, MFASetting, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { config } from '../config';
import { AppError, BadRequestError, ForbiddenError, NotFoundError, TooManyRequestsError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

const STEP_SECONDS = 30;
const CODE_DIGITS  = 6;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_VERIFY_ATTEMPTS = 5;

// ─────────────────────────────────────────────────────────────────────────
// Base32 (RFC 4648) — manual implementation, no external deps.
// ─────────────────────────────────────────────────────────────────────────

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const i = B32_ALPHABET.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ─────────────────────────────────────────────────────────────────────────
// TOTP — RFC 6238 (HMAC-SHA1)
// ─────────────────────────────────────────────────────────────────────────

export function generateTOTPSecret(): { secret: Buffer; base32: string } {
  const secret = randomBytes(20);   // RFC 6238 recommends 160 bits
  return { secret, base32: base32Encode(secret) };
}

export function totpFor(secret: Buffer, atSeconds = Math.floor(Date.now() / 1000), step = STEP_SECONDS, digits = CODE_DIGITS): string {
  const counter = Math.floor(atSeconds / step);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0 && counter >= 0; i--) {
    buf[i] = counter & 0xff;
    // shift right 8 bits using division to stay in JS-safe integer range
  }
  // Simpler: write big-endian counter (BigInt safe).
  buf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code   = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % Math.pow(10, digits)).padStart(digits, '0');
}

/** Verify a TOTP code against a base32 secret with ±1 step tolerance. */
export function verifyTOTP(base32Secret: string, code: string, atSeconds = Math.floor(Date.now() / 1000), step = STEP_SECONDS, digits = CODE_DIGITS): boolean {
  if (!code || !base32Secret) return false;
  const secret = base32Decode(base32Secret);
  for (const offset of [-1, 0, 1]) {
    const candidate = totpFor(secret, atSeconds + offset * step, step, digits);
    if (constantTimeEq(candidate, code)) return true;
  }
  return false;
}

/**
 * The 30-second step a code belongs to, within ±1 step, or null.
 *
 * `verifyTOTP` answers "is this code valid right now"; this answers "which
 * step's code is it", which is what makes a code single-use: the step is
 * recorded when the code is accepted, and only a strictly later step is ever
 * accepted again.
 */
export function matchTOTPStep(base32Secret: string, code: string, atSeconds = Math.floor(Date.now() / 1000), step = STEP_SECONDS, digits = CODE_DIGITS): number | null {
  if (!code || !base32Secret) return null;
  const secret = base32Decode(base32Secret);
  for (const offset of [-1, 0, 1]) {
    const at = atSeconds + offset * step;
    if (constantTimeEq(totpFor(secret, at, step, digits), code)) return Math.floor(at / step);
  }
  return null;
}

function constantTimeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ─────────────────────────────────────────────────────────────────────────
// Secret encryption (AES-256-GCM) — key derived from MFA_ENCRYPTION_KEY.
// Deliberately separate from JWT secrets: rotating JWT_ACCESS_SECRET must
// never corrupt stored TOTP seeds. Set MFA_ENCRYPTION_KEY before any user
// enables MFA — the service throws at call time if the key is absent.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The server has no MFA encryption key. A 503 rather than a bare Error (which
 * answered 500 and read as a crash): the feature is not configured here, and
 * the interface says so instead of failing.
 */
export class MfaUnavailableError extends AppError {
  constructor() { super('Two-step sign-in is not configured on this server', 503); }
}

/**
 * A code that did not verify. 400, deliberately not 401: the caller is signed
 * in, and a 401 would send the client down its session-expired path.
 */
export class InvalidMfaCodeError extends BadRequestError {
  constructor() { super('Invalid code'); }
}

/** Whether this server can store an MFA secret at all. */
export function mfaConfigured(): boolean {
  return !!config.mfa.encryptionKey;
}

function deriveAesKey(): Buffer {
  const raw = config.mfa.encryptionKey;
  if (!raw) throw new MfaUnavailableError();
  return createHash('sha256').update(raw + ':mfa:v1').digest();
}

// ─────────────────────────────────────────────────────────────────────────
// Code-guessing limit. A 6-digit code is one in a million; unlimited tries make
// it a matter of time. After MAX_CODE_FAILURES wrong codes for one user within
// CODE_FAILURE_WINDOW_MS every code check for that user answers 429 until the
// window has passed.
//
// PERSISTENT. The count lives on the user's MFASetting row, not in process
// memory, so a restart, a redeploy or a free-plan spin-down cannot reset it,
// and every instance shares one count.
//
// ATOMIC. An attempt is RESERVED before the code is checked, by one conditional
// increment (`codeFailures < MAX`) that Postgres applies to the row under its
// own lock. Twenty parallel guesses cannot all read "4 so far" and all proceed:
// exactly the attempts that fit are taken and the rest are refused. A correct
// code gives its reservation back and clears the window; a wrong one keeps it.
// ─────────────────────────────────────────────────────────────────────────

export const MAX_CODE_FAILURES = 5;
export const CODE_FAILURE_WINDOW_MS = 5 * 60_000;

async function reserveCodeAttempt(userId: string): Promise<void> {
  const now = new Date();
  // A window that has run out starts again from zero.
  await prisma.mFASetting.updateMany({
    where: {
      userId,
      OR: [{ codeWindowStart: null }, { codeWindowStart: { lt: new Date(now.getTime() - CODE_FAILURE_WINDOW_MS) } }],
    },
    data: { codeFailures: 0, codeWindowStart: now },
  });
  const taken = await prisma.mFASetting.updateMany({
    where: { userId, codeFailures: { lt: MAX_CODE_FAILURES } },
    data: { codeFailures: { increment: 1 } },
  });
  if (taken.count === 0) throw new TooManyRequestsError('Too many attempts. Try again later.');
}

/** A correct code: nothing in this window was a failure after all. */
async function clearCodeFailures(userId: string): Promise<void> {
  await prisma.mFASetting.updateMany({ where: { userId }, data: { codeFailures: 0, codeWindowStart: null } });
}

/**
 * Accept an app code's step at most once. One conditional update: it succeeds
 * only when no code of this step or a later one has been accepted before, so
 * the same code — or an older one still inside the ±1 step tolerance — is
 * refused the second time, even when both arrive at once.
 */
async function claimTotpStep(userId: string, step: number): Promise<boolean> {
  const r = await prisma.mFASetting.updateMany({
    where: { userId, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] },
    data: { lastTotpStep: step },
  });
  return r.count === 1;
}

// ─────────────────────────────────────────────────────────────────────────
// Recovery codes: 8 per enrolment, 80 bits each, base32. Stored as SHA-256
// hashes only; the plain codes leave the server once, in the response that
// created them. Accepted with or without the dashes and spaces the interface
// shows them with.
// ─────────────────────────────────────────────────────────────────────────

const RECOVERY_CODE_COUNT = 8;

function normaliseRecoveryCode(code: string): string {
  return String(code ?? '').replace(/[\s-]/g, '').toUpperCase();
}

function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}

function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const c = base32Encode(randomBytes(10));
    codes.push(c);
    hashes.push(hashRecoveryCode(c));
  }
  return { codes, hashes };
}

function encryptSecret(base32: string): string {
  const iv = randomBytes(12);
  const key = deriveAesKey();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(base32, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Envelope: ivBase64 + ':' + tagBase64 + ':' + cipherBase64
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptSecret(envelope: string): string {
  const [ivB64, tagB64, encB64] = envelope.split(':');
  if (!ivB64 || !tagB64 || !encB64) throw new BadRequestError('malformed MFA secret envelope');
  const key = deriveAesKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]);
  return plain.toString('utf8');
}

// ─────────────────────────────────────────────────────────────────────────
// MFA lifecycle
// ─────────────────────────────────────────────────────────────────────────

export interface MfaActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export interface EnrollResult {
  base32:  string;          // shown once to the user
  otpauth: string;          // for QR (otpauth://totp/...)
}

export async function enrollTOTP(actor: MfaActor, label = 'Familista'): Promise<EnrollResult> {
  const existing = await prisma.mFASetting.findUnique({ where: { userId: actor.userId } });
  if (existing && existing.enabledAt) throw new BadRequestError('MFA already enrolled. Disable first.');
  const { base32 } = generateTOTPSecret();
  await prisma.mFASetting.upsert({
    where:  { userId: actor.userId },
    create: { userId: actor.userId, method: 'TOTP', secretEncrypted: encryptSecret(base32) },
    // A new secret starts a new sequence of steps. The failure count is kept:
    // re-enrolling must not be a way to reset the guessing limit.
    update: { method: 'TOTP', secretEncrypted: encryptSecret(base32), enabledAt: null, lastTotpStep: null },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'MFA_ENROLL_INIT', entityType: 'MFASetting', entityId: actor.userId, payload: { method: 'TOTP' },
  });
  const issuer = 'Familista';
  const otpauth = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${base32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return { base32, otpauth };
}

export interface ConfirmResult {
  enabledAt: Date;
  /** Plain recovery codes, returned once and never stored in this form. */
  recoveryCodes: string[];
}

/**
 * Turn MFA on with a code from the newly enrolled app.
 *
 * Returns the recovery codes and nothing else: the settings row carries the
 * encrypted secret, which has no business in a response.
 */
export async function confirmTOTP(actor: MfaActor, code: string): Promise<ConfirmResult> {
  const settings = await prisma.mFASetting.findUnique({ where: { userId: actor.userId } });
  if (!settings || !settings.secretEncrypted) throw new BadRequestError('MFA not initialised; enroll first');
  if (settings.enabledAt) throw new BadRequestError('MFA is already on');
  await reserveCodeAttempt(actor.userId);
  const secret = decryptSecret(settings.secretEncrypted);
  const step = matchTOTPStep(secret, String(code ?? '').trim());
  if (step === null || !(await claimTotpStep(actor.userId, step))) throw new InvalidMfaCodeError();
  await clearCodeFailures(actor.userId);
  const { codes, hashes } = newRecoveryCodes();
  const updated = await prisma.mFASetting.update({
    where: { userId: actor.userId },
    data:  { enabledAt: new Date(), lastVerifiedAt: new Date(), backupCodesHash: hashes as unknown as Prisma.InputJsonValue },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'MFA_ENABLED', entityType: 'MFASetting', entityId: actor.userId,
  });
  return { enabledAt: updated.enabledAt ?? new Date(), recoveryCodes: codes };
}

/**
 * Check a code for an enrolled user: an app code, or — when `allowRecovery` —
 * a recovery code. Either is accepted at most once. Reserves an attempt first
 * (429 when the limit is reached); a wrong code keeps it, a correct one clears
 * the window.
 */
async function checkCode(actor: MfaActor, s: MFASetting, code: string, allowRecovery: boolean): Promise<boolean> {
  if (!s.secretEncrypted) return false;
  await reserveCodeAttempt(actor.userId);
  const secret = decryptSecret(s.secretEncrypted);
  const step = matchTOTPStep(secret, String(code ?? '').trim());
  if (step !== null && await claimTotpStep(actor.userId, step)) {
    await clearCodeFailures(actor.userId);
    return true;
  }
  if (allowRecovery && await consumeRecoveryCode(actor, s, code)) {
    await clearCodeFailures(actor.userId);
    return true;
  }
  return false;
}

/**
 * Use one recovery code, atomically. The row is updated only if its code list
 * is still exactly the one this request read, so two requests racing with the
 * same code cannot both succeed: the second finds the list already changed.
 */
async function consumeRecoveryCode(actor: MfaActor, s: MFASetting, code: string): Promise<boolean> {
  const hashes = (s.backupCodesHash as string[] | null) ?? [];
  const idx = hashes.indexOf(hashRecoveryCode(code));
  if (idx < 0) return false;
  const r = await prisma.mFASetting.updateMany({
    where: { userId: actor.userId, backupCodesHash: { equals: hashes as unknown as Prisma.InputJsonValue } },
    data:  { backupCodesHash: hashes.filter((_, i) => i !== idx) as unknown as Prisma.InputJsonValue },
  });
  if (r.count !== 1) return false;
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'MFA_RECOVERY_CODE_USED', entityType: 'MFASetting', entityId: actor.userId,
  });
  return true;
}

async function enrolledSettings(userId: string): Promise<MFASetting> {
  const s = await prisma.mFASetting.findUnique({ where: { userId } });
  if (!s || !s.enabledAt || s.method === 'NONE') throw new BadRequestError('MFA is not on');
  return s;
}

/**
 * Turn MFA off. Requires a current app code or a recovery code: a session
 * alone is not enough, or a stolen session could remove the second factor.
 */
export async function disableMFA(actor: MfaActor, code: string): Promise<{ ok: true }> {
  const s = await enrolledSettings(actor.userId);
  if (!(await checkCode(actor, s, code, true))) throw new InvalidMfaCodeError();
  await prisma.mFASetting.update({
    where: { userId: actor.userId },
    data:  { method: 'NONE', enabledAt: null, secretEncrypted: null, backupCodesHash: Prisma.JsonNull, lastTotpStep: null },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'MFA_DISABLED', entityType: 'MFASetting', entityId: actor.userId,
  });
  return { ok: true };
}

/**
 * Replace the recovery codes. Requires a current app code (not a recovery
 * code — the point is often that those are lost or used up). The old codes stop
 * working at once.
 */
export async function regenerateRecoveryCodes(actor: MfaActor, code: string): Promise<{ recoveryCodes: string[] }> {
  const s = await enrolledSettings(actor.userId);
  if (!(await checkCode(actor, s, code, false))) throw new InvalidMfaCodeError();
  const { codes, hashes } = newRecoveryCodes();
  await prisma.mFASetting.update({
    where: { userId: actor.userId },
    data:  { backupCodesHash: hashes as unknown as Prisma.InputJsonValue, lastVerifiedAt: new Date() },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'MFA_RECOVERY_CODES_REGENERATED', entityType: 'MFASetting', entityId: actor.userId,
  });
  return { recoveryCodes: codes };
}

export interface MfaStatus {
  /** Whether this server can store a secret (MFA_ENCRYPTION_KEY is set). */
  configured: boolean;
  enrolled: boolean;
  /** A secret was issued and not yet confirmed. */
  pending: boolean;
  enabledAt: Date | null;
  lastVerifiedAt: Date | null;
  recoveryCodesRemaining: number;
  /** Whether sign-in asks for the second factor. False in this build. */
  enforced: false;
}

/** What the user's own settings screen shows. Never the secret or the hashes. */
export async function mfaStatus(userId: string): Promise<MfaStatus> {
  const s = await prisma.mFASetting.findUnique({ where: { userId } });
  const enrolled = !!(s && s.enabledAt && s.method !== 'NONE');
  return {
    configured: mfaConfigured(),
    enrolled,
    pending: !!(s && s.secretEncrypted && !s.enabledAt),
    enabledAt: enrolled ? s!.enabledAt : null,
    lastVerifiedAt: enrolled ? s!.lastVerifiedAt : null,
    recoveryCodesRemaining: enrolled && Array.isArray(s!.backupCodesHash) ? (s!.backupCodesHash as unknown[]).length : 0,
    enforced: false,
  };
}

export async function verifyLogin(actor: MfaActor, code: string): Promise<boolean> {
  const s = await prisma.mFASetting.findUnique({ where: { userId: actor.userId } });
  if (!s || !s.enabledAt || s.method === 'NONE') return true;          // not enrolled → pass-through
  if (s.method === 'TOTP' && await checkCode(actor, s, code, true)) {
    await prisma.mFASetting.update({ where: { userId: actor.userId }, data: { lastVerifiedAt: new Date() } });
    return true;
  }
  return false;
}

/** Optional out-of-band challenge — useful for email/SMS flows. */
export async function issueChallenge(actor: MfaActor): Promise<{ challengeId: string; code: string }> {
  const code = randomBytes(3).readUIntBE(0, 3).toString().padStart(6, '0').slice(-6);
  const hash = createHash('sha256').update(code).digest('hex');
  const row = await prisma.mFAChallenge.create({
    data: { userId: actor.userId, challengeHash: hash, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
  });
  return { challengeId: row.id, code };
}

export async function consumeChallenge(actor: MfaActor, challengeId: string, code: string): Promise<boolean> {
  const c = await prisma.mFAChallenge.findUnique({ where: { id: challengeId } });
  if (!c || c.userId !== actor.userId) throw new NotFoundError('MFAChallenge');
  if (c.consumedAt)                    throw new ForbiddenError('Challenge already consumed');
  if (c.expiresAt < new Date())        throw new ForbiddenError('Challenge expired');
  if (c.attempts >= MAX_VERIFY_ATTEMPTS) throw new ForbiddenError('Too many attempts');
  const ok = createHash('sha256').update(code).digest('hex') === c.challengeHash;
  await prisma.mFAChallenge.update({
    where: { id: challengeId },
    data:  { attempts: { increment: 1 }, ...(ok ? { consumedAt: new Date() } : {}) },
  });
  return ok;
}
