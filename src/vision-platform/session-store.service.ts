// FAMILISTA VISION — where a session lives, and why it does not live in a new table
// ─────────────────────────────────────────────────────────────────────────────
// THE DECISION, AND THE REASONING BEHIND IT
//
// Vision adds NO new database tables. That was a decision, not an omission, and
// it follows from two rules the platform already has:
//
//   "Do not duplicate Data Vault storage."
//   "Do not delete or overwrite original evidence when a newer model later
//    produces different derived results."
//
// A Vision session is two different things wearing one name:
//
//   ORIGINAL EVIDENCE   the artefact the engine wrote — every observation,
//                       every ball sample, every calibration verdict. It is
//                       immutable by definition: when a better model disagrees
//                       next year, BOTH answers must be readable and
//                       attributable. It stays with the engine, read-only,
//                       addressed through the engine contract. Copying it into
//                       Postgres would create a second original, and two
//                       originals are no original at all.
//
//   PLATFORM FACTS      that a session was created, processed, completed; what
//                       it found; which models found it. These are EVENTS, and
//                       Familista already has durable, replayable, queryable
//                       storage for events: the Fabric outbox, its history, and
//                       the Data Vault that reads them. A `vision_session`
//                       table would be a second history beside that one.
//
// So the session summary travels as the payload of `vision.session.completed`
// and lands in the Vault with every other domain's facts, and the evidence
// stays where the evidence was made. Nothing is stored twice and nothing that
// was measured can be edited.
//
// WHAT THIS COSTS, STATED PLAINLY
//
// A query like "every session this club ran in March" is answered by the
// Vault's event history rather than by a SQL index over a sessions table, and
// it will be slower at scale than an index would be. When session VOLUME rather
// than session CONTENT becomes the bottleneck, the right fix is a projection
// table built FROM the events — a read model, not a second source of truth.
// That is a different change and it does not invalidate this one.

import { normaliseSession, type NormaliseContext } from './session-normaliser';
import type { VisionSession } from './session-model';
import {
  configuredTarget, isUnavailable, visionEngine,
  type VisionUnavailable,
} from './engine-contract';

/**
 * Normalised sessions, kept in memory for the life of the process.
 *
 * A cache and nothing more: every entry can be rebuilt from the engine's
 * artefact, so losing it loses nothing. It exists because normalising four
 * thousand observations on every request would be wasteful, not because the
 * platform needs somewhere to keep the truth.
 */
const cache = new Map<string, VisionSession>();

export interface SessionScope {
  clubId: string | null;
  teamId: string | null;
  matchId: string | null;
}

/**
 * Club ownership, declared beside the evidence rather than guessed from it.
 *
 * The engine does not know what a Familista club is and must not — it will run
 * on a device at a pitch with no platform account attached. So scope is applied
 * HERE, from a manifest the platform controls, and a session with no declared
 * owner is platform-scoped: visible to the platform owner and to nobody else.
 * That default is the safe one. The unsafe default would be to guess an owner
 * from a filename.
 */
function declaredScope(sessionRef: string): SessionScope {
  const raw = process.env.FAMILISTA_VISION_SESSION_SCOPES;
  if (!raw) return { clubId: null, teamId: null, matchId: null };
  try {
    const map = JSON.parse(raw) as Record<string, Partial<SessionScope>>;
    const found = map[sessionRef];
    return {
      clubId: found?.clubId ?? null,
      teamId: found?.teamId ?? null,
      matchId: found?.matchId ?? null,
    };
  } catch {
    return { clubId: null, teamId: null, matchId: null };
  }
}

export async function listSessionRefs(): Promise<string[] | VisionUnavailable> {
  return visionEngine().listSessions();
}

export async function loadSession(
  sessionRef: string,
): Promise<VisionSession | VisionUnavailable> {
  const cached = cache.get(sessionRef);
  if (cached) return cached;

  const engine = visionEngine();
  const artefact = await engine.readSession(sessionRef);
  if (isUnavailable(artefact)) return artefact;

  const identity = await engine.identify();
  const scope = declaredScope(sessionRef);
  const ctx: NormaliseContext = {
    clubId: scope.clubId,
    teamId: scope.teamId,
    matchId: scope.matchId,
    deviceId: identity.deviceId,
    processingTarget: configuredTarget(),
    importedAt: new Date().toISOString(),
  };
  const session = normaliseSession(artefact, ctx);
  cache.set(sessionRef, session);
  return session;
}

/** Summaries for the sessions list. One read each, cached after the first. */
export async function listSessions(): Promise<VisionSession['summary'][] | VisionUnavailable> {
  const refs = await listSessionRefs();
  if (isUnavailable(refs)) return refs;
  const out: VisionSession['summary'][] = [];
  for (const ref of refs) {
    const session = await loadSession(ref);
    if (!isUnavailable(session)) out.push(session.summary);
  }
  return out;
}

/** For tests, and for an operator who has replaced an artefact on disk. */
export function clearSessionCache(): void { cache.clear(); }
