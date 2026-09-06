// The Familista email gateway — what a message is, and what a provider must do
// ─────────────────────────────────────────────────────────────────────────────
// Familista → EmailService → EmailProvider → the provider.
//
// Nothing in the product may reach past EmailService to a provider SDK. That is
// the entire point of this file existing: the day SendGrid is replaced by
// Postmark, or SMTP by SES, the change is one adapter — not club invitations,
// staff invitations, password resets, security mail and everything else that
// has since grown a hardcoded call.
//
// The interface is deliberately small. A provider sends one message and reports
// what happened. It does not know what an invitation is, what a club is, or
// what language anything is in.

export type EmailFailureClass =
  /** The provider or the network failed transiently. Worth retrying. */
  | 'TEMPORARY'
  /** The provider refused for a reason that will not change. Never retry. */
  | 'PERMANENT'
  /** No credentials, a bad key, a sender that is not verified. An operator fixes it. */
  | 'CONFIGURATION'
  /** Too fast. Retry later, more slowly. */
  | 'RATE_LIMIT'
  /** The address itself is the problem. Do not retry, and do not blame the platform. */
  | 'INVALID_RECIPIENT';

export interface EmailAddress {
  address: string;
  name?: string | null;
}

export interface EmailMessage {
  to: EmailAddress;
  subject: string;
  html: string;
  text: string;
  /** BCP-47. Sets the document language and, for Arabic, its direction. */
  locale?: string;
  /** Ties a delivery to the thing that caused it, for the log. Never a token. */
  correlationId?: string | null;
}

export interface DeliveryResult {
  ok: boolean;
  providerName: string;
  /** The provider's own id for the message, when it gives one. */
  providerMessageId: string | null;
  failureClass: EmailFailureClass | null;
  /** A short, safe code. Never a provider body, which can quote the message. */
  failureCode: string | null;
  /** How long the provider took, in milliseconds. For the metrics, not the user. */
  latencyMs: number;
}

export interface EmailProvider {
  readonly name: string;
  /** False when the adapter has no usable configuration. Checked before sending. */
  isConfigured(): boolean;
  /** Why it is not configured, in one sentence. Never names a secret's value. */
  configurationProblem(): string | null;
  send(message: EmailMessage, timeoutMs: number): Promise<DeliveryResult>;
}

/** Every failure class, and whether trying again could possibly help. */
export const RETRYABLE: Readonly<Record<EmailFailureClass, boolean>> = Object.freeze({
  TEMPORARY: true,
  RATE_LIMIT: true,
  PERMANENT: false,
  CONFIGURATION: false,
  INVALID_RECIPIENT: false,
});

/**
 * An HTTP status, classified.
 *
 * Shared by every HTTP-speaking adapter so that one provider's 429 and
 * another's mean the same thing to the retry logic above them.
 */
export function classifyHttpStatus(status: number): EmailFailureClass {
  if (status === 401 || status === 403) return 'CONFIGURATION';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400 || status === 422) return 'INVALID_RECIPIENT';
  if (status >= 500) return 'TEMPORARY';
  return 'PERMANENT';
}

/** A thrown network error, classified. */
export function classifyNetworkError(err: unknown): EmailFailureClass {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|timeout/i.test(text)) return 'TEMPORARY';
  return 'TEMPORARY';
}
