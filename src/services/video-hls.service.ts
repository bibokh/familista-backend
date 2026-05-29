// Familista — Video HLS Service (Phase S.1)
// Target: src/services/video-hls.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Wraps fluent-ffmpeg to transcode a raw video file into an HLS stream:
//   1. Download raw video from S3 to a temp directory
//   2. Probe video metadata (duration, dimensions)
//   3. Generate HLS (H.264/AAC, 6-second segments) via FFmpeg
//   4. Extract a 640px thumbnail at t=5s
//   5. Upload all HLS files + thumbnail to S3 in batches
//   6. Clean up temp directory
//
// Called exclusively from VideoTranscodeWorker — not user-facing.
//
// Env vars:
//   VIDEO_S3_REGION, VIDEO_S3_ENDPOINT, VIDEO_S3_ACCESS_KEY_ID,
//   VIDEO_S3_SECRET_ACCESS_KEY, VIDEO_BUCKET, VIDEO_TEMP_DIR

import fs            from 'fs';
import os            from 'os';
import path          from 'path';
import https         from 'https';
import http          from 'http';
import ffmpeg        from 'fluent-ffmpeg';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
}                    from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HlsResult {
  hlsManifestKey:  string;
  thumbStorageKey: string;
  durationSec:     number;
  widthPx:         number;
  heightPx:        number;
  segmentCount:    number;
}

interface VideoMeta {
  durationSec: number;
  width:       number;
  height:      number;
}

// ─── S3 client (singleton) ───────────────────────────────────────────────────

let _s3: S3Client | null = null;

function s3(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      region:      process.env.VIDEO_S3_REGION   ?? 'auto',
      endpoint:    process.env.VIDEO_S3_ENDPOINT ?? undefined,
      credentials: {
        accessKeyId:     process.env.VIDEO_S3_ACCESS_KEY_ID     ?? '',
        secretAccessKey: process.env.VIDEO_S3_SECRET_ACCESS_KEY ?? '',
      },
    });
  }
  return _s3;
}

const BUCKET   = () => process.env.VIDEO_BUCKET    ?? 'familista-video';
const TEMP_DIR = () => process.env.VIDEO_TEMP_DIR  ?? os.tmpdir();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Full transcode pipeline: S3 raw → FFmpeg HLS → S3 segments.
 * Returns HLS + thumbnail storage keys and video metadata.
 */
export async function transcodeToHls(
  rawStorageKey: string,
  assetId:       string,
  clubId:        string,
): Promise<HlsResult> {
  // Create isolated temp directory for this job.
  const tmpDir = await fs.promises.mkdtemp(
    path.join(TEMP_DIR(), `fam-hls-${assetId.slice(0, 8)}-`),
  );

  try {
    // ── Step 1: download raw video ─────────────────────────────────────────
    const ext     = path.extname(rawStorageKey) || '.mp4';
    const rawPath = path.join(tmpDir, `raw${ext}`);
    await _downloadFromS3(rawStorageKey, rawPath);

    // ── Step 2: probe metadata ─────────────────────────────────────────────
    const meta = await _probeVideo(rawPath);

    // ── Step 3: generate HLS ───────────────────────────────────────────────
    const hlsDir = path.join(tmpDir, 'hls');
    await fs.promises.mkdir(hlsDir, { recursive: true });
    await _generateHls(rawPath, hlsDir, meta);

    // ── Step 4: extract thumbnail ──────────────────────────────────────────
    const thumbPath = path.join(tmpDir, 'thumb.jpg');
    await _extractThumbnail(rawPath, thumbPath, meta.durationSec);

    // ── Step 5: upload HLS dir to S3 ──────────────────────────────────────
    const hlsBaseKey     = `clubs/${clubId}/videos/${assetId}/hls`;
    const hlsManifestKey = await _uploadHlsDir(hlsDir, hlsBaseKey);

    // ── Step 6: upload thumbnail ───────────────────────────────────────────
    const thumbStorageKey = `clubs/${clubId}/videos/${assetId}/thumb.jpg`;
    await _uploadFile(thumbPath, thumbStorageKey, 'image/jpeg');

    // Count generated segments for logging.
    const files        = await fs.promises.readdir(hlsDir);
    const segmentCount = files.filter((f) => f.endsWith('.ts')).length;

    return {
      hlsManifestKey,
      thumbStorageKey,
      durationSec:  Math.round(meta.durationSec),
      widthPx:      meta.width,
      heightPx:     meta.height,
      segmentCount,
    };
  } finally {
    // Best-effort cleanup — never let a cleanup failure fail the job.
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── S3 download ─────────────────────────────────────────────────────────────

async function _downloadFromS3(key: string, destPath: string): Promise<void> {
  const signedUrl = await getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: BUCKET(), Key: key }),
    { expiresIn: 7200 },
  );
  await _downloadUrl(signedUrl, destPath);
}

function _downloadUrl(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(destPath);
    const lib  = url.startsWith('https') ? https : http;

    const req = lib.get(url, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        req.destroy();
        reject(new Error(`S3 download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(dest);
      dest.on('finish', () => dest.close(() => resolve()));
      dest.on('error', (err) => {
        fs.unlink(destPath, () => reject(err));
      });
    });

    req.on('error', (err) => {
      fs.unlink(destPath, () => reject(err));
    });

    // 2-hour timeout for large video files.
    req.setTimeout(7_200_000, () => {
      req.destroy();
      reject(new Error('S3 download timed out'));
    });
  });
}

// ─── FFprobe ──────────────────────────────────────────────────────────────────

function _probeVideo(inputPath: string): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));

      const videoStream = data.streams.find((s) => s.codec_type === 'video');
      resolve({
        durationSec: Number(data.format.duration) || 0,
        width:       videoStream?.width  ?? 0,
        height:      videoStream?.height ?? 0,
      });
    });
  });
}

// ─── HLS generation ───────────────────────────────────────────────────────────

function _generateHls(
  inputPath: string,
  outputDir: string,
  meta:      VideoMeta,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Scale to native resolution capped at 1080p; keep aspect ratio.
    const targetH = Math.min(meta.height > 0 ? meta.height : 720, 1080);
    // -2 ensures height is divisible by 2 (required for libx264).
    const scaleFilter = `scale=-2:${targetH}`;

    ffmpeg(inputPath)
      .outputOptions([
        // Video
        '-c:v libx264',
        '-crf 23',
        '-preset fast',
        '-profile:v baseline',   // maximum device compatibility
        '-level 3.1',
        `-vf ${scaleFilter}`,
        // Audio
        '-c:a aac',
        '-b:a 128k',
        '-ar 48000',
        '-ac 2',
        // HLS muxer
        '-f hls',
        '-hls_time 6',
        '-hls_list_size 0',
        '-hls_segment_type mpegts',
        `-hls_segment_filename ${path.join(outputDir, 'seg%04d.ts')}`,
        // Metadata
        '-movflags +faststart',
      ])
      .output(path.join(outputDir, 'manifest.m3u8'))
      .on('end',   () => resolve())
      .on('error', (err: Error) => reject(new Error(`FFmpeg HLS failed: ${err.message}`)))
      .run();
  });
}

// ─── Thumbnail extraction ─────────────────────────────────────────────────────

function _extractThumbnail(
  inputPath:   string,
  outputPath:  string,
  durationSec: number,
): Promise<void> {
  // Seek to 5 s (or 10% through for very short clips).
  const seekTime = durationSec > 10 ? 5 : Math.max(0, durationSec * 0.1);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(seekTime)
      .outputOptions([
        '-vframes 1',
        '-vf scale=640:-2',   // 640 px wide, height keeps aspect ratio
        '-q:v 3',             // JPEG quality (1=best, 31=worst)
      ])
      .output(outputPath)
      .on('end',   () => resolve())
      .on('error', (err: Error) => {
        // Thumbnail is non-fatal — resolve without thumbnail if it fails.
        console.error('[video-hls] thumbnail extraction failed:', err.message);
        resolve();
      })
      .run();
  });
}

// ─── S3 upload helpers ────────────────────────────────────────────────────────

async function _uploadHlsDir(dir: string, baseKey: string): Promise<string> {
  const files = await fs.promises.readdir(dir);

  // Upload in batches of 8 to bound memory usage while keeping throughput.
  const BATCH = 8;
  for (let i = 0; i < files.length; i += BATCH) {
    await Promise.all(
      files.slice(i, i + BATCH).map((file) => {
        const mime = file.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'video/mp2t';
        return _uploadFile(path.join(dir, file), `${baseKey}/${file}`, mime);
      }),
    );
  }

  return `${baseKey}/manifest.m3u8`;
}

async function _uploadFile(
  filePath:    string,
  key:         string,
  contentType: string,
): Promise<void> {
  // Stream directly from disk — never load the whole file into memory.
  const body = fs.createReadStream(filePath);
  await s3().send(
    new PutObjectCommand({
      Bucket:      BUCKET(),
      Key:         key,
      Body:        body as any,
      ContentType: contentType,
    }),
  );
}
