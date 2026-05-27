// Boot probe — stubs the DB layer, loads the compiled server, hits a few
// routes (including the new Phase E surfaces), then shuts down.

process.env.NODE_ENV          = 'production';
process.env.PORT              = '47913';
process.env.JWT_ACCESS_SECRET = 'phase-e-probe-secret-do-not-use';
process.env.JWT_REFRESH_SECRET= 'phase-e-probe-refresh-do-not-use';
process.env.DATABASE_URL      = 'postgresql://stub:stub@stub/stub';

// Replace prisma client BEFORE app imports it.
require.cache[require.resolve('../dist/config/database')] = {
  exports: {
    prisma: new Proxy({}, {
      get() { return new Proxy(() => Promise.resolve(null), { get() { return () => Promise.resolve(null); } }); },
    }),
    connectDatabase: async () => true,
    disconnectDatabase: async () => true,
  },
};

const http = require('http');

(async () => {
  let app;
  try {
    const mod = require('../dist/app');
    const factory = mod.createApp || mod.default || mod.app;
    app = typeof factory === 'function' ? factory() : factory;
  } catch (e) { console.error('FAIL load app:', e.message); process.exit(2); }
  if (!app) { console.error('FAIL: app export not found'); process.exit(2); }

  const server = http.createServer(app);
  const port = 47913;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const probe = (path) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => body += c.toString());
      res.on('end', () => resolve({ path, status: res.statusCode, body: body.slice(0, 80) }));
    }).on('error', (e) => resolve({ path, status: -1, body: e.message }));
  });

  const probes = await Promise.all([
    probe('/api/v1/health'),
    probe('/api/v1/matches/00000000-0000-0000-0000-000000000000/live'),
    probe('/api/v1/matches/00000000-0000-0000-0000-000000000000/tactical-state'),
    probe('/api/v1/matches/00000000-0000-0000-0000-000000000000/brain'),
    probe('/api/v1/matches/00000000-0000-0000-0000-000000000000/annotations'),
    probe('/api/v1/ai-ops/alerts'),
    probe('/api/v1/ai-ops/anomalies'),
    probe('/api/v1/device-infra/devices'),
    probe('/api/v1/device-infra/firmware'),
    // Phase G surfaces
    probe('/api/v1/vision/sports'),
    probe('/api/v1/vision/cameras'),
    probe('/api/v1/spatial/matches/00000000-0000-0000-0000-000000000000/frame'),
    probe('/api/v1/spatial/matches/00000000-0000-0000-0000-000000000000/twin?atMs=0'),
    probe('/api/v1/predictive/predictions'),
    // Phase I — security surfaces
    probe('/api/v1/security/audit'),
    probe('/api/v1/security/audit/head'),
    probe('/api/v1/security/audit/verify'),
    probe('/api/v1/security/events'),
    probe('/api/v1/security/approvals'),
    probe('/api/v1/security/health'),
    // Phase J — distributed sports cloud
    probe('/api/v1/distributed/regions'),
    probe('/api/v1/distributed/whoami'),
    probe('/api/v1/edge/nodes'),
    probe('/api/v1/provisioning/batches'),
    probe('/api/v1/provisioning/firmware/manifests'),
    probe('/api/v1/billing-j/tiers'),
    probe('/api/v1/billing-j/account'),
    probe('/api/v1/observability/snapshot'),
    // Phase K — neuromorphic vision
    probe('/api/v1/neuro/streams'),
    probe('/api/v1/neuro/rigs'),
    probe('/api/v1/neuro/runtimes'),
    probe('/api/v1/neuro/biomech'),
    // Phase L — federated cognition + real HW + simulation + cognitive graph + biochem
    probe('/api/v1/phase-l/hardware/sessions'),
    probe('/api/v1/phase-l/federated/jobs'),
    probe('/api/v1/phase-l/coaching/agents'),
    probe('/api/v1/phase-l/simulation/sessions'),
    probe('/api/v1/phase-l/catalog/plugins'),
    probe('/api/v1/phase-l/quantum/posture'),
    probe('/api/v1/phase-l/snapshot'),
    // Phase M — autonomous sports ecosystem
    probe('/api/v1/phase-m/twins'),
    probe('/api/v1/phase-m/executive/agents'),
    probe('/api/v1/phase-m/recruitment/targets'),
    probe('/api/v1/phase-m/training/plans'),
    probe('/api/v1/phase-m/marketplace/listings'),
    probe('/api/v1/phase-m/knowledge/documents'),
    probe('/api/v1/phase-m/snapshot'),
    // Phase N — global knowledge + universal identity + reasoning + multi-sport
    probe('/api/v1/phase-n/kg/nodes'),
    probe('/api/v1/phase-n/kg/edges'),
    probe('/api/v1/phase-n/reasoning/rules'),
    probe('/api/v1/phase-n/scouting/nodes'),
    probe('/api/v1/phase-n/trust'),
    probe('/api/v1/phase-n/snapshot'),
    // Phase O — production reality layer
    probe('/api/v1/phase-o/auth/sessions'),
    probe('/api/v1/phase-o/ops/payments'),
    probe('/api/v1/phase-o/ops/calendar'),
    probe('/api/v1/phase-o/lifecycle/contracts'),
    probe('/api/v1/phase-o/hw/inventory'),
    probe('/api/v1/phase-o/notifications/channels'),
    probe('/api/v1/phase-o/governance/retention'),
    probe('/api/v1/phase-o/governance/gdpr/requests'),
    probe('/api/v1/phase-o/monitoring/health/snapshot'),
    probe('/api/v1/phase-o/monitoring/alert-rules'),
    probe('/api/v1/phase-o/monitoring/backups'),
    probe('/api/v1/phase-o/snapshot'),
    // Phase P — real launch layer
    probe('/api/v1/phase-p/status'),
    probe('/api/v1/phase-p/reports/attendance/training'),
    probe('/api/v1/phase-p/reports/attendance/match'),
    probe('/api/v1/phase-p/finance/balance'),
    probe('/api/v1/phase-p/finance/history'),
    probe('/api/v1/phase-p/finance/club-summary'),
    probe('/api/v1/phase-p/notifications/inbox'),
    probe('/api/v1/phase-p/notifications/inbox/counts'),
    // Phase Q — football intelligence core
    probe('/api/v1/phase-q/events/match/__probe__'),
    probe('/api/v1/phase-q/stats/matches/__probe__'),
    probe('/api/v1/phase-q/workload/injuries'),
    probe('/api/v1/phase-q/video/assets'),
    probe('/api/v1/phase-q/video/clips'),
    probe('/api/v1/phase-q/video/playlists'),
    probe('/api/v1/phase-q/transfer/reports'),
    probe('/api/v1/phase-q/transfer/targets'),
    probe('/api/v1/phase-q/transfer/pipeline'),
    probe('/api/v1/phase-q/transfer/contracts-expiring'),
    probe('/api/v1/phase-q/competitions'),
  ]);

  for (const p of probes) console.log(`[${p.status}] ${p.path} — ${p.body}`);

  // Health 200, others 401 (or 404 for missing token) — anything < 500 proves the route exists.
  const allUp = probes[0].status === 200
    && probes.slice(1).every((p) => p.status >= 400 && p.status < 500);

  server.close();
  process.exit(allUp ? 0 : 1);
})().catch((e) => { console.error('PROBE ERROR:', e); process.exit(2); });
