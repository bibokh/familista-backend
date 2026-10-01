/**
 * tests/security-alerts.unit.test.ts
 *
 * Cyber Defense, R6 — security signals reach the operator by email.
 *
 * Before: SecurityEvent rows, `security.*` Fabric events and failed backups were
 * recorded and never sent anywhere; a cross-club access attempt or a broken
 * audit chain waited for somebody to open a table.
 *
 * After: one leased dispatcher reads them every minute and emails the operator,
 * one email per rule per 15 minutes (the rest held and counted, never lost),
 * at most HOURLY_CAP an hour, plus a daily digest — with counts only.
 */

import {
  BACKUP_STALE_MS, classifySecurityEvent, createSecurityAlertDispatcher, DEDUPE_MS, HOURLY_CAP, LAG_MS,
  parseAlertRecipient, startSecurityAlerts, securityAlertsRunning, stopSecurityAlerts, TICK_MS,
  type AlertStore,
} from '../src/security/security-alerts';
import { ALERT_RULE_IDS, renderSecurityAlert, renderSecurityDigest, resolveAlertLocale } from '../src/platform/email/templates/security-alert';
import type { EmailMessage } from '../src/platform/email/types';
import fs from 'fs';
import path from 'path';

type Ev = { at: number; kind: string; severity: string };
type Fx = { at: number; eventType: string };
type Bk = { at: number; ok: boolean };

function harness(start = Date.UTC(2030, 4, 14, 3, 0, 0)) {
  const clock = { now: start };
  const events: Ev[] = [];
  const fabric: Fx[] = [];
  const backups: Bk[] = [{ at: start - 60 * 60_000, ok: true }];
  const sent: EmailMessage[] = [];
  let sendOk = true;
  let failReads = false;
  const inWindow = (at: number, from: Date, to: Date) => at > from.getTime() && at <= to.getTime();
  const store: AlertStore = {
    async securityEventCounts(from, to) {
      if (failReads) throw new Error('db down');
      const m = new Map<string, { kind: string; severity: string; count: number }>();
      for (const e of events.filter((x) => inWindow(x.at, from, to))) {
        const k = `${e.kind}|${e.severity}`;
        m.set(k, { kind: e.kind, severity: e.severity, count: (m.get(k)?.count ?? 0) + 1 });
      }
      return [...m.values()];
    },
    async fabricCounts(from, to, types) {
      const m = new Map<string, number>();
      for (const f of fabric.filter((x) => inWindow(x.at, from, to) && types.includes(x.eventType))) m.set(f.eventType, (m.get(f.eventType) ?? 0) + 1);
      return [...m].map(([eventType, count]) => ({ eventType, count }));
    },
    async failedBackups(from, to) { return backups.filter((b) => !b.ok && inWindow(b.at, from, to)).length; },
    async lastBackupSuccessAt() {
      const ok = backups.filter((b) => b.ok).map((b) => b.at);
      return ok.length ? new Date(Math.max(...ok)) : null;
    },
  };
  const d = createSecurityAlertDispatcher({
    store,
    send: async (m) => { sent.push(m); return { ok: sendOk, failureCode: sendOk ? null : 'EMAIL_NOT_CONFIGURED' }; },
    now: () => new Date(clock.now),
    recipient: 'ops@example.com',
    locale: 'en',
  });
  /** Advance the clock and run one tick; events recorded "now" are counted once LAG has passed. */
  const step = async (ms = TICK_MS) => { clock.now += ms; return d.tick(); };
  const event = (kind: string, severity = 'WARN') => events.push({ at: clock.now, kind, severity });
  return {
    clock, events, fabric, backups, sent, step, event, d,
    setSendOk: (v: boolean) => { sendOk = v; }, setFailReads: (v: boolean) => { failReads = v; },
  };
}

describe('which signals alert', () => {
  it.each([
    ['TENANT_MISMATCH', 'WARN', 'tenant-mismatch'],
    ['AUDIT_CHAIN_BROKEN', 'CRITICAL', 'audit-chain-broken'],
    ['LOGIN_LOCKED', 'INFO', 'login-locked'],
    ['RATE_LIMITED', 'CRITICAL', 'critical-event'],
    ['RATE_LIMITED', 'WARN', null],
    ['LOGIN_FAILED', 'INFO', null],
    ['DEVICE_REPLAY', 'WARN', null],
  ])('%s at %s → %s', (kind, severity, rule) => {
    expect(classifySecurityEvent(kind, severity)).toBe(rule);
  });

  it('every rule the dispatcher can raise has words in every language', () => {
    for (const rule of ['critical-event', 'tenant-mismatch', 'audit-chain-broken', 'login-locked', 'refresh-token-reuse', 'brute-force', 'backup-failed', 'backup-stale']) {
      expect(ALERT_RULE_IDS).toContain(rule);
      for (const l of ['en', 'de', 'ar'] as const) {
        expect(renderSecurityAlert(l, [{ rule, count: 1, suppressed: 0 }], 1).text).not.toContain(rule);
      }
    }
  });
});

describe('the recipient', () => {
  it('is one plainly formed address, or alerting is off', () => {
    expect(parseAlertRecipient(' ops@example.com ')).toBe('ops@example.com');
    for (const bad of [undefined, '', 'ops', 'ops@example', 'a@b.com,c@d.com', 'a@b.com c@d.com', 'Ops <ops@example.com>', `${'a'.repeat(250)}@b.com`]) {
      expect(parseAlertRecipient(bad)).toBeNull();
    }
  });

  it('without SECURITY_ALERT_EMAIL the worker does not start', () => {
    const saved = process.env.SECURITY_ALERT_EMAIL;
    try {
      delete process.env.SECURITY_ALERT_EMAIL;
      startSecurityAlerts();
      expect(securityAlertsRunning()).toBe(false);
      process.env.SECURITY_ALERT_EMAIL = 'not-an-address';
      startSecurityAlerts();
      expect(securityAlertsRunning()).toBe(false);
    } finally {
      stopSecurityAlerts();
      if (saved === undefined) delete process.env.SECURITY_ALERT_EMAIL; else process.env.SECURITY_ALERT_EMAIL = saved;
    }
  });
});

describe('the dispatcher', () => {
  it('ignores everything recorded before it started — a deploy does not replay history', async () => {
    const h = harness();
    h.events.push({ at: h.clock.now - 5 * 60_000, kind: 'TENANT_MISMATCH', severity: 'WARN' });
    h.events.push({ at: h.clock.now - LAG_MS - 1, kind: 'AUDIT_CHAIN_BROKEN', severity: 'CRITICAL' });
    await h.step(); await h.step();
    expect(h.sent).toEqual([]);
  });

  it('emails a new signal once its window has closed, to the configured address only', async () => {
    const h = harness();
    await h.step();
    h.event('TENANT_MISMATCH');
    const r = await h.step();
    expect(r).toMatchObject({ sent: true, rules: ['tenant-mismatch'] });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toEqual({ address: 'ops@example.com' });
    expect(h.sent[0].text).toMatch(/1 × Attempts to reach another club's data/);
  });

  it('counts a row committed late (inside LAG) on the next tick instead of skipping it', async () => {
    const h = harness();
    await h.step();
    h.clock.now += TICK_MS;
    await h.d.tick();
    h.events.push({ at: h.clock.now - LAG_MS + 1, kind: 'LOGIN_LOCKED', severity: 'INFO' });
    expect(h.sent).toHaveLength(0);
    await h.step();
    expect(h.sent).toHaveLength(1);
  });

  it('one email per rule per 15 minutes: further signals are held and reported, not lost', async () => {
    const h = harness();
    await h.step();
    h.event('TENANT_MISMATCH');
    await h.step();
    expect(h.sent).toHaveLength(1);
    for (let i = 0; i < 5; i += 1) { h.event('TENANT_MISMATCH'); await h.step(); }
    expect(h.sent).toHaveLength(1);
    while (h.sent.length === 1) await h.step();
    expect(h.clock.now - Date.UTC(2030, 4, 14, 3, 0, 0)).toBeGreaterThanOrEqual(DEDUPE_MS);
    expect(h.sent[1].text).toMatch(/5 × Attempts to reach another club's data — 5 more held back/);
  });

  it('a different rule is not held by another rule\'s window', async () => {
    const h = harness();
    await h.step();
    h.event('TENANT_MISMATCH'); await h.step();
    h.fabric.push({ at: h.clock.now, eventType: 'security.refresh.reused' }); await h.step();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].text).toMatch(/refresh token was reused/);
  });

  it('never sends more than HOURLY_CAP emails an hour, and holds the rest for later', async () => {
    const h = harness();
    await h.step();
    // Seven rules, one new signal a minute, staggered so every tick has a rule
    // whose own window is open: without the cap this is ~28 emails an hour.
    const raise = [
      () => h.event('TENANT_MISMATCH'), () => h.event('AUDIT_CHAIN_BROKEN', 'CRITICAL'), () => h.event('LOGIN_LOCKED'),
      () => h.event('RATE_LIMITED', 'CRITICAL'), () => h.fabric.push({ at: h.clock.now, eventType: 'security.refresh.reused' }),
      () => h.fabric.push({ at: h.clock.now, eventType: 'security.lockout.triggered' }), () => h.backups.push({ at: h.clock.now, ok: false }),
    ];
    const t0 = h.clock.now;
    let capped = false;
    for (let t = 0; t < 60; t += 1) { raise[t % raise.length](); capped = (await h.step()).capped || capped; }
    const inFirstHour = h.sent.length;
    expect(capped).toBe(true);
    expect(inFirstHour).toBe(HOURLY_CAP);
    expect(h.clock.now - t0).toBe(60 * TICK_MS);
    for (let t = 0; t < 60; t += 1) await h.step();
    expect(h.sent.length).toBeGreaterThan(HOURLY_CAP);
    expect(h.sent.length).toBeLessThanOrEqual(2 * HOURLY_CAP);
  });

  it('a failed read keeps the window and retries it; a failed send keeps the signal', async () => {
    const h = harness();
    await h.step();
    h.event('AUDIT_CHAIN_BROKEN', 'CRITICAL');
    h.setFailReads(true);
    await expect(h.step()).rejects.toThrow(/db down/);
    h.setFailReads(false);
    h.setSendOk(false);
    await h.step();
    expect(h.sent).toHaveLength(1);
    h.setSendOk(true);
    await h.step();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].text).toMatch(/1 × Audit chain verification failed/);
  });

  it('a failed scheduled backup alerts; a run still in progress does not', async () => {
    const h = harness();
    await h.step();
    h.backups.push({ at: h.clock.now, ok: false });
    await h.step();
    expect(h.sent.map((m) => m.text).join()).toMatch(/A scheduled backup failed/);
  });

  it('no successful backup in 36 hours alerts — once per 6 hours, not every minute', async () => {
    const h = harness();
    h.backups.length = 0;
    h.backups.push({ at: h.clock.now - BACKUP_STALE_MS - 60_000, ok: true });
    await h.step();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toMatch(/No successful backup in the last 36 hours/);
    expect(h.sent[0].text).not.toMatch(/held back/);
    for (let i = 0; i < 60; i += 1) await h.step();
    expect(h.sent).toHaveLength(1);
  });

  it('sends one digest a day after 07:00 UTC, and none on a restart later that day', async () => {
    const h = harness(Date.UTC(2030, 4, 14, 6, 58, 0));
    h.event('LOGIN_LOCKED');
    await h.step(); await h.step(); // 07:00 → the alert email AND the digest
    const digests = () => h.sent.filter((m) => /digest/.test(m.subject));
    expect(digests()).toHaveLength(1);
    expect(digests()[0].text).toMatch(/Last successful backup: \d+ hours ago/);
    for (let i = 0; i < 120; i += 1) await h.step();
    expect(digests()).toHaveLength(1);
    const later = harness(Date.UTC(2030, 4, 14, 12, 0, 0));
    await later.step();
    expect(later.sent.filter((m) => /digest/.test(m.subject))).toHaveLength(0);
  });
});

describe('what the email says', () => {
  const lines = [{ rule: 'tenant-mismatch', count: 3, suppressed: 2 }, { rule: 'refresh-token-reuse', count: 1, suppressed: 0 }];

  it.each(['en', 'de', 'ar'] as const)('%s: a generic subject, counts and rule names only', (l) => {
    const a = renderSecurityAlert(l, lines, 15);
    const d = renderSecurityDigest(l, [{ rule: 'login-locked', count: 4 }, { rule: 'backup-failed', count: 0 }], 20);
    for (const m of [a, d]) {
      expect(m.subject).toMatch(/Familista/);
      expect(m.subject).not.toMatch(/\d|club|tenant|token|backup/i);
      expect(`${m.html}\n${m.text}`).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b|[0-9a-f]{8}-[0-9a-f]{4}-|@/);
    }
    expect(a.html).toContain(`lang="${l}"`);
    expect(a.html).toContain(l === 'ar' ? 'dir="rtl"' : 'dir="ltr"');
  });

  it('escapes everything it prints', () => {
    const a = renderSecurityAlert('en', [{ rule: '<script>x</script>', count: 1, suppressed: 0 }], 1);
    expect(a.html).not.toContain('<script>');
  });

  it('falls back to English for an unknown locale', () => {
    expect(resolveAlertLocale('de-AT')).toBe('de');
    expect(resolveAlertLocale('ar_EG')).toBe('ar');
    expect(resolveAlertLocale('fr')).toBe('en');
    expect(resolveAlertLocale(undefined)).toBe('en');
  });
});

describe('wiring', () => {
  it('runs as a leased background worker, in one process', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/infra/background-workers.ts'), 'utf8');
    expect(src).toMatch(/\{ label: 'security-alerts',\s+start: startSecurityAlerts,\s+stop: stopSecurityAlerts \}/);
  });

  it('the posture control is present and required', () => {
    const root = path.join(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/cyber-defense/generated/security-manifest.json'), 'utf8'));
    const policy = JSON.parse(fs.readFileSync(path.join(root, 'src/cyber-defense/posture-policy.json'), 'utf8'));
    expect(manifest.controls.find((c: { id: string }) => c.id === 'security-alert-delivery')?.status).toBe('PRESENT');
    expect(policy.requiredControls).toContain('security-alert-delivery');
  });
});
