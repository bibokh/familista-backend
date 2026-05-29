// Familista — Video Transcode Worker (Phase S.1)
// Target: src/workers/video-transcode.worker.ts
// ─────────────────────────────────────────────────────────────────────────────
// Polls VideoTranscodeJob(QUEUED), claims one job, downloads the raw video
// from S3, runs FFmpeg HLS generation via video-hls.service, uploads the
// resulting segments, then calls handleTranscodeCallback to mark the asset READY.
//
// Design:
//   • Single-job-per-tick — limits CPU/disk usage on shared hosting.
//   • Optimistic locking — updateMany with status=QUEUED guard prevents
//     duplicate processing on multi-instance deployments.
//   • MAX_RETRIES=2 — on permanent failure asset is marked FAILED with reason.
//
// Env vars:
//   VIDEO_WORKER_INTERVAL_MS  (default: 15000 — 15 s)
//   VIDEO_WORKER_DISABLED     set to 'true' to skip start (useful in tests)

import { prisma }               from '../config/database';
import { transcodeToHls }       from '../services/video-hls.service';
import { handleTranscodeCallback } from '../video/video-asset.service';

const POLL_INTERVAL = parseInt(process.env.VIDEO_WORKER_INTERVAL_MS ?? '15000', 10);
const MAX_RETRIES   = 2;
const WORKER_ID     = `vt-${process.pid}-${Date.now()}`;

let _running = false;
let _timer:   NodeJS.Timeout | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

export function startVideoTranscodeWorker(): void {
  if (_running) return;
  if (process.env.VIDEO_WORKER_DISABLED === 'true') {
    _log('disabled via VIDEO_WORKER_DISABLED — skipping start');
    return;
  }
  _running = true;
  _log(`started (interval=${POLL_INTERVAL}ms, worker=${WORKER_ID})`);
  _schedule();
}

export function stopVideoTranscodeWorker(): void {
  _running = false;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  _log('stopped');
}

// ─── Main tick ────────────────────────────────────────────────────────────────

async function _tick(): Promise<void> {
  try {
    // Find the next queued job ordered by priority (asc) then age (asc).
    const job = await prisma.videoTranscodeJob.findFirst({
      where: {
        status:     'QUEUED',
        retryCount: { lt: MAX_RETRIES },
      },
      orderBy: [
        { priority: 'asc'  },
        { queuedAt: 'asc'  },
      ],
    });

    if (!job) return;

    // Atomically claim the job — guards against concurrent workers.
    const claimed = await prisma.videoTranscodeJob.updateMany({
      where: { id: job.id, status: 'QUEUED' },
      data:  {
        status:    'RUNNING',
        workerRef: WORKER_ID,
        startedAt: new Date(),
      },
    });

    // Another worker claimed it between findFirst and updateMany.
    if (claimed.count === 0) return;

    _log(`claimed job ${job.id} for asset ${job.assetId}`);
    await _processJob(job.id, job.assetId, job.clubId, job.retryCount);
  } catch (err) {
    _log(`tick error: ${(err as Error).message}`);
  } finally {
    if (_running) _schedule();
  }
}

// ─── Job processing ───────────────────────────────────────────────────────────

async function _processJob(
  jobId:      string,
  assetId:    string,
  clubId:     string,
  retryCount: number,
): Promise<void> {
  // Fetch raw storage key from asset record.
  const asset = await prisma.videoAsset.findUnique({
    where:  { id: assetId },
    select: { rawStorageKey: true },
  });

  if (!asset?.rawStorageKey) {
    const reason = 'Asset has no rawStorageKey — upload may not have completed';
    await _failJob(jobId, reason);
    await handleTranscodeCallback({ assetId, errorMessage: reason }).catch(() => {});
    return;
  }

  try {
    _log(`transcoding asset ${assetId} (${asset.rawStorageKey})`);

    const result = await transcodeToHls(asset.rawStorageKey, assetId, clubId);

    // Mark asset READY + persist HLS keys.
    await handleTranscodeCallback({
      assetId,
      hlsManifestKey:  result.hlsManifestKey,
      thumbStorageKey: result.thumbStorageKey,
      durationSec:     result.durationSec,
      widthPx:         result.widthPx,
      heightPx:        result.heightPx,
    });

    // Mark job DONE.
    await prisma.videoTranscodeJob.update({
      where: { id: jobId },
      data:  { status: 'DONE', completedAt: new Date() },
    });

    _log(
      `job ${jobId} done — ` +
      `${result.durationSec}s, ${result.widthPx}×${result.heightPx}, ` +
      `${result.segmentCount} segments`,
    );
  } catch (err) {
    const msg      = (err as Error).message;
    const nextRetry = retryCount + 1;
    _log(`job ${jobId} failed (attempt ${nextRetry}/${MAX_RETRIES}): ${msg}`);

    if (nextRetry >= MAX_RETRIES) {
      // Permanent failure — update both job and asset.
      await _failJob(jobId, msg);
      await handleTranscodeCallback({ assetId, errorMessage: msg }).catch(() => {});
    } else {
      // Re-queue for retry — reset to QUEUED so the next tick picks it up.
      await prisma.videoTranscodeJob.update({
        where: { id: jobId },
        data:  {
          status:     'QUEUED',
          retryCount: nextRetry,
          workerRef:  null,
          startedAt:  null,
          errorMsg:   msg,
        },
      });
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _failJob(jobId: string, reason: string): Promise<void> {
  await prisma.videoTranscodeJob.update({
    where: { id: jobId },
    data:  { status: 'FAILED', errorMsg: reason, completedAt: new Date() },
  }).catch(() => {});
}

function _schedule(): void {
  _timer = setTimeout(() => { _tick(); }, POLL_INTERVAL);
}

function _log(msg: string): void {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), worker: 'video-transcode', msg }),
  );
}
