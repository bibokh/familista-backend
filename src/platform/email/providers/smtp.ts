// SMTP, behind the interface
//
// nodemailer is loaded lazily and is not a declared dependency: a deployment
// that uses an HTTP provider should not have to install a mail transport it
// never calls. If SMTP_HOST is set and the module is absent, that is a
// CONFIGURATION failure with a sentence saying so — not a crash at import time.

import { config } from '../../../config';
import {
  classifyNetworkError, type DeliveryResult, type EmailMessage, type EmailProvider,
} from '../types';

export class SmtpProvider implements EmailProvider {
  readonly name = 'smtp';

  isConfigured(): boolean {
    return !!config.email.smtpHost && !!config.email.fromAddress;
  }

  configurationProblem(): string | null {
    if (!config.email.smtpHost) return 'SMTP_HOST is not set.';
    if (!config.email.fromAddress) return 'EMAIL_FROM is not set.';
    return null;
  }

  async send(message: EmailMessage, timeoutMs: number): Promise<DeliveryResult> {
    const started = Date.now();
    const fail = (failureClass: DeliveryResult['failureClass'], failureCode: string): DeliveryResult => ({
      ok: false, providerName: this.name, providerMessageId: null,
      failureClass, failureCode, latencyMs: Date.now() - started,
    });

    let nodemailer: { createTransport: (o: unknown) => { sendMail: (m: unknown) => Promise<{ messageId?: string }> } };
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      nodemailer = require('nodemailer');
    } catch {
      return fail('CONFIGURATION', 'NODEMAILER_MISSING');
    }

    try {
      const transporter = nodemailer.createTransport({
        host: config.email.smtpHost,
        port: config.email.smtpPort,
        secure: config.email.smtpPort === 465,
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs,
        auth: config.email.smtpUser ? { user: config.email.smtpUser, pass: config.email.smtpPass } : undefined,
      });
      const info = await transporter.sendMail({
        from: `"${config.email.fromName}" <${config.email.fromAddress}>`,
        to: message.to.name ? `"${message.to.name}" <${message.to.address}>` : message.to.address,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return {
        ok: true, providerName: this.name,
        providerMessageId: info?.messageId ?? null,
        failureClass: null, failureCode: null, latencyMs: Date.now() - started,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      // 5xx SMTP replies are permanent refusals; everything else is worth one
      // more attempt. The provider's text is classified and dropped — it can
      // quote the recipient and the subject.
      const responseCode = (err as { responseCode?: number }).responseCode ?? 0;
      if (responseCode >= 500 && responseCode < 600) {
        return fail(responseCode === 550 ? 'INVALID_RECIPIENT' : 'PERMANENT', `SMTP_${responseCode}`);
      }
      if (/EAUTH/i.test(code)) return fail('CONFIGURATION', 'SMTP_AUTH');
      return fail(classifyNetworkError(err), code || 'SMTP_ERROR');
    }
  }
}
