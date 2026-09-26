// FAMILISTA VISION — engine artefact in, platform session out
// ─────────────────────────────────────────────────────────────────────────────
// Reads what the engine wrote. Decides nothing the engine declined to decide.
// See the header of `session-model.ts` for why that rule is the whole file.

import { createHash } from 'node:crypto';

import type { EngineSessionArtefact } from './engine-contract';
import type {
  BallState, CalibrationChain, ConfidenceBand, EvidenceOrigin, VisionBallSample,
  VisionCalibrationFrame, VisionCapabilities, VisionFootballEvent, VisionModelRef,
  VisionProviderRef, VisionRoleEvidence, VisionSession, VisionSessionSummary,
  VisionSourceRef, VisionTrackObservation,
} from './session-model';

type Doc = Record<string, unknown>;

const obj = (v: unknown): Doc => (v && typeof v === 'object' && !Array.isArray(v) ? v as Doc : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback);

/** The engine's band vocabulary, refused rather than coerced when unrecognised. */
function band(v: unknown): ConfidenceBand {
  return v === 'HIGH' || v === 'MEDIUM' || v === 'LOW' ? v : 'NONE';
}

function chain(v: unknown): CalibrationChain {
  return v === 'measured' || v === 'propagated' ? v : 'none';
}

function ballState(v: unknown): BallState {
  return v === 'OBSERVED' || v === 'PROPAGATED' || v === 'UNKNOWN' ? v : 'NOT_AVAILABLE';
}

/**
 * The origin of a ball sample, from the state the engine gave it.
 *
 * OBSERVED is MEASURED and PROPAGATED is PROPAGATED — the mapping is one line
 * and it is the most important line in this file. Everything downstream that
 * distinguishes a detection from a carried estimate reads this field, and a
 * mapping that flattened them would erase the distinction Phase 3 was built to
 * preserve.
 */
function ballOrigin(state: BallState): EvidenceOrigin {
  if (state === 'OBSERVED') return 'MEASURED';
  if (state === 'PROPAGATED') return 'PROPAGATED';
  return 'UNKNOWN';
}

function originFromChain(c: CalibrationChain): EvidenceOrigin {
  if (c === 'measured') return 'MEASURED';
  if (c === 'propagated') return 'PROPAGATED';
  return 'UNKNOWN';
}

function models(doc: Doc): VisionModelRef[] {
  return arr(doc.models).map((raw) => {
    const m = obj(raw);
    return {
      modelId: String(m.model_id ?? 'unknown'),
      registered: m.registered !== false,
      ...(str(m.name) ? { name: String(m.name) } : {}),
      ...(str(m.version) ? { version: String(m.version) } : {}),
      ...(str(m.task) ? { task: String(m.task) } : {}),
      ...(str(m.framework) ? { framework: String(m.framework) } : {}),
      weights: str(m.weights),
      checksumSha256: str(m.checksum_sha256),
      licenceSoftware: str(m.licence_software),
      licenceWeights: str(m.licence_weights),
      licenceDataset: str(m.licence_dataset),
      commercialUse: String(m.commercial_use ?? 'UNKNOWN'),
      licenceVerification: String(m.licence_verification ?? 'NOT_VERIFIED'),
    };
  });
}

function providers(doc: Doc): VisionProviderRef[] {
  const out: VisionProviderRef[] = [];
  for (const [role, raw] of Object.entries(obj(doc.providers))) {
    if (!raw) continue;
    const p = obj(raw);
    out.push({
      role,
      provider: String(p.provider ?? 'unknown'),
      modelIds: arr(p.model_ids).map(String),
      settings: obj(p.settings),
      ...(typeof p.fuses_detection_and_tracking === 'boolean'
        ? { fusesDetectionAndTracking: p.fuses_detection_and_tracking } : {}),
    });
  }
  return out;
}

/**
 * The source, described without exposing where it sits on disk.
 *
 * `mediaRef` is the file's NAME and its hash, not its path. An API that hands a
 * client `/home/user/…` has told an attacker the shape of the server and told
 * an honest reader something they cannot use.
 */
function source(doc: Doc, sessionRef: string): VisionSourceRef {
  const src = obj(doc.source);
  const video = obj(doc.video);
  const quality = obj(doc.source_quality);
  const rawPath = str(src.path) ?? str(src.file) ?? null;
  const name = rawPath ? rawPath.split('/').pop() ?? rawPath : null;
  return {
    sourceId: `vision-source-${sessionRef}`,
    sourceType: String(src.kind ?? 'VIDEO_FILE').toUpperCase().replace(/[^A-Z_]/g, '_'),
    displayName: name ?? sessionRef,
    mediaRef: name,
    sha256: str(src.sha256),
    width: num(video.width),
    height: num(video.height),
    fps: num(video.fps),
    rotationDegrees: num(video.rotation_degrees),
    qualityBand: str(quality.band),
    qualityScore: num(quality.score),
  };
}

function tracks(doc: Doc): VisionTrackObservation[] {
  return arr(doc.observations).map((raw) => {
    const o = obj(raw);
    const p = obj(o.provenance);
    const b = obj(o.bounding_box);
    const c = chain(p.chain);
    return {
      frameNumber: int(o.frame_number),
      timestamp: num(o.timestamp) ?? 0,
      identity: String(o.identity ?? ''),
      trackId: int(o.track_id),
      teamId: str(o.team_id),
      role: String(o.role ?? 'UNKNOWN'),
      classificationConfidence: num(o.classification_confidence),
      detectionConfidence: num(o.detection_confidence),
      box: { x1: int(b.x1), y1: int(b.y1), x2: int(b.x2), y2: int(b.y2) },
      imageX: num(o.foot_x) ?? num(o.image_x) ?? 0,
      imageY: num(o.foot_y) ?? num(o.image_y) ?? 0,
      // Copied, never computed. A null here means the engine published no
      // coordinate for this observation, and the platform must not produce one.
      pitchXM: num(o.pitch_x_m),
      pitchYM: num(o.pitch_y_m),
      calibrationChain: c,
      calibrationConfidence: band(p.calibration_confidence),
      calibrationErrorM: num(p.calibration_error_m),
      shotId: num(p.shot_id),
    };
  });
}

function ball(doc: Doc, fps: number | null): VisionBallSample[] {
  return arr(doc.ball).map((raw) => {
    const s = obj(raw);
    const state = ballState(s.state);
    const frame = int(s.frame_number ?? s.frame);
    return {
      frameNumber: frame,
      timestamp: num(s.timestamp) ?? (fps ? frame / fps : 0),
      state,
      imageX: num(s.image_x),
      imageY: num(s.image_y),
      pitchXM: num(s.pitch_x_m),
      pitchYM: num(s.pitch_y_m),
      trackingConfidence: num(s.track_confidence) ?? num(s.tracking_confidence),
      detectionConfidence: num(s.detection_confidence),
      framesSinceObservation: num(s.frames_since_observation),
      // The engine reports the nearest player as an object carrying its own
      // disclaimer ("proximity only; possession is not claimed"). Reading the
      // identity out of it keeps the figure; the disclaimer is enforced by the
      // event vocabulary, which has no name for a possession this could imply.
      nearestPlayer: str(obj(s.nearest_player).identity),
      nearestDistanceM: num(obj(s.nearest_player).distance_m),
      nearestDistancePx: num(obj(s.nearest_player).distance_px),
      reason: str(s.reason),
      origin: ballOrigin(state),
    };
  });
}

/**
 * One calibration verdict per frame, with the anchors marked.
 *
 * Built from the per-observation provenance because that is where the engine
 * puts it; a frame with no observations has no verdict and therefore no row,
 * which is the honest shape — the timeline draws a gap rather than a NONE it
 * inferred from silence.
 */
function calibration(doc: Doc): VisionCalibrationFrame[] {
  const byFrame = new Map<number, VisionCalibrationFrame>();
  for (const raw of arr(doc.observations)) {
    const o = obj(raw);
    const frame = int(o.frame_number);
    if (byFrame.has(frame)) continue;
    const p = obj(o.provenance);
    const c = chain(p.chain);
    const since = num(p.frames_since_anchor);
    byFrame.set(frame, {
      frameNumber: frame,
      chain: c,
      confidence: band(p.calibration_confidence),
      expectedErrorM: num(p.calibration_error_m),
      framesSinceAnchor: since,
      score: num(p.calibration_score),
      landmark: str(p.landmark),
      reprojectionErrorPx: num(p.reprojection_error_px),
      isAnchor: c === 'measured' && since === 0,
    });
  }
  return [...byFrame.values()].sort((a, b) => a.frameNumber - b.frameNumber);
}

function events(companions: Record<string, Doc>, fps: number | null,
                sessionRef: string): VisionFootballEvent[] {
  const p4 = obj(companions.events ?? companions.phase4 ?? {});
  return arr(p4.events).map((raw, index) => {
    const e = obj(raw);
    const frame = int(e.frame ?? e.frame_number);
    const involved = arr(e.players ?? e.track_ids).map(String);
    const evidence = obj(e.evidence);
    return {
      eventId: `${sessionRef}-ev-${index}`,
      type: String(e.type ?? 'UNKNOWN'),
      state: String(e.state ?? 'UNKNOWN'),
      frameNumber: frame,
      timestamp: num(e.t) ?? num(e.timestamp) ?? (fps ? frame / fps : 0),
      trackIds: involved,
      teamId: str(e.team_id) ?? str(e.team),
      ballState: e.ball_state ? ballState(e.ball_state) : null,
      pitchXM: num(e.pitch_x_m),
      pitchYM: num(e.pitch_y_m),
      confidence: num(e.confidence),
      // An event the engine derived from measured ball evidence is MEASURED;
      // one it derived from a propagated position inherits PROPAGATED. The
      // engine already decided this; the normaliser reads its word for it.
      origin: (e.origin === 'MEASURED' || e.origin === 'PROPAGATED'
        || e.origin === 'SYNTHETIC' ? e.origin : 'UNKNOWN') as EvidenceOrigin,
      reason: str(e.reason),
      evidence,
    };
  });
}

function roles(doc: Doc): VisionRoleEvidence[] {
  const out: VisionRoleEvidence[] = [];
  for (const [identity, raw] of Object.entries(obj(doc.role_evidence))) {
    const r = obj(raw);
    out.push({
      identity,
      role: String(r.role ?? 'UNKNOWN'),
      confidence: num(r.confidence),
      reason: str(r.reason),
      observations: num(r.observations),
    });
  }
  return out;
}

/**
 * What this session can answer, measured from what it holds.
 *
 * MIN_HEATMAP_POINTS is a rendering threshold, not a validation threshold: it
 * decides whether a heatmap would be a picture of anything, and it does not
 * touch what the engine accepted. Below it the screen says INSUFFICIENT
 * CALIBRATED TRACKING DATA, which is a true statement about this session and
 * not a judgement about the calibration.
 */
const MIN_HEATMAP_POINTS = 200;

function capabilities(s: {
  tracks: VisionTrackObservation[]; ball: VisionBallSample[];
  events: VisionFootballEvent[]; roles: VisionRoleEvidence[];
  withCoords: number;
}): VisionCapabilities {
  const reasons: Record<string, string> = {};
  const tracking = s.tracks.length > 0;
  if (!tracking) reasons.tracking = 'the session produced no tracked observations';

  const teams = s.tracks.some((t) => t.teamId);
  if (!teams) reasons.teams = 'no observation was assigned to a team';

  const roleKnown = s.roles.some((r) => r.role !== 'UNKNOWN');
  if (!roleKnown) reasons.roles = 'no track had sufficient evidence for a role';

  const ballSeen = s.ball.some((b) => b.state === 'OBSERVED');
  if (!ballSeen) reasons.ball = 'the ball was never directly observed in this session';

  const metric = s.withCoords > 0;
  if (!metric) {
    reasons.metricCoordinates = 'calibration was NONE throughout; no pitch coordinate '
      + 'was published and none may be inferred';
  }

  const heatmaps = s.withCoords >= MIN_HEATMAP_POINTS;
  if (!heatmaps) {
    reasons.heatmaps = metric
      ? `only ${s.withCoords} calibrated positions exist; a heatmap needs at least `
        + `${MIN_HEATMAP_POINTS} to describe anything`
      : 'no calibrated positions exist';
  }

  const hasEvents = s.events.length > 0;
  if (!hasEvents) reasons.events = 'the engine confirmed no football events in this session';

  // Two capabilities that are false for every session, because the engine does
  // not produce them. Stated as a property of the ENGINE, not of the session,
  // so a reader does not go looking for a better clip.
  reasons.tactical = 'tactical intelligence is not implemented in the validated engine; '
    + 'no formation, shape, pressing or space result exists to display';
  reasons.physicalMetrics = 'physical metrics are not validated: the engine measures '
    + 'implied speed only as a calibration guard, and it is not a player attribute';

  return {
    tracking, teams, roles: roleKnown, ball: ballSeen,
    metricCoordinates: metric, heatmaps, events: hasEvents,
    tactical: false, physicalMetrics: false, reasons,
  };
}

function countBy<T>(items: T[], key: (t: T) => string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** A stable session id from the artefact, so re-importing is not re-creating. */
export function sessionIdFor(sessionRef: string, doc: Doc): string {
  const src = obj(doc.source);
  const seed = `${sessionRef}|${str(src.sha256) ?? ''}|${str(doc.generated_at) ?? ''}`;
  return `vs_${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

export interface NormaliseContext {
  clubId: string | null;
  teamId: string | null;
  matchId: string | null;
  deviceId: string;
  processingTarget: string;
  importedAt: string;
}

export function normaliseSession(
  artefact: EngineSessionArtefact, ctx: NormaliseContext,
): VisionSession {
  const doc = artefact.document as Doc;
  const stats = obj(doc.stats);
  const src = source(doc, artefact.sessionRef);
  const t = tracks(doc);
  const b = ball(doc, src.fps);
  const cal = calibration(doc);
  const ev = events(artefact.companions as Record<string, Doc>, src.fps, artefact.sessionRef);
  const r = roles(doc);

  const withCoords = t.filter((x) => x.pitchXM !== null && x.pitchYM !== null).length;
  const onPitch = t.filter((x) => x.pitchXM !== null && x.pitchYM !== null
    && x.pitchXM >= -5 && x.pitchXM <= 110 && x.pitchYM >= -5 && x.pitchYM <= 73).length;
  const ballStates = countBy(b, (x) => x.state);
  const observed = ballStates.OBSERVED ?? 0;
  const propagated = ballStates.PROPAGATED ?? 0;

  const summary: VisionSessionSummary = {
    sessionId: sessionIdFor(artefact.sessionRef, doc),
    sessionRef: artefact.sessionRef,
    clubId: ctx.clubId,
    teamId: ctx.teamId,
    matchId: ctx.matchId,
    deviceId: ctx.deviceId,
    processingTarget: ctx.processingTarget,
    schema: artefact.schema,
    pipelineVersion: str(doc.schema),
    generatedAt: str(doc.generated_at),
    importedAt: ctx.importedAt,
    source: src,
    providers: providers(doc),
    models: models(doc),

    framesProcessed: int(stats.frames_processed),
    observationsTotal: int(stats.observations_total, t.length),
    identities: int(stats.identities),
    rawTrackIds: int(stats.raw_track_ids),
    teamAssignmentRate: num(stats.team_assignment_rate),
    observationsWithPitchCoords: withCoords,
    coordsOnPitchRate: withCoords ? Number((onPitch / withCoords).toFixed(4)) : null,

    calibrationCoverage: num(stats.calibration_coverage),
    calibrationMeasuredFrames: int(stats.calibration_measured_frames),
    calibrationPropagatedFrames: int(stats.calibration_propagated_frames),
    anchorsAccepted: cal.filter((c) => c.isAnchor).length,
    anchorDisagreementMedianM: num(stats.anchor_disagreement_median_m),

    ballFrames: b.length,
    ballStates,
    ballObservedCoverage: b.length ? Number((observed / b.length).toFixed(4)) : null,
    calibratedBallFrames: b.filter((x) => x.pitchXM !== null).length,

    eventCounts: countBy(ev, (x) => `${x.type}_${x.state}`),
    confidenceBands: countBy(t, (x) => x.calibrationConfidence),
    processingSeconds: num(stats.processing_seconds),
    processingFps: num(stats.processing_fps),

    guards: {
      speedGuardSpans: num(stats.speed_guard_spans),
      speedGuardSpansWithheld: num(stats.speed_guard_spans_withheld),
      speedGuardFramesWithheld: num(stats.speed_guard_frames_withheld),
      speedGuardP90MsMax: num(stats.speed_guard_p90_ms_max),
      ballPropagatedFrames: propagated,
    },
    capabilities: capabilities({ tracks: t, ball: b, events: ev, roles: r, withCoords }),
  };

  return { summary, tracks: t, ball: b, calibration: cal, events: ev, roles: r };
}

export { originFromChain };
