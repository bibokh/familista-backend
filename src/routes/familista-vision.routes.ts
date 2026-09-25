// FAMILISTA VISION — the API, on the platform's own auth and tenancy
// ─────────────────────────────────────────────────────────────────────────────
// Mounted at /api/v1/familista-vision.
//
// WHY NOT /api/v1/vision
//
// That path is taken, by the Phase-G camera module — camera registration, frame
// ingest, per-match frames. It is live, it is mounted, and other code calls it.
// Hanging a second module's routes off the same prefix would give the platform
// two things called Vision with different meanings and different guards, and
// the first collision would be silent. So this module takes its own prefix and
// says which one it is.
//
// AUTHENTICATION, TENANCY AND ROLES ARE THE PLATFORM'S
//
// `authenticate` is the platform's. Club scoping is the platform's club id on
// the request. There is no Vision login, no Vision token and no Vision role
// table — see `vision-access.ts` for the three rules that join a session to the
// identity the platform already established.
//
// WHAT NEVER LEAVES THIS BOUNDARY
//
// A filesystem path. The engine's artefacts live somewhere on a server and
// where that is, is not a client's business; `session-normaliser.ts` reduces a
// source to its file NAME and its hash before anything reaches a response.

import { Router, type Request, type Response } from 'express';

import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import {
  configuredTarget, isUnavailable, visionEngine,
} from '../vision-platform/engine-contract';
import { evidenceFor } from '../vision-platform/vision-intelligence.contract';
import { listSessions, loadSession } from '../vision-platform/session-store.service';
import { SOURCE_SLOTS, SOURCE_TYPES } from '../vision-platform/source-types';
import {
  maySeeSession, mayOperateVision, viewerRole, visibleSessions,
  type VisionViewer,
} from '../vision-platform/vision-access';
import { visionHealth } from '../vision-platform/vision-health.service';
import { registerVisionEvents, visionEventCatalogue } from '../vision-platform/vision-events';
import { registerVisionSource } from '../vision-platform/vision-source';
import { buildTimeline } from '../vision-platform/session-timeline';
import type { VisionSession } from '../vision-platform/session-model';

// Registration happens once, at module load, so Vision is on the Fabric's
// registries whether or not anybody has opened the screen yet. A source that
// only exists after a page view is a source Source Core cannot draw.
registerVisionSource();
registerVisionEvents();

const router = Router();
router.use(authenticate);

interface RequestUser { id?: string; clubId?: string | null; role?: string }

async function viewerOf(req: Request): Promise<VisionViewer> {
  const u = (req as Request & { user?: RequestUser }).user;
  const actor = { userId: u?.id ?? '', clubId: u?.clubId ?? null, role: u?.role };
  // The platform's own guard decides. It throws for anybody who is not the
  // owner, and a throw is the answer rather than an error: this is a
  // classification, not a failure.
  let owner = false;
  try { await assertPlatformOwner(actor); owner = true; } catch { owner = false; }
  return {
    userId: actor.userId,
    clubId: actor.clubId,
    role: u?.role ?? null,
    isPlatformOwner: owner,
  };
}

/** One shape for "the engine could not answer", so every route says it alike. */
function unavailable(res: Response, payload: { status: string; reason: string }) {
  return res.status(200).json({ ok: false, ...payload });
}

// ── status, models, sources ──────────────────────────────────────────────────

router.get('/status', async (req: Request, res: Response, next) => {
  try {
    const viewer = await viewerOf(req);
    const health = await visionHealth();
    res.json({
      ok: true,
      viewer: { role: viewerRole(viewer), mayOperate: mayOperateVision(viewer) },
      health,
    });
  } catch (err) { next(err); }
});

/**
 * The models behind every result, from the registry the engine carries.
 *
 * Composed from the sessions rather than from a list in this file: a model that
 * has not produced anything is not a model this deployment is using, and a
 * hand-written catalogue would disagree with reality the first time a provider
 * was swapped.
 */
router.get('/models', async (req: Request, res: Response, next) => {
  try {
    const viewer = await viewerOf(req);
    const summaries = await listSessions();
    if (isUnavailable(summaries)) return unavailable(res, summaries);
    const visible = visibleSessions(viewer, summaries);
    const byId = new Map<string, unknown>();
    const providers = new Map<string, unknown>();
    for (const s of visible) {
      for (const m of s.models) if (!byId.has(m.modelId)) byId.set(m.modelId, m);
      for (const p of s.providers) if (!providers.has(p.role)) providers.set(p.role, p);
    }
    res.json({
      ok: true,
      models: [...byId.values()],
      providers: [...providers.values()],
      note: 'composed from the sessions this viewer may see; a model that produced '
        + 'nothing here is not listed',
    });
  } catch (err) { next(err); }
});

router.get('/sources', async (req: Request, res: Response, next) => {
  try {
    const viewer = await viewerOf(req);
    const summaries = await listSessions();
    const connected = isUnavailable(summaries) ? [] : visibleSessions(viewer, summaries)
      .map((s) => ({ ...s.source, sessionId: s.sessionId, sessionRef: s.sessionRef }));
    res.json({
      ok: true,
      types: SOURCE_TYPES,
      slots: SOURCE_SLOTS,
      connected,
      note: 'a source type with implemented=false has no adapter. Nothing here is '
        + 'simulated hardware.',
    });
  } catch (err) { next(err); }
});

/**
 * Attaching a source is the platform owner's, and today it refuses.
 *
 * The route exists because the contract needs it and a client should get a
 * clear 501 rather than a 404 that looks like a typo. It refuses because there
 * is no live-source adapter to attach to.
 */
router.post('/sources', async (req: Request, res: Response, next) => {
  try {
    const viewer = await viewerOf(req);
    if (!mayOperateVision(viewer)) {
      return res.status(403).json({ ok: false, error: 'Vision operation is the platform owner\'s' });
    }
    res.status(501).json({
      ok: false,
      status: 'NOT_IMPLEMENTED',
      reason: 'no live-source adapter exists. VIDEO_FILE sessions are produced by the '
        + 'engine and read through the session store; attaching a camera belongs to '
        + 'the Vision Hub.',
    });
  } catch (err) { next(err); }
});

// ── sessions ─────────────────────────────────────────────────────────────────

router.get('/sessions', async (req: Request, res: Response, next) => {
  try {
    const viewer = await viewerOf(req);
    const summaries = await listSessions();
    if (isUnavailable(summaries)) return unavailable(res, summaries);
    res.json({ ok: true, sessions: visibleSessions(viewer, summaries) });
  } catch (err) { next(err); }
});

router.post('/sessions', async (req: Request, res: Response, next) => {
  try {
    const viewer = await viewerOf(req);
    if (!mayOperateVision(viewer)) {
      return res.status(403).json({ ok: false, error: 'Vision operation is the platform owner\'s' });
    }
    res.status(501).json({
      ok: false,
      status: 'NOT_IMPLEMENTED',
      reason: 'this deployment reads sessions an engine produced; it does not start '
        + 'inference in-process. Starting a session belongs to the engine, and on the '
        + 'Vision Hub target it belongs to the device.',
    });
  } catch (err) { next(err); }
});

/** Everything below takes a session and applies the same visibility rule once. */
async function withSession(
  req: Request, res: Response,
  handler: (session: VisionSession) => unknown,
) {
  const viewer = await viewerOf(req);
  const session = await loadSession(String(req.params.id));
  if (isUnavailable(session)) return unavailable(res, session);
  if (!maySeeSession(viewer, session.summary)) {
    // 404 rather than 403: a reader without access should not learn that a
    // session with this id exists at all.
    return res.status(404).json({ ok: false, error: 'no such session' });
  }
  return res.json({ ok: true, ...(handler(session) as object) });
}

router.get('/sessions/:id', (req, res, next) => {
  withSession(req, res, (s) => ({ session: s })).catch(next);
});

router.get('/sessions/:id/summary', (req, res, next) => {
  withSession(req, res, (s) => ({ summary: s.summary })).catch(next);
});

router.get('/sessions/:id/tracks', (req, res, next) => {
  withSession(req, res, (s) => ({ tracks: s.tracks, roles: s.roles })).catch(next);
});

router.get('/sessions/:id/ball', (req, res, next) => {
  withSession(req, res, (s) => ({ ball: s.ball })).catch(next);
});

router.get('/sessions/:id/calibration', (req, res, next) => {
  withSession(req, res, (s) => ({ calibration: s.calibration })).catch(next);
});

router.get('/sessions/:id/teams', (req, res, next) => {
  withSession(req, res, (s) => {
    const teams = new Map<string, { teamId: string; identities: Set<string>; observations: number }>();
    for (const t of s.tracks) {
      const key = t.teamId ?? 'UNASSIGNED';
      const row = teams.get(key) ?? { teamId: key, identities: new Set<string>(), observations: 0 };
      row.identities.add(t.identity);
      row.observations += 1;
      teams.set(key, row);
    }
    return {
      teams: [...teams.values()].map((t) => ({
        teamId: t.teamId, identities: t.identities.size, observations: t.observations,
      })),
      roles: s.roles,
    };
  }).catch(next);
});

router.get('/sessions/:id/events', (req, res, next) => {
  withSession(req, res, (s) => ({ events: s.events })).catch(next);
});

router.get('/sessions/:id/timeline', (req, res, next) => {
  withSession(req, res, (s) => ({ timeline: buildTimeline(s) })).catch(next);
});

/** The evidence bundle Familista Intelligence may consume. */
router.get('/sessions/:id/evidence', (req, res, next) => {
  withSession(req, res, (s) => ({ evidence: evidenceFor(s) })).catch(next);
});

router.get('/sessions/:id/reports', (req, res, next) => {
  withSession(req, res, (s) => ({
    reports: [
      { kind: 'session', label: 'Session JSON', format: 'json' },
      { kind: 'tracks', label: 'Tracking JSON', format: 'json' },
      { kind: 'ball', label: 'Ball JSON', format: 'json' },
      { kind: 'events', label: 'Events JSON', format: 'json' },
      { kind: 'calibration', label: 'Calibration JSON', format: 'json' },
      { kind: 'summary', label: 'Session summary', format: 'json' },
      { kind: 'tracks-csv', label: 'Tracking CSV', format: 'csv' },
      { kind: 'evidence', label: 'Intelligence evidence bundle', format: 'json' },
    ],
    provenance: {
      sessionId: s.summary.sessionId,
      sourceSha256: s.summary.source.sha256,
      pipelineVersion: s.summary.pipelineVersion,
      models: s.summary.models.map((m) => ({
        modelId: m.modelId, version: m.version, checksumSha256: m.checksumSha256,
        commercialUse: m.commercialUse,
      })),
      generatedAt: s.summary.generatedAt,
      clubId: s.summary.clubId,
    },
  })).catch(next);
});

router.get('/sessions/:id/export', async (req: Request, res: Response, next) => {
  try {
    const viewer = await viewerOf(req);
    const session = await loadSession(String(req.params.id));
    if (isUnavailable(session)) return unavailable(res, session);
    if (!maySeeSession(viewer, session.summary)) {
      return res.status(404).json({ ok: false, error: 'no such session' });
    }
    const kind = String(req.query.kind ?? 'session');
    const base = `${session.summary.sessionRef}-${kind}`;
    if (kind === 'tracks-csv') {
      const header = 'frame,timestamp,identity,track_id,team_id,role,'
        + 'image_x,image_y,pitch_x_m,pitch_y_m,calibration_chain,calibration_confidence,'
        + 'calibration_error_m\n';
      // An empty cell for a withheld coordinate, never a zero. A zero is a
      // position; an empty cell is the absence of one, and a spreadsheet that
      // averaged those zeros would be averaging the origin of the pitch.
      const rows = session.tracks.map((t) => [
        t.frameNumber, t.timestamp, t.identity, t.trackId, t.teamId ?? '', t.role,
        t.imageX, t.imageY, t.pitchXM ?? '', t.pitchYM ?? '',
        t.calibrationChain, t.calibrationConfidence, t.calibrationErrorM ?? '',
      ].join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
      return res.send(header + rows.join('\n') + '\n');
    }
    const payload =
      kind === 'tracks' ? { tracks: session.tracks }
        : kind === 'ball' ? { ball: session.ball }
          : kind === 'events' ? { events: session.events }
            : kind === 'calibration' ? { calibration: session.calibration }
              : kind === 'summary' ? { summary: session.summary }
                : kind === 'evidence' ? { evidence: evidenceFor(session) }
                  : session;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
    return res.send(JSON.stringify({
      exportedAt: new Date().toISOString(),
      sessionId: session.summary.sessionId,
      provenance: {
        sourceSha256: session.summary.source.sha256,
        pipelineVersion: session.summary.pipelineVersion,
        models: session.summary.models,
        processingTarget: session.summary.processingTarget,
      },
      ...payload,
    }, null, 1));
  } catch (err) { next(err); }
});

// ── the device, and the integration map ──────────────────────────────────────

router.get('/device', async (req: Request, res: Response, next) => {
  try {
    const engine = visionEngine();
    const [identity, telemetry] = await Promise.all([engine.identify(), engine.telemetry()]);
    res.json({
      ok: true,
      device: {
        ...identity,
        label: identity.deviceKind === 'SOFTWARE_DEVICE' ? 'SOFTWARE DEVICE' : 'VISION HUB',
        processingTarget: configuredTarget(),
      },
      telemetry,
    });
  } catch (err) { next(err); }
});

router.get('/integrations', async (_req: Request, res: Response, next) => {
  try {
    res.json({
      ok: true,
      events: visionEventCatalogue(),
      flow: [
        { stage: 'SOURCE', node: 'Camera / Video / Future Sensors', status: 'LIVE', detail: 'VIDEO_FILE only today' },
        { stage: 'SOURCE_CORE', node: 'Source Core', status: 'LIVE', detail: 'Vision registered on the Fabric source registry' },
        { stage: 'VISION', node: 'Familista Vision', status: 'LIVE', detail: 'engine contract, normaliser, session store' },
        { stage: 'FABRIC', node: 'Data Fabric', status: 'LIVE', detail: `${visionEventCatalogue().length} versioned event types` },
        { stage: 'VAULT', node: 'Data Vault', status: 'LIVE', detail: 'session facts persist as events; evidence is never rewritten' },
        { stage: 'INTELLIGENCE', node: 'Familista Intelligence', status: 'READY', detail: 'evidence interface available; no ratings are produced' },
        { stage: 'CONSUMERS', node: 'Clubs · Match Center · Video Intelligence · Training · Academy', status: 'READY', detail: 'authorised read paths; no unvalidated metric is injected' },
      ],
    });
  } catch (err) { next(err); }
});

export default router;
