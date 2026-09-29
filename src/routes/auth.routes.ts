import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller';
import * as mfaCtrl from '../controllers/account-mfa.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// Public
router.post('/register', ctrl.register);
router.post('/login',    ctrl.login);
// The second step, for an account that requires a code (Cyber Defense, Step 7).
// Public by necessity — no session exists yet; the challenge authenticates it.
router.post('/login/mfa', ctrl.loginMfa);
router.post('/refresh',  ctrl.refresh);
router.post('/logout',   ctrl.logout);

// Password reset (public — no auth required)
router.post('/forgot-password',                  ctrl.forgotPassword);
router.get( '/reset-password/:token/validate',   ctrl.validateResetToken);
router.post('/reset-password',                   ctrl.resetPassword);

// Protected
router.get( '/me',              authenticate, ctrl.me);
router.put( '/change-password', authenticate, ctrl.changePassword);

// Two-step sign-in for the platform owner (Cyber Defense, Step 6), and the
// owner's switch to require it at every sign-in (Step 7).
router.get( '/mfa',                authenticate, mfaCtrl.requirePlatformOwner, mfaCtrl.status);
router.post('/mfa/enroll',         authenticate, mfaCtrl.requirePlatformOwner, mfaCtrl.enroll);
router.post('/mfa/confirm',        authenticate, mfaCtrl.requirePlatformOwner, mfaCtrl.confirm);
router.post('/mfa/recovery-codes', authenticate, mfaCtrl.requirePlatformOwner, mfaCtrl.recoveryCodes);
router.post('/mfa/disable',        authenticate, mfaCtrl.requirePlatformOwner, mfaCtrl.disable);
router.post('/mfa/enforcement',    authenticate, mfaCtrl.requirePlatformOwner, mfaCtrl.enforcement);

export default router;
