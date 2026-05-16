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
    secret: optional('JWT_SECRET', 'dev-secret-change-in-prod-min-32-chars!!'),
    expiresIn: optional('JWT_EXPIRES_IN', '15m'),
    refreshSecret: optional('JWT_REFRESH_SECRET', 'dev-refresh-secret-change-in-prod!!'),
    refreshExpiresIn: optional('JWT_REFRESH_EXPIRES_IN', '7d'),
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

  isProd: process.env.NODE_ENV === 'production',
  isDev:  process.env.NODE_ENV === 'development',
} as const;
