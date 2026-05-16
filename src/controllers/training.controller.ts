import { Request, Response, NextFunction } from 'express';
import * as trainingService from '../services/training.service';
import { sendSuccess, sendCreated, sendNoContent, sendPaginated } from '../utils/response';

export async function getSessions(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, limit } = req.query;
    const result = await trainingService.getTrainingSessions(req.user!.clubId, {
      page:  page  ? parseInt(page  as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    return sendPaginated(res, result.sessions, result.total, result.page, result.limit);
  } catch (err) { return next(err); }
}

export async function getSession(req: Request, res: Response, next: NextFunction) {
  try {
    const session = await trainingService.getTrainingById(req.params.id, req.user!.clubId);
    return sendSuccess(res, session);
  } catch (err) { return next(err); }
}

export async function createSession(req: Request, res: Response, next: NextFunction) {
  try {
    const session = await trainingService.createTrainingSession(req.user!.clubId, req.body);
    return sendCreated(res, session, 'Training session created');
  } catch (err) { return next(err); }
}

export async function updateSession(req: Request, res: Response, next: NextFunction) {
  try {
    const session = await trainingService.updateTrainingSession(req.params.id, req.user!.clubId, req.body);
    return sendSuccess(res, session, 'Training session updated');
  } catch (err) { return next(err); }
}

export async function deleteSession(req: Request, res: Response, next: NextFunction) {
  try {
    await trainingService.deleteTrainingSession(req.params.id, req.user!.clubId);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

export async function getForm(req: Request, res: Response, next: NextFunction) {
  try {
    const form = await trainingService.getTrainingForm(req.user!.clubId);
    return sendSuccess(res, form);
  } catch (err) { return next(err); }
}
