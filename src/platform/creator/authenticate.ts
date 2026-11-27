/**
 * Familista Creator Studio (P2) — the gate of every creator route.
 *
 * A creator's request carries a token of the creator audience alone (cookie `creator_access`, or a bearer), so a club
 * session is never a creator session nor the reverse: the signature check itself refuses the other kind. The account
 * must be live and the token's version its current one (a password change, a suspension or a deletion ends every
 * session at once). The request then runs in the creator's own database context: row-level security answers it with
 * that creator's Design Studio and manufacturing rows and nothing of any club's. Its design scope is PERSONAL.
 */
import type { NextFunction, Request, Response } from 'express';
import { CreatorStatus } from '@prisma/client';
import { verifyToken } from '../../security/jwt-tokens';
import { runInCreatorContext } from '../../security/db-context';
import { UnauthorizedError } from '../../utils/errors';
import { personalScope } from '../product-design/service';
import { sessionAccount } from './account.service';

export const CREATOR_ACCESS_COOKIE = 'creator_access';
export const CREATOR_REFRESH_COOKIE = 'creator_refresh';

export async function authenticateCreator(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cookie = (req.cookies as Record<string, string> | undefined)?.[CREATOR_ACCESS_COOKIE];
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    let payload: { sub?: unknown; tv?: unknown } | null = null;
    for (const t of [cookie, bearer]) {
      if (!t) continue;
      try { payload = verifyToken<{ sub?: unknown; tv?: unknown }>('creator', t); break; } catch { /* the next credential, if any */ }
    }
    if (!payload || typeof payload.sub !== 'string' || typeof payload.tv !== 'number') throw new UnauthorizedError('Sign in to the Creator Studio');
    const account = await sessionAccount(payload.sub);
    if (!account || account.status !== CreatorStatus.ACTIVE || account.tokenVersion !== payload.tv) throw new UnauthorizedError('Sign in to the Creator Studio');
    req.creator = { id: account.id, tokenVersion: account.tokenVersion, emailVerified: account.emailVerified, locale: account.locale };
    res.locals.designScope = personalScope(account.id);
    runInCreatorContext(account.id, () => next());
  } catch (err) { next(err); }
}
