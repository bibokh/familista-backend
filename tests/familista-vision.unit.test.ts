// FAMILISTA VISION — the module's own promises, pinned
// ─────────────────────────────────────────────────────────────────────────────
// These do not test the computer vision. That was validated across five phases
// and three real clips, and the engine's artefacts are immutable fixtures here.
// These test what the PLATFORM promises about that evidence:
//
//   · that a session read through the platform reports what the engine found,
//     to the number, with nothing rounded, filled or improved;
//   · that a withheld coordinate stays withheld everywhere it travels;
//   · that OBSERVED and PROPAGATED never merge;
//   · that one club cannot see another's session;
//   · that the processing-target seam actually swaps the engine;
//   · that no filesystem path escapes the boundary.

import path from 'node:path';

import {
  LocalServerEngine, VisionHubEngine, configuredTarget, isUnavailable,
  resetVisionEngine, visionEngine,
} from '../src/vision-platform/engine-contract';
import { normaliseSession } from '../src/vision-platform/session-normaliser';
import { buildTimeline } from '../src/vision-platform/session-timeline';
import { evidenceFor } from '../src/vision-platform/vision-intelligence.contract';
import {
  clearSessionCache, listSessionRefs, loadSession,
} from '../src/vision-platform/session-store.service';
import {
  maySeeSession, mayOperateVision, viewerRole, visibleSessions,
} from '../src/vision-platform/vision-access';
import { SOURCE_SLOTS, SOURCE_TYPES, sourceTypeSpec } from '../src/vision-platform/source-types';
import { VISION_EVENTS, registerVisionEvents, visionEventCatalogue } from '../src/vision-platform/vision-events';
import { registerVisionSource } from '../src/vision-platform/vision-source';
import type { VisionSession } from '../src/vision-platform/session-model';

const STORE = path.join(process.cwd(), 'vision-sessions');
const REF = 'original-clip';

/** The measured truth of the fixture, from the validated engine's own report. */
const VALIDATED = {
  frames: 301,
  observations: 4484,
  identities: 38,
  calibrationCoverage: 0.7176,
  measuredFrames: 41,
  propagatedFrames: 175,
  anchors: 41,
  anchorDisagreementM: 1.086,
  withCoords: 4204,
  ballObserved: 132,
  ballPropagated: 11,
  ballUnknown: 12,
  ballNotAvailable: 146,
  calibratedBallFrames: 60,
  proximityConfirmed: 13,
};

beforeAll(() => { process.env.FAMILISTA_VISION_SESSIONS = STORE; resetVisionEngine(); });
beforeEach(() => { clearSessionCache(); });

async function fixture(): Promise<VisionSession> {
  const s = await loadSession(REF);
  if (isUnavailable(s)) throw new Error(`fixture unavailable: ${s.reason}`);
  return s;
}

// ── the engine contract ──────────────────────────────────────────────────────

describe('the processing-target seam', () => {
  afterEach(() => { delete process.env.FAMILISTA_VISION_TARGET; resetVisionEngine(); });

  it('runs on LOCAL_SERVER by default', () => {
    expect(configuredTarget()).toBe('LOCAL_SERVER');
    expect(visionEngine()).toBeInstanceOf(LocalServerEngine);
  });

  it('swaps the whole engine when the target changes', () => {
    process.env.FAMILISTA_VISION_TARGET = 'VISION_HUB';
    resetVisionEngine();
    expect(configuredTarget()).toBe('VISION_HUB');
    expect(visionEngine()).toBeInstanceOf(VisionHubEngine);
  });

  it('refuses rather than simulating a device that does not exist', async () => {
    process.env.FAMILISTA_VISION_TARGET = 'VISION_HUB';
    resetVisionEngine();
    const engine = visionEngine();
    const identity = await engine.identify();
    expect(identity.status).toBe('NOT_IMPLEMENTED');
    expect(identity.reason).toMatch(/not built/i);
    for (const answer of [await engine.listSessions(), await engine.readSession('x'),
      await engine.telemetry()]) {
      expect(isUnavailable(answer)).toBe(true);
      expect((answer as { status: string }).status).toBe('NOT_IMPLEMENTED');
    }
  });

  it('never invents a reading the host does not have', async () => {
    const t = await new LocalServerEngine(STORE, 'test').telemetry();
    // Four things a server genuinely has no sensor for. Each is an explicit
    // absence with a reason, never a zero a dashboard would draw as a value.
    for (const key of ['gpu', 'temperatureCelsius', 'batteryPercent', 'cameraLink'] as const) {
      expect(isUnavailable(t[key])).toBe(true);
      expect((t[key] as { reason: string }).reason.length).toBeGreaterThan(10);
    }
    expect(typeof t.cpuCores).toBe('number');
  });

  it('refuses a session reference that could escape the store', async () => {
    const engine = new LocalServerEngine(STORE, 'test');
    for (const bad of ['../etc', 'a/../../b', '/absolute', '..']) {
      const r = await engine.readSession(bad);
      expect(isUnavailable(r)).toBe(true);
    }
  });
});

// ── the fixture reports what the engine found ────────────────────────────────

describe('a real validated session, read through the platform', () => {
  it('reports the engine’s own numbers, unchanged', async () => {
    const { summary } = await fixture();
    expect(summary.framesProcessed).toBe(VALIDATED.frames);
    expect(summary.observationsTotal).toBe(VALIDATED.observations);
    expect(summary.identities).toBe(VALIDATED.identities);
    expect(summary.calibrationCoverage).toBeCloseTo(VALIDATED.calibrationCoverage, 4);
    expect(summary.calibrationMeasuredFrames).toBe(VALIDATED.measuredFrames);
    expect(summary.calibrationPropagatedFrames).toBe(VALIDATED.propagatedFrames);
    expect(summary.anchorsAccepted).toBe(VALIDATED.anchors);
    expect(summary.anchorDisagreementMedianM).toBeCloseTo(VALIDATED.anchorDisagreementM, 3);
    expect(summary.observationsWithPitchCoords).toBe(VALIDATED.withCoords);
  });

  it('keeps OBSERVED and PROPAGATED as separate counts', async () => {
    const { summary } = await fixture();
    expect(summary.ballStates.OBSERVED).toBe(VALIDATED.ballObserved);
    expect(summary.ballStates.PROPAGATED).toBe(VALIDATED.ballPropagated);
    expect(summary.ballStates.UNKNOWN).toBe(VALIDATED.ballUnknown);
    expect(summary.ballStates.NOT_AVAILABLE).toBe(VALIDATED.ballNotAvailable);
    // The two must never be summed into one "ball tracked" figure.
    expect(summary.ballObservedCoverage).toBeCloseTo(
      VALIDATED.ballObserved / (VALIDATED.ballObserved + VALIDATED.ballPropagated
        + VALIDATED.ballUnknown + VALIDATED.ballNotAvailable), 4);
  });

  it('marks every propagated ball sample as PROPAGATED origin, never MEASURED', async () => {
    const s = await fixture();
    for (const b of s.ball) {
      if (b.state === 'OBSERVED') expect(b.origin).toBe('MEASURED');
      else if (b.state === 'PROPAGATED') expect(b.origin).toBe('PROPAGATED');
      else expect(b.origin).toBe('UNKNOWN');
    }
  });

  it('publishes a pitch coordinate only where calibration produced one', async () => {
    const s = await fixture();
    const withCoords = s.tracks.filter((t) => t.pitchXM !== null);
    expect(withCoords).toHaveLength(VALIDATED.withCoords);
    // The rule that matters: no observation whose calibration chain is `none`
    // may carry a metric position, in any form.
    for (const t of s.tracks) {
      if (t.calibrationChain === 'none') {
        expect(t.pitchXM).toBeNull();
        expect(t.pitchYM).toBeNull();
      }
    }
  });

  it('keeps the engine’s confidence bands rather than re-deriving them', async () => {
    const { summary } = await fixture();
    expect(summary.confidenceBands).toEqual({
      HIGH: 1781, MEDIUM: 2193, LOW: 230, NONE: 280,
    });
  });

  it('carries the events the engine confirmed and invents none', async () => {
    const s = await fixture();
    expect(s.summary.eventCounts.PROXIMITY_CONFIRMED).toBe(VALIDATED.proximityConfirmed);
    // No CONTROL in this clip. The absence must be an absence, not a zero
    // invented to fill a card.
    expect(s.summary.eventCounts.CONTROL_CONFIRMED).toBeUndefined();
  });

  it('carries model provenance with a checksum and a licence verdict', async () => {
    const { summary } = await fixture();
    expect(summary.models.length).toBeGreaterThan(0);
    const yolo = summary.models.find((m) => m.modelId === 'ultralytics_yolo11m_coco');
    expect(yolo).toBeDefined();
    expect(yolo!.commercialUse).toBe('RESTRICTED');
    expect(yolo!.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    const pitch = summary.models.find((m) => m.modelId === 'pnlcalib_sv_kp_hrnetv2w48');
    expect(pitch!.commercialUse).toBe('UNKNOWN');
  });

  it('never lets a filesystem path cross the boundary', async () => {
    const s = await fixture();
    const serialised = JSON.stringify(s.summary);
    expect(serialised).not.toMatch(/\/home\//);
    expect(serialised).not.toMatch(/\/usr\//);
    expect(s.summary.source.mediaRef).toBe('test_match.mp4');
    expect(s.summary.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── capabilities and the empty states they drive ─────────────────────────────

describe('capabilities decide what a screen may draw', () => {
  it('reports tactical and physical as unavailable, with a reason', async () => {
    const { capabilities } = (await fixture()).summary;
    expect(capabilities.tactical).toBe(false);
    expect(capabilities.physicalMetrics).toBe(false);
    expect(capabilities.reasons.tactical).toMatch(/not implemented/i);
    expect(capabilities.reasons.physicalMetrics).toMatch(/not validated|guard/i);
  });

  it('allows a heatmap only when enough calibrated positions exist', async () => {
    const { capabilities } = (await fixture()).summary;
    expect(capabilities.heatmaps).toBe(true);
    expect(capabilities.metricCoordinates).toBe(true);
  });
});

// ── the intelligence contract ────────────────────────────────────────────────

describe('the evidence interface to Familista Intelligence', () => {
  it('hands over only positions that were actually published', async () => {
    const bundle = evidenceFor(await fixture());
    expect(bundle.metricPositions).toHaveLength(VALIDATED.withCoords);
    for (const p of bundle.metricPositions) {
      expect(typeof p.pitchXM).toBe('number');
      expect(['MEASURED', 'PROPAGATED']).toContain(p.origin);
    }
  });

  it('has no field for a rating, and says so', async () => {
    const bundle = evidenceFor(await fixture());
    const keys = Object.keys(bundle);
    for (const forbidden of ['quality', 'rating', 'ratings', 'vision', 'decisions',
      'composure', 'passing', 'finishing', 'stamina', 'mental']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(bundle.unavailable.playerRatings).toMatch(/not produced/i);
    expect(bundle.unavailable.physicalMetrics).toMatch(/not validated/i);
    expect(bundle.unavailable.tacticalRecommendations).toMatch(/not produced/i);
  });

  it('passes on only CONFIRMED findings', async () => {
    const s = await fixture();
    const bundle = evidenceFor(s);
    expect(bundle.findings.every((f) => f.state === 'CONFIRMED')).toBe(true);
    expect(bundle.findings).toHaveLength(
      s.events.filter((e) => e.state === 'CONFIRMED').length);
  });
});

// ── the timeline draws the gaps ──────────────────────────────────────────────

describe('the session timeline', () => {
  it('marks every accepted anchor and every shot cut', async () => {
    const s = await fixture();
    const tl = buildTimeline(s);
    expect(tl.marks.filter((m) => m.kind === 'CALIBRATION_ANCHOR')).toHaveLength(VALIDATED.anchors);
    expect(tl.frames).toBe(VALIDATED.frames);
  });

  it('draws calibration NONE as its own band rather than as silence', async () => {
    const s = await fixture();
    const tl = buildTimeline(s);
    const none = tl.spans.filter((x) => x.kind === 'CALIBRATION_NONE');
    const noneFrames = s.calibration.filter((c) => c.chain === 'none').length;
    expect(none.reduce((a, x) => a + x.frames, 0)).toBe(noneFrames);
    expect(tl.legend.CALIBRATION_NONE).toMatch(/no pitch coordinate was published/i);
  });

  it('never merges an observed ball span with a propagated one', async () => {
    const tl = buildTimeline(await fixture());
    const kinds = new Set(tl.spans.map((x) => x.kind));
    expect(kinds.has('BALL_OBSERVED')).toBe(true);
    for (const span of tl.spans) {
      expect(span.kind).not.toBe('BALL_TRACKED');
    }
  });
});

// ── access control ───────────────────────────────────────────────────────────

describe('club isolation', () => {
  const owner = { userId: 'u1', clubId: null, role: 'PLATFORM_OWNER', isPlatformOwner: true };
  const alpha = { userId: 'u2', clubId: 'club-alpha', role: 'CLUB_ADMIN', isPlatformOwner: false };
  const beta = { userId: 'u3', clubId: 'club-beta', role: 'CLUB_ADMIN', isPlatformOwner: false };
  const nobody = { userId: 'u4', clubId: null, role: 'PLAYER', isPlatformOwner: false };

  it('gives a platform-scoped session to the owner and to nobody else', () => {
    const session = { clubId: null };
    expect(maySeeSession(owner, session)).toBe(true);
    expect(maySeeSession(alpha, session)).toBe(false);
    expect(maySeeSession(nobody, session)).toBe(false);
  });

  it('never shows one club another club’s session', () => {
    const session = { clubId: 'club-alpha' };
    expect(maySeeSession(alpha, session)).toBe(true);
    expect(maySeeSession(beta, session)).toBe(false);
  });

  it('filters the list on the server rather than trusting the client', () => {
    const all = [{ clubId: 'club-alpha' }, { clubId: 'club-beta' }, { clubId: null }];
    expect(visibleSessions(alpha, all)).toEqual([{ clubId: 'club-alpha' }]);
    expect(visibleSessions(beta, all)).toEqual([{ clubId: 'club-beta' }]);
    expect(visibleSessions(owner, all)).toHaveLength(3);
    expect(visibleSessions(nobody, all)).toHaveLength(0);
  });

  it('reserves operational control for the platform owner', () => {
    expect(mayOperateVision(owner)).toBe(true);
    expect(mayOperateVision(alpha)).toBe(false);
    expect(viewerRole(alpha)).toBe('CLUB');
    expect(viewerRole(nobody)).toBe('NONE');
  });

  it('defaults an unowned session to the narrow answer', async () => {
    // The fixture declares no club, so only the owner reaches it. A default of
    // "everybody" would be how one club's footage reaches another club's screen.
    const { summary } = await fixture();
    expect(summary.clubId).toBeNull();
    expect(maySeeSession(alpha, summary)).toBe(false);
    expect(maySeeSession(owner, summary)).toBe(true);
  });
});

// ── the registries ───────────────────────────────────────────────────────────

describe('registration on the platform’s own registries', () => {
  it('registers Vision as a Fabric source rather than describing it on a screen', () => {
    const spec = registerVisionSource();
    expect(spec.id).toBe('vision');
    expect(spec.eventDomains).toContain('vision');
    // Idempotent: a route, a worker and a test may all import this.
    expect(registerVisionSource().id).toBe('vision');
  });

  it('registers every Vision event type on the Fabric', () => {
    const specs = registerVisionEvents();
    expect(specs.length).toBe(visionEventCatalogue().length);
    expect(specs.map((s) => s.type)).toContain(VISION_EVENTS.CALIBRATION_NONE);
    expect(registerVisionEvents().length).toBe(specs.length);
  });

  it('withholds the per-observation names from the live board but keeps them durable', () => {
    const catalogue = visionEventCatalogue();
    const perObservation = catalogue.filter((c) => [
      VISION_EVENTS.PLAYER_TRACK_OBSERVED, VISION_EVENTS.BALL_OBSERVED,
      VISION_EVENTS.BALL_PROPAGATED,
    ].includes(c.type as never));
    expect(perObservation).toHaveLength(3);
    for (const c of perObservation) expect(c.live).toBe(false);
    // Everything else is drawable.
    for (const c of catalogue) {
      if (!perObservation.includes(c)) expect(c.live).toBe(true);
    }
  });

  it('gives proximity and control different names, because they are different claims', () => {
    expect(VISION_EVENTS.EVENT_PROXIMITY).not.toBe(VISION_EVENTS.EVENT_CONTROL);
    const catalogue = visionEventCatalogue();
    const prox = catalogue.find((c) => c.type === VISION_EVENTS.EVENT_PROXIMITY);
    expect(prox!.describes).toMatch(/proximity is not possession/i);
  });
});

// ── the source vocabulary ────────────────────────────────────────────────────

describe('source types', () => {
  it('implements exactly one type and declares the rest as unbuilt', () => {
    const implemented = SOURCE_TYPES.filter((t) => t.implemented);
    expect(implemented.map((t) => t.type)).toEqual(['VIDEO_FILE']);
    for (const t of SOURCE_TYPES) {
      if (!t.implemented) expect(t.waitingOn).not.toBe('NOTHING');
    }
  });

  it('treats a camera brand as metadata and not as a code path', () => {
    const sony = sourceTypeSpec('SONY_CAMERA');
    expect(sony!.implemented).toBe(false);
    expect(sony!.describes).toMatch(/no Sony-specific code path/i);
  });

  it('declares the future rig slots as empty', () => {
    expect(SOURCE_SLOTS.length).toBeGreaterThanOrEqual(9);
    for (const slot of SOURCE_SLOTS) expect(slot.filled).toBe(false);
  });
});

// ── the store ────────────────────────────────────────────────────────────────

describe('the session store', () => {
  it('lists the imported sessions', async () => {
    const refs = await listSessionRefs();
    expect(isUnavailable(refs)).toBe(false);
    expect(refs).toContain(REF);
  });

  it('answers an unknown session with an absence rather than an empty session', async () => {
    const s = await loadSession('no-such-session');
    expect(isUnavailable(s)).toBe(true);
    expect((s as { status: string }).status).toBe('NOT_AVAILABLE');
  });

  it('normalises the same artefact to the same session id', async () => {
    const a = await fixture();
    clearSessionCache();
    const b = await fixture();
    expect(a.summary.sessionId).toBe(b.summary.sessionId);
  });
});
