// Familista — Super Admin White-label Control Panel
// Wiring patch and operational notes. Treat as documentation, not runtime code.

/* ──────────────────────────────────────────────────────────────────────────── *
 *  1. routes/index.ts — mount the admin router
 * ──────────────────────────────────────────────────────────────────────────── */
// import adminRoutes from './admin.routes';
// router.use('/admin', adminRoutes);

/* ──────────────────────────────────────────────────────────────────────────── *
 *  2. Required NPM packages
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *    npm i multer @aws-sdk/client-s3
 *    npm i -D @types/multer
 *
 *  Optional (image dimension probe for uploaded logos):
 *    npm i sharp
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  3. Static file serving (LOCAL storage backend only)
 * ──────────────────────────────────────────────────────────────────────────── *
 *  Asset URLs default to `/uploads/whitelabel/<configId>/<filename>`.
 *  Add to app.ts BEFORE the API routes, only when WL_ASSETS_BACKEND is LOCAL:
 */
// import path from 'path';
// const uploadsDir = process.env.WL_ASSETS_DIR ?? path.resolve(process.cwd(), 'uploads');
// app.use('/uploads', express.static(uploadsDir, {
//   maxAge: '1y',
//   immutable: true,
//   index: false,
//   dotfiles: 'deny',
//   setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
// }));

/* ──────────────────────────────────────────────────────────────────────────── *
 *  4. Existing service hooks (one-time edits)
 * ──────────────────────────────────────────────────────────────────────────── */

/*
 * 4a. services/auth.service.ts — add `signImpersonationToken`
 *
 *     export async function signImpersonationToken(
 *       payload: {
 *         sub: string;
 *         clubId: string;
 *         role: UserRole;
 *         impersonatedBy: { adminId: string; userId: string };
 *       },
 *       ttlSeconds: number,
 *     ): Promise<string> {
 *       return jwt.sign(payload, config.jwt.accessSecret, {
 *         expiresIn: ttlSeconds,
 *         issuer: config.jwt.issuer,
 *         audience: 'familista-impersonation',
 *       });
 *     }
 *
 * 4b. middleware/auth.middleware.ts — recognise impersonation tokens
 *     When `decoded.impersonatedBy` is present, validate against
 *     `imperSvc.findActiveByToken(rawJwt)` and inject into `req.user`:
 *
 *       req.user = {
 *         id: decoded.sub,
 *         clubId: decoded.clubId,
 *         role: decoded.role,
 *         impersonatedBy: decoded.impersonatedBy,    // surface to handlers
 *       };
 *
 *     and write a per-request audit entry on every impersonated call.
 *
 * 4c. webhooks/stripe.webhook.ts — respect override
 *     Before mutating Club.plan / Club.subscriptionStatus, check:
 *
 *       const club = await prisma.club.findUnique({
 *         where: { id: clubId },
 *         select: { planSource: true },
 *       });
 *       if (club?.planSource === 'OVERRIDE') return;   // skip, override wins
 *
 * 4d. services/pdf.service.ts — replace hard-coded brand with adapter call
 *
 *       import { getPdfBranding } from './pdf-branding.service';
 *       const brand = await getPdfBranding(clubId);
 *       doc.fillColor(brand.colors.primary).font(brand.fontFamily);
 *       if (brand.logo) doc.image(brand.logo.buffer, x, y, { width: 80 });
 *       doc.text(brand.footerText);
 *
 * 4e. services/email.service.ts — wrap outgoing HTML with branding
 *
 *       import { getEmailBranding, wrapEmailHtml } from './email-branding.service';
 *       const brand = await getEmailBranding(clubId);
 *       await transporter.sendMail({
 *         from: `"${brand.fromName}" <${brand.fromEmail}>`,
 *         replyTo: brand.replyTo ?? undefined,
 *         subject,
 *         html: wrapEmailHtml(brand, bodyHtml),
 *       });
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  5. Bootstrap seeds (run once after migrate)
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Either via a CLI script, or expose admin endpoints (already wired):
 *    POST /api/v1/admin/whitelabel/palettes/seed-presets
 *    POST /api/v1/admin/feature-flags/seed
 *
 *  Or call from seed.ts:
 *    import { seedSystemPalettes } from './services/admin-branding.service';
 *    import { seedBuiltinFlags } from './services/admin-feature-flag.service';
 *    await seedSystemPalettes();
 *    await seedBuiltinFlags();
 *
 *  First platform owner — create directly in DB or via psql:
 *    INSERT INTO "PlatformAdmin" (id, "userId", role, "mfaEnforced", "isActive")
 *    VALUES (gen_random_uuid(), '<existing-super-admin-user-id>',
 *            'PLATFORM_OWNER', true, true);
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  6. Background jobs (cron / scheduler)
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Add to your job scheduler (every 5–15 min):
 *    import { reapExpiredImpersonations } from './services/admin-impersonation.service';
 *    import { expireStaleOverrides } from './services/admin-organization.service';
 *    import { recheckStaleDomains } from './services/whitelabel.service';
 *
 *    setInterval(async () => {
 *      await reapExpiredImpersonations();
 *      await expireStaleOverrides();
 *      await recheckStaleDomains(60);
 *    }, 5 * 60 * 1000);
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  7. Operator MFA freshness
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  `requirePlatformRole` rejects when MFA is older than 15 minutes for any
 *  admin with `mfaEnforced=true`. Your auth flow must set
 *  `req.user.mfaVerifiedAt` after a successful MFA challenge. Two integration
 *  options:
 *    a) Mint an MFA cookie / claim after challenge; auth middleware reads it
 *       onto req.user.
 *    b) Mark the User row with `mfaVerifiedAt: Date` per session and refresh on
 *       challenge; auth middleware projects it onto req.user.
 *
 *  For initial bootstrap (no MFA infra yet), set `mfaEnforced: false` on the
 *  first owner. Re-enable as soon as MFA is wired.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  8. CORS — admin endpoints
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  The operator console is presumed to run on a fixed admin origin (e.g.
 *  https://admin.familista.app). Tighten CORS for `/api/v1/admin` to that
 *  exact origin, while leaving the public theme resolver open. Example:
 *
 *    app.use('/api/v1/admin', cors({ origin: 'https://admin.familista.app', credentials: true }));
 *    app.use('/api/v1', cors({ origin: true, credentials: true }));
 */
