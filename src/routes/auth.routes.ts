import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// Public
router.post('/register', ctrl.register);
router.post('/login',    ctrl.login);
router.post('/refresh',  ctrl.refresh);
router.post('/logout',   ctrl.logout);

// Password reset (public — no auth required)
router.post('/forgot-password',                  ctrl.forgotPassword);
router.get( '/reset-password/:token/validate',   ctrl.validateResetToken);
router.post('/reset-password',                   ctrl.resetPassword);

// Protected
router.get( '/me',              authenticate, ctrl.me);
router.put( '/change-password', authenticate, ctrl.changePassword);

export default router;
