import { Router } from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import { verifyToken } from '../../middleware/auth.js';
import monitoring from '../services/monitoring.js';
import pool from '../db.js';

const router = Router();

router.get('/metrics', requireAdmin, (req, res) => {
  return res.json({
    success: true,
    generatedAt: new Date().toISOString(),
    metrics: monitoring.getSnapshot(),
  });
});

router.get('/announcements', verifyToken, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT plan, role FROM users WHERE id::text = $1::text', [req.user.userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const userPlan = userResult.rows[0].role === 'admin' ? 'admin' : String(userResult.rows[0].plan || 'free').toLowerCase();

    const notices = await pool.query(
      `SELECT id, kind, title, message, audience_plan, priority, starts_at, ends_at, created_at
       FROM admin_broadcasts
       WHERE status = 'active'
         AND (audience_plan = 'all' OR audience_plan = $1)
         AND (starts_at IS NULL OR starts_at <= NOW())
         AND (ends_at IS NULL OR ends_at >= NOW())
       ORDER BY created_at DESC
       LIMIT 30`,
      [userPlan]
    );

    return res.json({ success: true, announcements: notices.rows });
  } catch (err) {
    console.error('[Ops] Error announcements:', err.message);
    return res.status(500).json({ error: 'Error obteniendo anuncios' });
  }
});

export default router;
