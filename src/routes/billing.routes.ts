import { Router } from 'express';
import express from 'express';
import * as ctrl from '../controllers/billing.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// Webhook must use raw body — mounted BEFORE json middleware in app
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  ctrl.handleWebhook
);

// Authenticated routes
router.get('/plans',        ctrl.getPlans);
router.get('/subscription', authenticate, ctrl.getSubscription);
router.post('/checkout',    authenticate, ctrl.createCheckout);
router.post('/portal',      authenticate, ctrl.createPortal);

export default router;
