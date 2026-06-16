// Familista — Home Dashboard controller
// GET /api/v1/home/dashboard → HomeDashboard

import { Request, Response, NextFunction } from 'express';
import * as homeService from '../services/home-data.service';
import { sendSuccess } from '../utils/response';

export async function getDashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const clubId = req.user!.clubId;
    const userId = req.user!.id;
    const data = await homeService.getDashboard(clubId, userId);
    return sendSuccess(res, data, 'Dashboard loaded');
  } catch (err) {
    return next(err);
  }
}
