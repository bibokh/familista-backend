// Familista — Digital Twin Replay (Phase E)
// ─────────────────────────────────────────────────────────────────────────
// Replay timeline is a READ-ONLY join over existing data:
//   - MatchTimeline           (human-entered events)
//   - MatchTacticalSnapshot   (positional snapshots)
//   - AIAlert                 (rules-engine output)
//   - DigitalTwinFrame        (optional — engine-persisted frames)
//
// We do NOT add a new write-heavy table for replay; instead we merge all
// the above into one chronological stream. This keeps Phase E migration
// strictly additive and avoids any double-source-of-truth risk.
//
// DigitalTwinFrame exists as an *optional* store for future high-rate
// tactical-state snapshots — but the engine emits sparingly (snapshot
// only on phase change or every 30s during active play).

import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import type { TacticalState } from '../realtime/tactical-state';

export type ReplayKind =
  | 'TIMELINE'
  | 'SNAPSHOT'
  | 'ALERT'
  | 'TWIN_FRAME';

export interface ReplayEvent {
  kind:      ReplayKind;
  atMs:      number;       // server epoch ms
  matchMin?: number | null; // game minute if known
  payload:   unknown;
  id:        string;
}

export interface ReplayTimeline {
  matchId:    string;
  clubId:     string;
  total:      number;
  events:     ReplayEvent[];
}

// ─────────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────────

export async function buildReplay(
  matchId: string,
  clubId: string,
  opts: { fromMs?: number; toMs?: number; kinds?: ReplayKind[]; limit?: number } = {},
): Promise<ReplayTimeline> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, clubId: true },
  });
  if (!match)                  throw new NotFoundError('Match');
  if (match.clubId !== clubId) throw new ForbiddenError();

  const from = opts.fromMs ? new Date(opts.fromMs) : new Date(0);
  const to   = opts.toMs   ? new Date(opts.toMs)   : new Date(Date.now() + 1);
  const kinds = new Set(opts.kinds ?? ['TIMELINE', 'SNAPSHOT', 'ALERT', 'TWIN_FRAME']);
  const limit = Math.min(opts.limit ?? 500, 5000);

  // Parallel reads — each capped.
  const [timeline, snapshots, alerts, frames] = await Promise.all([
    kinds.has('TIMELINE')
      ? prisma.matchTimeline.findMany({
          where:   { matchId, isDeleted: false, createdAt: { gte: from, lte: to } },
          orderBy: { createdAt: 'asc' },
          take:    limit,
        })
      : Promise.resolve([]),
    kinds.has('SNAPSHOT')
      ? prisma.matchTacticalSnapshot.findMany({
          where:   { matchId, createdAt: { gte: from, lte: to } },
          orderBy: { createdAt: 'asc' },
          take:    limit,
        })
      : Promise.resolve([]),
    kinds.has('ALERT')
      ? prisma.aIAlert.findMany({
          where:   { matchId, createdAt: { gte: from, lte: to } },
          orderBy: { createdAt: 'asc' },
          take:    limit,
        })
      : Promise.resolve([]),
    kinds.has('TWIN_FRAME')
      ? prisma.digitalTwinFrame.findMany({
          where:   { matchId, createdAt: { gte: from, lte: to } },
          orderBy: { takenAtMs: 'asc' },
          take:    limit,
        })
      : Promise.resolve([]),
  ]);

  const events: ReplayEvent[] = [
    ...timeline.map((t) => ({
      kind: 'TIMELINE' as ReplayKind,
      id:   t.id,
      atMs: t.createdAt.getTime(),
      matchMin: t.occurredAtMin,
      payload: {
        kind: t.kind, side: t.side, pitchX: t.pitchX, pitchY: t.pitchY,
        primaryPlayerId: t.primaryPlayerId, secondaryPlayerId: t.secondaryPlayerId,
        opponentName: t.opponentName, notes: t.notes, payload: t.payload,
      },
    })),
    ...snapshots.map((s) => ({
      kind: 'SNAPSHOT' as ReplayKind,
      id:   s.id,
      atMs: s.createdAt.getTime(),
      matchMin: s.takenAtMin,
      payload: { phase: s.phase, formation: s.formation, possession: s.possession, positions: s.positions, notes: s.notes },
    })),
    ...alerts.map((a) => ({
      kind: 'ALERT' as ReplayKind,
      id:   a.id,
      atMs: a.createdAt.getTime(),
      matchMin: null,
      payload: { kind: a.kind, severity: a.severity, title: a.title, message: a.message, status: a.status, playerId: a.playerId },
    })),
    ...frames.map((f) => ({
      kind: 'TWIN_FRAME' as ReplayKind,
      id:   f.id,
      atMs: Number(f.takenAtMs),
      matchMin: null,
      payload: { version: f.version, kind: f.kind, state: f.state },
    })),
  ].sort((a, b) => a.atMs - b.atMs);

  return { matchId, clubId, total: events.length, events: events.slice(0, limit) };
}

// ─────────────────────────────────────────────────────────────────────────
// Optional snapshot writer — called by the engine when it decides to
// persist a TacticalState frame. NOT called per SSE tick (would amplify).
// ─────────────────────────────────────────────────────────────────────────

export async function persistTwinFrame(
  clubId: string,
  matchId: string,
  state: TacticalState,
  opts: { kind?: string; version?: number } = {},
): Promise<{ id: string }> {
  const row = await prisma.digitalTwinFrame.create({
    data: {
      clubId,
      matchId,
      takenAtMs: BigInt(state.generatedAt),
      kind:      opts.kind ?? 'TACTICAL',
      version:   opts.version ?? 1,
      state:     state as unknown as never,
    },
    select: { id: true },
  });
  return row;
}
