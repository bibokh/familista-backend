// Cyber Defense, R7 — a WebSocket is opened with a ticket, not with the session
// ─────────────────────────────────────────────────────────────────────────────
// A browser cannot set headers on a WebSocket upgrade, so the sockets used to
// take the access token in the URL: `/ws/market?token=<jwt>`. A URL is logged
// by proxies, kept in history, shown in a referrer — and that token is the
// whole session for fifteen minutes, good for every API call.
//
// Now the page asks for a ticket over an authenticated request and opens the
// socket with that instead. A ticket:
//
//   · is good for one socket and nothing else — its own audience
//     (familista-ws), refused as an access token by the signature check;
//   · lives TICKET_TTL_SECONDS (30 s);
//   · can be redeemed ONCE: its id is claimed with SET NX in Redis, so a
//     second attempt fails in any process; without Redis there is one process
//     and the claim is held in memory. If Redis is configured but cannot be
//     reached, the claim fails CLOSED and the page simply asks again;
//   · carries the session's token version, so a socket opened with it is held
//     to the same rule as the session that asked for it (R1c), and whether
//     that session passed a code, so the admin MFA rule holds on the socket.

import { randomUUID } from 'crypto';
import { signToken, verifyToken } from '../security/jwt-tokens';
import { realtimeSessionFor, type RealtimeSession } from '../middleware/auth.middleware';
import { getRedis, redisConfigured, rkey } from '../infra/redis';

export const TICKET_TTL_SECONDS = 30;

export function issueWsTicket(userId: string, tokenVersion: number | null, passedCode = false): { ticket: string; expiresIn: number } {
  const claims: Record<string, unknown> = { sub: userId };
  if (typeof tokenVersion === 'number') claims.tv = tokenVersion;
  if (passedCode) claims.mfa = true;
  return {
    ticket: signToken('ws-ticket', claims, { expiresIn: TICKET_TTL_SECONDS, jwtid: randomUUID() }),
    expiresIn: TICKET_TTL_SECONDS,
  };
}

const claimedHere = new Map<string, number>();

/** True the first time a ticket id is presented, anywhere; false every time after. */
export async function claimOnce(jti: string, now: number = Date.now()): Promise<boolean> {
  if (redisConfigured()) {
    const client = getRedis('cmd');
    if (!client) return false;
    try {
      const ok = await client.set(rkey('ws-ticket', jti), '1', 'PX', TICKET_TTL_SECONDS * 2000, 'NX');
      return ok === 'OK';
    } catch {
      return false;
    }
  }
  for (const [k, exp] of claimedHere) if (exp <= now) claimedHere.delete(k);
  if (claimedHere.has(jti)) return false;
  claimedHere.set(jti, now + TICKET_TTL_SECONDS * 2000);
  return true;
}

/** Verifies and spends a ticket; resolves to the session it opens, or null. */
export async function redeemWsTicket(ticket: string | null | undefined): Promise<RealtimeSession | null> {
  if (!ticket) return null;
  let claims: { sub?: string; tv?: number; jti?: string; mfa?: unknown };
  try { claims = verifyToken('ws-ticket', ticket); } catch { return null; }
  if (!claims.sub || !claims.jti) return null;
  if (!(await claimOnce(claims.jti))) return null;
  try { return await realtimeSessionFor(claims.sub, claims.tv, claims.mfa === true); } catch { return null; }
}

/** Tests only. */
export function __resetTicketClaims(): void { claimedHere.clear(); }
