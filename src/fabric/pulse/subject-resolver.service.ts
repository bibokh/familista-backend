// Naming what an event was about, and nothing else about it
// ─────────────────────────────────────────────────────────────────────────────
// A frame carries `subjectType: 'PLAYER'` and, for a person, no id — which is
// correct for a firehose but useless to a reader. "A player was updated in some
// club" does not answer the question the owner opened the screen to ask.
//
// So this resolves exactly two labels, read-only, from the ids the envelope
// already carries:
//
//   clubLabel     the club's name
//   subjectLabel  the player's name, for a PLAYER subject
//
// THE RULE, AND WHY IT IS NARROW
//
// A `select` is written out by hand, per model, and it names the two or three
// columns a label needs. A player row also holds a date of birth, a parent's
// email and phone, a medical status and free-text notes; none of that is
// selected here, so none of it can reach a serialiser, a log or a browser even
// by accident. `select` rather than a fetch-and-delete, because a
// fetch-and-delete ships whatever a future migration adds.
//
// WHY THE ID STILL DOES NOT TRAVEL
//
// The frame gains a NAME, not an identifier. A name is what a person reads; an
// id is what a script iterates. The owner can already see both on the squad
// screen — which has an access log — and this screen does not need to become a
// second way to enumerate people.
//
// BATCHED, BECAUSE A BURST IS NORMAL
//
// One query per model per page, not one per frame. Two hundred events resolve
// in two queries. A per-frame lookup would make a burst of activity into a
// burst of database load, which is the visualiser hurting the thing it watches.
//
// A MISSING LABEL IS A MISSING LABEL
//
// A deleted player or an unreadable club leaves the label null and the frame is
// still drawn. The event happened; the fact that the subject has since gone is
// not a reason to hide it, and inventing a placeholder name would be a
// fabrication.

import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import type { PulseFrame } from './pulse.service';

/** Subject kinds this module knows how to name. */
const NAMEABLE = new Set(['PLAYER', 'CLUB', 'TEAM']);

/** The most subjects one page may resolve. A page is already bounded above. */
const MAX_LOOKUP = 200;

function unique(values: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of values) if (v) out.add(v);
  return [...out].slice(0, MAX_LOOKUP);
}

/**
 * Fill in `clubLabel` and `subjectLabel` on a page of frames, in place.
 *
 * Never throws: a label is a courtesy, and a failed lookup must not cost the
 * owner the event itself.
 */
export async function resolveSubjects(frames: PulseFrame[]): Promise<void> {
  if (!frames.length) return;

  try {
    const clubIds = unique(frames.map((f) => f.clubId));
    // Only PLAYER subjects carry an id worth resolving, and only because the
    // projection deliberately withholds that id from the wire — it is used
    // here, server-side, and does not travel.
    const playerIds = unique(frames.map((f) => (f.subjectType === 'PLAYER' ? f.resolveId : null)));
    const teamIds = unique(frames.map((f) => (f.subjectType === 'TEAM' ? f.resolveId : null)));

    const [clubs, players, teams] = await Promise.all([
      clubIds.length
        // The name, and the name only.
        ? prisma.club.findMany({ where: { id: { in: clubIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      playerIds.length
        // First and last name. Not the date of birth, not a parent's contact,
        // not the medical status, not the notes.
        ? prisma.player.findMany({
          where: { id: { in: playerIds } },
          select: { id: true, firstName: true, lastName: true },
        })
        : Promise.resolve([]),
      teamIds.length
        ? prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
    ]);

    const clubName = new Map(clubs.map((c) => [c.id, c.name]));
    const playerName = new Map(players.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    const teamName = new Map(teams.map((t) => [t.id, t.name]));

    for (const frame of frames) {
      frame.clubLabel = (frame.clubId && clubName.get(frame.clubId)) || null;
      if (frame.subjectType === 'PLAYER' && frame.resolveId) {
        frame.subjectLabel = playerName.get(frame.resolveId) ?? null;
      } else if (frame.subjectType === 'TEAM' && frame.resolveId) {
        frame.subjectLabel = teamName.get(frame.resolveId) ?? null;
      } else if (frame.subjectType === 'CLUB' && frame.clubId) {
        frame.subjectLabel = clubName.get(frame.clubId) ?? null;
      }
      // The id was needed to look the label up and must not reach the wire.
      // Deleted rather than blanked, so a serialiser cannot find the key.
      delete frame.resolveId;
    }
  } catch (err) {
    logger.warn('[pulse] could not resolve subject labels; frames are unlabelled', {
      err: (err as Error).message,
    });
    for (const frame of frames) delete frame.resolveId;
  }
}

/** Whether a subject kind can be given a name at all. For a status surface. */
export function isNameableSubject(subjectType: string | null): boolean {
  return !!subjectType && NAMEABLE.has(subjectType);
}
