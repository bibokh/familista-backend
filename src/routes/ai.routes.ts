import { Router } from 'express';
import * as ctrl from '../controllers/ai.controller';
import { authenticate } from '../middleware/auth.middleware';
import rateLimit from 'express-rate-limit';

const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { success: false, message: 'Too many AI requests, please wait a moment' },
});

const router = Router();
router.use(authenticate);

router.post('/analyze',           aiLimiter, ctrl.analyze);
router.post('/analyze-player/:id',aiLimiter, ctrl.analyzePlayer);
router.get('/history',            ctrl.getHistory);

export default router;
