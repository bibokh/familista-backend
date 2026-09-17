// Familista — the Infrastructure City API
// ─────────────────────────────────────────────────────────────────────────────
// Seven reads and one acknowledgement, all of them the platform owner's, behind
// the SAME guard the rest of SYSTEM and the Data Vault use. There is no second
// authorization model here and no club role reaches any of it however senior it
// is inside its club.
//
// WHAT THESE RETURN
//
// Architectural METADATA and measured TELEMETRY. The manifest describes what
// the repository contains; the health layer describes how it is behaving. What
// never travels: an environment value, a connection string, a key, a token, or
// anything a user typed. The discovery script refuses to write a manifest
// containing a secret-shaped value, and the values themselves are never read
// into the process in the first place — only the presence of a variable NAME.
//
// WHY A STREAM RATHER THAN A POLL
//
// The platform already serves Server-Sent Events for the live data board
// (`data-pulse.routes.ts`), so this reuses that shape rather than inventing a
// second transport or asking the browser to poll. The stream carries a full
// health frame on an interval the SERVER controls, which means a slow platform
// slows its own telemetry instead of being hammered by a fast client.

import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import {
  infrastructureRegistry, manifestOrNull, componentById,
  dependenciesOf, dependentsOf, technologyUsage, cityLayout,
} from '../infra/infrastructure-registry.service';
import {
  infrastructureHealth, infrastructureSignals, evaluate,
  openIncidents, resolvedIncidents, acknowledgeIncident,
  INFRASTRUCTURE_RULES, THRESHOLDS,
} from '../infra/infrastructure-health.service';
import { queryHistory } from '../fabric/history/history-query.service';

const router = Router();
router.use(authenticate);

router.use(async (req: Request, res: Response, next) => {
  try {
    const u = (req as Request & { user?: { id?: string; clubId?: string; role?: string } }).user;
    await assertPlatformOwner({ userId: u?.id ?? '', clubId: u?.clubId ?? null, role: u?.role });
    next();
  } catch (err) { next(err); }
});

/** The manifest has not been generated. One shape, so every route says it the same way. */
function notGenerated(res: Response, detail: { reason: string; remedy: string }): void {
  res.json({
    success: true,
    data: {
      state: 'NOT_GENERATED',
      reason: detail.reason,
      remedy: detail.remedy,
      note: 'Infrastructure City renders nothing rather than guessing at an architecture.',
    },
  });
}

/**
 * THE INVENTORY — what the repository proves exists.
 *
 * Generated at build from package.json, the lockfile, tsconfig, the Prisma
 * schema, render.yaml, the workflows and the mounted routers. Every component
 * carries the file that proves it.
 */
router.get('/', (_req: Request, res: Response) => {
  const reg = infrastructureRegistry();
  if (reg.state !== 'READY') return notGenerated(res, reg);
  res.json({
    success: true,
    data: {
      state: 'READY',
      generatedAt: reg.manifest.generatedAt,
      loadedAt: reg.loadedAt,
      platform: reg.manifest.platform,
      districts: reg.manifest.districts,
      components: reg.manifest.components,
      // The roads, not only the buildings. The city draws its Connections list,
      // its Change Impact paths and the dependency highlight an alert lights up
      // from these; without them three features render empty rather than fail,
      // which is the worse way to be broken.
      relationships: reg.manifest.relationships,
      future: reg.manifest.future,
      counts: reg.manifest.counts,
      surface: reg.manifest.surface,
      database: reg.manifest.database,
      typescript: reg.manifest.typescript,
      deployment: reg.manifest.deployment,
      ci: reg.manifest.ci,
      environment: reg.manifest.environment,
      evidence: reg.manifest.evidence,
      layout: cityLayout(),
    },
  });
});

/**
 * LIVE HEALTH — measured now, from what the platform already measures.
 *
 * Each signal carries the numbers it was derived from and the source of those
 * numbers. A signal nothing measures reports NOT_INSTRUMENTED rather than a
 * comfortable green.
 */
router.get('/health', async (_req: Request, res: Response, next) => {
  try {
    res.json({ success: true, data: await infrastructureHealth() });
  } catch (err) { return next(err); }
});

/**
 * TOPOLOGY — the dependency graph, with live state joined onto it.
 *
 * Nodes are manifest components; edges are relationships the repository proves.
 * An edge whose either end does not exist was already dropped at build, so a
 * road here always leads somewhere.
 */
router.get('/topology', async (_req: Request, res: Response, next) => {
  try {
    const m = manifestOrNull();
    if (!m) return notGenerated(res, infrastructureRegistry() as never);

    const signals = await infrastructureSignals();
    const byKey = new Map(signals.map((s) => [s.key, s]));

    res.json({
      success: true,
      data: {
        nodes: m.components.map((c) => ({
          id: c.id, name: c.name, district: c.district, category: c.category,
          type: c.type, status: c.status, version: c.version,
          provider: c.provider, region: c.region,
          health: c.healthKey ? (byKey.get(c.healthKey)?.state ?? 'UNKNOWN') : 'NOT_INSTRUMENTED',
          dependencies: dependenciesOf(c.id),
          dependents: dependentsOf(c.id),
        })),
        edges: m.relationships,
        districts: m.districts,
        future: m.future,
      },
    });
  } catch (err) { return next(err); }
});

/**
 * INCIDENTS — derived from rules, deduplicated, and kept after they recover.
 *
 * `rules` travels with them so an operator can read the exact condition that
 * fired. A threshold nobody can see is folklore.
 */
router.get('/incidents', async (_req: Request, res: Response, next) => {
  try {
    evaluate(await infrastructureSignals());
    res.json({
      success: true,
      data: {
        open: openIncidents(),
        resolved: resolvedIncidents(),
        rules: INFRASTRUCTURE_RULES,
        thresholds: THRESHOLDS,
        // Said on every response, because it changes what the reader can rely on.
        scope: 'PROCESS',
        scopeNote: 'Acknowledgement is held in this server process and does not survive a restart. '
          + 'Incident transitions are published to the Data Fabric and persist in the Historical Event Store.',
      },
    });
  } catch (err) { return next(err); }
});

/**
 * Acknowledge an incident.
 *
 * The one write on this router, and it changes nothing outside this process:
 * no infrastructure is touched, nothing is restarted, no dependency is
 * upgraded. Those remain the owner's to do elsewhere.
 */
router.post('/incidents/:id/acknowledge', (req: Request, res: Response) => {
  const inc = acknowledgeIncident(String(req.params.id ?? ''));
  if (!inc) {
    return res.status(404).json({
      success: false,
      message: 'No open incident with that id. It may have resolved, or the process may have restarted.',
    });
  }
  return res.json({ success: true, data: { incident: inc, scope: 'PROCESS' } });
});

/**
 * TECHNOLOGY MAP — every verified technology, and what uses it.
 *
 * `usedBy` is widened from the districts the discovery script could prove to
 * the components inside them, which is the question the map actually answers.
 */
router.get('/technology', (_req: Request, res: Response) => {
  const m = manifestOrNull();
  if (!m) return notGenerated(res, infrastructureRegistry() as never);

  return res.json({
    success: true,
    data: {
      technologies: m.technologies.map((t) => ({ ...t, usage: technologyUsage(t.id) })),
      dependencies: m.dependencies,
      // Stated rather than implied: no scanner runs in this build, so the
      // absence of findings is the absence of a scanner, not a clean bill.
      vulnerabilityScanning: {
        state: 'NOT_INSTRUMENTED',
        note: 'CI runs `npm audit --audit-level=high || true`, which reports but never fails and whose '
          + 'result is not readable from the running server. No advisory data is available here.',
        evidence: '.github/workflows/ci.yml',
      },
      lint: {
        state: 'NOT_CONFIGURED',
        note: 'No ESLint configuration exists in the repository.',
        evidence: 'absence of .eslintrc* / eslint.config.*',
      },
      coverage: {
        state: 'NOT_INSTRUMENTED',
        note: 'jest.config.ts sets collectCoverage: false.',
        evidence: 'jest.config.ts',
      },
    },
  });
});

/**
 * CHANGES — what actually changed, from the platform's own history.
 *
 * The Historical Event Store is the source, which is the honest one: it holds
 * the transitions this service published and the deployment and configuration
 * events the platform publishes elsewhere. Nothing here infers a change from a
 * file timestamp or claims a runtime impact it cannot measure.
 */
router.get('/changes', async (req: Request, res: Response, next) => {
  try {
    const m = manifestOrNull();
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);

    // One query per infrastructure-shaped type, bounded and indexed.
    const types = ['system.health.changed', 'system.deploy.completed', 'system.deploy.failed',
      'system.deploy.started', 'system.config.changed',
      'system.integration.connected', 'system.integration.disconnected'];

    const pages = await Promise.all(types.map((eventType) =>
      queryHistory({ eventType, from: since, limit: Math.ceil(limit / types.length) })
        .catch(() => ({ rows: [], nextCursor: null, more: false }))));

    const rows = pages.flatMap((p) => p.rows)
      .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)))
      .slice(0, limit);

    return res.json({
      success: true,
      data: {
        changes: rows,
        window: { from: since.toISOString(), to: new Date().toISOString() },
        source: 'Historical Event Store',
        build: m ? {
          manifestGeneratedAt: m.generatedAt,
          platformVersion: m.platform.version,
          latestMigration: m.database.latestMigration,
        } : null,
        // The one thing a CI green tick must never be read as.
        deployment: {
          state: 'UNVERIFIED',
          note: 'Render deploys are not observable from this process. A green CI run is not a live deployment.',
        },
      },
    });
  } catch (err) { return next(err); }
});

/**
 * One component, in full.
 *
 * Everything the inspector draws, assembled server-side so the browser never
 * has to join the manifest against the health frame itself.
 */
router.get('/components/:id', async (req: Request, res: Response, next) => {
  try {
    const id = String(req.params.id ?? '');
    const c = componentById(id);
    if (!c) return res.status(404).json({ success: false, message: 'No such component in the manifest.' });

    const signals = await infrastructureSignals();
    const signal = c.healthKey ? signals.find((s) => s.key === c.healthKey) ?? null : null;
    const incidents = [...openIncidents(), ...resolvedIncidents()].filter((i) => i.componentId === id);

    return res.json({
      success: true,
      data: {
        component: c,
        health: signal,
        dependencies: dependenciesOf(id).map((d) => componentById(d)).filter(Boolean),
        dependents: dependentsOf(id).map((d) => componentById(d)).filter(Boolean),
        incidents,
        rules: INFRASTRUCTURE_RULES.filter((r) => r.componentId === id),
      },
    });
  } catch (err) { return next(err); }
});

/**
 * THE LIVE STREAM.
 *
 * Server-Sent Events, the same shape the live data board already uses. A full
 * health frame on a server-controlled interval: the browser cannot ask faster,
 * and a degraded platform slows its own telemetry rather than being polled
 * harder while it struggles.
 */
router.get('/stream', async (req: Request, res: Response) => {
  const intervalMs = Math.min(Math.max(Number(process.env.INFRA_STREAM_MS ?? 15_000), 5_000), 60_000);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let open = true;
  const send = (event: string, data: unknown): void => {
    if (!open) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch { open = false; }
  };

  try { res.write(`retry: ${Math.max(3000, Math.round(intervalMs / 2))}\n\n`); } catch { open = false; }

  const tick = async (): Promise<void> => {
    if (!open) return;
    try {
      send('health', await infrastructureHealth());
    } catch (err) {
      send('error', { message: String((err as Error)?.message ?? 'health read failed').slice(0, 200) });
    }
  };

  await tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  const close = (): void => {
    open = false;
    clearInterval(timer);
    try { res.end(); } catch { /* the socket is already gone */ }
  };
  req.on('close', close);
  req.on('error', close);
});

export default router;
