/**
 * Familista Creator Studio (P2) — a creator's way in, mounted at /creator/auth, before any session: the sign-up terms,
 * sign-up by invitation, sign-in, the session's refresh and end, and the address and password links. Every credential
 * endpoint takes the tighter auth rate limit (per account, and per failing address) on top of the platform's; sign-in
 * also has its own lockout, counted apart from club sign-ins. A cross-site request is refused by the CORS origin
 * allowlist (app.ts) first. Nothing here reads or names a club.
 */
import { Router } from 'express';
import { rateLimitAuth } from '../middleware/rate-limit.middleware';
import {
  creatorForgotPassword, creatorLogin, creatorLogout, creatorRefresh, creatorRegister, creatorResetPassword, creatorSignupTerms, creatorVerifyEmail,
} from '../platform/creator/http';

const router = Router();
router.use(rateLimitAuth);
router.get('/terms', creatorSignupTerms);
router.post('/register', creatorRegister);
router.post('/login', creatorLogin);
router.post('/refresh', creatorRefresh);
router.post('/logout', creatorLogout);
router.post('/verify-email', creatorVerifyEmail);
router.post('/forgot-password', creatorForgotPassword);
router.post('/reset-password', creatorResetPassword);

export default router;
