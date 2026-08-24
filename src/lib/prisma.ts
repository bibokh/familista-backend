// One client, one connection pool.
//
// This file used to construct a PrismaClient of its own — the header called
// itself a local validation shim and claimed the real singleton lived
// elsewhere, but it was in the production build and seventy-two modules
// imported it, against a hundred and thirty-six importing
// ../config/database. Two clients mean two pools: neither knows about the
// other, each sizes itself independently from the CPU count, and the process
// holds twice the connections it is accounted for.
//
// That is what a cold club entry ran into. Entering a club fires a burst of
// concurrent reads; split across two pools that neither share nor queue
// together, the smaller one saturates and Prisma answers P2024 — "timed out
// fetching a new connection from the connection pool". Every endpoint here
// answers in about thirty milliseconds on its own and took ten seconds during
// that burst, which is contention, not slow queries. And because
// whitelabel.middleware imports this module, the second pool was exercised on
// every page load, before anyone had signed in.
//
// The fix is not a larger pool. It is one pool, so the limit means what it
// says. The export is unchanged, so every importer keeps working as before.
export { prisma } from '../config/database';
