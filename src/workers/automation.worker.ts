// Familista — Automation scheduler (Phase C)
// ─────────────────────────────────────────────────────────────────────────
// Polling scheduler that fires AutomationTask rows when due.
//
// Schedule format (intentionally minimalist for Phase C):
//   "every:30s"  → every 30 seconds
//   "every:5m"   → every 5 minutes
//   "every:1h"   → every hour
//   "every:1d"   → every 24 hours
//   ""  | null   → manual only (never auto-fired)
//
// Phase D can swap to true cron strings via the node-cron package while
// keeping this worker's contract intact (one PENDING AutomationRun per fire).

import { AutomationStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

const TICK_MS = 15_000;   // re-evaluate every 15 seconds; fine for "every:30s" granularity

let _running = false;
let _timer:   ReturnType<typeof setTimeout> | null = null;

// Parses "every:30s|5m|1h|1d" → milliseconds, or null when manual.
function parseIntervalMs(schedule: string | null | undefined): number | null {
  if (!schedule) return null;
  const m = /^every:(\d+)(s|m|h|d)$/.exec(schedule.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const u = m[2];
  if (!Number.isFinite(n) || n <= 0) return null;
  if (u === 's') return n * 1_000;
  if (u === 'm') return n * 60_000;
  if (u === 'h') return n * 3_600_000;
  if (u === 'd') return n * 86_400_000;
  return null;
}

async function tick(): Promise<void> {
  if (!_running) return;
  try {
    const tasks = await prisma.automationTask.findMany({
      where: { isActive: true },
      select: { id: true, schedule: true, lastRunAt: true, kind: true, clubId: true },
    });

    let fired = 0;
    for (const t of tasks) {
      const intervalMs = parseIntervalMs(t.schedule);
      if (!intervalMs) continue;                  // manual / unparsable
      const elapsed = t.lastRunAt ? (Date.now() - t.lastRunAt.getTime()) : Infinity;
      if (elapsed < intervalMs) continue;         // not due yet

      // Atomically claim — refuse to fire if someone else just bumped lastRunAt.
      const claim = await prisma.automationTask.updateMany({
        where: t.lastRunAt ? { id: t.id, lastRunAt: t.lastRunAt } : { id: t.id, lastRunAt: null },
        data:  { lastRunAt: new Date(), lastStatus: AutomationStatus.PENDING },
      });
      if (claim.count === 0) continue;            // lost the race

      // Enqueue a PENDING AutomationRun — workers (Phase C+) drain it.
      await prisma.automationRun.create({
        data: { taskId: t.id, status: AutomationStatus.PENDING },
      });
      fired++;
    }
    if (fired > 0) logger.info('[automation] fired', { count: fired });
  } catch (err) {
    logger.error('[automation] tick error', { err: (err as Error)?.message });
  } finally {
    if (_running) _timer = setTimeout(tick, TICK_MS);
  }
}

export function startAutomationScheduler(): void {
  if (_running) return;
  _running = true;
  logger.info('[automation] starting scheduler', { tickMs: TICK_MS });
  _timer = setTimeout(tick, TICK_MS);
}

export async function stopAutomationScheduler(): Promise<void> {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  logger.info('[automation] scheduler stopped');
}
