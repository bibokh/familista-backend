// Familista — Triangulation primitives (Phase G)
// ─────────────────────────────────────────────────────────────────────────
// Pure functions. No DB, no I/O.
//
// Use cases:
//   1. The edge node already gave us 3D world coords → just average across
//      cameras weighted by confidence (multi-view consensus).
//   2. The edge node only gave us 2D image coords → project through the
//      camera's calibration to a world ray, then intersect rays from N
//      cameras (least-squares).
//
// This file ships (1) — the consensus path — production-grade. Path (2)
// is provided as a deterministic stub that linearly maps normalised image
// coords to pitch metres using a homography. Real implementations should
// swap the stub for OpenCV-grade math on the edge node and ship case (1)
// to the backend.

import type { CameraDetection, UniversalPlayerState } from '../spatial/types';

export interface CameraView {
  cameraId:   string;
  /** Active calibration version that produced these detections. */
  version:    number;
  /** Optional homography (3×3) for 2D→2D pitch mapping, row-major. */
  homography?: number[];
  detections:  CameraDetection[];
}

export interface TriangulationOptions {
  /** Minimum confidence to admit a single-camera detection into the consensus. */
  minConfidence?: number;
  /** Maximum metres a detection can deviate from the multi-view centroid. */
  outlierGateM?:  number;
}

export interface TriangulatedPlayer {
  playerId:   string;
  x:          number;
  y:          number;
  z?:         number;
  confidence: number;
  /** How many camera views agreed on this player within the outlier gate. */
  votes:      number;
}

/**
 * Combine 2D/3D detections from N camera views into a single per-player
 * position. The strategy is intentionally simple + deterministic:
 *
 *   1. Group detections by `playerId` (skip unbound detections).
 *   2. Filter low-confidence detections.
 *   3. If 3D world coords are present, take a confidence-weighted average.
 *   4. Otherwise project via per-view homography to pitch metres, then
 *      average.
 *   5. Drop detections more than `outlierGateM` metres from the centroid
 *      and re-average if any survived.
 */
export function triangulate(
  views: CameraView[],
  opts: TriangulationOptions = {},
): TriangulatedPlayer[] {
  const minConf  = opts.minConfidence ?? 0.4;
  const gateM    = opts.outlierGateM ?? 8;

  // Bucket by playerId.
  const buckets: Record<string, Array<{ x: number; y: number; z?: number; w: number }>> = {};
  for (const v of views) {
    for (const d of v.detections) {
      if (!d.playerId)            continue;
      if (d.confidence < minConf) continue;
      let x: number, y: number, z: number | undefined;
      if (typeof d.worldX === 'number' && typeof d.worldY === 'number') {
        x = d.worldX; y = d.worldY; z = d.worldZ;
      } else if (v.homography && v.homography.length === 9) {
        const m = applyHomography(v.homography, d.x, d.y);
        x = m.x; y = m.y; z = 0;
      } else {
        // Fallback: pretend the detection IS pitch coords. Edge node
        // should always provide either worldX/Y or homography.
        x = d.x; y = d.y; z = 0;
      }
      const arr = buckets[d.playerId] ?? (buckets[d.playerId] = []);
      arr.push({ x, y, z, w: d.confidence });
    }
  }

  // Weighted-average centroid per bucket, with outlier rejection.
  const out: TriangulatedPlayer[] = [];
  for (const [playerId, points] of Object.entries(buckets)) {
    if (points.length === 0) continue;
    const c1 = weightedCentroid(points);
    const inliers = points.filter((p) => euclidean(p, c1) <= gateM);
    const c = inliers.length > 0 ? weightedCentroid(inliers) : c1;
    out.push({
      playerId,
      x:          Number(c.x.toFixed(3)),
      y:          Number(c.y.toFixed(3)),
      z:          Number((c.z ?? 0).toFixed(3)),
      confidence: Number((inliers.reduce((s, p) => s + p.w, 0) / inliers.length).toFixed(3)),
      votes:      inliers.length,
    });
  }
  return out;
}

/** Project a TriangulatedPlayer into a UniversalPlayerState shell. */
export function asPlayerState(t: TriangulatedPlayer, side: string): UniversalPlayerState {
  return {
    playerId:   t.playerId,
    side,
    number:     null,
    name:       null,
    role:       null,
    x:          t.x,
    y:          t.y,
    z:          t.z ?? 0,
    sources:    ['VISION'],
    confidence: t.confidence,
    alert:      'OK',
    sprint:     0,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Linear algebra helpers (pure)
// ─────────────────────────────────────────────────────────────────────────

function weightedCentroid(pts: Array<{ x: number; y: number; z?: number; w: number }>) {
  let sx = 0, sy = 0, sz = 0, sw = 0;
  for (const p of pts) { sx += p.x * p.w; sy += p.y * p.w; sz += (p.z ?? 0) * p.w; sw += p.w; }
  if (sw === 0) return { x: 0, y: 0, z: 0 };
  return { x: sx / sw, y: sy / sw, z: sz / sw };
}

function euclidean(a: { x: number; y: number; z?: number }, b: { x: number; y: number; z?: number }) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Apply a row-major 3×3 homography to a 2D point (image pixels → pitch metres). */
function applyHomography(h: number[], x: number, y: number): { x: number; y: number } {
  const w = h[6] * x + h[7] * y + h[8];
  if (w === 0) return { x: 0, y: 0 };
  return {
    x: (h[0] * x + h[1] * y + h[2]) / w,
    y: (h[3] * x + h[4] * y + h[5]) / w,
  };
}
