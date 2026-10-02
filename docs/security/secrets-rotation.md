# Secrets inventory and rotation runbook (Cyber Defense R12)

Every secret Familista uses, where it lives, what breaks while it changes, and
how to rotate it. **Names only — no value appears in this repository**, and
nothing here has been rotated. Rotation is the platform owner's action, done in
the Render dashboard (or GitHub repository settings), never in code.

`secret-rotation-runbook` (a required posture control) fails CI when a variable
marked `sync: false` in `render.yaml` is missing from the first table.

## General procedure

1. Generate the new value offline (`openssl rand -hex 32` unless the row says
   otherwise). Never paste it into a chat, an issue or a commit.
2. Where the row has a **previous** slot, put the old value there first, so
   nothing in flight is refused; otherwise expect the effect in the row.
3. Set the new value in the Render dashboard → familista-backend →
   Environment. Saving triggers a deploy; confirm it reaches Live.
4. Verify the row's check. Remove the previous value after its overlap.
5. Record the date of rotation in the owner's offline record.

Rotate immediately on suspected exposure; otherwise at least every 12 months,
and when anyone with access leaves.

## Render environment (`sync: false` in render.yaml)

| Variable | What it protects | Overlap / effect of rotation | Check afterwards |
|---|---|---|---|
| `JWT_ACCESS_SECRET` | access tokens, WebSocket tickets, device tokens, recommendation HMACs | put the old value in `JWT_ACCESS_SECRET_PREVIOUS` first (keyring, `src/security/jwt-tokens.ts`); remove it after 1 day. Recommendation signatures made with the old key stop verifying — re-sign if any are relied on | sign in; open a match socket |
| `JWT_REFRESH_SECRET` | refresh tokens | old value to `JWT_REFRESH_SECRET_PREVIOUS`; remove after 7 days (refresh lifetime) | a session survives a refresh |
| `MFA_ENCRYPTION_KEY` | stored TOTP secrets | **no overlap**: every enrolled authenticator must be re-enrolled. Rotate only on exposure | an owner re-enrols and signs in with a code |
| `FAMILISTA_SECRET_KEK` / `FAMILISTA_ACTIVE_KEK` / `FAMILISTA_RETIRED_KEKS` | the fabric keyring that wraps stored device and integration credentials (`src/fabric/secrets/keyring.ts`) | add the new KEK, make it active, keep the old one until re-wrapped, then list its kid in `FAMILISTA_RETIRED_KEKS` | a device authenticates |
| `STRIPE_SECRET_KEY` | billing API calls | roll the key in the Stripe dashboard; Stripe keeps the old one valid for the window you choose | create a test checkout |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signatures | roll in Stripe; set the new value promptly — webhooks signed with the new secret are refused until it is set | Stripe dashboard shows webhook deliveries 2xx |
| `SENDGRID_API_KEY` | e-mail delivery | create the new key in SendGrid, set it, then delete the old key | an invitation e-mail arrives |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | e-mail delivery (alternative provider) | change the password at the provider, then set it here | an invitation e-mail arrives |
| `SECURITY_ALERT_EMAIL` | where security alerts go (not a secret; kept out of the repo) | none | a test alert arrives |
| `PUBLIC_APP_URL` / `APP_URL` | links in e-mails (not secrets) | none | an invitation link opens |
| `ANTHROPIC_API_KEY` | the AI provider (through the AI Gateway only) | create a new key in the Anthropic console, set it, revoke the old one | an ARIA analysis answers |
| `WL_ASSETS_S3_ACCESS_KEY_ID` / `WL_ASSETS_S3_SECRET_ACCESS_KEY` | the media bucket | create a new key pair at the provider, set both, delete the old pair | upload a club crest |
| `WL_ASSETS_PUBLIC_BASE_URL` / `WL_ASSETS_S3_BUCKET` / `WL_ASSETS_S3_ENDPOINT` | where media lives (not secrets) | none | — |
| `VISION_WORKER_TOKEN` / `VISION_WEBHOOK_TOKEN` | the vision worker channel, both directions: HMAC keys for jobs sent and callbacks received, 32+ characters (`worker-channel-authenticated`) | set the same new value on the worker and here, in that order; callbacks in flight are refused for the minutes in between | a vision job completes |
| `VISION_CLIP_WORKER_TOKEN` / `VISION_CLIP_WEBHOOK_TOKEN` | the clip worker channel, both directions, 32+ characters | as above | a clip job completes |
| `VISION_WORKER_URL` / `VISION_WORKER_CALLBACK_URL` / `VISION_CLIP_WORKER_URL` / `VISION_CLIP_WORKER_CALLBACK_URL` | worker addresses (not secrets) | none | — |

## Linked by Render (not typed by anyone)

| Variable | Rotation |
|---|---|
| `DATABASE_URL` | rotate the database password from the Render database page; Render updates the linked value and redeploys |
| `REDIS_URL` | rotate from the Render Redis page; nothing persistent lives in Redis (`docs/security/disaster-recovery.md`) |

## Set in the dashboard, outside render.yaml

| Variable | What it protects | Rotation |
|---|---|---|
| `BACKUP_ENCRYPTION_PUBLIC_KEY` | backups are encrypted to it | generate a new pair offline (`docs/BACKUP_AND_RESTORE.md`, "Keys"); set the public key; **keep every old private key offline** — older backups need it |
| `BACKUP_SIGNING_PRIVATE_KEY` | backup manifests are signed with it | new pair offline; set the private key; keep old public keys to verify older backups |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | the write-only backup bucket key | new B2 application key with the same restricted capabilities; set; delete the old one |
| `BACKUP_TRIGGER_SECRET` | the scheduled backup trigger | set the same new value in Render and in GitHub (below) within a day; one scheduled run may be refused in between |
| `MODEL_SIGNING_PRIVATE_KEY` (not set yet) | model promotions (Batch 5, R8) | new Ed25519 pair offline; existing promotions verify only against the key that signed them, so re-promote active models after rotating |
| `MFA_REQUIRED_FOR_ADMINS` (not a secret) | admin MFA switch | — |

## GitHub repository secrets

| Secret | Used by | Rotation |
|---|---|---|
| `BACKUP_TRIGGER_SECRET` | `.github/workflows/backup.yml` | as above, together with the Render value |
| `RENDER_DEPLOY_HOOK_URL` | `.github/workflows/deploy.yml` | regenerate the deploy hook in Render (Settings → Deploy Hook), paste it as the secret; the old hook stops working immediately |

## Never stored anywhere online

`BACKUP_ENCRYPTION_PRIVATE_KEY` (and every retired one) and `BACKUP_SIGNING_PUBLIC_KEY` history live only in the owner's offline
record. They are never added to Render or GitHub.
