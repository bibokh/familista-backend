// Familista — White-label Engine
// Wiring patch for src/routes/index.ts. Apply the two marked lines.
//
// This file is documentation, not runtime code. Treat it as a guide diff.

/* ─── Add import (alongside other route imports) ─────────────────────────── */
// import whitelabelRoutes from './whitelabel.routes';

/* ─── Mount under /api/v1/whitelabel ─────────────────────────────────────── */
// router.use('/whitelabel', whitelabelRoutes);

/* ─── Full example after patch ────────────────────────────────────────────── */
/*
import { Router } from 'express';
import authRoutes from './auth.routes';
import clubRoutes from './clubs.routes';
import playerRoutes from './player.routes';
// ...existing imports...
import whitelabelRoutes from './whitelabel.routes';

const router = Router();

router.get('/health', (_req, res) => res.json({ ok: true }));

router.use('/auth', authRoutes);
router.use('/clubs', clubRoutes);
router.use('/players', playerRoutes);
// ...existing routes...
router.use('/whitelabel', whitelabelRoutes);

export default router;
*/

/* ─── CORS note ──────────────────────────────────────────────────────────────
 *
 * The public theme resolver is intentionally reachable without credentials.
 * If you serve the SPA from custom tenant domains, ensure the API CORS config
 * accepts requests with `Origin: https://<tenant-host>`. In app.ts the current
 * setting `origin: true` already reflects the request origin, which is correct
 * for white-label tenants.
 *
 * If you later tighten CORS to a fixed allowlist, derive the allowlist from
 * WhiteLabelDomain rows where status = ACTIVE.
 *
 * ─── Reverse proxy / TLS ────────────────────────────────────────────────────
 *
 * Custom tenant hostnames must reach this service. Two production patterns:
 *
 *   1. Wildcard CNAME to Render (or your proxy) + on-demand TLS at the proxy
 *      (e.g. Caddy with `tls { on_demand }` and an `ask` endpoint that hits
 *      /api/v1/whitelabel/public/resolve to confirm the tenant is real).
 *
 *   2. Per-tenant CNAME + Cloudflare for SaaS / Render custom domains, with
 *      one cert per domain provisioned out-of-band.
 *
 * In either case the backend's job ends at "domain → active config". TLS
 * issuance lives in the proxy layer.
 */
