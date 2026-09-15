/**
 * tests/fabric-media-producer.unit.test.ts
 *
 * The Media domain as a Data Fabric producer.
 *
 * WHAT IS DIFFERENT ABOUT THIS ONE
 *
 * Media's dangerous fields do not look dangerous. Nobody was ever going to put
 * video bytes on an event; what a careless producer puts on one is a STORAGE
 * KEY, a SIGNED URL, a CHECKSUM or an ORIGINAL FILENAME, each of which reads
 * like harmless metadata and is not:
 *
 *   · a signed upload URL is a time-limited WRITE CREDENTIAL for the bucket
 *   · a storage key plus a bucket is a read path around the authorised one
 *   · a checksum is a confirmation oracle — "do you hold this exact file?"
 *   · `Tomas-U15-knee-scan.mp4` is a child, an age group and a medical fact
 *
 * All four are planted in the fixtures below and searched for in every
 * representation. The checksum one is not hypothetical: the `media.created`
 * event this producer replaces carried one, which is why the payload moves to
 * schema version 2 rather than being edited in place.
 *
 * MEDIA IS NOT AI
 *
 * Asserted structurally. The vision ingest pipeline — the part that runs
 * models — must not reach this producer, and no `media.analysis.*` name may be
 * registered under the Media source.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER_CLUB = '22222222-2222-4222-8222-222222222222';
const SENIOR_TEAM = '33333333-3333-4333-8333-333333333333';
const ACADEMY_TEAM = '44444444-4444-4444-8444-444444444444';
const ACTOR = 'u-actor';

/** Every string that must never leave the Media module. */
const SECRETS = {
  storageKey: 'clubs/11111111/videos/asset-1/raw.mp4',
  bucket: 'familista-prod-media-eu-west-1',
  signedUrl: 'https://familista-prod-media-eu-west-1.s3.amazonaws.com/raw.mp4?X-Amz-Signature=deadbeefcafe',
  cdnBase: 'https://d1234abcd.cloudfront.net',
  hlsKey: 'clubs/11111111/videos/asset-1/hls/index.m3u8',
  thumbKey: 'clubs/11111111/videos/asset-1/thumb.jpg',
  checksum: 'a3f5c1d9e7b2408f6a1c3e5d7b9f0a2c4e6d8b0f2a4c6e8d0b2f4a6c8e0d2b4f',
  filename: 'Tomas-Muller-U15-knee-scan-2026-03-04.mp4',
  title: 'U15 v Hertha — second half, Tomás isolated on the left',
  description: 'Their centre back steps up every time; exploit it. Do not share outside the staff room.',
  tag: 'safeguarding-review',
  transcodeError: 'ffmpeg: clubs/11111111/videos/asset-1/raw.mp4: moov atom not found',
  externalUrl: 'https://private.example.test/matches/u15-vs-hertha-full.mp4',
};

const state = {
  media: [] as Row[], videos: [] as Row[], jobs: [] as Row[],
  teams: [] as Row[], clubs: [] as Row[], audit: [] as Row[],
};

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== (v as Row).not;
      if ('lt' in v) return Number(row[k]) < Number((v as Row).lt);
    }
    if (v === null) return row[k] == null;
    return row[k] === v;
  });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const copy = <T>(row: T): T => {
  if (row == null) return row;
  return JSON.parse(
    JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    (_k, v) => (typeof v === 'string' && ISO.test(v) ? new Date(v) : v),
  ) as T;
};

const table = (rows: () => Row[], prefix: string, defaults: Row = {}) => ({
  findUnique: async ({ where }: Row) => copy(rows().find((r) => r.id === where.id) ?? null),
  findFirst: async ({ where = {} }: Row = {}) => copy(rows().find((r) => match(r, where)) ?? null),
  findMany: async ({ where = {} }: Row = {}) => copy(rows().filter((r) => match(r, where))),
  count: async ({ where = {} }: Row = {}) => rows().filter((r) => match(r, where)).length,
  create: async ({ data }: Row) => {
    const row = { id: data.id ?? `${prefix}-${rows().length + 1}`, createdAt: new Date(), ...defaults, ...data };
    rows().push(row); return copy(row);
  },
  update: async ({ where, data }: Row) => {
    const r = rows().find((x) => x.id === where.id)!;
    for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v;
    return copy(r);
  },
  updateMany: async ({ where = {}, data }: Row = {}) => {
    const hits = rows().filter((r) => match(r, where));
    hits.forEach((r) => Object.assign(r, data));
    return { count: hits.length };
  },
  delete: async ({ where }: Row) => {
    const i = rows().findIndex((x) => x.id === where.id);
    return i >= 0 ? copy(rows().splice(i, 1)[0]) : null;
  },
});

const db: Row = {
  mediaAsset: table(() => state.media, 'media'),
  videoAsset: table(() => state.videos, 'asset', { status: 'PENDING', tags: [] }),
  videoTranscodeJob: table(() => state.jobs, 'job', { retryCount: 0 }),
  team: table(() => state.teams, 'team'),
  club: table(() => state.clubs, 'club'),
  platformAuditEvent: { create: async ({ data }: Row) => data },
  auditEvent: { create: async ({ data }: Row) => data },
  visionAuditLog: { create: async ({ data }: Row) => { state.audit.push(data); return data; } },
  eventOutbox: { create: async ({ data }: Row) => data, findMany: async () => [] },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

// The object store the media service writes through. Its signed URLs and keys
// are exactly what must not reach an event, so the fake produces real-looking
// ones rather than blanks.
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { async send() { return {}; } },
  PutObjectCommand: class { constructor(public input: Row) {} },
  DeleteObjectCommand: class { constructor(public input: Row) {} },
  GetObjectCommand: class { constructor(public input: Row) {} },
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async () => 'https://familista-prod-media-eu-west-1.s3.amazonaws.com/raw.mp4?X-Amz-Signature=deadbeefcafe',
}));

import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { project, sourceLaneFor } from '../src/fabric/pulse/pulse.service';
import { resolveSubjects } from '../src/fabric/pulse/subject-resolver.service';
import { fabricEvent, fabricEventsForSource } from '../src/fabric/registry/event-registry';
import { visibleFabricSources, sourceLanes } from '../src/fabric/registry/source-registry';
import { validateEventPayload, schemaVersionsFor } from '../src/fabric/registry/schema-registry';
import { setObjectStore, MemoryObjectStore } from '../src/fabric/media/object-store';
import { bucketSize, bucketDuration } from '../src/fabric/producers/media.producer';
import '../src/fabric/producers/media.producer';
// The v1 payload contracts, which self-register at load exactly as they do at
// boot. Imported here so this suite sees both versions of `media.created` and
// can prove the old one was kept rather than replaced.
import '../src/fabric/registry/core-schemas';

import * as media from '../src/fabric/media/media-asset.service';
import * as video from '../src/video/video-asset.service';

let published: FamilistaEvent[] = [];

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const transport: EventTransport = {
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as EventTransport;

const VIDEO_ACTOR = { userId: ACTOR, clubId: CLUB, role: 'HEAD_COACH' } as never;

beforeEach(() => {
  published = [];
  setEventTransport(transport);
  setObjectStore(new MemoryObjectStore());
  state.media = [];
  state.videos = [];
  state.jobs = [];
  state.teams = [
    { id: SENIOR_TEAM, clubId: CLUB, kind: 'SENIOR' },
    { id: ACADEMY_TEAM, clubId: CLUB, kind: 'ACADEMY_U17' },
  ];
  state.clubs = [{ id: CLUB, name: 'FC Familista' }, { id: OTHER_CLUB, name: 'SV Nord' }];
  state.audit = [];
});

afterEach(async () => { await settle(); });
afterAll(async () => { await settle(); setEventTransport(null); });

const types = () => published.map((e) => e.eventType).sort();
const one = (type: string) => {
  const hits = published.filter((e) => e.eventType === type);
  expect(`${type} count: ${hits.length}`).toBe(`${type} count: 1`);
  return hits[0];
};

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// ══════════════════════════════════════════════════════════════════════════════
// 1 · THE MEDIA ASSET SERVICE
// ══════════════════════════════════════════════════════════════════════════════

describe('storing an asset', () => {
  const store = (over: Row = {}) => media.createMediaAsset({
    clubId: CLUB, teamId: SENIOR_TEAM,
    subjectType: 'PLAYER' as never, subjectId: 'p-1',
    mediaType: 'IMAGE' as never, purpose: 'PHOTO' as never,
    mimeType: 'image/png', originalFilename: SECRETS.filename,
    body: PNG, createdBy: ACTOR, ...over,
  } as never);

  it('publishes exactly one media.created, at schema version 2, after the row exists', async () => {
    const asset = await store();
    await settle();

    expect(types()).toEqual(['media.created']);
    const e = one('media.created');
    expect(state.media).toHaveLength(1);
    expect(e.subjectType).toBe('MEDIA_ASSET');
    expect(e.subjectId).toBe(asset.id);
    expect(e.clubId).toBe(CLUB);
    expect(e.schemaVersion).toBe(2);
    expect(e.payload).toEqual({
      mediaCategory: 'IMAGE', purpose: 'PHOTO', mimeType: 'image/png',
      sizeBucket: 'UNDER_1MB', teamKind: 'SENIOR',
    });
  });

  it('carries no checksum, no storage provider, no key and no filename', async () => {
    const asset = await store();
    await settle();

    const wire = JSON.stringify(published);
    expect(wire).not.toContain(SECRETS.filename);
    expect(wire).not.toContain('checksum');
    expect(wire).not.toContain('storageProvider');
    expect(wire).not.toContain('storageKey');
    // and the row still holds all of it, because the module still needs it
    expect(state.media[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(state.media[0].storageKey).toContain(asset.id);
  });

  it('a soft delete publishes one media.deleted saying whether the bytes went too', async () => {
    const asset = await store();
    await settle();
    published = [];

    await media.deleteMediaAsset(CLUB, asset.id, { purgeObject: true, actorUserId: ACTOR });
    await settle();

    expect(types()).toEqual(['media.deleted']);
    const e = one('media.deleted');
    expect(e.schemaVersion).toBe(2);
    expect(e.payload).toEqual({ mediaCategory: 'IMAGE', purgedObject: true, teamKind: 'SENIOR' });
    // soft: the row survives, marked
    expect(state.media[0].deletedAt).toBeTruthy();
  });

  it('a rejected file publishes nothing at all', async () => {
    await expect(store({ mimeType: 'application/zip' })).rejects.toThrow();
    await expect(store({ body: Buffer.alloc(0) })).rejects.toThrow();
    await expect(store({ clubId: '' })).rejects.toThrow();
    await settle();

    expect(types()).toEqual([]);
    expect(state.media).toHaveLength(0);
  });

  it('reading an asset or a signed URL publishes nothing — a read is not an event', async () => {
    const asset = await store();
    await settle();
    published = [];

    await media.getMediaAsset(CLUB, asset.id);
    await media.getMediaReadUrl(CLUB, asset.id);
    await settle();
    expect(types()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2 · THE VIDEO UPLOAD LIFECYCLE
// ══════════════════════════════════════════════════════════════════════════════

describe('the upload lifecycle', () => {
  const request = (over: Row = {}) => video.requestUpload(VIDEO_ACTOR, {
    filename: SECRETS.filename, title: SECRETS.title, description: SECRETS.description,
    sourceKind: 'MATCH', teamId: SENIOR_TEAM, tags: [SECRETS.tag], fileSizeMb: 2048, ...over,
  } as never);

  it('requesting an upload publishes upload.started and NOT media.created', async () => {
    const { asset } = await request();
    await settle();

    expect(types()).toEqual(['media.upload.started']);
    const e = one('media.upload.started');
    expect(e.subjectId).toBe(asset.id);
    expect(e.payload).toEqual({
      mediaCategory: 'VIDEO', sourceKind: 'MATCH',
      sizeBucket: 'OVER_1GB', teamKind: 'SENIOR',
    });
  });

  it('the signed upload URL — a write credential — is on no event', async () => {
    const { uploadUrl, uploadKey } = await request();
    await settle();

    expect(uploadUrl).toContain('X-Amz-Signature');   // the fake really produced one
    const wire = JSON.stringify(published);
    expect(wire).not.toContain('X-Amz-Signature');
    expect(wire).not.toContain(uploadUrl);
    expect(wire).not.toContain(uploadKey);
    expect(wire).not.toContain('s3.amazonaws.com');
  });

  it('confirming the upload publishes exactly one upload.completed, after the job is queued', async () => {
    const { asset } = await request();
    await settle();
    published = [];

    await video.confirmUpload(VIDEO_ACTOR, { assetId: asset.id } as never);
    await settle();

    expect(types()).toEqual(['media.upload.completed']);
    expect(one('media.upload.completed').payload)
      .toEqual({ mediaCategory: 'VIDEO', sourceKind: 'MATCH', teamKind: 'SENIOR' });
    expect(state.jobs).toHaveLength(1);
    expect(state.videos[0].status).toBe('UPLOADED');
  });

  it('confirming twice publishes once — the second call is refused', async () => {
    const { asset } = await request();
    await video.confirmUpload(VIDEO_ACTOR, { assetId: asset.id } as never);
    await settle();
    published = [];

    await expect(video.confirmUpload(VIDEO_ACTOR, { assetId: asset.id } as never)).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
    expect(state.jobs).toHaveLength(1);
  });

  it('a rejected upload request publishes nothing', async () => {
    await expect(request({ filename: 'notes.txt' })).rejects.toThrow();
    await expect(request({ fileSizeMb: 999_999 })).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
    expect(state.videos).toHaveLength(0);
  });

  it('another club’s asset cannot be confirmed, and publishes nothing', async () => {
    const { asset } = await request();
    await settle();
    published = [];

    await expect(video.confirmUpload(
      { userId: ACTOR, clubId: OTHER_CLUB } as never, { assetId: asset.id } as never,
    )).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3 · PROCESSING
// ══════════════════════════════════════════════════════════════════════════════

describe('processing', () => {
  const ready = async () => {
    const { asset } = await video.requestUpload(VIDEO_ACTOR, {
      filename: SECRETS.filename, title: SECRETS.title, sourceKind: 'TRAINING',
      teamId: ACADEMY_TEAM,
    } as never);
    await video.confirmUpload(VIDEO_ACTOR, { assetId: asset.id } as never);
    await settle();
    published = [];
    return asset;
  };

  it('a successful transcode publishes one processing.completed with a duration BUCKET', async () => {
    const asset = await ready();

    await video.handleTranscodeCallback({
      assetId: asset.id,
      hlsManifestKey: SECRETS.hlsKey, thumbStorageKey: SECRETS.thumbKey,
      durationSec: 2712, widthPx: 1920, heightPx: 1080,
    } as never);
    await settle();

    expect(types()).toEqual(['media.processing.completed']);
    expect(one('media.processing.completed').payload).toEqual({
      processingStage: 'TRANSCODE', durationBucket: 'UNDER_1HR', teamKind: 'ACADEMY_U17',
    });
    expect(state.videos[0].status).toBe('READY');
    // not the manifest, not the thumbnail, not the CDN base, not the pixels
    const wire = JSON.stringify(published);
    for (const s of [SECRETS.hlsKey, SECRETS.thumbKey, SECRETS.cdnBase, '1920', '2712']) {
      expect(`${s}: ${wire.includes(s)}`).toBe(`${s}: false`);
    }
  });

  it('a failed transcode publishes one processing.failed and never the error text', async () => {
    const asset = await ready();

    await video.handleTranscodeCallback({
      assetId: asset.id, errorMessage: SECRETS.transcodeError,
    } as never);
    await settle();

    expect(types()).toEqual(['media.processing.failed']);
    expect(one('media.processing.failed').payload)
      .toEqual({ processingStage: 'TRANSCODE', teamKind: 'ACADEMY_U17' });
    expect(state.videos[0].status).toBe('FAILED');
    const wire = JSON.stringify(published);
    expect(wire).not.toContain(SECRETS.transcodeError);
    expect(wire).not.toContain('moov atom');
    expect(wire).not.toContain(SECRETS.storageKey);
  });

  it('one outcome per callback — success and failure are never both published', async () => {
    const asset = await ready();
    await video.handleTranscodeCallback({ assetId: asset.id, durationSec: 30 } as never);
    await settle();
    expect(types()).toEqual(['media.processing.completed']);
    expect(types()).not.toContain('media.processing.failed');
  });

  it('a callback for an asset that is not there publishes nothing', async () => {
    await expect(video.handleTranscodeCallback({ assetId: 'nobody' } as never)).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('deleting a video asset publishes media.deleted with the bytes purged', async () => {
    const asset = await ready();
    await video.deleteAsset(VIDEO_ACTOR, asset.id);
    await settle();

    expect(types()).toEqual(['media.deleted']);
    expect(one('media.deleted').payload)
      .toEqual({ mediaCategory: 'VIDEO', purgedObject: true, teamKind: 'ACADEMY_U17' });
    expect(state.videos).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4 · BUCKETS
// ══════════════════════════════════════════════════════════════════════════════

describe('buckets', () => {
  it('a size becomes a band and never a figure', () => {
    expect(bucketSize(512)).toBe('UNDER_1MB');
    expect(bucketSize(5 * 1024 * 1024)).toBe('UNDER_10MB');
    expect(bucketSize(50 * 1024 * 1024)).toBe('UNDER_100MB');
    expect(bucketSize(500 * 1024 * 1024)).toBe('UNDER_1GB');
    expect(bucketSize(9 * 1024 * 1024 * 1024)).toBe('OVER_1GB');
    expect(bucketSize(null)).toBeNull();
    expect(bucketSize(-1)).toBeNull();
    expect(bucketSize(Number.NaN)).toBeNull();
  });

  it('a duration becomes a band and never a figure', () => {
    expect(bucketDuration(12)).toBe('UNDER_1MIN');
    expect(bucketDuration(300)).toBe('UNDER_10MIN');
    expect(bucketDuration(2700)).toBe('UNDER_1HR');
    expect(bucketDuration(7200)).toBe('OVER_1HR');
    expect(bucketDuration(null)).toBeNull();
    expect(bucketDuration(-5)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5 · ACADEMY AND FIRST TEAM
// ══════════════════════════════════════════════════════════════════════════════

describe('academy and first team', () => {
  it('share one source and are told apart by teamKind alone', async () => {
    await video.requestUpload(VIDEO_ACTOR, {
      filename: 'a.mp4', title: 't', sourceKind: 'MATCH', teamId: SENIOR_TEAM,
    } as never);
    await video.requestUpload(VIDEO_ACTOR, {
      filename: 'b.mp4', title: 't', sourceKind: 'MATCH', teamId: ACADEMY_TEAM,
    } as never);
    await settle();

    const kinds = published.map((e) => (e.payload as Row).teamKind).sort();
    expect(kinds).toEqual(['ACADEMY_U17', 'SENIOR']);
    expect(new Set(published.map((e) => sourceLaneFor(e.eventType)))).toEqual(new Set(['Media']));
  });

  it('an asset with no team publishes a null kind rather than a guess', async () => {
    await video.requestUpload(VIDEO_ACTOR, {
      filename: 'c.mp4', title: 't', sourceKind: 'MATCH',
    } as never);
    await settle();
    expect((one('media.upload.started').payload as Row).teamKind).toBeNull();
  });

  it('adds no source card for any media family', () => {
    const ids = visibleFabricSources().map((s) => s.id);
    for (const invented of ['images', 'videos', 'match-footage', 'training-footage',
      'documents', 'thumbnails', 'analysis-clips', 'uploads']) {
      expect(`${invented} is a source: ${ids.includes(invented)}`).toBe(`${invented} is a source: false`);
    }
    expect(ids).toContain('media');
    expect(sourceLanes()).toEqual([
      'Clubs', 'Users', 'Players', 'Training', 'Matches',
      'Transfers', 'Medical', 'Media', 'AI', 'System',
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6 · NOTHING PRIVATE REACHES OBSERVABILITY
// ══════════════════════════════════════════════════════════════════════════════

describe('redaction', () => {
  const everywhere = async () => {
    const frames = published.map((e) => project(e, 'STORED'));
    await resolveSubjects(frames);
    const catalogue = fabricEventsForSource('media');
    return JSON.stringify({ published, frames, catalogue });
  };

  it('no key, URL, bucket, checksum, filename, title, description or tag survives', async () => {
    const { asset } = await video.requestUpload(VIDEO_ACTOR, {
      filename: SECRETS.filename, title: SECRETS.title, description: SECRETS.description,
      sourceKind: 'MATCH', teamId: ACADEMY_TEAM, tags: [SECRETS.tag], fileSizeMb: 40,
    } as never);
    await video.confirmUpload(VIDEO_ACTOR, { assetId: asset.id } as never);
    await video.handleTranscodeCallback({
      assetId: asset.id, hlsManifestKey: SECRETS.hlsKey,
      thumbStorageKey: SECRETS.thumbKey, durationSec: 120,
    } as never);
    await media.createMediaAsset({
      clubId: CLUB, teamId: SENIOR_TEAM, subjectType: 'CLUB' as never,
      mediaType: 'IMAGE' as never, purpose: 'CREST' as never,
      mimeType: 'image/png', originalFilename: SECRETS.filename, body: PNG,
    } as never);
    await settle();

    const blob = await everywhere();
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(`${name}: ${blob.includes(secret)}`).toBe(`${name}: false`);
    }
  });

  it('a frame carries no payload — the media id is all a board gets', async () => {
    const { asset } = await video.requestUpload(VIDEO_ACTOR, {
      filename: SECRETS.filename, title: SECRETS.title, sourceKind: 'MATCH', teamId: SENIOR_TEAM,
    } as never);
    await settle();

    const frame = project(published[0], 'STORED') as Row;
    expect(frame.payload).toBeUndefined();
    expect(frame.metadata).toBeUndefined();
    // The id DOES travel — a file is not a person, and without it an upload is
    // four unrelated dots. It is not a route: reads still check the club.
    expect(frame.subjectId).toBe(asset.id);
    expect(frame.subjectType).toBe('MEDIA_ASSET');
    expect(frame.source).toBe('Media');
  });

  it('the subject resolver gives a media asset no name', async () => {
    await video.requestUpload(VIDEO_ACTOR, {
      filename: SECRETS.filename, title: SECRETS.title, sourceKind: 'MATCH', teamId: SENIOR_TEAM,
    } as never);
    await settle();

    const frames = published.map((e) => project(e, 'STORED'));
    await resolveSubjects(frames);
    expect(frames[0].subjectLabel).toBeNull();
    expect(frames[0].clubLabel).toBe('FC Familista');
  });

  it('every media payload validates against its declared schema, which is strict', async () => {
    const { asset } = await video.requestUpload(VIDEO_ACTOR, {
      filename: SECRETS.filename, title: SECRETS.title, sourceKind: 'MATCH', teamId: SENIOR_TEAM,
    } as never);
    await video.confirmUpload(VIDEO_ACTOR, { assetId: asset.id } as never);
    await video.handleTranscodeCallback({ assetId: asset.id, durationSec: 90 } as never);
    await media.createMediaAsset({
      clubId: CLUB, subjectType: 'CLUB' as never, mediaType: 'IMAGE' as never,
      purpose: 'CREST' as never, mimeType: 'image/png', body: PNG,
    } as never);
    await settle();

    expect(published.length).toBeGreaterThanOrEqual(4);
    for (const e of published) {
      const check = validateEventPayload(e.eventType, e.schemaVersion, e.payload);
      expect(`${e.eventType} v${e.schemaVersion}: ${check.ok ? 'ok' : JSON.stringify((check as Row).issues)}`)
        .toBe(`${e.eventType} v${e.schemaVersion}: ok`);
    }
  });

  it('a strict schema refuses a storage key or a checksum somebody adds later', () => {
    expect(validateEventPayload('media.created', 2, {
      mediaCategory: 'VIDEO', purpose: 'MATCH_FOOTAGE', mimeType: 'video/mp4',
      sizeBucket: 'UNDER_1GB', teamKind: null, storageKey: SECRETS.storageKey,
    }).ok).toBe(false);
    expect(validateEventPayload('media.created', 2, {
      mediaCategory: 'VIDEO', purpose: 'MATCH_FOOTAGE', mimeType: 'video/mp4',
      sizeBucket: 'UNDER_1GB', teamKind: null, checksum: SECRETS.checksum,
    }).ok).toBe(false);
    expect(validateEventPayload('media.upload.started', 1, {
      mediaCategory: 'VIDEO', sourceKind: 'MATCH', sizeBucket: null, teamKind: null,
      uploadUrl: SECRETS.signedUrl,
    }).ok).toBe(false);
    // and a raw byte count is not a bucket
    expect(validateEventPayload('media.created', 2, {
      mediaCategory: 'VIDEO', purpose: 'MATCH_FOOTAGE', mimeType: 'video/mp4',
      sizeBucket: 2_147_483_648, teamKind: null,
    }).ok).toBe(false);
  });

  it('the v1 contract is still registered beside v2, not replaced', () => {
    expect(schemaVersionsFor('media.created')).toEqual([1, 2]);
    expect(schemaVersionsFor('media.deleted')).toEqual([1, 2]);
    // v1 still describes what v1 events carried, checksum and all
    expect(validateEventPayload('media.created', 1, {
      mediaType: 'IMAGE', purpose: 'PHOTO', mimeType: 'image/png',
      sizeBytes: 16, checksum: SECRETS.checksum, storageProvider: 'memory',
    }).ok).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7 · MEDIA IS NOT AI
// ══════════════════════════════════════════════════════════════════════════════

describe('media and AI stay apart', () => {
  it('no analysis name is registered under the Media source', () => {
    for (const spec of fabricEventsForSource('media')) {
      expect(`${spec.type}: ${/analysis|inference|model|agent|detect|predict/i.test(spec.type)}`)
        .toBe(`${spec.type}: false`);
    }
    expect(fabricEvent('media.analysis.started')).toBeUndefined();
    expect(fabricEvent('media.analysis.completed')).toBeUndefined();
  });

  it('the vision inference pipeline does not reach the Media producer', () => {
    const root = path.join(__dirname, '..', 'src');
    const src = fs.readFileSync(path.join(root, 'services', 'vision-ingest.service.ts'), 'utf8');
    // The asset half — register and update a video — is Media, and does call it.
    expect(src).toContain('publishMediaCreated');
    // The ingest half — start, transition, inference results, fail — is AI, and
    // the Media producer is named nowhere near any of them.
    const ingest = src.slice(src.indexOf('export async function startIngest'));
    expect(`ingest touches media: ${/publishMedia/.test(ingest)}`).toBe('ingest touches media: false');
  });

  it('the AI source keeps its own lane and its own names', () => {
    const ai = fabricEventsForSource('ai');
    for (const spec of ai) expect(spec.source).toBe('ai');
    expect(fabricEventsForSource('media').every((s) => s.source === 'media')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8 · THE CATALOGUE
// ══════════════════════════════════════════════════════════════════════════════

describe('the catalogue', () => {
  const PRODUCED = [
    'media.created', 'media.updated', 'media.deleted',
    'media.upload.started', 'media.upload.completed',
    'media.processing.started', 'media.processing.completed', 'media.processing.failed',
  ];

  it('registers every produced type under the media source, about a MEDIA_ASSET', () => {
    for (const type of PRODUCED) {
      const spec = fabricEvent(type);
      expect(`${type} registered: ${!!spec}`).toBe(`${type} registered: true`);
      expect(`${type} source: ${spec!.source}`).toBe(`${type} source: media`);
      expect(`${type} produced: ${spec!.produced}`).toBe(`${type} produced: true`);
      expect(sourceLaneFor(type)).toBe('Media');
      expect(validateEventPayload(type, spec!.schemaVersion, null).ok).toBe(false);
    }
  });

  it('says plainly which names are declared and not yet published', () => {
    const declared = fabricEventsForSource('media').filter((s) => !s.produced).map((s) => s.type).sort();
    expect(declared).toEqual([
      'media.attached', 'media.detached', 'media.processed',
      'media.status.changed', 'media.upload.failed',
    ]);
  });

  it('and everything else under the source IS published by this build', () => {
    const produced = fabricEventsForSource('media').filter((s) => s.produced).map((s) => s.type).sort();
    expect(produced).toEqual([...PRODUCED].sort());
  });

  it('invents no batch abstraction, because there is no bulk media flow', () => {
    expect(fabricEvent('media.batch.processed')).toBeUndefined();
    for (const spec of fabricEventsForSource('media')) {
      expect(`${spec.type}: ${/batch|bulk|import/i.test(spec.type)}`).toBe(`${spec.type}: false`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9 · THE FABRIC MUST NOT BE ABLE TO BREAK A MEDIA OPERATION
// ══════════════════════════════════════════════════════════════════════════════

describe('when the fabric is broken', () => {
  it('a transport that throws does not fail the upload or the store that caused it', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('outbox is down'); },
      async read() { return []; },
    } as EventTransport);

    const { asset } = await video.requestUpload(VIDEO_ACTOR, {
      filename: SECRETS.filename, title: SECRETS.title, sourceKind: 'MATCH', teamId: SENIOR_TEAM,
    } as never);
    await video.confirmUpload(VIDEO_ACTOR, { assetId: asset.id } as never);
    const stored = await media.createMediaAsset({
      clubId: CLUB, subjectType: 'CLUB' as never, mediaType: 'IMAGE' as never,
      purpose: 'CREST' as never, mimeType: 'image/png', body: PNG,
    } as never);
    await settle();

    expect(state.videos[0].status).toBe('UPLOADED');
    expect(state.jobs).toHaveLength(1);
    expect(stored.id).toBeTruthy();
    expect(state.media).toHaveLength(1);
    setEventTransport(transport);
  });

  it('a team lookup that throws still records the event, without a squad kind', async () => {
    const original = db.team.findUnique;
    db.team.findUnique = async () => { throw new Error('database is unwell'); };
    try {
      await video.requestUpload(VIDEO_ACTOR, {
        filename: SECRETS.filename, title: SECRETS.title, sourceKind: 'MATCH', teamId: SENIOR_TEAM,
      } as never);
      await settle();
    } finally {
      db.team.findUnique = original;
    }

    expect(types()).toEqual(['media.upload.started']);
    expect((one('media.upload.started').payload as Row).teamKind).toBeNull();
  });
});
