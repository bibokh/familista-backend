# Familista — Phase P · Real Launch Handbook (FC Familista)

> Operational handbook for bringing FC Familista live on the Familista platform. No new architecture — this document explains how to deploy, seed, operate, and recover the system using the surfaces shipped in Phases A–O.

---

## 0. What Phase P adds

| Surface | Files |
| --- | --- |
| In-app notification model | `prisma/schema.prisma` → `model UserNotification` + `enum UserNotificationKind` |
| Idempotent seed | `src/launch/seed-fc-familista.service.ts` + `prisma/seeds/fc-familista.ts` |
| Attendance reports | `src/launch/attendance-report.service.ts` |
| Payer balance + history + ops summary | `src/launch/balance.service.ts` |
| In-app inbox | `src/launch/notifications-inbox.service.ts` |
| Production status rollup | `src/launch/status.service.ts` |
| Controller + routes | `src/controllers/phase-p.controller.ts` + `src/routes/phase-p.routes.ts` mounted at `/api/v1/phase-p` |
| Preflight script | `scripts/preflight-prod.sh` |
| npm scripts | `db:seed:fc-familista`, `preflight` |
| Boot probe | extended with 8 Phase P probes |

Tactical OS (Phase H) is untouched. No Phase A–O code is modified.

---

## 1. Render deployment steps

1. **Create / verify Render Postgres** — `familista-postgres` in `frankfurt`, plan `standard`, Postgres 16, private network only (`ipAllowList: []`). The `render.yaml` already declares this.

2. **Create / verify web service** — `familista-backend`, runtime Node, region `frankfurt`, plan `standard`, branch `main`, autoDeploy on.

3. **Environment variables** — open Render dashboard → Service → Environment, paste / verify:

   | Key | Value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `PORT` | `10000` |
   | `API_VERSION` | `v1` |
   | `DATABASE_URL` | (from Postgres binding) |
   | `JWT_ACCESS_SECRET` | random ≥ 64 bytes |
   | `JWT_REFRESH_SECRET` | random ≥ 64 bytes |
   | `JWT_ACCESS_TTL` | `15m` |
   | `JWT_REFRESH_TTL` | `7d` |
   | `JWT_ISSUER` | `familista` |
   | `RATE_LIMIT_WINDOW_MS` | `60000` |
   | `RATE_LIMIT_MAX` | `300` |
   | `FC_FAMILISTA_ADMIN_EMAIL` | `admin@fcfamilista.local` (or your real one) |
   | `FC_FAMILISTA_ADMIN_PASSWORD` | strong ≥ 12 chars (used only during seed) |
   | `FC_FAMILISTA_DEFAULT_PASSWORD` | strong ≥ 12 chars (default for coaches/parents) |
   | `FC_FAMILISTA_SEED_CONFIRM` | `yes` (only set when actually seeding) |

   **Never commit these to git.** All `sync: false` entries in `render.yaml` are populated through the dashboard.

4. **Build command** — already set in `render.yaml`:
   ```
   npm install && npx prisma migrate deploy && npx prisma generate && npm run build
   ```

5. **Start command** — `node dist/server.js`.

6. **Health check path** — `/api/v1/health` (already configured).

---

## 2. PostgreSQL setup

Production:

- Region must match the web service (`frankfurt`).
- Backups: Render manages automated daily snapshots on the `standard` plan; Phase O `BackupRecord` augments this with manual / pre-deploy snapshots.
- Connection pooling: rely on Prisma's default pool. If you outgrow Render's primary, add a Pooler URL.

Schema migration:

```bash
npx prisma migrate deploy --schema=prisma/schema.prisma
```

This is forward-only. The CI deploy invokes it automatically. Local dev uses `prisma migrate dev`.

Verification:

```bash
psql "$DATABASE_URL" -c '\dt' | wc -l        # ~150 tables expected
psql "$DATABASE_URL" -c 'SELECT COUNT(*) FROM "Club";'
```

---

## 3. Environment variables (full list)

See `render.yaml` for the canonical list. Phase P adds the three `FC_FAMILISTA_*` keys above. Every other key is inherited from earlier phases.

For local dev, copy:

```bash
cp .env.example .env
# fill in DATABASE_URL, JWT_*, FC_FAMILISTA_*
```

---

## 4. First admin login

After the very first deploy (no rows exist yet):

1. Set `FC_FAMILISTA_SEED_CONFIRM=yes` in Render env (temporary).
2. Run the seed remotely:
   ```bash
   # via Render shell:
   npm run db:seed:fc-familista
   ```
   Output prints a JSON report. Expect `playersCreated: 8`, `teamsCreated: 4`, etc.
3. **Immediately unset `FC_FAMILISTA_SEED_CONFIRM`** so the seed cannot accidentally re-run.
4. Log in at `/` with `FC_FAMILISTA_ADMIN_EMAIL` + `FC_FAMILISTA_ADMIN_PASSWORD`.
5. Enrol MFA: `POST /api/v1/phase-o/auth/mfa/enroll` → scan the otpauth QR → `POST /api/v1/phase-o/auth/mfa/confirm`. **Save the backup codes offline.**
6. Rotate `FC_FAMILISTA_ADMIN_PASSWORD` in Render env to a fresh value (or change the password via the standard user endpoint).

---

## 5. Seed instructions

Idempotent — re-running the seed never duplicates rows. Each entity has a stable natural key (`Club.name`, `User.email`, `Team.(clubId,name)`, `Player.(clubId,firstName,lastName,DOB)`, `DeviceInventoryEntry.serial`, `OperationsPayment.invoiceRef`).

Default fixture:

- 1 club (`FC Familista`)
- 4 teams (`Senior`, `Reserves`, `U17`, `U15`)
- 1 admin + 8 staff (head coach, asst coach, 2 youth coaches, manager, analyst, medical, scout)
- 3 parents linked to 3 academy players
- 8 players spread across the 4 teams
- 48 onboarding-step rows (6 steps × 8 players)
- ~20 training sessions over the next 14 days
- 16 payment ledger rows (2 months × 8 players)
- 5 placeholder device inventory entries in `STOCK`

To customise: edit `src/launch/seed-fc-familista.service.ts` (top-level constants) and re-run. Rows that already exist with a different shape are left untouched and reported as a `warning`.

---

## 6. Backup instructions

Continuous (every hour, via Render cron or external scheduler):

```bash
DATABASE_URL=… BACKUP_ENCRYPT_PASS=… \
BACKUP_UPLOAD_CMD='aws s3 cp $1 s3://familista-backups/' \
./scripts/backup.sh
```

Always record the backup metadata in the audit ledger:

```bash
curl -X POST https://<host>/api/v1/phase-o/monitoring/backups \
  -H "authorization: bearer <admin jwt>" \
  -H "content-type: application/json" \
  -d '{ "kind":"SCHEDULED", "ref":"s3://familista-backups/familista_…_.sql.gz.enc", "sizeBytes":12345678, "sha256":"…" }'
```

Pre-deploy:

- Always tag pre-deploy backups with `"kind":"PRE_DEPLOY"`.
- The `scripts/rollback.sh` script reads `PRE_DEPLOY_BACKUP_FILE` to restore.

Retention:

- Keep `SCHEDULED` 30 days, `PRE_DEPLOY` 90 days, `MANUAL` indefinitely. Lifecycle policy on S3 enforces this.

---

## 7. Restore instructions

**Always restore to a clone first** — never to production directly without rehearsal.

```bash
# 1. Spin up a staging DB
DATABASE_URL_STAGING=postgresql://staging…/familista_staging

# 2. Decrypt + restore
DATABASE_URL="$DATABASE_URL_STAGING" \
BACKUP_FILE=./backups/familista_…_.sql.gz.enc \
BACKUP_ENCRYPT_PASS=… \
CONFIRM=yes \
./scripts/restore.sh

# 3. Apply any forward migrations the dump pre-dates
DATABASE_URL="$DATABASE_URL_STAGING" npx prisma migrate deploy

# 4. Smoke test
DATABASE_URL="$DATABASE_URL_STAGING" node scripts/boot-probe.js

# 5. Only after smoke passes, point production to the restored DB via Render env update.
```

---

## 8. Club operation guide (CLUB_ADMIN / MANAGER)

| Goal | Endpoint |
| --- | --- |
| Production dashboard | `GET /api/v1/phase-p/status` |
| Club ops totals (paid / unpaid / member count) | `GET /api/v1/phase-p/finance/club-summary` |
| Open payments queue | `GET /api/v1/phase-o/ops/payments?state=PENDING` |
| Create a payment | `POST /api/v1/phase-o/ops/payments` |
| Mark payment paid | `PATCH /api/v1/phase-o/ops/payments/:id/state` `{"state":"PAID"}` |
| Add invoice line item | `POST /api/v1/phase-o/ops/invoices/:invoiceDraftId/lines` |
| Schedule a training | `POST /api/v1/phase-o/ops/calendar` (kind `TRAINING`) |
| GDPR queue | `GET /api/v1/phase-o/governance/gdpr/requests?state=PENDING` |
| Send payment reminders to a list of parents | `POST /api/v1/phase-p/notifications/batch` (kind `PAYMENT_REMINDER`) |

---

## 9. Coach operation guide (HEAD_COACH / COACH / ASSISTANT_COACH)

| Goal | Endpoint |
| --- | --- |
| Mark training attendance | `POST /api/v1/phase-o/ops/attendance/training` |
| Mark match attendance + minutes on pitch | `POST /api/v1/phase-o/ops/attendance/match` |
| Player attendance rollup (last 60 d) | `GET /api/v1/phase-p/reports/attendance/players/:playerId` |
| Training attendance rate per session | `GET /api/v1/phase-p/reports/attendance/training?windowDays=14` |
| Player evaluation | `POST /api/v1/phase-o/lifecycle/evaluations` |
| Notify parents of a schedule change | `POST /api/v1/phase-p/notifications/batch` (kind `TRAINING_UPDATE`) |
| Read inbox | `GET /api/v1/phase-p/notifications/inbox` |

Tactical OS (Phase H) frontend is the primary UI for matches; nothing changes there.

---

## 10. Parent / player operation guide

| Goal | Endpoint |
| --- | --- |
| Open inbox | `GET /api/v1/phase-p/notifications/inbox` |
| Unread count | `GET /api/v1/phase-p/notifications/inbox/counts` |
| Mark a notification read | `PATCH /api/v1/phase-p/notifications/inbox/:id/read` |
| Mark all read | `PATCH /api/v1/phase-p/notifications/inbox/read-all` |
| Archive | `DELETE /api/v1/phase-p/notifications/inbox/:id` |
| Balance (parent → child) | `GET /api/v1/phase-p/finance/balance?payerPlayerId=…` |
| Payment history | `GET /api/v1/phase-p/finance/history?payerPlayerId=…` |
| Grant / revoke consent | `POST /api/v1/phase-o/governance/consent` |
| Open GDPR request | `POST /api/v1/phase-o/governance/gdpr/requests` |
| Manage own sessions | `GET /api/v1/phase-o/auth/sessions` + `DELETE /api/v1/phase-o/auth/sessions/:id` |

---

## 11. Notification flows (in-app only)

Phase P writes `UserNotification` rows. There is **no** email/SMS/push dispatch worker yet — `UserNotificationChannel` is a registry for the future worker.

Recommended cadence:

| Kind | Sent by | Cadence |
| --- | --- | --- |
| `ATTENDANCE_REMINDER` | scheduled job (coach manually for now) | 24h before training |
| `PAYMENT_REMINDER` | scheduled job (manual for now) | 7 days before due, then on overdue |
| `TRAINING_UPDATE` | head coach | on schedule changes |
| `INJURY_ALERT` | medical staff | on `PlayerEvaluationRecord` kind `INJURY` |
| `DEVICE_ALERT` | manager | on inventory state change to `RMA` |
| `GDPR_UPDATE` | club admin | on `GdprDataRequest` state transition |
| `SYSTEM` | super admin | platform notices |

---

## 12. Validation commands (final)

```bash
cd /path/to/familista-backend

# 1. Schema + client
npx prisma format --schema=prisma/schema.prisma
npx prisma generate --schema=prisma/schema.prisma
cp prisma/schema.prisma schema.prisma                # keep root mirror in sync

# 2. Type-check + build
npx tsc --noEmit                                     # only seed.ts TS6059 expected
npm run build

# 3. Boot probe
node scripts/boot-probe.js                           # expect exit 0

# 4. Preflight (env + schema + boot probe)
npm run preflight

# 5. Deploy
git add -A
git commit -m "phase-p: real launch layer (status + reports + balance + inbox + fc-familista seed)"
git push origin main
# Render autoDeploy runs: npm install && npx prisma migrate deploy && npx prisma generate && npm run build

# 6. First-time seed (production)
# Set FC_FAMILISTA_*  env vars in Render dashboard first, then via Render shell:
npm run db:seed:fc-familista

# 7. Verify
curl https://<host>/api/v1/health
curl -H "authorization: bearer <admin-jwt>" https://<host>/api/v1/phase-p/status
```

---

## 13. Troubleshooting guide

| Symptom | First check | Fix |
| --- | --- | --- |
| `503` on `/api/v1/health` | Render logs → app crashed at boot | Inspect `Render → familista-backend → Logs`. Usually missing env var. |
| `prisma migrate deploy` complains about drift | Schema in git differs from production DB | Compare `npx prisma migrate status`; resolve with `prisma migrate resolve` then redeploy. |
| Seed reports `playersCreated: 0` second run | Working as intended — idempotent | None |
| Seed aborts with "FC_FAMILISTA_ADMIN_PASSWORD required" | Env var missing | Set in Render env, redeploy or re-shell. |
| `401` even with correct JWT | Token expired (15 m) | Call `POST /api/v1/phase-o/auth/sessions/rotate` with refresh token. |
| Audit chain verify fails | Manual DB edit broke the chain | Restore from latest pre-deploy backup; investigate audit logs for unauthorised access. |
| Boot probe non-zero exit | Route registration regression | `npx prisma generate` then `npm run build` then re-run; inspect probe output for the failing path. |
| Render build fails on `prisma migrate deploy` | Migration drift OR missing DB | Verify `DATABASE_URL` binding; check Postgres status. |
| Inbox returns empty for user | User in different club | Confirm `currentClubId` on User row matches club for notification sender. |
| GDPR request stuck in `PENDING` | Nobody processed it | `PATCH /governance/gdpr/requests/:id/state` to `PROCESSING`, then `COMPLETED`. |
| TOTP code rejected | Clock skew on user device | Refresh device clock; backup codes still work. |

---

## 14. Real-launch checklist (one-pass)

- [ ] All Render env vars set; secrets ≥ 64 chars.
- [ ] `render.yaml` reviewed; Postgres bound; `autoDeploy=true`.
- [ ] `npm run preflight` exits 0 locally.
- [ ] CI workflow green on main.
- [ ] First deploy completes; `/api/v1/health` returns 200.
- [ ] `FC_FAMILISTA_SEED_CONFIRM=yes` toggled, seed runs, then env unset.
- [ ] Admin logs in, enrols MFA, saves backup codes offline.
- [ ] Admin rotates the default seed password.
- [ ] Default retention policies created (`MEDICAL`, `MONTHLY_MEMBERSHIP`, etc.).
- [ ] First alert rule created (`auth_failures_spike`).
- [ ] First scheduled backup recorded.
- [ ] Coaches added by admin invite (they self-set passwords on first login).
- [ ] Parents linked to academy players via `POST /ops/guardians`.
- [ ] Tactical OS frontend loads at `/`; live matches strip renders empty until the first match.
- [ ] Boot probe green from Render shell: `node scripts/boot-probe.js`.

When every box is ticked, FC Familista is live on Familista.
