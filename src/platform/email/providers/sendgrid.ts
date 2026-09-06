// SendGrid, behind the interface
//
// One HTTP call, a bounded timeout, and a result. It knows nothing about
// invitations, clubs or languages — it is handed a finished message.
//
// The API key is read from config and never logged, never returned, and never
// included in a failure code. A provider's error body can quote the message it
// refused, so the body is classified and discarded rather than propagated.

import * as https from 'https';
import { config } from '../../../config';
import {
  classifyHttpStatus, classifyNetworkError,
  type DeliveryResult, type EmailMessage, type EmailProvider,
} from '../types';

export class SendGridProvider implements EmailProvider {
  readonly name = 'sendgrid';

  isConfigured(): boolean {
    return !!config.email.sendgridKey && !!config.email.fromAddress;
  }

  configurationProblem(): string | null {
    if (!config.email.sendgridKey) return 'SENDGRID_API_KEY is not set.';
    if (!config.email.fromAddress) return 'EMAIL_FROM is not set.';
    return null;
  }

  async send(message: EmailMessage, timeoutMs: number): Promise<DeliveryResult> {
    const started = Date.now();
    const payload = JSON.stringify({
      personalizations: [{ to: [{ email: message.to.address, ...(message.to.name ? { name: message.to.name } : {}) }] }],
      from: { email: config.email.fromAddress, name: config.email.fromName },
      subject: message.subject,
      content: [
        { type: 'text/plain', value: message.text },
        { type: 'text/html', value: message.html },
      ],
    });

    return new Promise<DeliveryResult>((resolve) => {
      const done = (r: Omit<DeliveryResult, 'providerName' | 'latencyMs'>) =>
        resolve({ ...r, providerName: this.name, latencyMs: Date.now() - started });

      const req = https.request({
        hostname: 'api.sendgrid.com',
        path: '/v3/mail/send',
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.email.sendgridKey}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        const status = res.statusCode ?? 0;
        // The body is read to drain the socket and then dropped. It can quote
        // the message it refused, and a log is the wrong place for that.
        res.resume();
        if (status >= 200 && status < 300) {
          done({
            ok: true,
            providerMessageId: (res.headers['x-message-id'] as string) ?? null,
            failureClass: null, failureCode: null,
          });
          return;
        }
        done({
          ok: false, providerMessageId: null,
          failureClass: classifyHttpStatus(status),
          failureCode: `HTTP_${status}`,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        done({ ok: false, providerMessageId: null, failureClass: 'TEMPORARY', failureCode: 'TIMEOUT' });
      });
      req.on('error', (err) => {
        done({
          ok: false, providerMessageId: null,
          failureClass: classifyNetworkError(err),
          failureCode: (err as NodeJS.ErrnoException).code ?? 'NETWORK',
        });
      });
      req.write(payload);
      req.end();
    });
  }
}
