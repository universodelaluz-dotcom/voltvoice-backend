import { Router } from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import monitoring from '../services/monitoring.js';

const router = Router();

router.get('/metrics', requireAdmin, (req, res) => {
  return res.json({
    success: true,
    generatedAt: new Date().toISOString(),
    metrics: monitoring.getSnapshot(),
  });
});

export default router;
