import * as https from 'https';
import { config } from '../config';
import { logger } from '../utils/logger';

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

async function sendViaSendGrid(opts: PasswordResetEmailOptions): Promise<void> {
  const payload = JSON.stringify({
    personalizations: [{ to: [{ email: opts.to }] }],
    from: {
      email: config.email.fromAddress,
      name: config.email.fromName,
    },
    subject: 'Reset your Familista password',
    content: [
      { type: 'text/plain', value: buildPasswordResetText(opts.firstName, opts.resetUrl) },
      { type: 'text/html',  value: buildPasswordResetHtml(opts.firstName, opts.resetUrl) },
    ],
  });

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.sendgrid.com',
        path:     '/v3/mail/send',
        method:   'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.email.sendgridKey}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          res.resume();
          resolve();
        } else {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => reject(new Error(`SendGrid ${res.statusCode}: ${body}`)));
        }
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendViaSmtp(opts: PasswordResetEmailOptions): Promise<void> {
  // Dynamic require — nodemailer is not a declared dependency; only used when SMTP_HOST is set
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
  const nodemailer = require('nodemailer') as any;

  const transporter = nodemailer.createTransport({
    host:   config.email.smtpHost,
    port:   config.email.smtpPort,
    secure: config.email.smtpPort === 465,
    auth:   config.email.smtpUser
      ? { user: config.email.smtpUser, pass: config.email.smtpPass }
      : undefined,
  });

  await transporter.sendMail({
    from:    `"${config.email.fromName}" <${config.email.fromAddress}>`,
    to:      opts.to,
    subject: 'Reset your Familista password',
    text:    buildPasswordResetText(opts.firstName, opts.resetUrl),
    html:    buildPasswordResetHtml(opts.firstName, opts.resetUrl),
  });
}

export async function sendPasswordResetEmail(opts: PasswordResetEmailOptions): Promise<void> {
  if (config.email.sendgridKey) {
    await sendViaSendGrid(opts);
    logger.info({ msg: 'password-reset email dispatched via SendGrid', to: opts.to });
    return;
  }

  if (config.email.smtpHost) {
    await sendViaSmtp(opts);
    logger.info({ msg: 'password-reset email dispatched via SMTP', to: opts.to });
    return;
  }

  // Dev fallback — log the link so it can be used without a real email provider
  logger.info({
    msg:      'password-reset email (no transport configured — dev log only)',
    to:       opts.to,
    resetUrl: opts.resetUrl,
  });
}
