// The provider that exists so nothing has to pretend
//
// When no credentials are present, Familista does not fall back to logging the
// link and calling it sent. It answers CONFIGURATION, the invitation records
// delivery FAILED with the code EMAIL_NOT_CONFIGURED, and every screen that
// shows the invitation says "email delivery not configured" in those words.
//
// The invitation itself is untouched by that. A token that could not be
// emailed is still a valid, single-use, expiring token — delivery state and
// invitation validity are different facts, and this file is where the
// difference starts.

import type { DeliveryResult, EmailMessage, EmailProvider } from '../types';

export class UnconfiguredProvider implements EmailProvider {
  readonly name = 'none';
  isConfigured(): boolean { return false; }
  configurationProblem(): string {
    return 'No email provider is configured. Set SENDGRID_API_KEY, or SMTP_HOST with its credentials.';
  }
  async send(_message: EmailMessage, _timeoutMs: number): Promise<DeliveryResult> {
    return {
      ok: false, providerName: this.name, providerMessageId: null,
      failureClass: 'CONFIGURATION', failureCode: 'EMAIL_NOT_CONFIGURED', latencyMs: 0,
    };
  }
}
