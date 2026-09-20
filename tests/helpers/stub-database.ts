/**
 * A database for suites that believe they do not need one
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Three smoke suites each carry a header saying their auth-guard tests are
 * "safe without a live DB" because "every route rejects unauthenticated /
 * bad-token requests BEFORE any Prisma call".
 *
 * That was never true. `authenticate` verifies the JWT and then calls
 * `loadIdentity`, which is `prisma.user.findFirst` — the guard has to know the
 * account still exists and is active, and it cannot know that from a token.
 *
 * The suites passed anyway, for the wrong reason. With no database reachable
 * the query THREW, the request became a 500, and an assertion of
 * `expect(status).not.toBe(401)` was satisfied by a server error. Point the
 * same suites at a real, empty database — which is what CI has — and the query
 * returns null, the middleware correctly answers 401, and twenty-two
 * assertions fail. They were asserting that a token for a NON-EXISTENT user
 * reaches a club route, which is the opposite of what must happen.
 *
 * This makes the claim true instead of accidental: the identity read is
 * answered deterministically, so the guard is exercised with a known, active
 * user in every environment — with a database, without one, and in CI.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not run when `TEST_DATABASE_URL` is set. Those suites' DB-gated
 * sections want the real client, and replacing it there would make a live-data
 * test assert against a stub.
 */

/** The fields `authenticate` reads. Anything else it does not look at. */
export interface StubIdentity {
  id: string;
  email?: string;
  /**
   * The role the middleware will use.
   *
   * Read from THIS ROW, never from the token — so a token minted with a
   * different role claim does not change what the request is authorised as.
   * Worth knowing before writing a role test against this path.
   */
  role?: string;
  clubId?: string | null;
}

/**
 * The module replacement for `src/config/database`.
 *
 * Every model answers the shape of a query and the substance of none, except
 * `user`, which answers the identity the guard is about to ask for.
 */
export function stubDatabase(identity: StubIdentity): { prisma: unknown } {
  if (process.env.TEST_DATABASE_URL) {
    // A live database is configured: the DB-gated sections are running and
    // they must talk to it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    return require('../../src/config/database');
  }

  const user = {
    id: identity.id,
    email: identity.email ?? 'test@test.com',
    role: identity.role ?? 'HEAD_COACH',
    clubId: identity.clubId ?? null,
    isActive: true,
    currentClubId: identity.clubId ?? null,
    currentTeamId: null,
    tokenVersion: 0,
    platformAdmin: null,
  };

  return {
    prisma: new Proxy({}, {
      get: (_t, key: string) => {
        if (key === '$queryRaw' || key === '$executeRaw') return async () => [{ ok: 1 }];
        if (key === '$transaction') {
          return async (arg: unknown) => (Array.isArray(arg) ? [] : (arg as (tx: unknown) => unknown)({}));
        }
        if (key === '$connect' || key === '$disconnect') return async () => {};
        if (key === 'user') {
          return {
            findFirst: async () => user,
            findUnique: async () => user,
            findMany: async () => [user],
            count: async () => 1,
          };
        }
        return new Proxy({}, { get: (_x, op: string) => async () => {
          if (op === 'count') return 0;
          if (op === 'findFirst' || op === 'findUnique') return null;
          if (op === 'aggregate') return { _count: 0, _sum: {}, _min: {}, _max: {} };
          return [];
        } });
      },
    }),
  };
}
