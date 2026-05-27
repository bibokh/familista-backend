/**
 * Jest global setup — runs before any test module is imported.
 * Sets the minimum required env vars so config/index.ts does not throw
 * on `required()` calls at module-load time.
 *
 * Tests that actually query the database check for TEST_DATABASE_URL and
 * skip themselves when it is absent (see individual test files).
 */

// Core
process.env.NODE_ENV = 'test';

// Database — use TEST_DATABASE_URL if provided; fall back to a placeholder
// so required() in config does not throw. DB-dependent tests skip themselves
// when this value is the placeholder.
if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/familista_test_placeholder';
}
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// JWT — short, distinct test secrets. Never use production values here.
process.env.JWT_ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  ?? 'test-access-secret-jest-min-32-chars!!';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'test-refresh-secret-jest-min-32-chars!!';
process.env.JWT_EXPIRES_IN     = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';

// MFA (optional — not required for auth smoke tests)
process.env.MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY ?? 'test-mfa-key-jest-min-32-chars-pad!!';
