// FAMILISTA VISION → FAMILISTA INTELLIGENCE — evidence, and nothing that looks
// like a conclusion
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS INTERFACE DELIBERATELY CANNOT CARRY
//
// No overall Quality. No Vision rating, Decisions rating, Composure, Passing,
// Finishing or Stamina. No mental attributes. No tactical recommendation. Not
// because they are hard, but because the engine does not produce them, and an
// interface that has a field for something nobody measures is an invitation to
// fill it. The first consumer that wrote `quality: 7.2` into this shape would
// be the last moment anybody could tell measurement from estimate.
//
// WHAT IT DOES CARRY
//
// Observations with their error bars and their origin, and enough provenance to
// re-derive anything built on them. Familista Intelligence can consume this
// today and produce whatever it can justify; when a rating is genuinely
// validated it will arrive as its own contract, with its own evidence, and this
// one will still say what it says.
//
// THE CONFIDENCE FIELD IS NOT DECORATION
//
// A consumer that ignores `expectedErrorM` and treats a LOW-band position as a
// HIGH-band one has produced a number the platform cannot stand behind. The
// contract therefore refuses to hand over a metric position at all where
// calibration was NONE — there is no field to misread, because there is no
// value.

import type {
  ConfidenceBand, EvidenceOrigin, VisionSession, VisionSessionSummary,
} from './session-model';

/** One position the platform is prepared to stand behind, with its error bar. */
export interface MetricPositionEvidence {
  identity: string;
  frameNumber: number;
  timestamp: number;
  pitchXM: number;
  pitchYM: number;
  confidence: ConfidenceBand;
  expectedErrorM: number | null;
  origin: EvidenceOrigin;
}

/** A football finding the engine confirmed, with what confirmed it. */
export interface FootballFindingEvidence {
  eventId: string;
  type: string;
  state: string;
  frameNumber: number;
  timestamp: number;
  identities: string[];
  teamId: string | null;
  origin: EvidenceOrigin;
  confidence: number | null;
  reason: string | null;
}

export interface VisionEvidenceBundle {
  sessionId: string;
  sessionRef: string;
  clubId: string | null;
  teamId: string | null;
  matchId: string | null;
  pipelineVersion: string | null;
  modelIds: string[];

  /** Only where calibration published a coordinate. Never interpolated. */
  metricPositions: MetricPositionEvidence[];
  findings: FootballFindingEvidence[];

  /**
   * What this bundle does NOT support, and why.
   *
   * Carried with the evidence rather than left to the consumer to work out, so
   * an intelligence module asking for something absent gets a reason instead of
   * an empty array it might read as "no occurrences".
   */
  unavailable: Record<string, string>;

  /** Counted, so a consumer can weight a session by how much it actually saw. */
  coverage: {
    framesProcessed: number;
    observationsTotal: number;
    observationsWithMetricPosition: number;
    calibrationCoverage: number | null;
    ballObservedCoverage: number | null;
  };
}

/**
 * Build the bundle Familista Intelligence may consume.
 *
 * The filter on the first line is the contract: an observation without a
 * published pitch coordinate does not appear, in any form, with any marker.
 * Handing over a null island and trusting the consumer to skip it is how a
 * mean gets computed over positions that were never measured.
 */
export function evidenceFor(session: VisionSession): VisionEvidenceBundle {
  const s: VisionSessionSummary = session.summary;
  const metricPositions: MetricPositionEvidence[] = session.tracks
    .filter((t) => t.pitchXM !== null && t.pitchYM !== null)
    .map((t) => ({
      identity: t.identity,
      frameNumber: t.frameNumber,
      timestamp: t.timestamp,
      pitchXM: t.pitchXM as number,
      pitchYM: t.pitchYM as number,
      confidence: t.calibrationConfidence,
      expectedErrorM: t.calibrationErrorM,
      origin: t.calibrationChain === 'measured' ? 'MEASURED'
        : t.calibrationChain === 'propagated' ? 'PROPAGATED' : 'UNKNOWN',
    }));

  const findings: FootballFindingEvidence[] = session.events
    .filter((e) => e.state === 'CONFIRMED')
    .map((e) => ({
      eventId: e.eventId,
      type: e.type,
      state: e.state,
      frameNumber: e.frameNumber,
      timestamp: e.timestamp,
      identities: e.trackIds,
      teamId: e.teamId,
      origin: e.origin,
      confidence: e.confidence,
      reason: e.reason,
    }));

  const unavailable: Record<string, string> = {
    playerRatings: 'not produced. The engine measures observations, not attributes; '
      + 'no Quality, Vision, Decisions, Composure, Passing, Finishing or Stamina '
      + 'value exists to consume.',
    mentalAttributes: 'not produced, and not derivable from anything in this bundle.',
    tacticalRecommendations: 'not produced. No formation, shape, pressing or space '
      + 'result is implemented in the validated engine.',
    physicalMetrics: 'not validated. Implied speed exists only as a calibration '
      + 'guard statistic and is deliberately absent here so it cannot be mistaken '
      + 'for a player measurement.',
  };
  if (!s.capabilities.metricCoordinates) {
    unavailable.metricPositions = s.capabilities.reasons.metricCoordinates
      ?? 'calibration published no coordinates for this session';
  }
  if (!s.capabilities.events) {
    unavailable.findings = s.capabilities.reasons.events
      ?? 'no football event was confirmed in this session';
  }

  return {
    sessionId: s.sessionId,
    sessionRef: s.sessionRef,
    clubId: s.clubId,
    teamId: s.teamId,
    matchId: s.matchId,
    pipelineVersion: s.pipelineVersion,
    modelIds: s.models.map((m) => m.modelId),
    metricPositions,
    findings,
    unavailable,
    coverage: {
      framesProcessed: s.framesProcessed,
      observationsTotal: s.observationsTotal,
      observationsWithMetricPosition: metricPositions.length,
      calibrationCoverage: s.calibrationCoverage,
      ballObservedCoverage: s.ballObservedCoverage,
    },
  };
}
