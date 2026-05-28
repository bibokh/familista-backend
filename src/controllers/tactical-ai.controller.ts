// src/controllers/tactical-ai.controller.ts
// Phase 13 — Tactical AI Engine

import type { Request, Response, NextFunction } from 'express';
import { sendSuccess }   from '../utils/response';
import * as svc          from '../tactical/tactical-ai.service';

export async function getMatchAnalysis(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const data = await svc.analyzeMatch(req.params['matchId']!, req.user!.clubId);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}

export async function getTeamAnalysis(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const raw   = req.query['matches'];
    const limit = Math.min(parseInt(typeof raw === 'string' ? raw : '5', 10) || 5, 10);
    const data  = await svc.analyzeTeam(req.params['teamId']!, req.user!.clubId, limit);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}
