// LOCAL VALIDATION SHIM — your production repo has the real implementation.
// In production this file exists at src/config.ts and exports the full config.

export const config = {
  isDev: process.env.NODE_ENV !== 'production',
  apiVersion: process.env.API_VERSION ?? 'v1',
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    max: Number(process.env.RATE_LIMIT_MAX ?? 300),
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-secret-change-me',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-change-me',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
    issuer: process.env.JWT_ISSUER ?? 'familista',
  },
};
