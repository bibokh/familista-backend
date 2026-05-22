# Familista — Phase O · Production Reality Layer

> Production readiness reference. No new architecture, no theoretical layers — only the surfaces operators need to ship, secure, recover, and audit Familista in real-world clubs.
>
> Phase O is **additive** to every prior phase. The Tactical OS frontend (Phase H), all REST routes, audit chain (Phase I), approval gates, all models, and all sport adapters remain untouched.

---

## 1. What Phase O ships

| Domain | Surfaces |
| --- | --- |
| **RBAC** | `UserRole` enum extended with `MANAGER`, `COACH`, `PARENT`, `PLAYER` on top of existing `SUPER_ADMIN`, `CLUB_ADMIN`, `HEAD_COACH`, `ASSISTANT_COACH`, `ANALYST`, `MEDICAL_STAFF`, `SCOUT` (9 roles total). Per-route `authorize(…)` middleware in `src/routes/phase-o.routes.ts`. |
| **Auth sessions** | `AuthSession` + refresh-token rotation (`src/auth-prod/session.service.ts`). Tokens stored as sha256 hashes; parent linkage on rotation; per-user cap of 20 active sessions. |
| **MFA** | TOTP (RFC 6238) + 8 one-time backup codes (`src/auth-prod/mfa.service.ts`). AES-256-GCM secret encryption, no external dependencies. |
| **Club operations** | Guardians, training/match attendance, payment ledger, invoice lines (composes with Phase J `InvoiceDraft`), calendar (`src/operations/operations.service.ts`). |
| **Player lifecycle** | Onboarding workflow (6 default steps), recurring evaluations, contracts with €1M high-value approval gate (`src/player-lifecycle/player-lifecycle.service.ts`). |
| **Hardware deploy** | Serial-unique inventory, diagnostic reports, ESP32 workflow helper that composes with Phase L `HardwareProvisioningSession` (`src/hardware-deploy/hardware-deploy.service.ts`). |
| **Notifications + reports** | Per-user channels (EMAIL/SMS/PUSH/IN_APP/WEBHOOK), report templates (global + per-club), deterministic run ledger with output sha256 (`src/notifications/notifications.service.ts`). |
| **Governance** | Retention policies (per-club + global), GDPR requests (EXPORT/DELETE/RECTIFICATION/PORTABILITY), consent records (6 scopes). Every action audit-anchored (`src/governance/governance.service.ts`). |
| **Monitoring** | Health checks, alert rules, backup records (`src/monitoring/monitoring.service.ts`). Composes with Phase J `SystemMetric` / `RealtimeHealth`. |
| **Deployment automation** | `Dockerfile`, `docker-compose.yml`, `.github/workflows/{ci,deploy}.yml`, `scripts/{backup,restore,rollback}.sh`. |

---

## 2. Files created (Phase O)

```
prisma/schema.prisma                       (extended +23 models, +13 enums, UserRole+4)
schema.prisma                              (root mirror)
src/auth-prod/session.service.ts
src/auth-prod/mfa.service.ts
src/operations/operations.service.ts
src/player-lifecycle/player-lifecycle.service.ts
src/hardware-deploy/hardware-deploy.service.ts
src/notifications/notifications.service.ts
src/governance/governance.service.ts
src/monitoring/monitoring.service.ts
src/controllers/phase-o.controller.ts
src/routes/phase-o.routes.ts
src/routes/index.ts                        (mount /phase-o)
scripts/boot-probe.js                      (extended)
Dockerfile
.dockerignore
docker-compose.yml
.github/workflows/ci.yml
.github/workflows/deploy.yml
scripts/backup.sh
scripts/restore.sh
scripts/rollback.sh
docs/PHASE_O_PRODUCTION_READINESS.md       (this file)
```

No file from Phases B–N was modified except for the additive route mount in `src/routes/index.ts` and the additive probe list in `scripts/boot-probe.js`.

---

## 3. REST surface — `/api/v1/phase-o/*`

All endpoints sit behind `authenticate → tenantGuard → authorize(…)` and inherit Phase I's per-IP/per-user rate limiter.

```
# Auth — sessions
GET    /auth/sessions                                   (self; CLUB_ADMIN/SUPER_ADMIN may pass ?userId)
POST   /auth/sessions/rotate                            (body: { refreshToken })
DELETE /auth/sessions/:sessionId                        (self or admin)
DELETE /auth/users/:userId/sessions                     (CLUB_ADMIN/SUPER_ADMIN)

# Auth — MFA
POST   /auth/mfa/enroll                                 → { base32, otpauth }   (show once)
POST   /auth/mfa/confirm                                → { backupCodes }       (show once)
POST   /auth/mfa/verify                                 → { ok }
POST   /auth/mfa/disable

# Operations — guardians
POST   /ops/guardians
GET    /ops/guardians/:playerId
DELETE /ops/guardians/:id

# Operations — attendance
POST   /ops/attendance/training
GET    /ops/attendance/training/:sessionId
POST   /ops/attendance/match
GET    /ops/attendance/match/:matchId

# Operations — payments
POST   /ops/payments
PATCH  /ops/payments/:id/state
GET    /ops/payments

# Operations — invoice lines (composes with Phase J InvoiceDraft)
POST   /ops/invoices/:invoiceDraftId/lines
GET    /ops/invoices/:invoiceDraftId/lines

# Operations — calendar
POST   /ops/calendar
GET    /ops/calendar

# Player lifecycle — onboarding
POST   /lifecycle/onboarding/:playerId/seed
POST   /lifecycle/onboarding/:playerId/complete
GET    /lifecycle/onboarding/:playerId

# Player lifecycle — evaluations
POST   /lifecycle/evaluations
GET    /lifecycle/evaluations/:playerId

# Player lifecycle — contracts (high-value contracts auto-route through Phase I approval)
POST   /lifecycle/contracts
PATCH  /lifecycle/contracts/:id/state
GET    /lifecycle/contracts

# Hardware deploy
POST   /hw/inventory                                    (serial-unique upsert)
GET    /hw/inventory
POST   /hw/diagnostics
GET    /hw/diagnostics/:deviceId

# Notifications
POST   /notifications/channels
GET    /notifications/channels
POST   /notifications/report-templates
POST   /notifications/report-runs

# Governance — retention
POST   /governance/retention                            (global: SUPER_ADMIN only)
GET    /governance/retention

# Governance — GDPR (4 kinds)
POST   /governance/gdpr/requests
PATCH  /governance/gdpr/requests/:id/state
GET    /governance/gdpr/requests

# Governance — consent
POST   /governance/consent
GET    /governance/consent

# Monitoring
POST   /monitoring/health
GET    /monitoring/health/snapshot
POST   /monitoring/alert-rules                          (global: SUPER_ADMIN only)
PATCH  /monitoring/alert-rules/:id/state
GET    /monitoring/alert-rules
POST   /monitoring/backups                              (admin only)
GET    /monitoring/backups

# Aggregate
GET    /snapshot
```

---

## 4. Schema additions

23 new models, 13 new enums (all after `model TrustScore`). `UserRole` enum extended additively. No table renamed, no column dropped, no required field added to an existing table.

Migration is forward-compatible: `npx prisma migrate deploy` is the only command needed. Old clients keep working because every Phase O field is either nullable or has a default.

---

## 5. Deployment checklist

### 5.1. Pre-deploy (local)

- [ ] `git pull origin main && git status` — clean working tree.
- [ ] `npm ci` — install lockfile-pinned dependencies.
- [ ] `npx prisma format --schema=prisma/schema.prisma` — schema validates.
- [ ] `npx prisma generate --schema=prisma/schema.prisma` — client regenerates.
- [ ] `npx tsc --noEmit` — only the pre-existing `prisma/seed.ts` TS6059 warning is expected.
- [ ] `npm run build` — `dist/` produced cleanly.
- [ ] `node scripts/boot-probe.js` — exits 0; every probe responds with 2xx/4xx (no 5xx).
- [ ] Inspect `git diff` — review additive-only nature.

### 5.2. Render deploy

- [ ] Confirm `render.yaml` env vars are populated (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, etc.).
- [ ] **Take a manual `BackupRecord` (`POST /api/v1/phase-o/monitoring/backups`) tagged `kind=PRE_DEPLOY`** before merging.
- [ ] Merge to `main` → Render autoDeploy triggers.
- [ ] Watch `Render dashboard → familista-backend → Events`.
- [ ] Wait for `Build succeeded` then `Deploy live`.

### 5.3. Post-deploy verification

- [ ] `curl https://<host>/api/v1/health` → `{ "status": "ok" }`.
- [ ] `curl https://<host>/api/v1/phase-o/snapshot` with admin JWT → returns rollup counts.
- [ ] Audit chain still verifies: `POST /api/v1/security/audit/verify` → `{ ok: true, head: … }`.
- [ ] Tactical OS HTML loads: open the deployed frontend, confirm sport adapter dropdown still lists 7 sports.
- [ ] `node scripts/boot-probe.js` against the live host (set `host`/`port` overrides) — Phase O endpoints register.

---

## 6. Security checklist

- [ ] **Refresh tokens** never logged in plaintext. Hash-only at rest (`AuthSession.refreshHash`).
- [ ] **TOTP secrets** AES-256-GCM-encrypted; never returned after enroll/confirm.
- [ ] **Backup codes** sha256-hashed in `MFASetting.backupCodesHash`; plain values shown to user once.
- [ ] **JWT secrets** ≥ 64 bytes random, rotated quarterly via `JWT_ACCESS_SECRET` env update + rolling restart.
- [ ] **Sessions cap** at 20 per user (`MAX_SESSIONS_PER_USER`); oldest evicted on overflow.
- [ ] **Rate limit** verified active in production logs (Phase I `rateLimit` middleware).
- [ ] **Audit chain** verified before/after each deploy.
- [ ] **High-value contracts** (≥ €1M) route through Phase I `AIApprovalRequest`.
- [ ] **Global retention / alert rules** restricted to `SUPER_ADMIN`.
- [ ] **GDPR / consent** writes call `appendAuditEventAsync` — confirm rows appear in `SecurityAuditEvent`.
- [ ] **Tenant isolation** spot-checked: every Phase O service rejects cross-club reads/writes for non-SUPER_ADMIN.

---

## 7. Hardware rollout checklist (per device)

Use `POST /api/v1/phase-o/hw/inventory` and `POST /api/v1/phase-o/hw/diagnostics` to record each step.

| Step | Action | Verification |
| --- | --- | --- |
| 1 | **INVENTORY_RECEIVE** — upsert serial into `DeviceInventoryEntry` with `state=STOCK`. | `GET /hw/inventory?state=STOCK` shows the new row. |
| 2 | **HMAC_SECRET_BURN** — burn Phase F device HMAC into eFuse via Phase L provisioning session. | `recordEsp32Step(sessionId, { step: 'HMAC_SECRET_BURN', ok: true })`. |
| 3 | **CERT_INSTALL** — install client cert chain (`Cert` table from Phase J). | Inventory `state=DEPLOYED` after manifest issued. |
| 4 | **FIRMWARE_INSTALL** — flash latest `OTARelease` manifest. | Diagnostic report kind=`FIRMWARE_VERIFY` posted. |
| 5 | **SECURE_BOOT_SEAL** — irreversibly enable secure boot. | Phase L `HardwareAttestation` row marked verified. |
| 6 | **ACTIVATE** — call activation endpoint, device begins heartbeating. | Phase J `DeviceHealth` shows `online`. |
| 7 | Record `BackupRecord` of inventory snapshot post-rollout (optional). | `GET /monitoring/backups?kind=MANUAL`. |

RMA workflow:

- Update inventory: `state=RMA`, set `rmaReason`.
- Submit a final diagnostic report.
- Once disposed: `state=RETIRED`.

---

## 8. GDPR checklist (per request)

`POST /api/v1/phase-o/governance/gdpr/requests` opens a request. State machine: `PENDING → PROCESSING → COMPLETED | REJECTED`.

| Kind | Operator action | Audit |
| --- | --- | --- |
| `EXPORT` | Generate an archive of the subject's rows. PATCH state to `PROCESSING`, then `COMPLETED` with `resultRef` pointing to the archive. | `GDPR_REQUEST_OPENED:EXPORT` → `GDPR_REQUEST_COMPLETED` |
| `DELETE` | Verify retention policy. If permitted, soft-delete or anonymize. PATCH `COMPLETED`. | `GDPR_REQUEST_OPENED:DELETE` → `GDPR_REQUEST_COMPLETED` |
| `RECTIFICATION` | Apply corrections to user/player rows. PATCH `COMPLETED`. | `GDPR_REQUEST_OPENED:RECTIFICATION` → `GDPR_REQUEST_COMPLETED` |
| `PORTABILITY` | Produce a portable JSON export. PATCH `COMPLETED` with `resultRef`. | `GDPR_REQUEST_OPENED:PORTABILITY` → `GDPR_REQUEST_COMPLETED` |

Consent management:

- `POST /governance/consent` with `granted=true|false` and `scope=MEDICAL|MARKETING|DATA_SHARING|RESEARCH|IMAGE_USE|CUSTOM`.
- Revoking sets `revokedAt` server-side and logs `CONSENT_REVOKED`.
- `GET /governance/consent?playerId=…` returns the canonical consent timeline.

Retention enforcement (manual today; scheduled-task automation deferred):

- `POST /governance/retention` declares the policy `{ entityType, retentionDays, global? }`.
- A cron job (or admin run) deletes / archives rows older than the policy.
- Every delete writes a `SecurityAuditEvent` referencing the policy ID.

---

## 9. Operational checklist (daily / weekly)

| Cadence | Task | Endpoint / command |
| --- | --- | --- |
| Daily | Health snapshot review | `GET /monitoring/health/snapshot` |
| Daily | GDPR queue under SLA | `GET /governance/gdpr/requests?state=PENDING` (count ≤ 5 fresh) |
| Daily | Active alert rules unmuted | `GET /monitoring/alert-rules` → no surprises |
| Weekly | Backups present | `GET /monitoring/backups?kind=SCHEDULED` (≥ 7 rows past week) |
| Weekly | Audit chain verification | `POST /api/v1/security/audit/verify` |
| Weekly | Session ramp | `GET /auth/sessions?userId=<su>` — confirm SUPER_ADMIN sessions reasonable |
| Monthly | Rotate JWT secrets | Update Render env vars; rolling restart |
| Monthly | Restore drill on staging | `scripts/restore.sh` against staging DB from latest backup |
| Quarterly | Pen-test against `/api/v1/phase-o/*` | Pentest report attached to BackupRecord notes |

---

## 10. Launch checklist (go-live)

- [ ] Render service has `autoDeploy=true` and a Postgres `standard` plan in the same region.
- [ ] `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` set, ≥ 64 random bytes each.
- [ ] First SUPER_ADMIN seeded (`scripts/seed-platform-admin.sql`).
- [ ] First SUPER_ADMIN enrols MFA (`POST /auth/mfa/enroll` → `/confirm`) — backup codes printed and stored offline.
- [ ] Default retention policies created for: `PlayerEvaluationRecord` (1825 days), `TrainingAttendanceRecord` (1095 days), `OperationsPayment` (3650 days).
- [ ] Initial alert rules: `auth_failures_spike`, `gdpr_queue_age`, `backup_overdue`.
- [ ] At least one `kind=SCHEDULED` backup recorded.
- [ ] Tactical OS frontend loads at `/`; live matches strip renders.
- [ ] Boot probe green from a fresh container build (`docker compose up --build`).
- [ ] Rollback playbook reviewed: `scripts/rollback.sh` dry-run against staging.

---

## 11. Disaster recovery — RTO / RPO targets

| Target | Value | Mechanism |
| --- | --- | --- |
| RPO (data loss tolerance) | ≤ 1 hour | hourly `scripts/backup.sh` cron + Render's managed PITR |
| RTO (recovery time) | ≤ 30 minutes | `scripts/restore.sh` on a fresh standby, then `scripts/rollback.sh` to last green SHA |
| Audit-chain proof | continuous | Phase I chain verifies every event against prior SHA-256 |

Rehearse the full sequence (backup → restore → boot probe → audit verify) at least once per quarter on staging. Record each rehearsal as a `BackupRecord` with `notes='rehearsal'`.

---

## 12. What Phase O explicitly does **not** ship

- No payment gateway integration. `OperationsPayment` is a ledger; Stripe/Paddle/etc. integrations are Phase P+.
- No notification dispatch worker. Phase O registers `UserNotificationChannel` rows; dispatching emails/SMS/push is a future worker.
- No automatic retention-policy enforcement worker. Schema + endpoints exist; a scheduled job is deferred.
- No Tactical OS UI changes — per the user's constraint, the elite frontend is untouched.

These are intentional. Phase O is the operator-facing surface and the contract for downstream automation, not the automation itself.

---

## 13. Migration command (final)

```bash
# 1. format + regenerate
npx prisma format --schema=prisma/schema.prisma
npx prisma generate --schema=prisma/schema.prisma

# 2. type-check + boot probe
npx tsc --noEmit                          # only seed.ts TS6059 expected
npm run build
node scripts/boot-probe.js                # all probes < 500

# 3. (in CI / on Render) migrate
npx prisma migrate deploy --schema=prisma/schema.prisma

# 4. commit + deploy
git add -A
git commit -m "phase-o: production reality layer (auth/mfa/ops/lifecycle/hw/notif/gov/monitoring)"
git push origin main
# Render autoDeploy now picks up the change.
```

---

## 14. Verification matrix

| Concern | Verified by |
| --- | --- |
| Schema integrity | `npx prisma format` (Phase O) |
| Type safety | `npx tsc --noEmit` |
| Route registration | `scripts/boot-probe.js` (probes 401 ≠ 500) |
| Auth flow | manual `/auth/sessions/rotate` round-trip in staging |
| MFA flow | manual enroll → confirm → verify in staging |
| Audit-chain anchoring | `POST /api/v1/security/audit/verify` after Phase O writes |
| Tenant isolation | targeted cross-club POSTs return 403 |
| Approval gating | high-value contract draft creates a Phase I AIApprovalRequest |
| GDPR audit | `GET /api/v1/security/audit?action=GDPR_REQUEST_OPENED:EXPORT` returns the event |
| Backup integrity | `scripts/backup.sh` → `scripts/restore.sh` → boot probe green |

---

Phase O is production-ready.
