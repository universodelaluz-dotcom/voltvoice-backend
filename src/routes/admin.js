import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import pool from '../db.js';
import { requireAdmin } from '../../middleware/auth.js';

const router = Router();

const normalizePlan = (value = 'free') => String(value || 'free').trim().toLowerCase();
const ALLOWED_PLANS = new Set(['free', 'start', 'creator', 'pro', 'admin']);
const ALLOWED_BROADCAST_KIND = new Set(['global_message', 'in_app_notification', 'maintenance_alert']);
const ALLOWED_BROADCAST_STATUS = new Set(['draft', 'active', 'paused', 'archived']);

const parseLimit = (raw, fallback = 25, max = 200) => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const logAdminAction = async ({ actorId, targetUserId = null, action, details = {} }) => {
  try {
    await pool.query(
      `INSERT INTO admin_audit_logs (actor_user_id, target_user_id, action, details)
       VALUES ($1, $2, $3, $4)`,
      [actorId, targetUserId, action, JSON.stringify(details || {})]
    );
  } catch (err) {
    console.warn('[Admin] No se pudo registrar admin_audit_logs:', err.message);
  }
};

const buildUserWhere = (search, planFilter, includeSuspended = 'all') => {
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (search) {
    conditions.push(`u.email ILIKE $${paramIdx++}`);
    params.push(`%${search}%`);
  }

  if (planFilter && planFilter !== 'all') {
    conditions.push(`u.plan = $${paramIdx++}`);
    params.push(normalizePlan(planFilter));
  }

  if (includeSuspended === 'yes') conditions.push('u.is_suspended = TRUE');
  if (includeSuspended === 'no') conditions.push('(u.is_suspended = FALSE OR u.is_suspended IS NULL)');

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
};

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
      suspendedUsers,
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
      pool.query("SELECT COUNT(*) FROM users WHERE is_suspended = TRUE"),
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
        JOIN users u ON tl.user_id::text = u.id::text
        ORDER BY tl.timestamp DESC LIMIT 20
      `),
      pool.query(`
        SELECT u.id, u.email, u.plan, u.tokens, u.created_at,
               COALESCE(tl.total_used, 0) AS total_used
        FROM users u
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(tokens_used), 0) AS total_used
          FROM token_logs
          WHERE user_id::text = u.id::text
        ) tl ON true
        ORDER BY total_used DESC LIMIT 10
      `),
    ]);

    return res.json({
      success: true,
      stats: {
        totalUsers: parseInt(totalUsers.rows[0].count, 10),
        usersToday: parseInt(usersToday.rows[0].count, 10),
        onlineUsers: parseInt(onlineUsers.rows[0].count, 10),
        suspendedUsers: parseInt(suspendedUsers.rows[0].count, 10),
        totalTokensUsed: parseInt(totalTokensUsed.rows[0].total, 10),
        tokensUsedToday: parseInt(tokensUsedToday.rows[0].total, 10),
        totalTransactions: parseInt(totalTransactions.rows[0].count, 10),
        planBreakdown: planBreakdown.rows,
        recentActivity: recentActivity.rows,
        topUsers: topUsers.rows,
      }
    });
  } catch (err) {
    console.error('[Admin] Error stats:', {
      message: err.message,
      code: err.code,
      detail: err.detail,
      hint: err.hint,
      stack: err.stack
    });
    return res.status(500).json({ error: 'Error obteniendo stats' });
  }
});

/**
 * GET /api/admin/users - Lista de todos los usuarios
 */
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseLimit(req.query.limit, 50, 100);
    const search = (req.query.search || '').trim();
    const planFilter = req.query.plan || '';
    const includeSuspended = String(req.query.includeSuspended || 'all');
    const offset = (page - 1) * limit;

    const { whereClause, params } = buildUserWhere(search, planFilter, includeSuspended);
    let paramIdx = params.length + 1;

    const query = `
      SELECT u.id, u.email, u.plan, u.tokens, u.role, u.created_at, u.last_seen,
             u.is_suspended, u.suspension_reason, u.suspended_until,
             COALESCE(tl.total_tokens_used, 0) AS total_tokens_used,
             COALESCE(tx.total_tokens_purchased, 0) AS total_tokens_purchased
      FROM users u
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(tokens_used), 0) AS total_tokens_used
        FROM token_logs
        WHERE user_id::text = u.id::text
      ) tl ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(tokens_purchased), 0) AS total_tokens_purchased
        FROM transactions
        WHERE user_id::text = u.id::text AND status = 'completed'
      ) tx ON true
      ${whereClause}
      ORDER BY u.created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;

    const countQuery = `SELECT COUNT(*) FROM users u ${whereClause}`;
    const queryParams = [...params, limit, offset];

    const [users, total] = await Promise.all([
      pool.query(query, queryParams),
      pool.query(countQuery, params)
    ]);

    return res.json({
      success: true,
      users: users.rows,
      total: parseInt(total.rows[0].count, 10),
      page,
      pages: Math.ceil(parseInt(total.rows[0].count, 10) / limit)
    });
  } catch (err) {
    console.error('[Admin] Error users:', {
      message: err.message,
      code: err.code,
      detail: err.detail,
      hint: err.hint,
      stack: err.stack
    });
    return res.status(500).json({ error: 'Error obteniendo usuarios' });
  }
});

/**
 * POST /api/admin/users - Crear usuario por admin
 */
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const plan = normalizePlan(req.body.plan || 'free');
    const role = String(req.body.role || 'user').toLowerCase() === 'admin' ? 'admin' : 'user';
    const tokens = Number.isFinite(Number(req.body.tokens)) ? Math.max(0, parseInt(req.body.tokens, 10)) : 100;

    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalido' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password minimo 8 caracteres' });
    if (!ALLOWED_PLANS.has(plan)) return res.status(400).json({ error: 'Plan invalido' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Email ya registrado' });

    const hash = await bcrypt.hash(password, 12);
    const created = await pool.query(
      `INSERT INTO users (email, password_hash, plan, tokens, email_verified, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id, email, plan, tokens, role, created_at`,
      [email, hash, plan, tokens, role]
    );

    await logAdminAction({
      actorId: req.user.userId,
      targetUserId: created.rows[0].id,
      action: 'create_user',
      details: { email, plan, role, tokens }
    });

    return res.status(201).json({ success: true, user: created.rows[0] });
  } catch (err) {
    console.error('[Admin] Error create user:', err.message);
    return res.status(500).json({ error: 'Error creando usuario' });
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

    if (plan !== undefined) {
      const safePlan = normalizePlan(plan);
      if (!ALLOWED_PLANS.has(safePlan)) return res.status(400).json({ error: 'Plan invalido' });
      updates.push(`plan = $${paramIdx++}`);
      params.push(safePlan);
    }
    if (tokens !== undefined) {
      updates.push(`tokens = $${paramIdx++}`);
      params.push(Math.max(0, parseInt(tokens, 10) || 0));
    }
    if (role !== undefined) {
      const safeRole = String(role).toLowerCase() === 'admin' ? 'admin' : 'user';
      updates.push(`role = $${paramIdx++}`);
      params.push(safeRole);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const result = await pool.query(
      `UPDATE users
       SET ${updates.join(', ')}
       WHERE id::text = $${paramIdx}::text
       RETURNING id, email, plan, tokens, role, is_suspended, suspension_reason, suspended_until`,
      params
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    await logAdminAction({
      actorId: req.user.userId,
      targetUserId: id,
      action: 'update_user',
      details: { plan, tokens, role }
    });

    return res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('[Admin] Error updating user:', err.message);
    return res.status(500).json({ error: 'Error actualizando usuario' });
  }
});

/**
 * DELETE /api/admin/users/:id - Eliminar usuario
 */
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (String(req.user.userId) === String(id)) {
      return res.status(400).json({ error: 'No puedes eliminar tu propio usuario admin' });
    }

    const deleted = await pool.query(
      'DELETE FROM users WHERE id::text = $1::text RETURNING id, email',
      [id]
    );

    if (deleted.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    await logAdminAction({
      actorId: req.user.userId,
      targetUserId: id,
      action: 'delete_user',
      details: { email: deleted.rows[0].email }
    });

    return res.json({ success: true, deleted: deleted.rows[0] });
  } catch (err) {
    console.error('[Admin] Error deleting user:', err.message);
    return res.status(500).json({ error: 'Error eliminando usuario' });
  }
});

/**
 * POST /api/admin/users/:id/add-tokens - Agregar tokens
 */
router.post('/users/:id/add-tokens', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Cantidad invalida' });

    const result = await pool.query(
      `UPDATE users
       SET tokens = GREATEST(0, tokens + $1), updated_at = CURRENT_TIMESTAMP
       WHERE id::text = $2::text
       RETURNING id, email, tokens`,
      [amount, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    await logAdminAction({
      actorId: req.user.userId,
      targetUserId: id,
      action: 'add_tokens',
      details: { amount, resultingTokens: result.rows[0].tokens }
    });

    return res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('[Admin] Error add tokens:', err.message);
    return res.status(500).json({ error: 'Error agregando tokens' });
  }
});

/**
 * POST /api/admin/users/:id/suspend - Suspender usuario
 */
router.post('/users/:id/suspend', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const reason = String(req.body.reason || 'Suspension administrativa').slice(0, 300);
    const minutes = Number.parseInt(req.body.minutes, 10);

    const suspendedUntilExpr = Number.isFinite(minutes) && minutes > 0
      ? `NOW() + ($1::int || ' minutes')::interval`
      : 'NULL';

    const params = Number.isFinite(minutes) && minutes > 0 ? [minutes, reason, id] : [reason, id];
    const idParamPos = Number.isFinite(minutes) && minutes > 0 ? 3 : 2;

    const query = `
      UPDATE users
      SET is_suspended = TRUE,
          suspension_reason = $${Number.isFinite(minutes) && minutes > 0 ? 2 : 1},
          suspended_at = CURRENT_TIMESTAMP,
          suspended_until = ${suspendedUntilExpr},
          updated_at = CURRENT_TIMESTAMP
      WHERE id::text = $${idParamPos}::text
      RETURNING id, email, is_suspended, suspension_reason, suspended_until
    `;

    const updated = await pool.query(query, params);
    if (updated.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    await logAdminAction({
      actorId: req.user.userId,
      targetUserId: id,
      action: 'suspend_user',
      details: { reason, minutes: Number.isFinite(minutes) ? minutes : null }
    });

    return res.json({ success: true, user: updated.rows[0] });
  } catch (err) {
    console.error('[Admin] Error suspend user:', err.message);
    return res.status(500).json({ error: 'Error suspendiendo usuario' });
  }
});

/**
 * POST /api/admin/users/:id/unsuspend - Reactivar usuario
 */
router.post('/users/:id/unsuspend', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await pool.query(
      `UPDATE users
       SET is_suspended = FALSE,
           suspension_reason = NULL,
           suspended_at = NULL,
           suspended_until = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id::text = $1::text
       RETURNING id, email, is_suspended`,
      [id]
    );

    if (updated.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    await logAdminAction({
      actorId: req.user.userId,
      targetUserId: id,
      action: 'unsuspend_user',
      details: {}
    });

    return res.json({ success: true, user: updated.rows[0] });
  } catch (err) {
    console.error('[Admin] Error unsuspend user:', err.message);
    return res.status(500).json({ error: 'Error reactivando usuario' });
  }
});

/**
 * POST /api/admin/users/:id/reset-password - Reset password
 */
router.post('/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const provided = String(req.body.newPassword || '').trim();
    const generatedPassword = provided || crypto.randomBytes(8).toString('base64url');

    if (generatedPassword.length < 8) {
      return res.status(400).json({ error: 'Password minimo 8 caracteres' });
    }

    const hash = await bcrypt.hash(generatedPassword, 12);
    const updated = await pool.query(
      `UPDATE users
       SET password_hash = $1,
           last_password_reset_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id::text = $2::text
       RETURNING id, email`,
      [hash, id]
    );

    if (updated.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    await logAdminAction({
      actorId: req.user.userId,
      targetUserId: id,
      action: 'reset_password',
      details: { manual: Boolean(provided) }
    });

    return res.json({
      success: true,
      user: updated.rows[0],
      temporaryPassword: provided ? null : generatedPassword
    });
  } catch (err) {
    console.error('[Admin] Error reset password:', err.message);
    return res.status(500).json({ error: 'Error restableciendo password' });
  }
});

/**
 * GET /api/admin/users/:id/activity - Historial de actividad del usuario
 */
router.get('/users/:id/activity', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const limit = parseLimit(req.query.limit, 100, 500);

    const [userQ, tokenLogsQ, transactionsQ, adminActionsQ] = await Promise.all([
      pool.query(
        `SELECT id, email, plan, tokens, role, created_at, last_seen, is_suspended, suspended_until, suspension_reason
         FROM users WHERE id::text = $1::text`,
        [id]
      ),
      pool.query(
        `SELECT action, tokens_used, characters_count, voice_name, timestamp
         FROM token_logs
         WHERE user_id::text = $1::text
         ORDER BY timestamp DESC
         LIMIT $2`,
        [id, limit]
      ),
      pool.query(
        `SELECT id, tokens_purchased, amount_usd, status, created_at, stripe_payment_id
         FROM transactions
         WHERE user_id::text = $1::text
         ORDER BY created_at DESC
         LIMIT $2`,
        [id, limit]
      ),
      pool.query(
        `SELECT aal.action, aal.details, aal.created_at,
                actor.email AS admin_email
         FROM admin_audit_logs aal
         LEFT JOIN users actor ON aal.actor_user_id::text = actor.id::text
         WHERE aal.target_user_id::text = $1::text
         ORDER BY aal.created_at DESC
         LIMIT $2`,
        [id, limit]
      )
    ]);

    if (userQ.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    return res.json({
      success: true,
      user: userQ.rows[0],
      activity: {
        tokenLogs: tokenLogsQ.rows,
        transactions: transactionsQ.rows,
        adminActions: adminActionsQ.rows,
      }
    });
  } catch (err) {
    console.error('[Admin] Error user activity:', err.message);
    return res.status(500).json({ error: 'Error obteniendo actividad del usuario' });
  }
});

/**
 * GET /api/admin/users/:id/technical-logs - Logs tecnicos (token_logs)
 */
router.get('/users/:id/technical-logs', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const limit = parseLimit(req.query.limit, 200, 1000);

    const logs = await pool.query(
      `SELECT id, action, tokens_used, characters_count, voice_name, timestamp
       FROM token_logs
       WHERE user_id::text = $1::text
       ORDER BY timestamp DESC
       LIMIT $2`,
      [id, limit]
    );

    return res.json({ success: true, logs: logs.rows });
  } catch (err) {
    console.error('[Admin] Error technical logs:', err.message);
    return res.status(500).json({ error: 'Error obteniendo logs tecnicos' });
  }
});

/**
 * GET /api/admin/anomalies - Detectar uso anormal
 */
router.get('/anomalies', requireAdmin, async (req, res) => {
  try {
    const dailyThreshold = parseInt(req.query.dailyThreshold || '250000', 10);
    const burstThreshold = parseInt(req.query.burstThreshold || '80', 10);

    const [heavyDaily, burstUsage] = await Promise.all([
      pool.query(
        `SELECT u.id, u.email, COALESCE(SUM(tl.tokens_used), 0) AS tokens_day
         FROM users u
         LEFT JOIN token_logs tl ON tl.user_id::text = u.id::text
           AND tl.timestamp >= NOW() - INTERVAL '24 hours'
         GROUP BY u.id, u.email
         HAVING COALESCE(SUM(tl.tokens_used), 0) >= $1
         ORDER BY tokens_day DESC
         LIMIT 50`,
        [dailyThreshold]
      ),
      pool.query(
        `SELECT u.id, u.email, COUNT(*) AS events_10m, COALESCE(SUM(tl.tokens_used),0) AS tokens_10m
         FROM users u
         JOIN token_logs tl ON tl.user_id::text = u.id::text
         WHERE tl.timestamp >= NOW() - INTERVAL '10 minutes'
         GROUP BY u.id, u.email
         HAVING COUNT(*) >= $1
         ORDER BY events_10m DESC
         LIMIT 50`,
        [burstThreshold]
      )
    ]);

    const anomalies = [];
    for (const row of heavyDaily.rows) {
      anomalies.push({
        userId: row.id,
        email: row.email,
        type: 'high_daily_consumption',
        severity: Number(row.tokens_day) > dailyThreshold * 2 ? 'high' : 'medium',
        value: Number(row.tokens_day),
        details: `Consumo 24h: ${Number(row.tokens_day).toLocaleString()} tokens`
      });
    }
    for (const row of burstUsage.rows) {
      anomalies.push({
        userId: row.id,
        email: row.email,
        type: 'burst_activity',
        severity: Number(row.events_10m) > burstThreshold * 2 ? 'high' : 'medium',
        value: Number(row.events_10m),
        details: `Eventos 10m: ${row.events_10m}, tokens 10m: ${Number(row.tokens_10m).toLocaleString()}`
      });
    }

    return res.json({ success: true, anomalies });
  } catch (err) {
    console.error('[Admin] Error anomalies:', err.message);
    return res.status(500).json({ error: 'Error detectando uso anormal' });
  }
});

/**
 * GET /api/admin/broadcasts - Listar comunicados globales
 */
router.get('/broadcasts', requireAdmin, async (req, res) => {
  try {
    const status = String(req.query.status || 'all').toLowerCase();
    const limit = parseLimit(req.query.limit, 50, 200);

    const whereStatus = status !== 'all' ? 'WHERE b.status = $1' : '';
    const params = status !== 'all' ? [status, limit] : [limit];
    const limitPos = status !== 'all' ? 2 : 1;

    const rows = await pool.query(
      `SELECT b.*, u.email AS created_by_email
       FROM admin_broadcasts b
       LEFT JOIN users u ON b.created_by::text = u.id::text
       ${whereStatus}
       ORDER BY b.created_at DESC
       LIMIT $${limitPos}`,
      params
    );

    return res.json({ success: true, broadcasts: rows.rows });
  } catch (err) {
    console.error('[Admin] Error broadcasts list:', err.message);
    return res.status(500).json({ error: 'Error obteniendo comunicados' });
  }
});

/**
 * POST /api/admin/broadcasts - Crear comunicado global
 */
router.post('/broadcasts', requireAdmin, async (req, res) => {
  try {
    const kind = String(req.body.kind || '').trim();
    const title = String(req.body.title || '').trim().slice(0, 140);
    const message = String(req.body.message || '').trim().slice(0, 2000);
    const audiencePlan = normalizePlan(req.body.audiencePlan || 'all');
    const priority = String(req.body.priority || 'normal').toLowerCase().slice(0, 20);
    const status = String(req.body.status || 'active').toLowerCase();
    const startsAt = req.body.startsAt || null;
    const endsAt = req.body.endsAt || null;

    if (!ALLOWED_BROADCAST_KIND.has(kind)) return res.status(400).json({ error: 'Tipo de comunicado invalido' });
    if (!title || !message) return res.status(400).json({ error: 'Titulo y mensaje son requeridos' });
    if (!ALLOWED_BROADCAST_STATUS.has(status)) return res.status(400).json({ error: 'Status invalido' });

    const created = await pool.query(
      `INSERT INTO admin_broadcasts
       (kind, title, message, audience_plan, priority, status, starts_at, ends_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [kind, title, message, audiencePlan, priority, status, startsAt, endsAt, req.user.userId]
    );

    await logAdminAction({
      actorId: req.user.userId,
      action: 'create_broadcast',
      details: { kind, title, audiencePlan, priority, status }
    });

    return res.status(201).json({ success: true, broadcast: created.rows[0] });
  } catch (err) {
    console.error('[Admin] Error create broadcast:', err.message);
    return res.status(500).json({ error: 'Error creando comunicado' });
  }
});

/**
 * PUT /api/admin/broadcasts/:id/status - Cambiar estado comunicado
 */
router.put('/broadcasts/:id/status', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const status = String(req.body.status || '').toLowerCase();
    if (!ALLOWED_BROADCAST_STATUS.has(status)) return res.status(400).json({ error: 'Status invalido' });

    const updated = await pool.query(
      `UPDATE admin_broadcasts
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );

    if (updated.rows.length === 0) return res.status(404).json({ error: 'Comunicado no encontrado' });

    await logAdminAction({
      actorId: req.user.userId,
      action: 'update_broadcast_status',
      details: { broadcastId: id, status }
    });

    return res.json({ success: true, broadcast: updated.rows[0] });
  } catch (err) {
    console.error('[Admin] Error update broadcast:', err.message);
    return res.status(500).json({ error: 'Error actualizando comunicado' });
  }
});

export default router;
