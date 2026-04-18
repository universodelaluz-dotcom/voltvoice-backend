import { Router } from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import { verifyToken } from '../../middleware/auth.js';
import monitoring from '../services/monitoring.js';
import pool from '../db.js';

const router = Router();

const ensureBroadcastTargetsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_broadcast_targets (
      id SERIAL PRIMARY KEY,
      broadcast_id INTEGER NOT NULL REFERENCES admin_broadcasts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (broadcast_id, user_id)
    );
  `);
};

router.get('/metrics', requireAdmin, (req, res) => {
  return res.json({
    success: true,
    generatedAt: new Date().toISOString(),
    metrics: monitoring.getSnapshot(),
  });
});

router.get('/announcements', verifyToken, async (req, res) => {
  try {
    await ensureBroadcastTargetsTable();
    const userResult = await pool.query('SELECT plan, role FROM users WHERE id::text = $1::text', [req.user.userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const userPlan = userResult.rows[0].role === 'admin' ? 'admin' : String(userResult.rows[0].plan || 'free').toLowerCase();

    const notices = await pool.query(
      `SELECT b.id, b.kind, b.title, b.message, b.audience_plan, b.priority, b.starts_at, b.ends_at, b.created_at
       FROM admin_broadcasts b
       WHERE b.status = 'active'
         AND (b.audience_plan = 'all' OR b.audience_plan = $1)
         AND (b.starts_at IS NULL OR b.starts_at <= NOW())
         AND (b.ends_at IS NULL OR b.ends_at >= NOW())
         AND (
           NOT EXISTS (
             SELECT 1
             FROM admin_broadcast_targets t0
             WHERE t0.broadcast_id = b.id
           )
           OR EXISTS (
             SELECT 1
             FROM admin_broadcast_targets t1
             WHERE t1.broadcast_id = b.id
               AND t1.user_id::text = $2::text
           )
         )
       ORDER BY b.created_at DESC
       LIMIT 30`,
      [userPlan, req.user.userId]
    );

    return res.json({ success: true, announcements: notices.rows });
  } catch (err) {
    console.error('[Ops] Error announcements:', err.message);
    return res.status(500).json({ error: 'Error obteniendo anuncios' });
  }
});

export default router;
