import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

/**
 * The connection pool.
 *
 * Prisma's default is `cores * 2 + 1` — nine connections on a four-core
 * instance. Postgres here permits a hundred, so under concurrent load the
 * application was queueing behind nine connections while ninety sat idle: every
 * endpoint measured the same p50 because they were all waiting for the same
 * thing rather than doing different amounts of work.
 *
 * The pool is sized from the environment so an operator can match it to the
 * database's own `max_connections` and to the number of instances sharing it —
 * `connection_limit × instances` must stay under it. The default is a
 * conservative twenty-five, which one instance can use and four instances can
 * share against a hundred-connection database.
 */
function datasourceUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  if (/[?&]connection_limit=/.test(raw)) return raw;      // an operator set it explicitly
  const limit = process.env.DB_CONNECTION_LIMIT ?? '25';
  const timeout = process.env.DB_POOL_TIMEOUT ?? '20';
  return raw + (raw.includes('?') ? '&' : '?')
    + `connection_limit=${encodeURIComponent(limit)}&pool_timeout=${encodeURIComponent(timeout)}`;
}

export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    datasourceUrl: datasourceUrl(),
    log: [
      { level: 'query',  emit: 'event' },
      { level: 'error',  emit: 'event' },
      { level: 'warn',   emit: 'event' },
    ],
  });

// Held in every environment, not only outside production. The guard used to be
// skipped in production, so anything that caused this module to be evaluated
// twice — two copies in the dependency graph, a CJS and an ESM build of the
// same file — silently produced a second client with a second connection pool.
// A pool limit only means something if there is one pool.
global.__prisma = prisma;

// A counter, so the cost of a request cycle can be measured rather than
// guessed. Off unless PRISMA_QUERY_COUNT is set, because counting every query
// in production is itself a cost.
export const queryCounter = { n: 0 };
if (process.env.PRISMA_QUERY_COUNT === '1') {
  prisma.$on('query' as never, () => { queryCounter.n++; });
}

prisma.$on('error' as never, (e: unknown) => {
  logger.error('Prisma error', { error: e });
});

prisma.$on('warn' as never, (e: unknown) => {
  logger.warn('Prisma warning', { warn: e });
});

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info('✅ Database connected');
  } catch (err) {
    logger.error('❌ Database connection failed', { err });
    process.exit(1);
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}
