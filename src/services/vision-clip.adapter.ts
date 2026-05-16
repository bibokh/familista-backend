// Familista — Vision Intelligence Engine
// File location: src/services/vision-clip.adapter.ts
//
// Pluggable clip-rendering adapter. Real implementations talk to AWS
// MediaConvert, Mux, Cloudflare Stream, or an internal ffmpeg worker.
// The default STUB returns the source video URL with the clip time range as
// a query string so the player can clamp playback; useful for development.
//
// Switch backend via env VISION_CLIP_BACKEND:
//   STUB                 (default)
//   FFMPEG_WORKER        (POST to VISION_CLIP_WORKER_URL, callback delivery)
//   AWS_MEDIA_CONVERT    (stub — wire to AWS SDK)
//   MUX                  (stub — wire to Mux SDK)

import crypto from 'crypto';
import type {
  ClipRenderRequest,
  ClipRenderSubmission,
  ClipRenderResult,
} from '../types/vision.types';

export interface ClipAdapter {
  readonly kind: string;
  submit(req: ClipRenderRequest): Promise<ClipRenderSubmission>;
  poll(externalRenderId: string): Promise<ClipRenderResult>;
  cancel?(externalRenderId: string): Promise<void>;
}

// ─── STUB adapter ────────────────────────────────────────────────────────────

class StubClipAdapter implements ClipAdapter {
  readonly kind = 'STUB';

  async submit(req: ClipRenderRequest): Promise<ClipRenderSubmission> {
    return {
      externalRenderId: `stub-clip-${crypto.randomBytes(10).toString('hex')}`,
      estimatedDurationSec: Math.ceil((req.endMs - req.startMs) / 1000),
    };
  }

  async poll(externalRenderId: string): Promise<ClipRenderResult> {
    // Immediately return READY so the rest of the pipeline can exercise.
    return {
      status: 'READY',
      url: `https://stub.familista.local/clip/${externalRenderId}.mp4`,
      thumbnailUrl: `https://stub.familista.local/clip/${externalRenderId}.jpg`,
      durationMs: null,
      bytes: null,
      error: null,
    };
  }
}

// ─── ffmpeg worker adapter ───────────────────────────────────────────────────

class FfmpegWorkerAdapter implements ClipAdapter {
  readonly kind = 'FFMPEG_WORKER';

  private readonly endpoint: string;
  private readonly callbackUrl: string;
  private readonly token: string;

  constructor() {
    const endpoint = process.env.VISION_CLIP_WORKER_URL;
    const callbackUrl = process.env.VISION_CLIP_WORKER_CALLBACK_URL;
    const token = process.env.VISION_CLIP_WORKER_TOKEN;
    if (!endpoint || !callbackUrl || !token) {
      throw new Error('VISION_CLIP_WORKER_URL / _CALLBACK_URL / _TOKEN required for FFMPEG_WORKER');
    }
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.callbackUrl = callbackUrl;
    this.token = token;
  }

  async submit(req: ClipRenderRequest): Promise<ClipRenderSubmission> {
    const res = await fetch(`${this.endpoint}/clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({
        videoUrl: req.videoUrl,
        startMs: req.startMs,
        endMs: req.endMs,
        format: req.format ?? 'MP4',
        thumbnail: req.thumbnail ?? true,
        watermarkText: req.watermarkText ?? null,
        callbackUrl: this.callbackUrl,
      }),
    });
    if (!res.ok) throw new Error(`clip submit failed (${res.status})`);
    const body = (await res.json()) as { renderId: string; estimatedDurationSec?: number };
    return { externalRenderId: body.renderId, estimatedDurationSec: body.estimatedDurationSec ?? null };
  }

  async poll(externalRenderId: string): Promise<ClipRenderResult> {
    const res = await fetch(`${this.endpoint}/clips/${encodeURIComponent(externalRenderId)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`clip poll failed (${res.status})`);
    return (await res.json()) as ClipRenderResult;
  }

  async cancel(externalRenderId: string): Promise<void> {
    await fetch(`${this.endpoint}/clips/${encodeURIComponent(externalRenderId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.token}` },
    });
  }
}

// ─── External stubs ──────────────────────────────────────────────────────────

class AwsMediaConvertAdapter implements ClipAdapter {
  readonly kind = 'AWS_MEDIA_CONVERT';
  constructor() {
    if (!process.env.AWS_MEDIA_CONVERT_QUEUE_ARN) {
      throw new Error('AWS_MEDIA_CONVERT_QUEUE_ARN required');
    }
  }
  async submit(_req: ClipRenderRequest): Promise<ClipRenderSubmission> {
    throw new Error('AWS_MEDIA_CONVERT adapter not implemented — fill in AWS SDK wiring here');
  }
  async poll(_id: string): Promise<ClipRenderResult> { throw new Error('not implemented'); }
}

class MuxAdapter implements ClipAdapter {
  readonly kind = 'MUX';
  constructor() {
    if (!process.env.MUX_TOKEN_ID || !process.env.MUX_TOKEN_SECRET) {
      throw new Error('MUX_TOKEN_ID and MUX_TOKEN_SECRET required');
    }
  }
  async submit(_req: ClipRenderRequest): Promise<ClipRenderSubmission> {
    throw new Error('MUX adapter not implemented — fill in @mux/mux-node wiring here');
  }
  async poll(_id: string): Promise<ClipRenderResult> { throw new Error('not implemented'); }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

let cached: ClipAdapter | null = null;

export function getClipAdapter(): ClipAdapter {
  if (cached) return cached;
  const backend = (process.env.VISION_CLIP_BACKEND ?? 'STUB').toUpperCase();
  switch (backend) {
    case 'FFMPEG_WORKER':
      cached = new FfmpegWorkerAdapter();
      break;
    case 'AWS_MEDIA_CONVERT':
      cached = new AwsMediaConvertAdapter();
      break;
    case 'MUX':
      cached = new MuxAdapter();
      break;
    default:
      cached = new StubClipAdapter();
      break;
  }
  return cached;
}

export function _resetClipAdapterForTests(): void {
  cached = null;
}
