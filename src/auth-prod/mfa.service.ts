// Familista — Multi-Factor Authentication (Phase O)
// ─────────────────────────────────────────────────────────────────────────
// RFC 6238 TOTP using built-in `crypto` (HMAC-SHA1, 30-sec step, 6 digits).
// No external dependencies. Secret is base32-encoded, stored encrypted with
// a key derived from `config.jwt.secret` (AES-GCM via createCipheriv).

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { MFAChallenge, MfaMethod, MFASetting, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { config } from '../config';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/errors';
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

function constantTimeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ─────────────────────────────────────────────────────────────────────────
// Secret encryption (AES-256-GCM) — key derived from jwt.secret
// ─────────────────────────────────────────────────────────────────────────

function deriveAesKey(): Buffer {
  return createHash('sha256').update(config.jwt.secret + ':mfa:v1').digest();
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
    update: { method: 'TOTP', secretEncrypted: encryptSecret(base32), enabledAt: null },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'MFA_ENROLL_INIT', entityType: 'MFASetting', entityId: actor.userId, payload: { method: 'TOTP' },
  });
  const issuer = 'Familista';
  const otpauth = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${base32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return { base32, otpauth };
}

export async function confirmTOTP(actor: MfaActor, code: string): Promise<MFASetting> {
  const settings = await prisma.mFASetting.findUnique({ where: { userId: actor.userId } });
  if (!settings || !settings.secretEncrypted) throw new BadRequestError('MFA not initialised; enroll first');
  const secret = decryptSecret(settings.secretEncrypted);
  if (!verifyTOTP(secret, code)) throw new UnauthorizedError('Invalid TOTP code');
  // Generate 8 backup codes (sha256 of base32(10 bytes)).
  const backupCodes: string[] = [];
  const backupHashes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const c = base32Encode(randomBytes(10));
    backupCodes.push(c);
    backupHashes.push(createHash('sha256').update(c).digest('hex'));
  }
  const updated = await prisma.mFASetting.update({
    where: { userId: actor.userId },
    data:  { enabledAt: new Date(), lastVerifiedAt: new Date(), backupCodesHash: backupHashes as unknown as Prisma.InputJsonValue },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'MFA_ENABLED', entityType: 'MFASetting', entityId: actor.userId,
  });
  // Return the plain backup codes ONCE via response (caller stores externally).
  return { ...updated, backupCodesHash: backupCodes as unknown as Prisma.JsonValue };
}

export async function disableMFA(actor: MfaActor): Promise<{ ok: true }> {
  await prisma.mFASetting.update({
    where: { userId: actor.userId },
    data:  { method: 'NONE', enabledAt: null, secretEncrypted: null, backupCodesHash: Prisma.JsonNull },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'MFA_DISABLED', entityType: 'MFASetting', entityId: actor.userId,
  });
  return { ok: true };
}

export async function verifyLogin(actor: MfaActor, code: string): Promise<boolean> {
  const s = await prisma.mFASetting.findUnique({ where: { userId: actor.userId } });
  if (!s || !s.enabledAt || s.method === 'NONE') return true;          // not enrolled → pass-through
  if (s.method === 'TOTP' && s.secretEncrypted) {
    const secret = decryptSecret(s.secretEncrypted);
    if (verifyTOTP(secret, code)) {
      await prisma.mFASetting.update({ where: { userId: actor.userId }, data: { lastVerifiedAt: new Date() } });
      return true;
    }
    // Try backup codes.
    const hashes = (s.backupCodesHash as string[] | null) ?? [];
    const provided = createHash('sha256').update(code).digest('hex');
    const idx = hashes.findIndex((h) => h === provided);
    if (idx >= 0) {
      // Single-use backup — remove the consumed hash.
      const newHashes = hashes.filter((_, i) => i !== idx);
      await prisma.mFASetting.update({
        where: { userId: actor.userId },
        data:  { backupCodesHash: newHashes as unknown as Prisma.InputJsonValue, lastVerifiedAt: new Date() },
      });
      return true;
    }
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
