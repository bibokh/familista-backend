// Cyber Defense, Step 10 — backup runs as BackupRecords, one at a time
// ─────────────────────────────────────────────────────────────────────────────
// The global lock is a PostgreSQL transaction-level advisory lock, taken on a
// transaction that stays open for the length of the run. It is released by
// the database when that transaction ends — on success, on failure, or when
// the process dies and its connection drops — so it cannot be left behind.
// It needs no Redis, which the service may not have.

import type { PrismaClient } from '@prisma/client';
import type { BackupDb } from './backup-runner';
import { MAX_RUN_MS, type BackupRunStore, type RunRow } from './backup-trigger';

/** 'FBK1' as a number: the one advisory-lock key backups use. */
export const BACKUP_LOCK_KEY = 0x46424b31;

const RUN_FIELDS = { id: true, startedAt: true, finishedAt: true, ok: true } as const;

export function prismaRunStore(prisma: PrismaClient): BackupRunStore {
  return {
    withLock(fn) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ got: boolean }>>`SELECT pg_try_advisory_xact_lock(${BACKUP_LOCK_KEY}::bigint) AS got`;
        return fn(rows[0]?.got === true);
      }, { maxWait: 10_000, timeout: MAX_RUN_MS + 10 * 60 * 1000 });
    },
    async lastSuccessAt() {
      const r = await prisma.backupRecord.findFirst({
        where: { kind: 'SCHEDULED', ok: true, finishedAt: { not: null } },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      });
      return r?.finishedAt ?? null;
    },
    async latestUnfinished(): Promise<RunRow | null> {
      return prisma.backupRecord.findFirst({ where: { kind: 'SCHEDULED', finishedAt: null }, orderBy: { startedAt: 'desc' }, select: RUN_FIELDS });
    },
    async createRunning(startedAt) {
      const r = await prisma.backupRecord.create({
        data: { kind: 'SCHEDULED', ok: false, startedAt, notes: JSON.stringify({ format: 'FBK1', state: 'running', trigger: 'scheduled' }) },
        select: { id: true },
      });
      return r.id;
    },
    async find(id): Promise<RunRow | null> {
      return prisma.backupRecord.findUnique({ where: { id }, select: RUN_FIELDS });
    },
  };
}

/** The runner's database side, completing the run's own record rather than adding another. */
export function recordDbFor(prisma: PrismaClient, id: string): BackupDb {
  return {
    async migrationHead() {
      try {
        const rows = await prisma.$queryRaw<Array<{ name: string | null }>>`
          SELECT max(migration_name) AS name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
        return rows[0]?.name ?? null;
      } catch { return null; }
    },
    async record(row) {
      await prisma.backupRecord.update({
        where: { id },
        data: {
          ok: row.ok,
          ref: row.ref ?? null,
          sizeBytes: row.sizeBytes === undefined ? null : BigInt(row.sizeBytes),
          sha256: row.sha256 ?? null,
          finishedAt: row.finishedAt,
          notes: row.notes,
        },
      });
    },
  };
}
