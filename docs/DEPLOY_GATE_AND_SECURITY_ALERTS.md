# Deploy gate and security alerting (Cyber Defense R4 + R6)

## R4: production moves only after CI

| | Before | After |
|---|---|---|
| Render | `autoDeploy: true`: every push to `main` is deployed at once, even if CI then fails | `autoDeploy: false` |
| `deploy.yml` | Hook unset → "skipping", green | Runs after a **successful** `ci` run on `main`, and only for the commit that is still `main`'s head. A missing hook **fails** the workflow |
| Manual | none | `Actions → deploy → Run workflow` (rollback / redeploy) |

The posture control `deploy-gated-by-ci` is required, so `security:check` fails if auto-deploy is switched back on in `render.yaml` or if the workflow loses its gate.

### Production steps, in this order

1. **Render → familista-backend → Settings → Deploy Hook**: copy the hook URL. Treat it as a secret: anyone holding it can trigger a deploy.
2. **GitHub → Settings → Secrets and variables → Actions → New repository secret**:
   - name: `RENDER_DEPLOY_HOOK_URL`
   - value: the hook URL.
3. **Render → familista-backend → Settings → Build & Deploy → Auto-Deploy → Off.**
   - If the service is synced from the Blueprint, merging `render.yaml` sets this too. Step 3 makes it true either way.
   - If Render offers "After CI checks pass", do not choose it. Keep **Off**: two deploy paths would deploy each commit twice.
4. Verify:
   - The next merge to `main` shows `ci` green, then `deploy` green with the line "Triggering Render deploy".
   - Render shows a deploy started by the hook.

**Order matters.** Do steps 1–2 before the R4 change reaches Render. If auto-deploy turns off while the hook is unset, nothing deploys. The `deploy` workflow then fails red on every merge until the secret exists. That fails safe (production stays on the last good build), but it does stop deploys.

## R6: security alerts by email

`src/security/security-alerts.ts` runs as one leased background worker, so only one process sends. Every 60 s it reads the window ending 15 s ago.

| Rule | Source |
|---|---|
| `critical-event` | `SecurityEvent` with severity `CRITICAL` (e.g. auth/account rate-limit) |
| `tenant-mismatch` | `SecurityEvent` kind `TENANT_MISMATCH` |
| `audit-chain-broken` | `SecurityEvent` kind `AUDIT_CHAIN_BROKEN` |
| `login-locked` | `SecurityEvent` kind `LOGIN_LOCKED` |
| `refresh-token-reuse` | Fabric `security.refresh.reused` |
| `brute-force` | Fabric `security.lockout.triggered` (shadow lockout) |
| `backup-failed` | `BackupRecord` scheduled, finished, `ok = false` |
| `backup-stale` | no successful scheduled backup in 36 h |

How sending works:

- Each rule sends at most one email per 15 minutes (`backup-stale`: one per 6 hours). Signals in between are held and counted in the next email; none are dropped.
- No more than 12 alert emails go out in any hour.
- A daily digest goes out once per UTC day, after 07:00. It lists 24-hour counts per rule and the hours since the last successful backup.
- The worker starts from "now", so a deploy or restart never replays history.
- Its memory is per process. After a restart, a still-stale backup is reported again once.

What the email contains:

- Subject: "Familista security alert" or "Familista security digest", with nothing more.
- Body: counts and rule names only. No IP addresses, no user or club ids, no email addresses, no payloads.
- Languages: English, German or Arabic (right-to-left), chosen by `SECURITY_ALERT_LOCALE`.

### Production steps

1. **Render → familista-backend → Environment**:
   - Add `SECURITY_ALERT_EMAIL` = the operator mailbox (one address).
   - Optional: add `SECURITY_ALERT_LOCALE` = `en` (default), `de` or `ar`.
2. Email delivery must already be configured (`SENDGRID_API_KEY` or `SMTP_*`). If it isn't, each send fails with `EMAIL_NOT_CONFIGURED`, and the log says so.
3. Verify in the logs after the deploy: `[security-alerts] security alert emails are ON`. If you see `... is not set; security alert emails are OFF`, step 1 is missing.

The variable is not a secret, but it is kept out of git (`sync: false` in `render.yaml`).

## Not covered here

- A deploy made directly in the Render dashboard ("Manual Deploy") still bypasses CI. It is a deliberate owner action, and nobody else should have dashboard access.
- A manual run of `deploy.yml` deploys `main`'s current head, whatever its CI result.
- Alerts are email only. Pager or SMS escalation is out of scope.
