// Which squad, for a medical event
// ─────────────────────────────────────────────────────────────────────────────
// The only file in the Medical producer that reads the database, kept apart for
// the reason `match-context.ts` is: a producer whose helpers are pure is a
// producer a test can drive without a schema, and the one lookup that is
// genuinely needed should be visible rather than buried in a payload builder.
//
// It resolves ONE thing — the kind of squad the player is in, `SENIOR` or
// `ACADEMY_U17` — and it resolves it INSIDE the detached publish, so no medical
// operation ever waits on it. A physiotherapist saving an injury record must
// not be slower because an observability surface wanted to know an age group.
//
// It reads `teamId` and `team.kind` and nothing else. Not the name, not the
// date of birth, not the medical status, not the notes. A `select` written out
// by hand, so a column added by a future migration cannot arrive here on its
// own.

import { logger } from '../../utils/logger';
import type { MedicalContext } from './medical.producer';

/**
 * Resolve the squad kind, then publish. Detached; nobody waits, nothing throws.
 *
 * The caller passes what it already knows and a function that publishes. If the
 * lookup fails, or the player has since gone, the event is still published with
 * a null `teamKind` — the medical fact happened, and losing the record of it to
 * protect an optional label would be the wrong trade.
 */
export function withMedicalContext(
  who: { playerId: string; clubId: string; actorUserId?: string | null; teamKind?: string | null },
  publish: (ctx: MedicalContext) => void,
): void {
  // Already known — the caller read the player for its own reasons. No lookup.
  if (who.teamKind !== undefined) {
    try { publish({ ...who, teamKind: who.teamKind ?? null }); }
    catch (err) { logger.warn('[medical] could not record a medical event', { err: (err as Error)?.message }); }
    return;
  }

  void (async () => {
    const { prisma } = require('../../config/database') as typeof import('../../config/database');
    let teamKind: string | null = null;
    try {
      const player = await prisma.player.findUnique({
        where: { id: who.playerId },
        select: { teamId: true, team: { select: { kind: true } } },
      });
      teamKind = player?.team?.kind ?? null;
    } catch {
      // A label, not the fact. Publish without it.
      teamKind = null;
    }
    publish({ ...who, teamKind });
  })().catch((err) => {
    logger.warn('[medical] could not record a medical event', { err: (err as Error)?.message });
  });
}

/**
 * The same, for the athlete medical history.
 *
 * `AthleteMedicalHistory` keys on a UNIVERSAL ATHLETE id rather than on a
 * Player id, so that is what the event carries as its subject: it is the key
 * the record is stored under, and therefore the key a retention job, a consent
 * rule or a deletion request has to match on. A Player id would be a link this
 * record does not itself make.
 *
 * The squad kind is resolved THROUGH the identity link, so an academy record
 * is still distinguishable from a senior one. Two indexed reads, both inside
 * the detached publish, neither of them on the medical caller's path — and the
 * event is published with a null kind if either misses.
 */
export function withAthleteMedicalContext(
  who: { athleteId: string; clubId: string; actorUserId?: string | null },
  publish: (ctx: MedicalContext) => void,
): void {
  void (async () => {
    const { prisma } = require('../../config/database') as typeof import('../../config/database');
    let teamKind: string | null = null;
    try {
      const link = await prisma.athleteIdentityLink.findFirst({
        where: { athleteId: who.athleteId, clubId: who.clubId },
        select: { playerId: true },
      });
      if (link?.playerId) {
        const player = await prisma.player.findUnique({
          where: { id: link.playerId },
          select: { team: { select: { kind: true } } },
        });
        teamKind = player?.team?.kind ?? null;
      }
    } catch {
      teamKind = null;
    }
    publish({
      playerId: who.athleteId, clubId: who.clubId,
      actorUserId: who.actorUserId ?? null, teamKind,
    });
  })().catch((err) => {
    logger.warn('[medical] could not record a medical event', { err: (err as Error)?.message });
  });
}
