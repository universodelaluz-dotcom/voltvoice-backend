import { Router } from 'express';
import pool from '../db.js';
import { requireAdmin } from '../../middleware/auth.js';

const router = Router();

/**
 * GET /api/admin/stats - Dashboard principal
 */
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const [
      totalUsers,
      usersToday,
      onlineUsers,
      totalTokensUsed,
      tokensUsedToday,
      totalTransactions,
      planBreakdown,
      recentActivity,
      topUsers,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at >= CURRENT_DATE"),
      pool.query("SELECT COUNT(*) FROM users WHERE last_seen >= NOW() - INTERVAL '5 minutes'"),
      pool.query('SELECT COALESCE(SUM(tokens_used), 0) AS total FROM token_logs'),
      pool.query("SELECT COALESCE(SUM(tokens_used), 0) AS total FROM token_logs WHERE timestamp >= CURRENT_DATE"),
      pool.query("SELECT COUNT(*) FROM transactions WHERE status = 'completed'"),
      pool.query(`
        SELECT plan, COUNT(*) as count,
               SUM(CASE WHEN last_seen >= NOW() - INTERVAL '5 minutes' THEN 1 ELSE 0 END) AS online
        FROM users
        GROUP BY plan
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT tl.action, tl.tokens_used, tl.characters_count, tl.voice_name, tl.timestamp, u.email
        FROM token_logs tl
        JOIN users u ON tl.user_id = u.id
        ORDER BY tl.timestamp DESC LIMIT 20
      `),
      pool.query(`
        SELECT u.id, u.email, u.plan, u.tokens, u.created_at,
               COALESCE(SUM(tl.tokens_used), 0) AS total_used
        FROM users u
        LEFT JOIN token_logs tl ON tl.user_id = u.id
        GROUP BY u.id, u.email, u.plan, u.tokens, u.created_at
        ORDER BY total_used DESC LIMIT 10
      `),
    ]);

    return res.json({
      success: true,
      stats: {
        totalUsers: parseInt(totalUsers.rows[0].count),
        usersToday: parseInt(usersToday.rows[0].count),
        onlineUsers: parseInt(onlineUsers.rows[0].count),
        totalTokensUsed: parseInt(totalTokensUsed.rows[0].total),
        tokensUsedToday: parseInt(tokensUsedToday.rows[0].total),
        totalTransactions: parseInt(totalTransactions.rows[0].count),
        planBreakdown: planBreakdown.rows,
        recentActivity: recentActivity.rows,
        topUsers: topUsers.rows
      }
    });
  } catch (err) {
    console.error('[Admin] Error stats:', err.message);
    return res.status(500).json({ error: 'Error obteniendo stats' });
  }
});

/**
 * GET /api/admin/users - Lista de todos los usuarios
 */
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';
    const planFilter = req.query.plan || '';
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (search) {
      conditions.push(`u.email ILIKE $${paramIdx++}`);
      params.push(`%${search}%`);
    }
    if (planFilter && planFilter !== 'all') {
      conditions.push(`u.plan = $${paramIdx++}`);
      params.push(planFilter);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT u.id, u.email, u.plan, u.tokens, u.role, u.created_at, u.last_seen,
             COALESCE(SUM(tl.tokens_used), 0) AS total_tokens_used
      FROM users u
      LEFT JOIN token_logs tl ON tl.user_id = u.id
      ${whereClause}
      GROUP BY u.id, u.email, u.plan, u.tokens, u.role, u.created_at, u.last_seen
      ORDER BY u.created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    params.push(limit, offset);

    const countQuery = `SELECT COUNT(*) FROM users u ${whereClause}`;
    const countParams = conditions.length > 0 ? params.slice(0, conditions.length) : [];

    const [users, total] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, countParams)
    ]);

    return res.json({
      success: true,
      users: users.rows,
      total: parseInt(total.rows[0].count),
      page,
      pages: Math.ceil(parseInt(total.rows[0].count) / limit)
    });
  } catch (err) {
    console.error('[Admin] Error users:', err.message);
    return res.status(500).json({ error: 'Error obteniendo usuarios' });
  }
});

/**
 * PUT /api/admin/users/:id - Modificar un usuario (plan, tokens, role)
 */
router.put('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { plan, tokens, role } = req.body;

    const updates = [];
    const params = [];
    let paramIdx = 1;

    if (plan !== undefined) { updates.push(`plan = $${paramIdx++}`); params.push(plan); }
    if (tokens !== undefined) { updates.push(`tokens = $${paramIdx++}`); params.push(parseInt(tokens)); }
    if (role !== undefined) { updates.push(`role = $${paramIdx++}`); params.push(role); }

    if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(id);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING id, email, plan, tokens, role`,
      params
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    return res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('[Admin] Error updating user:', err.message);
    return res.status(500).json({ error: 'Error actualizando usuario' });
  }
});

/**
 * POST /api/admin/users/:id/add-tokens - Agregar tokens
 */
router.post('/users/:id/add-tokens', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;
    if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Cantidad inválida' });

    const result = await pool.query(
      'UPDATE users SET tokens = tokens + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, email, tokens',
      [parseInt(amount), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    return res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Error agregando tokens' });
  }
});

export default router;
