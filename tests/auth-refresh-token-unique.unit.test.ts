/**
 * tests/auth-refresh-token-unique.unit.test.ts
 *
 * Two logins for the same user inside one second must not mint the same
 * refresh token.
 *
 * RefreshToken.token stores the JWT itself and the column is @unique. A JWT's
 * `iat` has one-second resolution, so signing the same payload twice within a
 * second produces byte-identical strings — and the second login dies on the
 * unique constraint. Observed in this repository as `409 A record with this
 * value already exists` on a double-clicked login or a second tab.
 *
 * This drives the real login path (loginUser → issueTokens →
 * generateRefreshToken → refreshToken.create) with Prisma and bcrypt mocked, in
 * the same way the other unit suites here mock their dependencies. Time is
 * frozen so "the same second" is a fact of the test rather than a race.
 *
 * Not added to auth.cookie.integration.test.ts: that suite is `describe.skip`
 * without TEST_DATABASE_URL, so it cannot demonstrate this failing or passing
 * in the default run.
 */

const userFindUnique   = jest.fn();
const userUpdate       = jest.fn();
const refreshTokenCreate = jest.fn();

jest.mock('../src/config/database', () => ({
  prisma: {
    user:         { findUnique: (...a: unknown[]) => userFindUnique(...a),
                    update:     (...a: unknown[]) => userUpdate(...a) },
    refreshToken: { create:     (...a: unknown[]) => refreshTokenCreate(...a) },
  },
}));

jest.mock('bcryptjs', () => ({
  __esModule: true,
  default: { compare: jest.fn().mockResolvedValue(true), hash: jest.fn() },
}));

jest.mock('../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import jwt from 'jsonwebtoken';
import { loginUser } from '../src/services/auth.service';
import { config } from '../src/config';

const USER = {
  id: 'user-1',
  email: 'coach@example.test',
  passwordHash: 'hashed',
  firstName: 'Test',
  lastName: 'Coach',
  role: 'HEAD_COACH',
  clubId: 'club-1',
  isActive: true,
  club: { name: 'Test Club' },
};

// The unique column, modelled: a second insert of the same token value is the
// constraint violation the user sees as a 409.
let stored: string[] = [];

beforeEach(() => {
  stored = [];
  userFindUnique.mockResolvedValue(USER);
  userUpdate.mockResolvedValue(USER);
  refreshTokenCreate.mockImplementation(({ data }: { data: { token: string } }) => {
    if (stored.includes(data.token)) {
      return Promise.reject(new Error('Unique constraint failed on the fields: (`token`)'));
    }
    stored.push(data.token);
    return Promise.resolve({ id: 'rt-' + stored.length, token: data.token });
  });
  // Freeze the clock so both logins land in the same second by construction.
  jest.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('refresh tokens issued in the same second', () => {
  it('are different from each other', async () => {
    const first  = await loginUser(USER.email, 'password');
    const second = await loginUser(USER.email, 'password');

    expect(second.tokens.refreshToken).not.toBe(first.tokens.refreshToken);
  });

  it('both persist without violating the unique column', async () => {
    await loginUser(USER.email, 'password');
    await expect(loginUser(USER.email, 'password')).resolves.toBeDefined();
    expect(stored).toHaveLength(2);
    expect(new Set(stored).size).toBe(2);
  });

  it('are both valid JWTs carrying the unchanged claims', async () => {
    const { tokens } = await loginUser(USER.email, 'password');
    const decoded = jwt.verify(tokens.refreshToken, config.jwt.refreshSecret) as Record<string, unknown>;

    expect(decoded.sub).toBe(USER.id);
    expect(decoded.email).toBe(USER.email);
    expect(decoded.role).toBe(USER.role);
    expect(decoded.clubId).toBe(USER.clubId);
    expect(typeof decoded.iat).toBe('number');
    expect(typeof decoded.exp).toBe('number');
  });

  it('leaves the access token untouched', async () => {
    const first  = await loginUser(USER.email, 'password');
    const second = await loginUser(USER.email, 'password');

    // The access token is not stored and has no uniqueness requirement, so it
    // keeps exactly the claims it had: same payload in the same second, same
    // token, and no added identifier.
    const decoded = jwt.verify(first.tokens.accessToken, config.jwt.secret) as Record<string, unknown>;
    expect(decoded.sub).toBe(USER.id);
    expect(decoded.email).toBe(USER.email);
    expect(decoded.role).toBe(USER.role);
    expect(decoded.clubId).toBe(USER.clubId);
    expect(decoded.jti).toBeUndefined();
    expect(second.tokens.accessToken).toBe(first.tokens.accessToken);
  });
});
