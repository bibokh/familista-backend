-- Add the INJURED value to the AttendanceMark enum.
-- Isolated in its own migration (Prisma convention for enum changes) so the
-- column-adding migration that follows is a clean transactional block.
-- Additive + idempotent: IF NOT EXISTS makes re-runs a no-op; no data change.
ALTER TYPE "AttendanceMark" ADD VALUE IF NOT EXISTS 'INJURED';
