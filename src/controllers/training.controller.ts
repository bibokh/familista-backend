import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import * as trainingService from '../services/training.service';
import { sendSuccess, sendCreated, sendNoContent, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

// Matches the DrillType enum in prisma/schema.prisma — no runtime Prisma dependency.
const DRILLS = [
  'TECHNICAL_PASSING', 'SPRINT_INTERVALS', 'SHOOTING_PRACTICE', 'DEFENSIVE_SHAPE',
  'TRANSITION_PLAY', 'RECOVERY', 'SET_PIECES', 'POSSESSION', 'PRESSING', 'CUSTOM',
] as const;

const DATE_OR_ISO = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/));

const createSchema = z.object({
  body: z.object({
    title:       z.string().trim().min(1).max(200),
    description: z.string().max(4000).optional(),
    location:    z.string().trim().max(200).optional(),
    scheduledAt: DATE_OR_ISO,
    duration:    z.number().int().min(1).max(480),
    drills:      z.array(z.enum(DRILLS)).optional(),
    playerIds:   z.array(z.string().uuid()).optional(),
  }),
});

const updateSchema = z.object({
  body: z.object({
    title:       z.string().trim().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    location:    z.string().trim().max(200).optional(),
    scheduledAt: DATE_OR_ISO.optional(),
    duration:    z.number().int().min(1).max(480).optional(),
    drills:      z.array(z.enum(DRILLS)).optional(),
    playerIds:   z.array(z.string().uuid()).optional(),
  }).refine((b) => Object.keys(b).length > 0, { message: 'No fields supplied to update' }),
});

const ATTENDANCE_MARKS = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'] as const;
const attendanceSchema = z.object({
  body: z.object({
    marks: z.array(z.object({
      playerId: z.string().uuid(),
      mark:     z.enum(ATTENDANCE_MARKS),
      notes:    z.string().max(500).optional(),
    })).min(1),
  }),
});

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}

// ─── New clean Create Session flow ────────────────────────────────────────
// Independent of the legacy createSchema / createSession path so nothing in
// the old code interferes. `notes` maps to TrainingSession.description.
const newSessionSchema = z.object({
  body: z.object({
    title:       z.string().trim().min(1).max(200),
    scheduledAt: DATE_OR_ISO,
    duration:    z.number().int().min(1).max(480),
    location:    z.string().trim().max(200).optional(),
    notes:       z.string().max(4000).optional(),
    drills:      z.array(z.enum(DRILLS)).optional(),
    playerIds:   z.array(z.string().uuid()).optional(),
  }),
});

export async function createNewSession(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.clubId) throw new BadRequestError('No active club context');
    const parsed = newSessionSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const session = await trainingService.createCleanSession(req.user.clubId, parsed.data.body);
    return sendCreated(res, session, 'Training session created');
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const meta = err.meta ? ` ${JSON.stringify(err.meta)}` : '';
      return next(new BadRequestError(`Create training failed [${err.code}]${meta}`));
    }
    return next(err);
  }
}

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
    const parsed = createSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const session = await trainingService.createTrainingSession(req.user!.clubId, parsed.data.body);
    return sendCreated(res, session, 'Training session created');
  } catch (err) {
    // Endpoint-scoped surfacing: any Prisma known-request error (P2002 unique,
    // P2003 FK, P2011 null, P2025 not-found, …) becomes a 400 with code + meta
    // so the modal banner shows the real cause instead of the global error
    // handler's generic 500 "Server error. Please retry shortly."
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const meta = err.meta ? ` ${JSON.stringify(err.meta)}` : '';
      return next(new BadRequestError(`Create training failed [${err.code}]${meta}`));
    }
    // PrismaClientValidationError is thrown client-side by Prisma when the
    // generated Client's internal schema doesn't recognise an argument (e.g.
    // a column added by a migration the Client wasn't regenerated against).
    // Same principle as the known-request catch above: surface the cause as
    // a clean 400 instead of letting it fall through to the generic 500.
    if (err instanceof Prisma.PrismaClientValidationError) {
      const msg = (err.message || '').split('\n').filter(Boolean).slice(-1)[0] || 'Prisma validation error';
      return next(new BadRequestError(`Create training failed [PrismaValidation] ${msg}`));
    }
    return next(err);
  }
}

export async function updateSession(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = updateSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const session = await trainingService.updateTrainingSession(req.params.id, req.user!.clubId, parsed.data.body);
    return sendSuccess(res, session, 'Training session updated');
  } catch (err) {
    // Endpoint-scoped surfacing — mirrors createSession. Any Prisma known
    // request error (P2002 unique, P2003 FK, P2011 null, P2025 not-found, …)
    // becomes a 400 with code + meta so the modal banner shows the real
    // cause instead of the global error handler's generic 500
    // "Server error. Please retry shortly."
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const meta = err.meta ? ` ${JSON.stringify(err.meta)}` : '';
      return next(new BadRequestError(`Update training failed [${err.code}]${meta}`));
    }
    // Same client-side validation catch as createSession — converts a stale
    // Prisma Client / schema mismatch into a clean 400 with the offending
    // argument named, instead of a generic 500.
    if (err instanceof Prisma.PrismaClientValidationError) {
      const msg = (err.message || '').split('\n').filter(Boolean).slice(-1)[0] || 'Prisma validation error';
      return next(new BadRequestError(`Update training failed [PrismaValidation] ${msg}`));
    }
    return next(err);
  }
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

export async function getAttendance(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await trainingService.getTrainingAttendance(req.params.id, req.user!.clubId);
    return sendSuccess(res, result);
  } catch (err) { return next(err); }
}

export async function saveAttendance(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = attendanceSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const result = await trainingService.setTrainingAttendance(
      req.params.id,
      req.user!.clubId,
      req.user!.id,
      parsed.data.body.marks,
    );
    return sendSuccess(res, result, 'Attendance saved');
  } catch (err) { return next(err); }
}
