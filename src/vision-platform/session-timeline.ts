// FAMILISTA VISION — the session as a strip of time, with the gaps drawn
// ─────────────────────────────────────────────────────────────────────────────
// THE GAPS ARE THE POINT
//
// A timeline that only draws what happened is a timeline that hides what did
// not. This one draws calibration NONE spans as their own band, ball gaps as
// their own band and shot cuts as their own marks, because "the system saw
// nothing here" is an operational fact a reader needs at a glance — it is the
// difference between a quiet passage of play and a passage the engine could not
// analyse.
//
// Every band is built from the session's own rows. Nothing is smoothed, nothing
// is filled in across a gap, and a one-frame span is drawn as a one-frame span
// rather than being rounded up into something visible.

import type { VisionSession } from './session-model';

export type BandKind =
  | 'CALIBRATION_VALID' | 'CALIBRATION_PROPAGATED' | 'CALIBRATION_NONE'
  | 'BALL_OBSERVED' | 'BALL_PROPAGATED' | 'BALL_GAP';

export interface TimelineSpan {
  kind: BandKind;
  fromFrame: number;
  toFrame: number;
  fromTime: number;
  toTime: number;
  frames: number;
  detail?: string;
}

export interface TimelineMark {
  kind: 'SHOT_BOUNDARY' | 'CALIBRATION_ANCHOR' | 'EVENT';
  frame: number;
  time: number;
  label: string;
  detail?: string;
  eventId?: string;
}

export interface SessionTimeline {
  frames: number;
  durationSeconds: number;
  spans: TimelineSpan[];
  marks: TimelineMark[];
  legend: Record<string, string>;
}

function runs<T>(
  items: T[], frameOf: (t: T) => number, timeOf: (t: T) => number,
  classify: (t: T) => BandKind | null,
): TimelineSpan[] {
  const out: TimelineSpan[] = [];
  let current: TimelineSpan | null = null;
  for (const item of items) {
    const kind = classify(item);
    const frame = frameOf(item);
    const time = timeOf(item);
    if (kind === null) { current = null; continue; }
    if (current && current.kind === kind && frame === current.toFrame + 1) {
      current.toFrame = frame;
      current.toTime = time;
      current.frames += 1;
      continue;
    }
    current = { kind, fromFrame: frame, toFrame: frame, fromTime: time, toTime: time, frames: 1 };
    out.push(current);
  }
  return out;
}

export function buildTimeline(session: VisionSession): SessionTimeline {
  const fps = session.summary.source.fps;
  const timeFor = (frame: number) => (fps ? Number((frame / fps).toFixed(3)) : 0);

  const calibration = runs(
    session.calibration,
    (c) => c.frameNumber,
    (c) => timeFor(c.frameNumber),
    (c) => (c.chain === 'measured' ? 'CALIBRATION_VALID'
      : c.chain === 'propagated' ? 'CALIBRATION_PROPAGATED' : 'CALIBRATION_NONE'),
  );

  const ball = runs(
    session.ball,
    (b) => b.frameNumber,
    (b) => b.timestamp,
    (b) => (b.state === 'OBSERVED' ? 'BALL_OBSERVED'
      : b.state === 'PROPAGATED' ? 'BALL_PROPAGATED' : 'BALL_GAP'),
  );

  const marks: TimelineMark[] = [];
  for (const c of session.calibration) {
    if (!c.isAnchor) continue;
    marks.push({
      kind: 'CALIBRATION_ANCHOR',
      frame: c.frameNumber,
      time: timeFor(c.frameNumber),
      label: `Anchor · ${c.confidence}`,
      detail: c.expectedErrorM === null ? 'no expected error published'
        : `expected error ${c.expectedErrorM.toFixed(3)} m`,
    });
  }

  // Shot boundaries, read from the engine's own shot ids rather than guessed
  // from motion: the frame where the id changes IS the cut the engine detected.
  let lastShot: number | null = null;
  for (const t of session.tracks) {
    if (t.shotId === null || t.shotId === lastShot) continue;
    if (lastShot !== null) {
      marks.push({
        kind: 'SHOT_BOUNDARY',
        frame: t.frameNumber,
        time: t.timestamp,
        label: `Shot ${t.shotId}`,
        detail: 'camera cut; the calibration chain resets here',
      });
    }
    lastShot = t.shotId;
  }

  for (const e of session.events) {
    marks.push({
      kind: 'EVENT',
      frame: e.frameNumber,
      time: e.timestamp,
      label: `${e.type} · ${e.state}`,
      detail: e.reason ?? undefined,
      eventId: e.eventId,
    });
  }
  marks.sort((a, b) => a.frame - b.frame);

  return {
    frames: session.summary.framesProcessed,
    durationSeconds: fps ? Number((session.summary.framesProcessed / fps).toFixed(2)) : 0,
    spans: [...calibration, ...ball],
    marks,
    legend: {
      CALIBRATION_VALID: 'a fresh anchor solved the ground plane on this frame',
      CALIBRATION_PROPAGATED: 'the anchor was carried here through measured camera motion',
      CALIBRATION_NONE: 'no metric calibration; no pitch coordinate was published',
      BALL_OBSERVED: 'the ball was directly detected',
      BALL_PROPAGATED: 'a ball position was carried, not observed',
      BALL_GAP: 'the ball was not located; nothing was assumed',
      SHOT_BOUNDARY: 'a camera cut, where the calibration chain resets',
      CALIBRATION_ANCHOR: 'an accepted anchor, with its expected metric error',
      EVENT: 'a football finding the engine confirmed',
    },
  };
}
