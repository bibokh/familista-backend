// Familista — Sport Adapter contract (Phase G)
// ─────────────────────────────────────────────────────────────────────────
// Every sport that runs on Familista implements SportAdapter. New sports
// drop in as one new class; nothing else in the codebase changes.
//
// Why this exists: rules engine, predictive layer, spatial engine, AI
// agents — all of them need answers to a small set of sport-specific
// questions: "is this player sprinting?" "is this an attacking event?"
// "what's the expected formation?". Centralising those answers behind
// SportAdapter keeps the rest of the platform sport-agnostic.

import type { SportKind } from '@prisma/client';
import type {
  TacticalGeometry,
  UniversalPlayerState,
  UniversalEventEnvelope,
  SpatialFrame,
} from '../spatial/types';

export interface SprintThresholdInput {
  /** Instant speed in m/s. */
  speedMps: number;
  /** Optional acceleration magnitude in m/s². */
  accelMagMps2?: number;
}

export interface FormationTemplate {
  name:    string;          // "4-3-3" | "5-1" | "Singles" | "2-3 zone" | …
  /** Static reference positions in pitch metres. */
  spots:   Array<{ role: string; x: number; y: number }>;
}

export interface TacticalThreatEvent {
  kind:        string;
  isThreat:    boolean;
  /** Side relative to caller: 'OFFENSE' | 'DEFENSE' | 'NEUTRAL'. */
  polarity:    'OFFENSE' | 'DEFENSE' | 'NEUTRAL';
  scoreDelta?: number;   // +1 for goal/point in our favour, -1 against, 0 otherwise
}

export interface SportAdapter {
  readonly sport: SportKind;

  /** Geometry definition (pitch dims, zones, targets, etc.). */
  geometry(): TacticalGeometry;

  /** Maximum players on the field at one time (per side). */
  playersPerSide(): number;

  /** Return true if the player is currently sprinting per sport-specific threshold. */
  isSprinting(input: SprintThresholdInput): boolean;

  /** Standard formation templates the engine can compare against. */
  formations(): FormationTemplate[];

  /**
   * Given an event `kind` string and side, decide whether it's an attacking
   * threat, a defensive action, or neutral. Drives momentum + rules engine.
   */
  classifyEvent(kind: string, side: string): TacticalThreatEvent;

  /**
   * Normalise a raw player record (from any source) into a
   * UniversalPlayerState. Sport adapters may adjust thresholds, default
   * positions, etc. Pure function.
   */
  normaliseState(raw: Partial<UniversalPlayerState>): UniversalPlayerState;

  /**
   * Build a sport-specific envelope from a universal event. Default impl
   * just passes through; sports can enrich with sport-specific fields.
   */
  envelope<P>(evt: UniversalEventEnvelope<P>): UniversalEventEnvelope<P>;

  /**
   * Optionally project a raw SpatialFrame onto sport-specific tactical
   * features (e.g. "pressing line", "tennis court side"). Implementations
   * MAY return the frame unchanged.
   */
  projectFrame(frame: SpatialFrame): SpatialFrame;
}

// ─────────────────────────────────────────────────────────────────────────
// Base helpers — concrete adapters inherit from this to cut boilerplate.
// ─────────────────────────────────────────────────────────────────────────

export abstract class BaseSportAdapter implements SportAdapter {
  abstract readonly sport: SportKind;
  abstract geometry(): TacticalGeometry;
  abstract playersPerSide(): number;
  abstract isSprinting(input: SprintThresholdInput): boolean;
  abstract classifyEvent(kind: string, side: string): TacticalThreatEvent;

  formations(): FormationTemplate[] { return []; }

  normaliseState(raw: Partial<UniversalPlayerState>): UniversalPlayerState {
    return {
      playerId: raw.playerId ?? '',
      side:     raw.side ?? 'HOME',
      number:   raw.number ?? null,
      name:     raw.name ?? null,
      role:     raw.role ?? null,
      x:        typeof raw.x === 'number' ? raw.x : null,
      y:        typeof raw.y === 'number' ? raw.y : null,
      z:        raw.z ?? 0,
      vx:       raw.vx ?? null,
      vy:       raw.vy ?? null,
      vz:       raw.vz ?? null,
      heading:  raw.heading ?? null,
      hr:       raw.hr ?? null,
      sprint:   raw.sprint ?? 0,
      load:     raw.load ?? null,
      alert:    raw.alert ?? 'OK',
      sources:  raw.sources ?? ['VISION'],
      confidence: raw.confidence ?? 0.5,
      staleMs:  raw.staleMs ?? null,
    };
  }

  envelope<P>(evt: UniversalEventEnvelope<P>): UniversalEventEnvelope<P> { return evt; }
  projectFrame(frame: SpatialFrame): SpatialFrame { return frame; }
}
