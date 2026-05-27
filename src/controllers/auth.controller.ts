import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as authService from '../services/auth.service';
import * as passwordResetService from '../services/password-reset.service';
import { sendSuccess, sendCreated } from '../utils/response';
import { config } from '../config';

// ─── Cookie helpers ────────────────────────────────────────────────────────────

/** 15-minute access-token cookie — HttpOnly, Secure in production. */
const ACCESS_COOKIE_OPTS = {
  httpOnly:  true,
  secure:    config.isProd,
  sameSite:  'strict' as const,
  maxAge:    15 * 60 * 1000,           // 15 min in ms
  path:      '/',
};

/** 7-day refresh-token cookie — path-restricted to auth endpoints. */
const REFRESH_COOKIE_OPTS = {
  httpOnly:  true,
  secure:    config.isProd,
  sameSite:  'strict' as const,
  maxAge:    7 * 24 * 60 * 60 * 1000, // 7 days in ms
  path:      '/api',                   // sent on all /api/* paths
};

function setAuthCookies(res: Response, tokens: authService.TokenPair): void {
  res.cookie('access_token',  tokens.accessToken,  ACCESS_COOKIE_OPTS);
  res.cookie('refresh_token', tokens.refreshToken, REFRESH_COOKIE_OPTS);
}

function clearAuthCookies(res: Response): void {
  res.clearCookie('access_token',  { ...ACCESS_COOKIE_OPTS,  maxAge: 0 });
  res.clearCookie('refresh_token', { ...REFRESH_COOKIE_OPTS, maxAge: 0 });
}

/** Resolve refresh token: prefer HttpOnly cookie, fall back to request body. */
function resolveRefreshToken(req: Request): string | undefined {
  return (req.cookies as Record<string, string>)?.refresh_token
      || req.body?.refreshToken;
}

// ─── Validation schemas ────────────────────────────────────────────────────────

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

const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1),
    newPassword:     z.string().min(8),
  }),
});

// ─── Controllers ───────────────────────────────────────────────────────────────

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    await registerSchema.parseAsync({ body: req.body });
    const result = await authService.registerUser(req.body);
    setAuthCookies(res, result.tokens);
    return sendCreated(res, result, 'Registration successful');
  } catch (err) { return next(err); }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    await loginSchema.parseAsync({ body: req.body });
    const result = await authService.loginUser(req.body.email, req.body.password);
    setAuthCookies(res, result.tokens);
    return sendSuccess(res, result, 'Login successful');
  } catch (err) { return next(err); }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const token = resolveRefreshToken(req);
    if (!token) {
      // Zod-compatible 400 for missing token
      await z.object({ body: z.object({ refreshToken: z.string().min(1) }) })
        .parseAsync({ body: {} });
    }
    const tokens = await authService.refreshTokens(token!);
    setAuthCookies(res, tokens);
    return sendSuccess(res, tokens, 'Token refreshed');
  } catch (err) { return next(err); }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    const token = resolveRefreshToken(req);
    if (token) {
      await authService.logoutUser(token);
    }
    clearAuthCookies(res);
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

// ─── Password Reset ────────────────────────────────────────────────────────────

const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email('A valid email address is required'),
  }),
});

const resetPasswordSchema = z.object({
  body: z.object({
    token:       z.string().min(1, 'Reset token is required'),
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
  }),
});

const tokenParamSchema = z.object({
  params: z.object({
    token: z.string().min(1),
  }),
});

export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    await forgotPasswordSchema.parseAsync({ body: req.body });
    const result = await passwordResetService.requestPasswordReset(req.body.email);
    // Always return the same message regardless of whether the email exists (anti-enumeration)
    return sendSuccess(res, result, 'If that email is registered you will receive a reset link shortly');
  } catch (err) { return next(err); }
}

export async function validateResetToken(req: Request, res: Response, next: NextFunction) {
  try {
    await tokenParamSchema.parseAsync({ params: req.params });
    const result = await passwordResetService.validateResetToken(req.params.token);
    return sendSuccess(res, result, 'Token is valid');
  } catch (err) { return next(err); }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    await resetPasswordSchema.parseAsync({ body: req.body });
    await passwordResetService.resetPassword(req.body.token, req.body.newPassword);
    return sendSuccess(res, null, 'Password has been reset successfully. Please log in with your new password.');
  } catch (err) { return next(err); }
}
