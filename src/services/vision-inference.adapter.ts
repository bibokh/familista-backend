// Familista — Vision Intelligence Engine
// File location: src/services/vision-inference.adapter.ts
//
// Pluggable CV-inference adapter. Real computer vision runs on GPU services:
//   • Stats Perform Opta CV
//   • Hudl Studio / Hudl Cloud Compute
//   • Second Spectrum Pulse
//   • An internal YOLOv8 + ByteTrack worker (Triton / Replicate / Modal)
//
// This adapter abstracts those: the orchestrator calls `submitVideo()` to
// queue a job, polls `pollStatus()`, then ingests final tracks + events via
// `fetchResults()`. The default STUB queues the job and returns immediately,
// letting the rest of the pipeline run end-to-end against synthetic / manual
// inputs while a real GPU provider is being wired.
//
// Switch backend via env VISION_INFERENCE_BACKEND:
//   STUB              (default — for development + e2e tests)
//   INTERNAL_WORKER   (POST to VISION_WORKER_URL; webhook delivers results)
//   STATS_PERFORM     (stub — wire to Opta API)
//   HUDL              (stub — wire to Hudl Cloud Compute API)
//   SECOND_SPECTRUM   (stub — wire to Pulse API)

import crypto from 'crypto';
import type {
  InferenceSubmission,
  InferenceSubmissionResult,
  InferenceStatus,
  InferenceResults,
} from '../types/vision.types';

export interface InferenceAdapter {
  readonly kind: string;
  submitVideo(req: InferenceSubmission): Promise<InferenceSubmissionResult>;
  pollStatus(externalJobId: string): Promise<InferenceStatus>;
  fetchResults(externalJobId: string): Promise<InferenceResults | null>;
  cancel?(externalJobId: string): Promise<void>;
}

// ─── STUB adapter ────────────────────────────────────────────────────────────
//
// Returns synthetic submission identifiers and reports QUEUED forever. The
// orchestrator can still write the AnalysisRun and let an operator deliver
// results manually via the inference-results webhook for development.

class StubAdapter implements InferenceAdapter {
  readonly kind = 'STUB';

  async submitVideo(req: InferenceSubmission): Promise<InferenceSubmissionResult> {
    return {
      externalJobId: `stub-${crypto.randomBytes(12).toString('hex')}`,
      estimatedDurationSec: req.durationMs ? Math.ceil(req.durationMs / 1000) : null,
    };
  }

  async pollStatus(_externalJobId: string): Promise<InferenceStatus> {
    return { stage: 'UPLOADED', status: 'QUEUED', progress: 0, error: null };
  }

  async fetchResults(_externalJobId: string): Promise<InferenceResults | null> {
    return null;
  }

  async cancel(_externalJobId: string): Promise<void> {
    return;
  }
}

// ─── Internal worker adapter ─────────────────────────────────────────────────
//
// POSTs the job to a managed worker (Replicate / Modal / internal Triton).
// The worker is responsible for calling our webhook with InferenceResults
// when complete. We keep this thin so any GPU runtime can plug in.

class InternalWorkerAdapter implements InferenceAdapter {
  readonly kind = 'INTERNAL_WORKER';

  private readonly endpoint: string;
  private readonly callbackUrl: string;
  private readonly authToken: string;

  constructor() {
    const endpoint = process.env.VISION_WORKER_URL;
    const callbackUrl = process.env.VISION_WORKER_CALLBACK_URL;
    const token = process.env.VISION_WORKER_TOKEN;
    if (!endpoint) throw new Error('VISION_WORKER_URL not configured');
    if (!callbackUrl) throw new Error('VISION_WORKER_CALLBACK_URL not configured');
    if (!token) throw new Error('VISION_WORKER_TOKEN not configured');
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.callbackUrl = callbackUrl;
    this.authToken = token;
  }

  async submitVideo(req: InferenceSubmission): Promise<InferenceSubmissionResult> {
    const res = await fetch(`${this.endpoint}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.authToken}` },
      body: JSON.stringify({
        videoAssetId: req.videoAssetId,
        videoUrl: req.videoUrl,
        matchId: req.matchId ?? null,
        trainingSessionId: req.trainingSessionId ?? null,
        fps: req.fps ?? null,
        durationMs: req.durationMs ?? null,
        callbackUrl: this.callbackUrl,
        metadata: req.metadata ?? null,
      }),
    });
    if (!res.ok) throw new Error(`worker submit failed (${res.status})`);
    const body = (await res.json()) as { jobId: string; estimatedDurationSec?: number };
    return { externalJobId: body.jobId, estimatedDurationSec: body.estimatedDurationSec ?? null };
  }

  async pollStatus(externalJobId: string): Promise<InferenceStatus> {
    const res = await fetch(`${this.endpoint}/jobs/${encodeURIComponent(externalJobId)}`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    });
    if (!res.ok) throw new Error(`worker poll failed (${res.status})`);
    const body = (await res.json()) as InferenceStatus;
    return body;
  }

  async fetchResults(externalJobId: string): Promise<InferenceResults | null> {
    const res = await fetch(`${this.endpoint}/jobs/${encodeURIComponent(externalJobId)}/results`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`worker fetch results failed (${res.status})`);
    return (await res.json()) as InferenceResults;
  }

  async cancel(externalJobId: string): Promise<void> {
    await fetch(`${this.endpoint}/jobs/${encodeURIComponent(externalJobId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.authToken}` },
    });
  }
}

// ─── External provider stubs ─────────────────────────────────────────────────
//
// These throw on construction unless the wiring is filled in. Keeping them
// explicit makes the integration surface obvious — switching VISION_INFERENCE_BACKEND
// to one of these names without finishing the wiring fails fast at startup.

class StatsPerformAdapter implements InferenceAdapter {
  readonly kind = 'STATS_PERFORM';
  constructor() {
    if (!process.env.STATS_PERFORM_API_KEY) {
      throw new Error('STATS_PERFORM_API_KEY required for STATS_PERFORM backend');
    }
  }
  async submitVideo(_req: InferenceSubmission): Promise<InferenceSubmissionResult> {
    throw new Error('STATS_PERFORM adapter not implemented — fill in Opta API wiring here');
  }
  async pollStatus(_id: string): Promise<InferenceStatus> { throw new Error('not implemented'); }
  async fetchResults(_id: string): Promise<InferenceResults | null> { throw new Error('not implemented'); }
}

class HudlAdapter implements InferenceAdapter {
  readonly kind = 'HUDL';
  constructor() {
    if (!process.env.HUDL_API_KEY) {
      throw new Error('HUDL_API_KEY required for HUDL backend');
    }
  }
  async submitVideo(_req: InferenceSubmission): Promise<InferenceSubmissionResult> {
    throw new Error('HUDL adapter not implemented — fill in Hudl Cloud Compute API wiring here');
  }
  async pollStatus(_id: string): Promise<InferenceStatus> { throw new Error('not implemented'); }
  async fetchResults(_id: string): Promise<InferenceResults | null> { throw new Error('not implemented'); }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

let cached: InferenceAdapter | null = null;

export function getInferenceAdapter(): InferenceAdapter {
  if (cached) return cached;
  const backend = (process.env.VISION_INFERENCE_BACKEND ?? 'STUB').toUpperCase();
  switch (backend) {
    case 'INTERNAL_WORKER':
      cached = new InternalWorkerAdapter();
      break;
    case 'STATS_PERFORM':
      cached = new StatsPerformAdapter();
      break;
    case 'HUDL':
      cached = new HudlAdapter();
      break;
    case 'SECOND_SPECTRUM':
      throw new Error('SECOND_SPECTRUM adapter not implemented — see vision-inference.adapter.ts');
    default:
      cached = new StubAdapter();
      break;
  }
  return cached;
}

export function _resetInferenceAdapterForTests(): void {
  cached = null;
}
