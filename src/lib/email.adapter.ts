// Password-reset email
// ─────────────────────────────────────────────────────────────────────────────
// The template is this file's; the delivery is not. The SendGrid and SMTP
// transports that used to live here have moved behind EmailService, so this
// file no longer knows or cares which provider carries the message — which is
// the whole point of having a gateway.

import { logger } from '../utils/logger';
import { sendEmail, recipientRef } from '../platform/email/service';

interface PasswordResetEmailOptions {
  to: string;
  firstName: string;
  resetUrl: string;
}

function buildPasswordResetHtml(firstName: string, resetUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset your Familista password</title>
  <style>
    body { margin: 0; padding: 0; background: #0d1117; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }
    .wrapper { max-width: 560px; margin: 40px auto; background: #161b22; border-radius: 12px; overflow: hidden; }
    .header { background: #1a2332; padding: 32px 40px; text-align: center; border-bottom: 1px solid #30363d; }
    .header h1 { margin: 0; font-size: 22px; color: #ffffff; letter-spacing: -0.3px; }
    .header span { color: #22c55e; }
    .body { padding: 40px; color: #c9d1d9; font-size: 15px; line-height: 1.6; }
    .body p { margin: 0 0 16px; }
    .cta { text-align: center; margin: 32px 0; }
    .cta a {
      display: inline-block;
      background: #22c55e;
      color: #0d1117;
      font-weight: 700;
      font-size: 15px;
      text-decoration: none;
      padding: 14px 32px;
      border-radius: 8px;
      letter-spacing: 0.2px;
    }
    .url-fallback { background: #0d1117; border-radius: 6px; padding: 12px 16px; font-size: 12px; word-break: break-all; color: #8b949e; margin: 16px 0; }
    .footer { padding: 24px 40px; border-top: 1px solid #30363d; text-align: center; font-size: 12px; color: #6e7681; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>Famili<span>sta</span></h1>
    </div>
    <div class="body">
      <p>Hi ${firstName},</p>
      <p>We received a request to reset the password for your Familista account. Click the button below to choose a new password.</p>
      <div class="cta">
        <a href="${resetUrl}">Reset Password</a>
      </div>
      <p>If the button above doesn't work, copy and paste this URL into your browser:</p>
      <div class="url-fallback">${resetUrl}</div>
      <p>This link expires in <strong>1 hour</strong> and can only be used once.</p>
      <p>If you didn't request a password reset, you can safely ignore this email — your password will not change.</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} Familista Football Intelligence Platform. All rights reserved.
    </div>
  </div>
</body>
</html>`;
}

function buildPasswordResetText(firstName: string, resetUrl: string): string {
  return [
    `Hi ${firstName},`,
    '',
    'We received a request to reset the password for your Familista account.',
    '',
    `Reset your password: ${resetUrl}`,
    '',
    'This link expires in 1 hour and can only be used once.',
    '',
    "If you didn't request a password reset, you can safely ignore this email.",
    '',
    '— The Familista Team',
  ].join('\n');
}

/**
 * Password reset, through the gateway.
 *
 * The templates above are unchanged and still produce exactly the message this
 * function always sent. What changed is who delivers it: the SendGrid and SMTP
 * code that used to live in this file has moved behind EmailService, so a
 * provider change is one adapter rather than an edit here and in every other
 * place that learned to send mail.
 *
 * Kept as a function with the same name and shape so nothing that calls it had
 * to change. It still resolves rather than throwing on a delivery failure —
 * a reset token is valid whether or not its email got out, and telling a
 * caller otherwise would leak which addresses have accounts.
 */
export async function sendPasswordResetEmail(opts: PasswordResetEmailOptions): Promise<void> {
  const result = await sendEmail({
    to: { address: opts.to, name: opts.firstName || null },
    subject: 'Reset your Familista password',
    html: buildPasswordResetHtml(opts.firstName, opts.resetUrl),
    text: buildPasswordResetText(opts.firstName, opts.resetUrl),
    locale: 'en',
  });
  if (!result.ok) {
    // Logged with a reference rather than the address, and never with the URL —
    // a reset link in a log is a reset link anybody with the log can use.
    logger.warn('password-reset email not delivered', {
      provider: result.providerName,
      failureClass: result.failureClass,
      failureCode: result.failureCode,
      recipient: recipientRef(opts.to),
    });
  }
}
