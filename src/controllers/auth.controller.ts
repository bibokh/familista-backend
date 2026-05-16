import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as authService from '../services/auth.service';
import { sendSuccess, sendCreated } from '../utils/response';

const registerSchema = z.object({
  body: z.object({
    email:     z.string().email(),
    password:  z.string().min(8, 'Password must be at least 8 characters'),
    firstName: z.string().min(1),
    lastName:  z.string().min(1),
    clubId:    z.string().uuid(),
    role:      z.enum(['HEAD_COACH','ASSISTANT_COACH','ANALYST','MEDICAL_STAFF','SCOUT']).optional(),
  }),
});

const loginSchema = z.object({
  body: z.object({
    email:    z.string().email(),
    password: z.string().min(1),
  }),
});

const refreshSchema = z.object({
  body: z.object({ refreshToken: z.string().min(1) }),
});

const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1),
    newPassword:     z.string().min(8),
  }),
});

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    await registerSchema.parseAsync({ body: req.body });
    const result = await authService.registerUser(req.body);
    return sendCreated(res, result, 'Registration successful');
  } catch (err) { return next(err); }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    await loginSchema.parseAsync({ body: req.body });
    const result = await authService.loginUser(req.body.email, req.body.password);
    return sendSuccess(res, result, 'Login successful');
  } catch (err) { return next(err); }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    await refreshSchema.parseAsync({ body: req.body });
    const tokens = await authService.refreshTokens(req.body.refreshToken);
    return sendSuccess(res, tokens, 'Token refreshed');
  } catch (err) { return next(err); }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    await refreshSchema.parseAsync({ body: req.body });
    await authService.logoutUser(req.body.refreshToken);
    return sendSuccess(res, null, 'Logged out successfully');
  } catch (err) { return next(err); }
}

export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, req.user, 'Profile fetched');
  } catch (err) { return next(err); }
}

export async function changePassword(req: Request, res: Response, next: NextFunction) {
  try {
    await changePasswordSchema.parseAsync({ body: req.body });
    await authService.changePassword(
      req.user!.id,
      req.body.currentPassword,
      req.body.newPassword
    );
    return sendSuccess(res, null, 'Password changed successfully');
  } catch (err) { return next(err); }
}
