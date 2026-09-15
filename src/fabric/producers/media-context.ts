// Which squad, for a media event
// ─────────────────────────────────────────────────────────────────────────────
// The only file in the Media producer that reads the database, kept apart for
// the reason `match-context.ts` and `medical-context.ts` are: the helpers stay
// pure, and the one lookup that is genuinely needed is visible rather than
// buried in a payload builder.
//
// It resolves ONE thing — the kind of squad a media asset belongs to, `SENIOR`
// or `ACADEMY_U17` — and it resolves it INSIDE the detached publish, so no
// upload, transcode or deletion ever waits on it. It reads `team.kind` and
// nothing else.

import { logger } from '../../utils/logger';
import type { MediaContext } from './media.producer';

/**
 * Resolve the squad kind, then publish. Detached; nobody waits, nothing throws.
 *
 * A caller that already knows the kind passes it and no query is made. One that
 * knows only a `teamId` gets one indexed read. One with no team at all — a club
 * crest, a document — publishes immediately with a null kind, which is the
 * truthful answer rather than a lookup that was always going to miss.
 */
export function withMediaContext(
  who: MediaContext,
  publish: (ctx: MediaContext) => void,
): void {
  const done = (teamKind: string | null) => {
    try { publish({ ...who, teamKind }); }
    catch (err) { logger.warn('[media] could not record a media event', { err: (err as Error)?.message }); }
  };

  if (who.teamKind !== undefined || !who.teamId) {
    done(who.teamKind ?? null);
    return;
  }

  void (async () => {
    const { prisma } = require('../../config/database') as typeof import('../../config/database');
    let kind: string | null = null;
    try {
      const team = await prisma.team.findUnique({
        where: { id: who.teamId as string },
        select: { kind: true },
      });
      kind = team?.kind ?? null;
    } catch {
      // A label, not the fact. Publish without it.
      kind = null;
    }
    done(kind);
  })().catch((err) => {
    logger.warn('[media] could not record a media event', { err: (err as Error)?.message });
  });
}
