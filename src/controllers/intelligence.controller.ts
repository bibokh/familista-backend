// Familista — Intelligence Controller (Phase S.2)
// Target: src/controllers/intelligence.controller.ts
// ─────────────────────────────────────────────────────────────────────────────
// Thin HTTP adapter for the AI Intelligence Service.
// All business logic lives in intelligence.service.ts.

import { Request, Response, NextFunction } from 'express';
import * as Svc from '../intelligence/intelligence.service';

// ─── Actor helper ─────────────────────────────────────────────────────────────

function actor(req: Request): Svc.IntelligenceActor {
  return {
    userId: (req as any).user?.id     ?? '',
    clubId: (req as any).user?.clubId ?? '',
    role:   (req as any).user?.role,
  };
}

// ─── Trigger endpoints ────────────────────────────────────────────────────────

export async function triggerMatchAnalysis(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { matchId } = req.params;
    const job = await Svc.triggerMatchAnalysis(actor(req), matchId);
    res.status(202).json(job);
  } catch (err) { next(err); }
}

export async function triggerTacticalAdvisor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { teamId } = req.params;
    const job = await Svc.triggerTacticalAdvisor(actor(req), teamId);
    res.status(202).json(job);
  } catch (err) { next(err); }
}

export async function triggerRecruitmentAdvisor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const job = await Svc.triggerRecruitmentAdvisor(actor(req));
    res.status(202).json(job);
  } catch (err) { next(err); }
}

export async function triggerTrainingPlanner(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { teamId } = req.params;
    const job = await Svc.triggerTrainingPlanner(actor(req), teamId);
    res.status(202).json(job);
  } catch (err) { next(err); }
}

export async function triggerInjuryRiskScan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { teamId } = req.params;
    const job = await Svc.triggerInjuryRiskScan(actor(req), teamId);
    res.status(202).json(job);
  } catch (err) { next(err); }
}

// ─── Read endpoints ───────────────────────────────────────────────────────────

export async function listJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const domain = (req.query.domain as string) ?? '';
    const limit  = parseInt((req.query.limit as string) ?? '20', 10);
    const jobs   = await Svc.listJobs(actor(req), domain, limit);
    res.json({ items: jobs, total: jobs.length });
  } catch (err) { next(err); }
}

export async function getJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const job = await Svc.getJob(actor(req), req.params.jobId);
    res.json(job);
  } catch (err) { next(err); }
}
