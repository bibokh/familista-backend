import { Router } from 'express';
import authRoutes     from './auth.routes';
import playerRoutes   from './player.routes';
import matchRoutes    from './match.routes';
import analyticsRoutes from './analytics.routes';
import aiRoutes       from './ai.routes';
import billingRoutes  from './billing.routes';
import trainingRoutes from './training.routes';

const router = Router();

router.use('/auth',     authRoutes);
router.use('/players',  playerRoutes);
router.use('/matches',  matchRoutes);
router.use('/analytics',analyticsRoutes);
router.use('/ai',       aiRoutes);
router.use('/billing',  billingRoutes);
router.use('/training', trainingRoutes);

// Health check
router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '1.0.0',
  });
});

export default router;
