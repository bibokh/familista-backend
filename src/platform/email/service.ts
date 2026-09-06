// EmailService — the one door out of Familista
// ─────────────────────────────────────────────────────────────────────────────
// Every email Familista sends goes through `sendEmail`. Club invitations, staff
// invitations, password resets, security notices and whatever comes next all
// call this, and none of them names a provider. Replacing SendGrid with
// Postmark is then an adapter and one environment variable — not a search
// through the codebase for SDK calls.
//
// Three properties this file keeps:
//
//   1. IT NEVER BLOCKS THE PLATFORM. Every attempt is bounded by a timeout, the
//      retries are bounded and short, and a total failure returns a result
//      rather than throwing. An invitation that could not be emailed is still a
//      valid invitation; the club being unable to reach a mail provider must
//      not stop a president being appointed.
//   2. IT NEVER LEAKS. No recipient address, no token, no provider key and no
//      provider body reaches a log or a metric. Failures are classified into a
//      short code; the provider's own text is dropped, because it can quote the
//      message it refused.
//   3. IT NEVER PRETENDS. With no credentials it answers CONFIGURATION and the
//      caller records FAILED / EMAIL_NOT_CONFIGURED. It does not log the link
//      and call that "sent".

import { createHash } from 'crypto';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { currentEnvironment } from '../environment';
import { SendGridProvider } from './providers/sendgrid';
import { SmtpProvider } from './providers/smtp';
import { UnconfiguredProvider } from './providers/unconfigured';
import { RETRYABLE, type DeliveryResult, type EmailMessage, type EmailProvider } from './types';

/** One attempt may take this long. Bounded, because a provider can hang. */
export const SEND_TIMEOUT_MS = Number(process.env.EMAIL_TIMEOUT_MS ?? 8000);
/** Attempts in total, including the first. Bounded, because this runs inline. */
export const MAX_ATTEMPTS = Math.max(1, Math.min(Number(process.env.EMAIL_MAX_ATTEMPTS ?? 2), 5));

const PROVIDERS: Record<string, () => EmailProvider> = {
  sendgrid: () => new SendGridProvider(),
  smtp: () => new SmtpProvider(),
  none: () => new UnconfiguredProvider(),
};

let override: EmailProvider | null = null;

/**
 * Which provider this deployment uses.
 *
 * EMAIL_PROVIDER names one explicitly. Without it, the first adapter that is
 * actually configured wins — so adding a SendGrid key is enough to turn
 * delivery on, and removing it falls back rather than breaking.
 */
export function selectProvider(): EmailProvider {
  if (override) return override;

  const named = String(process.env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
  if (named && PROVIDERS[named]) {
    const provider = PROVIDERS[named]();
    // A named provider that is not configured is NOT silently replaced: an
    // operator who set EMAIL_PROVIDER=sendgrid and forgot the key must be told
    // that, not quietly given SMTP.
    return provider;
  }

  for (const build of [PROVIDERS.sendgrid, PROVIDERS.smtp]) {
    const provider = build();
    if (provider.isConfigured()) return provider;
  }
  return PROVIDERS.none();
}

/** For tests, and for a process that wants a known provider. */
export function setEmailProvider(provider: EmailProvider | null): void { override = provider; }

export interface EmailConfiguration {
  configured: boolean;
  providerName: string;
  /** Why not, in one sentence. Never contains a secret's value. */
  problem: string | null;
  fromAddress: string;
  fromName: string;
  publicAppUrl: string;
  timeoutMs: number;
  maxAttempts: number;
}

/**
 * What an operator, and SYSTEM, need to know about email — and nothing else.
 *
 * There is no field here a key could be in, and no code path that reads one
 * into this shape. It is returned to the platform owner's screen and printed
 * at boot, and both are places a secret must never appear.
 */
export function emailConfiguration(): EmailConfiguration {
  const provider = selectProvider();
  return {
    configured: provider.isConfigured(),
    providerName: provider.name,
    problem: provider.isConfigured() ? null : provider.configurationProblem(),
    fromAddress: config.email.fromAddress,
    fromName: config.email.fromName,
    publicAppUrl: publicAppUrl(),
    timeoutMs: SEND_TIMEOUT_MS,
    maxAttempts: MAX_ATTEMPTS,
  };
}

/**
 * Where an acceptance link points.
 *
 * PUBLIC_APP_URL is the configured public origin; APP_URL is the older name and
 * is still honoured so an existing deployment keeps working. A trailing slash
 * is removed so the path is joined once, correctly.
 */
export function publicAppUrl(): string {
  const raw = String(process.env.PUBLIC_APP_URL ?? config.email.appUrl ?? '').trim();
  return raw.replace(/\/+$/, '');
}

// ── metrics ─────────────────────────────────────────────────────────────────
// Counts and latencies only. There is no recipient, no subject, no token and no
// club in here — a metric is read by more people, and kept longer, than
// anybody assumes.
interface EmailMetrics {
  attempted: number;
  sent: number;
  failed: number;
  byFailureClass: Record<string, number>;
  latencyMsTotal: number;
  latencySamples: number;
}
const metrics: EmailMetrics = {
  attempted: 0, sent: 0, failed: 0, byFailureClass: {}, latencyMsTotal: 0, latencySamples: 0,
};

export function emailMetrics() {
  return {
    attempted: metrics.attempted,
    sent: metrics.sent,
    failed: metrics.failed,
    byFailureClass: { ...metrics.byFailureClass },
    averageLatencyMs: metrics.latencySamples ? Math.round(metrics.latencyMsTotal / metrics.latencySamples) : null,
  };
}
export function resetEmailMetrics(): void {
  metrics.attempted = 0; metrics.sent = 0; metrics.failed = 0;
  metrics.byFailureClass = {}; metrics.latencyMsTotal = 0; metrics.latencySamples = 0;
}

/**
 * A recipient, in a log line.
 *
 * The first eight characters of a SHA-256 of the lowercased address: enough to
 * correlate two log lines about the same person, useless for learning who they
 * are. An address in a log is an address in every backup of that log.
 */
export function recipientRef(address: string): string {
  return createHash('sha256').update(String(address).toLowerCase().trim()).digest('hex').slice(0, 8);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send one message.
 *
 * Never throws. Returns what happened, so the caller can record a delivery
 * state — which is a different fact from whether the invitation is valid.
 */
export async function sendEmail(message: EmailMessage): Promise<DeliveryResult> {
  const provider = selectProvider();
  metrics.attempted += 1;

  if (!provider.isConfigured()) {
    const result: DeliveryResult = {
      ok: false, providerName: provider.name, providerMessageId: null,
      failureClass: 'CONFIGURATION',
      failureCode: 'EMAIL_NOT_CONFIGURED', latencyMs: 0,
    };
    record(result, message);
    return result;
  }

  let last: DeliveryResult | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: DeliveryResult;
    try {
      result = await provider.send(message, SEND_TIMEOUT_MS);
    } catch (err) {
      // An adapter that throws is an adapter bug, not a caller's problem.
      result = {
        ok: false, providerName: provider.name, providerMessageId: null,
        failureClass: 'TEMPORARY', failureCode: 'ADAPTER_ERROR', latencyMs: 0,
      };
      logger.warn('email adapter threw', { provider: provider.name, err: String(err) });
    }
    last = result;
    if (result.ok) { record(result, message); return result; }
    if (!result.failureClass || !RETRYABLE[result.failureClass]) break;
    if (attempt < MAX_ATTEMPTS) await sleep(250 * attempt);
  }

  const failed = last ?? {
    ok: false, providerName: provider.name, providerMessageId: null,
    failureClass: 'TEMPORARY' as const, failureCode: 'UNKNOWN', latencyMs: 0,
  };
  record(failed, message);
  return failed;
}

function record(result: DeliveryResult, message: EmailMessage): void {
  metrics.latencyMsTotal += result.latencyMs;
  metrics.latencySamples += 1;
  if (result.ok) {
    metrics.sent += 1;
  } else {
    metrics.failed += 1;
    const key = result.failureClass ?? 'UNKNOWN';
    metrics.byFailureClass[key] = (metrics.byFailureClass[key] ?? 0) + 1;
  }
  // The address is a reference, the subject is absent, and the failure is a
  // code rather than the provider's sentence.
  logger.info('email delivery', {
    provider: result.providerName,
    ok: result.ok,
    failureClass: result.failureClass,
    failureCode: result.failureCode,
    latencyMs: result.latencyMs,
    recipient: recipientRef(message.to.address),
    environment: currentEnvironment(),
    correlationId: message.correlationId ?? null,
  });
}
