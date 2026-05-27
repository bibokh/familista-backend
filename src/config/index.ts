import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env variable: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '4000')),
  apiVersion: optional('API_VERSION', 'v1'),

  db: {
    url: required('DATABASE_URL'),
  },

  jwt: {
    // render.yaml sets JWT_ACCESS_SECRET (sync: false) — must match this name exactly.
    secret: required('JWT_ACCESS_SECRET'),
    expiresIn: optional('JWT_EXPIRES_IN', '15m'),
    // render.yaml sets JWT_REFRESH_SECRET (sync: false).
    refreshSecret: required('JWT_REFRESH_SECRET'),
    refreshExpiresIn: optional('JWT_REFRESH_EXPIRES_IN', '7d'),
  },

  mfa: {
    // Dedicated encryption key for TOTP seed AES-256-GCM storage.
    // MUST be distinct from the JWT secret — rotating one must not affect the other.
    // render.yaml: MFA_ENCRYPTION_KEY (sync: false, 32+ random bytes, base64url encoded).
    // If absent at startup the service throws; provide the key before any user enables MFA.
    encryptionKey: process.env.MFA_ENCRYPTION_KEY ?? '',
  },

  anthropic: {
    apiKey: optional('ANTHROPIC_API_KEY', ''),
    model: 'claude-sonnet-4-20250514',
    maxTokens: 1000,
  },

  stripe: {
    secretKey: optional('STRIPE_SECRET_KEY', ''),
    webhookSecret: optional('STRIPE_WEBHOOK_SECRET', ''),
    prices: {
      basic:   optional('STRIPE_PRICE_BASIC',   ''),
      pro:     optional('STRIPE_PRICE_PRO',     ''),
      academy: optional('STRIPE_PRICE_ACADEMY', ''),
    },
  },

  cors: {
    origin: optional('FRONTEND_URL', 'http://localhost:3000'),
  },

  rateLimit: {
    windowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '900000')),
    max:      parseInt(optional('RATE_LIMIT_MAX',        '100')),
  },

  log: {
    level: optional('LOG_LEVEL', 'info'),
  },

  email: {
    fromAddress:  optional('EMAIL_FROM',       'noreply@familista.app'),
    fromName:     optional('EMAIL_FROM_NAME',  'Familista'),
    sendgridKey:  optional('SENDGRID_API_KEY', ''),
    smtpHost:     optional('SMTP_HOST',        ''),
    smtpPort:     parseInt(optional('SMTP_PORT', '587')),
    smtpUser:     optional('SMTP_USER',        ''),
    smtpPass:     optional('SMTP_PASS',        ''),
    appUrl:       optional('APP_URL',          'http://localhost:3000'),
  },

  isProd: process.env.NODE_ENV === 'production',
  isDev:  process.env.NODE_ENV === 'development',
} as const;
