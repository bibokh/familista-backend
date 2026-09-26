// FAMILISTA VISION — publishing onto the platform's nervous system
// ─────────────────────────────────────────────────────────────────────────────
// Every Vision fact leaves this module through `publishFabricEvent`, the same
// call the other eleven domains use, into the same outbox, the same durable
// history and the same Data Vault. There is no Vision transport.
//
// THE RULE ABOUT WHAT MAY BE PUBLISHED
//
// An event is a claim the platform will stand behind and a consumer may act on.
// So: nothing is published that the validated engine did not determine. A
// session that found no events publishes no event findings — not a zero-filled
// summary of findings it might have made. A frame where calibration was NONE
// publishes `vision.calibration.none`, which is a real fact, rather than a
// coordinate with a wide error bar attached.
//
// WHY PER-OBSERVATION EVENTS ARE SUMMARISED RATHER THAN STREAMED
//
// A ten-second clip holds four and a half thousand player observations. Each
// one is real, and publishing each one individually would put a session's
// worth of tracking into a transport that other domains share, to say something
// no operator can read at that granularity. So the per-observation names exist
// and are registered — a device streaming live WILL use them — and this
// importer publishes counts instead, with the detail addressable through the
// session API. The events say how many and of what kind; they do not pretend
// there were fewer.

import { publishFabricEvent } from '../fabric/registry/publisher';
import type { VisionSession } from './session-model';
import { VISION_EVENTS, VISION_SOURCE_ID, type VisionEventPayload } from './vision-events';

interface PublishContext {
  actorUserId?: string | null;
  correlationId?: string | null;
}

function payloadFor(session: VisionSession, extra: Partial<VisionEventPayload> = {}): VisionEventPayload {
  const s = session.summary;
  return {
    sessionId: s.sessionId,
    sourceId: s.source.sourceId,
    clubId: s.clubId,
    teamId: s.teamId,
    pipelineVersion: s.pipelineVersion,
    modelIds: s.models.map((m) => m.modelId),
    origin: 'MEASURED',
    ...extra,
  };
}

async function publish(
  session: VisionSession, eventType: string, payload: VisionEventPayload,
  ctx: PublishContext, idempotencySuffix: string,
) {
  const s = session.summary;
  return publishFabricEvent({
    eventType,
    schemaVersion: 1,
    clubId: s.clubId,
    teamId: s.teamId,
    subjectType: 'VISION_SESSION' as never,
    subjectId: s.sessionId,
    sourceType: 'SYSTEM' as never,
    sourceId: VISION_SOURCE_ID,
    actorUserId: ctx.actorUserId ?? null,
    correlationId: ctx.correlationId ?? s.sessionId,
    dataClassification: 'INTERNAL' as never,
    payload,
    // The session id plus what this event is about. Re-importing the same
    // artefact must not produce a second copy of the same fact.
    idempotencyKey: `${s.sessionId}:${idempotencySuffix}`,
    metadata: {
      sessionRef: s.sessionRef,
      processingTarget: s.processingTarget,
      deviceId: s.deviceId,
    },
  });
}

export interface PublishSummary {
  published: string[];
  withheld: Record<string, string>;
}

/**
 * Announce a completed session on the platform transport.
 *
 * Returns what was published AND what was deliberately not, because "no
 * possession transition event" and "possession transitions were not examined"
 * are different facts and an operator reading a quiet lane deserves to know
 * which one they are looking at.
 */
export async function publishSessionCompleted(
  session: VisionSession, ctx: PublishContext = {},
): Promise<PublishSummary> {
  const s = session.summary;
  const published: string[] = [];
  const withheld: Record<string, string> = {};

  await publish(session, VISION_EVENTS.SESSION_CREATED,
    payloadFor(session, { detail: { sourceType: s.source.sourceType, displayName: s.source.displayName } }),
    ctx, 'created');
  published.push(VISION_EVENTS.SESSION_CREATED);

  await publish(session, VISION_EVENTS.SOURCE_CONNECTED,
    payloadFor(session, {
      detail: {
        sourceType: s.source.sourceType,
        qualityBand: s.source.qualityBand,
        width: s.source.width, height: s.source.height, fps: s.source.fps,
      },
    }), ctx, 'source-connected');
  published.push(VISION_EVENTS.SOURCE_CONNECTED);

  await publish(session, VISION_EVENTS.SESSION_STARTED, payloadFor(session), ctx, 'started');
  published.push(VISION_EVENTS.SESSION_STARTED);

  await publish(session, VISION_EVENTS.SESSION_PROCESSING,
    payloadFor(session, {
      detail: {
        framesProcessed: s.framesProcessed,
        processingFps: s.processingFps,
        processingSeconds: s.processingSeconds,
      },
    }), ctx, 'processing');
  published.push(VISION_EVENTS.SESSION_PROCESSING);

  // ── tracking, as a count rather than four thousand events ──
  await publish(session, VISION_EVENTS.PLAYER_TRACK_OBSERVED,
    payloadFor(session, {
      detail: {
        observations: s.observationsTotal,
        identities: s.identities,
        rawTrackIds: s.rawTrackIds,
        teamAssignmentRate: s.teamAssignmentRate,
        withMetricPosition: s.observationsWithPitchCoords,
        note: 'a per-frame count; the observations themselves are addressable '
          + 'through the session API and were not individually streamed',
      },
    }), ctx, 'tracks');
  published.push(VISION_EVENTS.PLAYER_TRACK_OBSERVED);

  // ── ball: observed and propagated are two facts, never one ──
  const observed = s.ballStates.OBSERVED ?? 0;
  const propagated = s.ballStates.PROPAGATED ?? 0;
  if (observed > 0) {
    await publish(session, VISION_EVENTS.BALL_OBSERVED,
      payloadFor(session, {
        origin: 'MEASURED',
        detail: { frames: observed, coverage: s.ballObservedCoverage, calibratedFrames: s.calibratedBallFrames },
      }), ctx, 'ball-observed');
    published.push(VISION_EVENTS.BALL_OBSERVED);
  } else {
    withheld[VISION_EVENTS.BALL_OBSERVED] = 'the ball was never directly detected in this session';
  }
  if (propagated > 0) {
    await publish(session, VISION_EVENTS.BALL_PROPAGATED,
      payloadFor(session, {
        origin: 'PROPAGATED',
        detail: { frames: propagated, note: 'carried through measured camera motion, not observed' },
      }), ctx, 'ball-propagated');
    published.push(VISION_EVENTS.BALL_PROPAGATED);
  } else {
    withheld[VISION_EVENTS.BALL_PROPAGATED] = 'no ball position was propagated in this session';
  }

  // ── calibration: three verdicts, published only where each occurred ──
  const anchors = session.calibration.filter((c) => c.isAnchor);
  if (anchors.length > 0) {
    await publish(session, VISION_EVENTS.CALIBRATION_VALID,
      payloadFor(session, {
        detail: {
          anchors: anchors.length,
          coverage: s.calibrationCoverage,
          measuredFrames: s.calibrationMeasuredFrames,
          propagatedFrames: s.calibrationPropagatedFrames,
          anchorDisagreementMedianM: s.anchorDisagreementMedianM,
          expectedErrorRangeM: [
            Math.min(...anchors.map((a) => a.expectedErrorM ?? Infinity)),
            Math.max(...anchors.map((a) => a.expectedErrorM ?? -Infinity)),
          ],
        },
      }), ctx, 'calibration-valid');
    published.push(VISION_EVENTS.CALIBRATION_VALID);
  } else {
    withheld[VISION_EVENTS.CALIBRATION_VALID] = 'no calibration anchor was accepted in this session';
  }

  const lowBand = session.calibration.filter((c) => c.chain !== 'none' && c.confidence === 'LOW').length;
  if (lowBand > 0) {
    await publish(session, VISION_EVENTS.CALIBRATION_DEGRADED,
      payloadFor(session, { detail: { frames: lowBand, band: 'LOW' } }), ctx, 'calibration-degraded');
    published.push(VISION_EVENTS.CALIBRATION_DEGRADED);
  } else {
    withheld[VISION_EVENTS.CALIBRATION_DEGRADED] = 'no frame held calibration in the LOW band';
  }

  const noneFrames = session.calibration.filter((c) => c.chain === 'none').length;
  if (noneFrames > 0) {
    await publish(session, VISION_EVENTS.CALIBRATION_NONE,
      payloadFor(session, {
        origin: 'UNKNOWN',
        detail: {
          frames: noneFrames,
          note: 'no metric coordinate was published for these frames and none may be inferred',
        },
      }), ctx, 'calibration-none');
    published.push(VISION_EVENTS.CALIBRATION_NONE);
  } else {
    withheld[VISION_EVENTS.CALIBRATION_NONE] = 'every frame carried a calibration';
  }

  // ── football findings, only the kinds this session actually confirmed ──
  const byType = new Map<string, number>();
  for (const e of session.events) {
    if (e.state !== 'CONFIRMED') continue;
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  }
  const eventMap: Record<string, string> = {
    CONTROL: VISION_EVENTS.EVENT_CONTROL,
    PROXIMITY: VISION_EVENTS.EVENT_PROXIMITY,
    POSSESSION_TRANSITION: VISION_EVENTS.EVENT_POSSESSION_TRANSITION,
  };
  for (const [type, name] of Object.entries(eventMap)) {
    const count = byType.get(type) ?? 0;
    if (count === 0) {
      withheld[name] = `the engine confirmed no ${type} in this session`;
      continue;
    }
    await publish(session, name,
      payloadFor(session, {
        detail: {
          confirmed: count,
          note: type === 'PROXIMITY'
            ? 'proximity is not possession; this event asserts distance only'
            : 'confirmed against ball evidence, not from proximity',
        },
      }), ctx, `event-${type.toLowerCase()}`);
    published.push(name);
  }

  await publish(session, VISION_EVENTS.SESSION_COMPLETED,
    payloadFor(session, {
      detail: {
        framesProcessed: s.framesProcessed,
        observationsTotal: s.observationsTotal,
        calibrationCoverage: s.calibrationCoverage,
        ballObservedCoverage: s.ballObservedCoverage,
        eventCounts: s.eventCounts,
        capabilities: s.capabilities,
        guards: s.guards,
      },
    }), ctx, 'completed');
  published.push(VISION_EVENTS.SESSION_COMPLETED);

  return { published, withheld };
}
