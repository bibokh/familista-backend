// Cyber Defense, R7 — every JWT is signed and verified in one place
// ─────────────────────────────────────────────────────────────────────────────
// Before this file, five call sites called jsonwebtoken directly:
//
//   · none passed an `algorithms` list, so the algorithm was the token's own
//     choice — the library refuses `alg: none` with a secret, but "the token
//     decides how it is checked" is not a control;
//   · nothing set or checked an issuer or an audience, so an access token, a
//     device token and (with the right secret) a refresh token were
//     interchangeable shapes — a device token is signed with the same secret as
//     a person's session, and the only thing keeping it out of `authenticate`
//     was that its subject happened not to be a user id;
//   · no token said which key signed it, so the secret could never be rotated
//     without signing everybody out at once.
//
// Now:
//
//   HS256, pinned    every verify passes `algorithms: ['HS256']`;
//   issuer           JWT_ISSUER (render.yaml already sets it: `familista`);
//   audience         one per kind — familista-api, familista-refresh,
//                    familista-device, familista-ws — so a token of one kind is
//                    refused as another by the signature check itself;
//   kid              each token names its key; the keyring holds the active
//                    secret and, when one is configured, the previous one, so a
//                    rotation is a configuration change rather than an outage.
//                    Nothing is rotated now.
//
// THE TRANSITION. Tokens minted before this build carry no kid, issuer or
// audience. They are accepted — HS256-pinned, with the active key, and only for
// the kind they could have been — if they were ISSUED before
// LEGACY_ISSUED_BEFORE. This build never mints such a token, so the last of
// them expires on its own (refresh tokens live 7 days); after the cut-off date
// no unscoped token is accepted at all, and the legacy branch can be deleted.

import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export type TokenKind = 'access' | 'refresh' | 'device' | 'ws-ticket';

export const JWT_ALGORITHM = 'HS256' as const;
export const ISSUER = process.env.JWT_ISSUER || 'familista';
export const AUDIENCE: Record<TokenKind, string> = {
  access: 'familista-api',
  refresh: 'familista-refresh',
  device: 'familista-device',
  'ws-ticket': 'familista-ws',
};

/**
 * Tokens without a kid/issuer/audience are a migration artefact. One issued
 * before this instant is still honoured until its own expiry; none issued after
 * it ever is. A fixed date, so the window cannot be widened by configuration.
 */
export const LEGACY_ISSUED_BEFORE = Date.parse('2026-11-01T00:00:00Z');

interface Key { kid: string; secret: string }

/** A key's id: a one-way, non-reversible fingerprint of the secret. Never the secret. */
export function kidOf(secret: string): string {
  return createHash('sha256').update('familista-jwt-kid\0').update(secret).digest('base64url').slice(0, 16);
}

/** The active key first, then the previous one if a rotation is in progress. */
export function keyring(kind: TokenKind): Key[] {
  const refresh = kind === 'refresh';
  const active = refresh ? config.jwt.refreshSecret : config.jwt.secret;
  const previous = refresh ? process.env.JWT_REFRESH_SECRET_PREVIOUS : process.env.JWT_ACCESS_SECRET_PREVIOUS;
  const keys: Key[] = [{ kid: kidOf(active), secret: active }];
  if (previous && previous !== active) keys.push({ kid: kidOf(previous), secret: previous });
  return keys;
}

export interface SignOptions { expiresIn?: string | number; jwtid?: string }

/** Signs `payload` as a token of `kind` with the active key. */
export function signToken(kind: TokenKind, payload: object, opts: SignOptions = {}): string {
  const [active] = keyring(kind);
  const options: jwt.SignOptions = {
    algorithm: JWT_ALGORITHM,
    keyid: active.kid,
    issuer: ISSUER,
    audience: AUDIENCE[kind],
  };
  if (opts.expiresIn !== undefined) options.expiresIn = opts.expiresIn as jwt.SignOptions['expiresIn'];
  if (opts.jwtid) options.jwtid = opts.jwtid;
  return jwt.sign(payload, active.secret, options);
}

export class TokenRejected extends Error {
  constructor(public readonly reason: 'malformed' | 'unknown-key' | 'invalid' | 'expired' | 'legacy-closed' | 'wrong-kind') {
    super(`token rejected: ${reason}`);
    this.name = 'TokenRejected';
  }
}

/**
 * Verifies `token` as a token of `kind`. Throws TokenRejected; never returns
 * an unverified payload.
 */
export function verifyToken<T = jwt.JwtPayload>(kind: TokenKind, token: string, now: number = Date.now()): T {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string' || typeof decoded.payload === 'string') throw new TokenRejected('malformed');
  if (decoded.header.alg !== JWT_ALGORITHM) throw new TokenRejected('invalid');
  const keys = keyring(kind);
  const clock = { clockTimestamp: Math.floor(now / 1000) };
  const kid = decoded.header.kid;

  try {
    if (kid !== undefined) {
      const key = keys.find((k) => k.kid === kid);
      if (!key) throw new TokenRejected('unknown-key');
      return jwt.verify(token, key.secret, {
        algorithms: [JWT_ALGORITHM], issuer: ISSUER, audience: AUDIENCE[kind], ...clock,
      }) as T;
    }

    // ── legacy: minted before this build (no kid) ─────────────────────────
    if (kind === 'ws-ticket') throw new TokenRejected('invalid');
    const payload = jwt.verify(token, keys[0].secret, { algorithms: [JWT_ALGORITHM], ...clock }) as jwt.JwtPayload & { kind?: string };
    if (payload.iss !== undefined || payload.aud !== undefined) throw new TokenRejected('invalid');
    if (typeof payload.iat !== 'number' || payload.iat * 1000 >= LEGACY_ISSUED_BEFORE) throw new TokenRejected('legacy-closed');
    // The old shapes are told apart the only way they ever could be.
    if (kind === 'device' ? payload.kind !== 'device' : payload.kind === 'device') throw new TokenRejected('wrong-kind');
    return payload as unknown as T;
  } catch (err) {
    if (err instanceof TokenRejected) throw err;
    if ((err as { name?: string }).name === 'TokenExpiredError') throw new TokenRejected('expired');
    throw new TokenRejected('invalid');
  }
}
