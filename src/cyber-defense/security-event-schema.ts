// Cyber Defense — Security Event Schema v1
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS
//
// The one payload shape every `security.*` event on the Data Fabric carries,
// and the catalogue of `security.*` names this build reserves. Step 2 of Cyber
// Defense: a contract, declared ahead of the collectors that will fill it.
//
// Five of the names have a collector (`cyber-defense/collectors.ts`, Step 4):
// failed sign-ins, reused refresh tokens, refused access (403), refused
// browser origins and rate-limit hits. A sixth, `security.lockout.triggered`,
// is the lockout evaluated in shadow mode (`cyber-defense/lockout-shadow.ts`,
// Step 5): recorded, never enforced. A seventh, `security.mfa.failed`, is a
// refused second-step code at sign-in (`auth-prod/mfa-enforcement.service.ts`,
// Step 7), seen by the same collector. The rest are registered
// `produced: false` — the registry's own way of saying "declared, no producer
// yet", the same device `system.deploy.*` uses.
//
// WHAT THE ENVELOPE ALREADY CARRIES, AND IS NOT REPEATED HERE
//
// The Fabric envelope has the club, the team, the acting user id, the subject
// and the correlation id. The payload adds only what is specific to security:
// what kind of thing happened, how it ended, how serious it is, what kind of
// actor caused it, where in the platform it was seen, and bounded evidence.
//
// WHAT NEVER TRAVELS
//
// No password, token, cookie, header, secret, e-mail address, user agent, URL,
// query string, request body or free text. A full IP address is personal data
// under the GDPR and does not travel either: `source.ipPrefix` is a network
// prefix (IPv4 /24, IPv6 /48), produced by `ipPrefix()` below and nothing else.
// `evidence` values are numbers, booleans or short tokens with no whitespace,
// so a sentence — somebody's notes, an error message, a stack trace — cannot
// fit in one.
//
// The schema is `strict()`: an unknown key fails validation and the event is
// quarantined, which is the right answer to somebody adding a field to a
// security event without a review.

import { isIP } from 'net';
import { z } from 'zod';

export const SECURITY_EVENT_SCHEMA_VERSION = 1;

/** What area of defence an event belongs to. One per `security.*` name. */
export const SECURITY_CATEGORIES = [
  'AUTHENTICATION', 'SESSION', 'ACCESS', 'NETWORK', 'ABUSE', 'DEVICE', 'INTEGRITY', 'AI',
] as const;
export type SecurityCategory = (typeof SECURITY_CATEGORIES)[number];

/** How the attempt ended, from the platform's side. */
export const SECURITY_OUTCOMES = ['SUCCESS', 'FAILURE', 'BLOCKED', 'DETECTED'] as const;

/** How serious a single event is. A rule, not a producer, raises an incident. */
export const SECURITY_SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

/** What kind of actor caused it. The actor's id, when there is one, is on the envelope. */
export const SECURITY_ACTOR_TYPES = ['USER', 'DEVICE', 'SERVICE', 'ANONYMOUS'] as const;

/** Where in the platform it was observed. */
export const SECURITY_COMPONENTS = [
  'AUTH', 'API', 'CORS', 'RATE_LIMIT', 'TENANT_GUARD', 'MFA', 'DEVICE_INGEST',
  'VISION_INGEST', 'AUDIT_CHAIN', 'AI_GATEWAY', 'WEBSOCKET',
] as const;

/** The privacy class of the event as a whole. Drives who may read it. */
export const SECURITY_PRIVACY_CLASSES = ['PLATFORM', 'PERSONAL', 'RESTRICTED'] as const;

/** A token: an identifier-like string with no whitespace. Never a sentence. */
const token = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_.:-]+$/);

/** An IPv4 /24 or IPv6 /48 network prefix, exactly as `ipPrefix()` renders it. */
const IP_PREFIX = /^(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.0\/24|[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}::\/48)$/;

/** Bounded evidence: at most 12 named scalars. */
const evidence = z
  .record(token(40), z.union([z.number().finite(), z.boolean(), token(64)]))
  .refine((e) => Object.keys(e).length <= 12, { message: 'evidence holds at most 12 entries' });

/** Security Event Schema v1. Every `security.*` payload is this shape. */
export const securityEventPayloadV1 = z.object({
  category: z.enum(SECURITY_CATEGORIES),
  outcome: z.enum(SECURITY_OUTCOMES),
  severity: z.enum(SECURITY_SEVERITIES),
  actor: z.object({
    type: z.enum(SECURITY_ACTOR_TYPES),
    /** A role token from the platform's own enums, when the actor has one. */
    role: token(40).nullable(),
  }).strict(),
  source: z.object({
    component: z.enum(SECURITY_COMPONENTS),
    /** The request id the platform already stamps on every request. */
    requestId: token(80).nullable(),
    ipPrefix: z.string().regex(IP_PREFIX).nullable(),
  }).strict(),
  evidence,
  privacyClass: z.enum(SECURITY_PRIVACY_CLASSES),
}).strict();

export type SecurityEventPayloadV1 = z.infer<typeof securityEventPayloadV1>;

/** One reserved `security.*` name. */
export interface SecurityEventDeclaration {
  type: string;
  category: SecurityCategory;
  describes: string;
  /** Whether the record that it happened is itself the point. */
  auditRelevant: boolean;
  /**
   * Whether this build has a collector for it (`cyber-defense/collectors.ts`).
   * False declares the name ahead of its collector.
   */
  produced: boolean;
}

/**
 * The `security.*` names this build reserves.
 *
 * Each one is a signal a later collector will emit, taken from the Cyber
 * Defense plan's telemetry list. Adding one is a reviewed change; the posture
 * tests pin the set.
 */
export const SECURITY_EVENT_TYPES: readonly SecurityEventDeclaration[] = Object.freeze([
  { type: 'security.login.failed', category: 'AUTHENTICATION', produced: true, auditRelevant: true,
    describes: 'A sign-in attempt was refused' },
  { type: 'security.lockout.triggered', category: 'AUTHENTICATION', produced: true, auditRelevant: true,
    describes: 'A sign-in attempt that the lockout thresholds would refuse (shadow mode: recorded, not enforced)' },
  { type: 'security.mfa.failed', category: 'AUTHENTICATION', produced: true, auditRelevant: true,
    describes: 'A second-factor code was refused' },
  { type: 'security.refresh.reused', category: 'SESSION', produced: true, auditRelevant: true,
    describes: 'A refresh token that was already used was presented again' },
  { type: 'security.access.denied', category: 'ACCESS', produced: true, auditRelevant: true,
    describes: 'An authenticated request was refused by an access check' },
  { type: 'security.tenant.mismatch', category: 'ACCESS', produced: false, auditRelevant: true,
    describes: 'A request named a club or team outside the caller’s tenancy' },
  { type: 'security.origin.rejected', category: 'NETWORK', produced: true, auditRelevant: false,
    describes: 'A browser request came from an origin outside the allowlist' },
  { type: 'security.ratelimit.exceeded', category: 'ABUSE', produced: true, auditRelevant: false,
    describes: 'A caller exceeded a rate limit' },
  { type: 'security.device.signature.rejected', category: 'DEVICE', produced: false, auditRelevant: true,
    describes: 'A device or camera message failed its signature check' },
  { type: 'security.device.replay.rejected', category: 'DEVICE', produced: false, auditRelevant: true,
    describes: 'A device or camera message reused a nonce' },
  { type: 'security.audit.chain.broken', category: 'INTEGRITY', produced: false, auditRelevant: true,
    describes: 'The audit hash chain failed verification' },
  { type: 'security.ai.action.decided', category: 'AI', produced: false, auditRelevant: true,
    describes: 'A person approved or rejected an AI-proposed action' },
]);

/** The payload schema for one declared type: v1 with its category pinned. */
export function securityPayloadSchemaFor(declaration: SecurityEventDeclaration) {
  return securityEventPayloadV1.extend({ category: z.literal(declaration.category) }).strict();
}

/**
 * A network prefix from an IP address — the only form an address may take in
 * a security event.
 *
 * IPv4 keeps its first three octets (/24); IPv6 keeps its first three hextets
 * (/48); an IPv4-mapped IPv6 address is treated as IPv4. Anything that is not
 * an IP address returns null rather than being passed through.
 */
export function ipPrefix(address: string | null | undefined): string | null {
  // A zone id (`%eth0`) names a host interface; it is dropped with the host part.
  let ip = String(address ?? '').trim().toLowerCase().split('%')[0];
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const family = isIP(ip);
  if (family === 4) {
    const [a, b, c] = ip.split('.');
    return `${Number(a)}.${Number(b)}.${Number(c)}.0/24`;
  }
  if (family === 6) {
    const [head] = ip.split('::');
    const expanded = ip.includes('::')
      ? [...head.split(':').filter(Boolean), '0', '0', '0']
      : ip.split(':');
    const [a, b, c] = expanded.map((h) => (h === '' ? '0' : h.replace(/^0+(?=.)/, '')));
    return `${a}:${b}:${c}::/48`;
  }
  return null;
}
