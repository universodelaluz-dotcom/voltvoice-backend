import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import pool from '../db.js';
import { requireAdmin } from '../../middleware/auth.js';
import audioCacheService from '../services/audioCacheService.js';

const router = Router();

const normalizePlan = (value = 'free') => String(value || 'free').trim().toLowerCase();
const PLAN_KEY_TO_BACKEND_PLAN = {
  free: 'free',
  start: 'pro',
  creator: 'premium',
  pro: 'elite',
  admin: 'admin',
};
const BACKEND_PLAN_TO_PLAN_KEY = {
  free: 'free',
  pro: 'start',
  premium: 'creator',
  elite: 'pro',
  on_demand: 'pro',
  admin: 'admin',
};
const toBackendPlan = (value = 'free') => {
  const key = normalizePlan(value);
  return PLAN_KEY_TO_BACKEND_PLAN[key] || key;
};
const toDisplayPlan = (value = 'free') => {
  const plan = normalizePlan(value);
  return BACKEND_PLAN_TO_PLAN_KEY[plan] || plan;
};
const ALLOWED_PLANS = new Set(['free', 'start', 'creator', 'pro', 'admin']);
const ALLOWED_BROADCAST_KIND = new Set(['global_message', 'in_app_notification', 'maintenance_alert']);
const ALLOWED_BROADCAST_STATUS = new Set(['draft', 'active', 'paused', 'archived']);
const ESTIMATED_COST_PER_1K_TOKENS_USD = Number(process.env.ADMIN_ESTIMATED_COST_PER_1K_TOKENS_USD || 0.004);
const ESTIMATED_FIXED_MONTHLY_COST_USD = Number(process.env.ADMIN_ESTIMATED_FIXED_MONTHLY_COST_USD || 0);

const parseLimit = (raw, fallback = 25, max = 200) => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const parseIntRange = (raw, fallback, min, max) => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};
const parseHours = (raw, fallback = 48, max = 24 * 14) => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};
const csvEscape = (value = '') => `"${String(value ?? '').replace(/"/g, '""')}"`;

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
    const normalized = normalizePlan(planFilter);
    const backendPlan = toBackendPlan(normalized);
    if (backendPlan === normalized) {
      conditions.push(`u.plan = $${paramIdx++}`);
      params.push(backendPlan);
    } else {
      conditions.push(`(u.plan = $${paramIdx++} OR u.plan = $${paramIdx++})`);
      params.push(backendPlan, normalized);
    }
  }

  if (includeSuspended === 'yes') conditions.push('u.is_suspended = TRUE');
  if (includeSuspended === 'no') conditions.push('(u.is_suspended = FALSE OR u.is_suspended IS NULL)');

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
};

/**
 * GET /api/admin/stats - Dashboard principal
 * Query params: year (optional, defaults to current year)
 */
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();
    const selectedYear = parseInt(req.query.year, 10) || currentYear;
    const isCurrentYear = selectedYear === currentYear;

    // Date range for the selected year
    const yearStart = `${selectedYear}-01-01`;
    const yearEnd   = `${selectedYear + 1}-01-01`;

    const [
      totalUsers,
      usersToday,
      usersThisMonth,
      usersThisYear,
      onlineUsers,
      totalTokensUsed,
      tokensUsedToday,
      tokensUsedMonth,
      tokensUsedYear,
      totalTransactions,
      transactionsMonth,
      transactionsYear,
      revenueTotal,
      revenueMonth,
      revenueYear,
      suspendedUsers,
      planBreakdown,
      usersMonthly,
      tokensMonthly,
      revenueMonthly,
      recentActivity,
      topUsers,
      hourlyStats,
      weekdayStats,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at >= CURRENT_DATE"),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at >= date_trunc('month', NOW())"),
      // Year-specific user count
      pool.query('SELECT COUNT(*) FROM users WHERE created_at >= $1 AND created_at < $2', [yearStart, yearEnd]),
      pool.query("SELECT COUNT(*) FROM users WHERE last_seen >= NOW() - INTERVAL '5 minutes'"),
      pool.query('SELECT COALESCE(SUM(tokens_used), 0) AS total FROM token_logs'),
      pool.query("SELECT COALESCE(SUM(tokens_used), 0) AS total FROM token_logs WHERE timestamp >= CURRENT_DATE"),
      pool.query("SELECT COALESCE(SUM(tokens_used), 0) AS total FROM token_logs WHERE timestamp >= date_trunc('month', NOW())"),
      // Year-specific token usage
      pool.query('SELECT COALESCE(SUM(tokens_used), 0) AS total FROM token_logs WHERE timestamp >= $1 AND timestamp < $2', [yearStart, yearEnd]),
      pool.query("SELECT COUNT(*) FROM transactions WHERE status = 'completed'"),
      pool.query("SELECT COUNT(*) FROM transactions WHERE status = 'completed' AND created_at >= date_trunc('month', NOW())"),
      // Year-specific transactions
      pool.query("SELECT COUNT(*) FROM transactions WHERE status = 'completed' AND created_at >= $1 AND created_at < $2", [yearStart, yearEnd]),
      pool.query("SELECT COALESCE(SUM(amount_usd), 0) AS total FROM transactions WHERE status = 'completed'"),
      pool.query("SELECT COALESCE(SUM(amount_usd), 0) AS total FROM transactions WHERE status = 'completed' AND created_at >= date_trunc('month', NOW())"),
      // Year-specific revenue
      pool.query("SELECT COALESCE(SUM(amount_usd), 0) AS total FROM transactions WHERE status = 'completed' AND created_at >= $1 AND created_at < $2", [yearStart, yearEnd]),
      pool.query("SELECT COUNT(*) FROM users WHERE is_suspended = TRUE"),
      pool.query(`
        SELECT plan, COUNT(*) as count,
               SUM(CASE WHEN last_seen >= NOW() - INTERVAL '5 minutes' THEN 1 ELSE 0 END) AS online
        FROM users
        GROUP BY plan
        ORDER BY count DESC
      `),
      // Monthly overview for selected year (all 12 months)
      pool.query(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month_key,
                COUNT(*)::int AS users
         FROM users
         WHERE created_at >= $1 AND created_at < $2
         GROUP BY 1 ORDER BY 1 ASC`,
        [yearStart, yearEnd]
      ),
      pool.query(
        `SELECT to_char(date_trunc('month', timestamp), 'YYYY-MM') AS month_key,
                COALESCE(SUM(tokens_used), 0)::bigint AS tokens
         FROM token_logs
         WHERE timestamp >= $1 AND timestamp < $2
         GROUP BY 1 ORDER BY 1 ASC`,
        [yearStart, yearEnd]
      ),
      pool.query(
        `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month_key,
                COALESCE(SUM(amount_usd), 0)::numeric(14,2) AS revenue
         FROM transactions
         WHERE status = 'completed' AND created_at >= $1 AND created_at < $2
         GROUP BY 1 ORDER BY 1 ASC`,
        [yearStart, yearEnd]
      ),
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
      // Uso por hora del día (zona horaria Mexico)
      pool.query(
        `SELECT EXTRACT(HOUR FROM timestamp AT TIME ZONE 'America/Mexico_City')::int AS hour,
                COALESCE(SUM(tokens_used), 0)::bigint AS tokens,
                COUNT(*)::int AS messages
         FROM token_logs
         WHERE timestamp >= $1 AND timestamp < $2
         GROUP BY 1 ORDER BY 1`,
        [yearStart, yearEnd]
      ),
      // Uso por día de la semana (0=Dom, 1=Lun, ..., 6=Sáb)
      pool.query(
        `SELECT EXTRACT(DOW FROM timestamp AT TIME ZONE 'America/Mexico_City')::int AS dow,
                COALESCE(SUM(tokens_used), 0)::bigint AS tokens,
                COUNT(*)::int AS messages
         FROM token_logs
         WHERE timestamp >= $1 AND timestamp < $2
         GROUP BY 1 ORDER BY 1`,
        [yearStart, yearEnd]
      ),
    ]);

    // Build all 12 months of the selected year
    const monthMap = new Map();
    const ensureMonth = (monthKey) => {
      if (!monthMap.has(monthKey)) {
        monthMap.set(monthKey, { monthKey, users: 0, tokens: 0, revenueUsd: 0 });
      }
      return monthMap.get(monthKey);
    };
    for (let m = 1; m <= 12; m++) {
      const monthKey = `${selectedYear}-${String(m).padStart(2, '0')}`;
      ensureMonth(monthKey);
    }
    for (const row of usersMonthly.rows) {
      ensureMonth(String(row.month_key)).users = Number(row.users || 0);
    }
    for (const row of tokensMonthly.rows) {
      ensureMonth(String(row.month_key)).tokens = Number(row.tokens || 0);
    }
    for (const row of revenueMonthly.rows) {
      ensureMonth(String(row.month_key)).revenueUsd = Number(row.revenue || 0);
    }
    const monthlyOverview = Array.from(monthMap.values());

    // Build full 24-hour and 7-day arrays
    const hourlyUsage = Array.from({ length: 24 }, (_, h) => {
      const row = hourlyStats.rows.find(r => Number(r.hour) === h);
      return { hour: h, tokens: Number(row?.tokens || 0), messages: Number(row?.messages || 0) };
    });
    const weekdayUsage = Array.from({ length: 7 }, (_, d) => {
      const row = weekdayStats.rows.find(r => Number(r.dow) === d);
      return { dow: d, tokens: Number(row?.tokens || 0), messages: Number(row?.messages || 0) };
    });

    const normalizedPlanBreakdownMap = new Map();
    for (const row of planBreakdown.rows) {
      const displayPlan = toDisplayPlan(row.plan);
      const prev = normalizedPlanBreakdownMap.get(displayPlan) || { plan: displayPlan, count: 0, online: 0 };
      prev.count += Number(row.count || 0);
      prev.online += Number(row.online || 0);
      normalizedPlanBreakdownMap.set(displayPlan, prev);
    }
    const normalizedPlanBreakdown = Array.from(normalizedPlanBreakdownMap.values())
      .sort((a, b) => b.count - a.count);

    const totalRevenueUsd = Number(revenueTotal.rows[0].total || 0);
    const revenueMonthUsd = Number(revenueMonth.rows[0].total || 0);
    const revenueYearUsd  = Number(revenueYear.rows[0].total || 0);
    const totalTokens  = parseInt(totalTokensUsed.rows[0].total, 10) || 0;
    const monthTokens  = parseInt(tokensUsedMonth.rows[0].total, 10) || 0;
    const yearTokens   = parseInt(tokensUsedYear.rows[0].total, 10) || 0;
    const estCostTotalUsd = Number(((totalTokens / 1000) * ESTIMATED_COST_PER_1K_TOKENS_USD).toFixed(2));
    const estCostMonthUsd = Number(((monthTokens / 1000) * ESTIMATED_COST_PER_1K_TOKENS_USD + ESTIMATED_FIXED_MONTHLY_COST_USD).toFixed(2));
    const estCostYearUsd  = Number(((yearTokens / 1000) * ESTIMATED_COST_PER_1K_TOKENS_USD + (ESTIMATED_FIXED_MONTHLY_COST_USD * 12)).toFixed(2));
    const marginMonthUsd  = Number((revenueMonthUsd - estCostMonthUsd).toFixed(2));
    const marginYearUsd   = Number((revenueYearUsd - estCostYearUsd).toFixed(2));

    return res.json({
      success: true,
      selectedYear,
      stats: {
        totalUsers: parseInt(totalUsers.rows[0].count, 10),
        usersToday: parseInt(usersToday.rows[0].count, 10),
        usersThisMonth: parseInt(usersThisMonth.rows[0].count, 10),
        usersThisYear: parseInt(usersThisYear.rows[0].count, 10),
        onlineUsers: parseInt(onlineUsers.rows[0].count, 10),
        suspendedUsers: parseInt(suspendedUsers.rows[0].count, 10),
        totalTokensUsed: totalTokens,
        tokensUsedToday: parseInt(tokensUsedToday.rows[0].total, 10),
        tokensUsedMonth: monthTokens,
        tokensUsedYear: yearTokens,
        totalTransactions: parseInt(totalTransactions.rows[0].count, 10),
        transactionsMonth: parseInt(transactionsMonth.rows[0].count, 10),
        transactionsYear: parseInt(transactionsYear.rows[0].count, 10),
        revenueTotalUsd: totalRevenueUsd,
        revenueMonthUsd,
        revenueYearUsd,
        estimatedCostTotalUsd: estCostTotalUsd,
        estimatedCostMonthUsd: estCostMonthUsd,
        estimatedCostYearUsd: estCostYearUsd,
        estimatedMarginMonthUsd: marginMonthUsd,
        estimatedMarginYearUsd: marginYearUsd,
        estimatedCostPer1kTokensUsd: ESTIMATED_COST_PER_1K_TOKENS_USD,
        estimatedFixedMonthlyCostUsd: ESTIMATED_FIXED_MONTHLY_COST_USD,
        planBreakdown: normalizedPlanBreakdown,
        monthlyOverview,
        hourlyUsage,
        weekdayUsage,
        recentActivity: recentActivity.rows,
        topUsers: topUsers.rows.map((row) => ({
          ...row,
          normalized_plan: toDisplayPlan(row.plan),
        })),
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
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_billing_cycle VARCHAR(20) DEFAULT 'monthly';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_current_period_start TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_cancel_at_period_end BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_pending_plan_key VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_pending_billing_cycle VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_pending_effective_at TIMESTAMP;
    `);

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
             u.subscription_billing_cycle, u.subscription_current_period_start, u.subscription_current_period_end,
             u.subscription_cancel_at_period_end, u.subscription_pending_plan_key,
             u.subscription_pending_billing_cycle, u.subscription_pending_effective_at,
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

    const normalizedUsers = users.rows.map((row) => ({
      ...row,
      normalized_plan: toDisplayPlan(row.plan),
      subscription_billing_cycle: String(row.subscription_billing_cycle || 'monthly').toLowerCase() === 'annual' ? 'annual' : 'monthly',
      subscription_pending_plan_display: row.subscription_pending_plan_key ? toDisplayPlan(row.subscription_pending_plan_key) : null,
      subscription_pending_billing_cycle: row.subscription_pending_billing_cycle
        ? (String(row.subscription_pending_billing_cycle).toLowerCase() === 'annual' ? 'annual' : 'monthly')
        : null,
    }));

    return res.json({
      success: true,
      users: normalizedUsers,
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
 * GET /api/admin/users/export-emails - Exportar correos en CSV
 */
router.get('/users/export-emails', requireAdmin, async (req, res) => {
  try {
    const plan = String(req.query.plan || 'all').toLowerCase();
    const normalizedPlan = normalizePlan(plan);
    let where = '';
    let params = [];
    if (normalizedPlan !== 'all') {
      const backendPlan = toBackendPlan(normalizedPlan);
      if (backendPlan === normalizedPlan) {
        where = 'WHERE plan = $1';
        params = [backendPlan];
      } else {
        where = 'WHERE (plan = $1 OR plan = $2)';
        params = [backendPlan, normalizedPlan];
      }
    }

    const rows = await pool.query(
      `SELECT id, email, plan, role, created_at
       FROM users
       ${where}
       ORDER BY created_at DESC`,
      params
    );

    const lines = ['id,email,plan,role,created_at'];
    for (const row of rows.rows) {
      lines.push([
        row.id,
        csvEscape(row.email),
        csvEscape(toDisplayPlan(row.plan)),
        csvEscape(row.role),
        csvEscape(row.created_at ? new Date(row.created_at).toISOString() : '')
      ].join(','));
    }
    const csv = `${lines.join('\n')}\n`;
    const filename = `voltvoice-users-${plan}-${new Date().toISOString().slice(0, 10)}.csv`;

    await logAdminAction({
      actorId: req.user.userId,
      action: 'export_user_emails_csv',
      details: { plan, exported: rows.rowCount }
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error('[Admin] Error export emails:', err.message);
    return res.status(500).json({ error: 'Error exportando correos' });
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
    const backendPlan = toBackendPlan(plan);
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
      [email, hash, backendPlan, tokens, role]
    );

    await logAdminAction({
      actorId: req.user.userId,
      targetUserId: created.rows[0].id,
      action: 'create_user',
      details: { email, plan, backendPlan, role, tokens }
    });
    return res.status(201).json({
      success: true,
      user: {
        ...created.rows[0],
        normalized_plan: toDisplayPlan(created.rows[0].plan),
      }
    });
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
      const backendPlan = toBackendPlan(safePlan);
      updates.push(`plan = $${paramIdx++}`);
      params.push(backendPlan);
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

    return res.json({
      success: true,
      user: {
        ...result.rows[0],
        normalized_plan: toDisplayPlan(result.rows[0].plan),
      }
    });
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
 * GET /api/admin/users/:id/voices - Listar voces clonadas/personalizadas del usuario
 */
router.get('/users/:id/voices', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT id, user_id, voice_name, voice_id, provider, created_at
       FROM user_voices
       WHERE user_id::text = $1::text
       ORDER BY created_at DESC`,
      [id]
    );

    return res.json({ success: true, voices: result.rows });
  } catch (err) {
    console.error('[Admin] Error loading user voices:', err.message);
    return res.status(500).json({ error: 'Error obteniendo voces del usuario' });
  }
});

/**
 * DELETE /api/admin/users/:id/voices/:voiceRecordId - Eliminar voz de usuario
 */
router.delete('/users/:id/voices/:voiceRecordId', requireAdmin, async (req, res) => {
  try {
    const { id, voiceRecordId } = req.params;

    const deleted = await pool.query(
      `DELETE FROM user_voices
       WHERE user_id::text = $1::text
         AND id::text = $2::text
       RETURNING id, user_id, voice_name, voice_id, provider`,
      [id, voiceRecordId]
    );

    if (deleted.rows.length === 0) {
      return res.status(404).json({ error: 'Voz no encontrada' });
    }

    await logAdminAction({
      actorId: req.user.userId,
      targetUserId: id,
      action: 'delete_user_voice',
      details: deleted.rows[0]
    });

    return res.json({ success: true, deleted: deleted.rows[0] });
  } catch (err) {
    console.error('[Admin] Error deleting user voice:', err.message);
    return res.status(500).json({ error: 'Error eliminando voz del usuario' });
  }
});

/**
 * GET /api/admin/logs/requests - Buscar logs reales de API (soporte)
 */
router.get('/logs/requests', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    const email = String(req.query.email || '').trim();
    const pathLike = String(req.query.path || '').trim();
    const statusMin = Number.parseInt(req.query.statusMin, 10);
    const statusMax = Number.parseInt(req.query.statusMax, 10);
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    const limit = parseLimit(req.query.limit, 200, 1000);

    const where = [];
    const params = [];
    let idx = 1;

    if (userId) {
      where.push(`l.user_id::text = $${idx++}::text`);
      params.push(userId);
    }
    if (email) {
      where.push(`u.email ILIKE $${idx++}`);
      params.push(`%${email}%`);
    }
    if (pathLike) {
      where.push(`l.path ILIKE $${idx++}`);
      params.push(`%${pathLike}%`);
    }
    if (Number.isFinite(statusMin)) {
      where.push(`l.status_code >= $${idx++}`);
      params.push(statusMin);
    }
    if (Number.isFinite(statusMax)) {
      where.push(`l.status_code <= $${idx++}`);
      params.push(statusMax);
    }
    if (from && !Number.isNaN(from.getTime())) {
      where.push(`l.created_at >= $${idx++}`);
      params.push(from.toISOString());
    }
    if (to && !Number.isNaN(to.getTime())) {
      where.push(`l.created_at <= $${idx++}`);
      params.push(to.toISOString());
    }

    params.push(limit);
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT l.id, l.user_id, u.email AS user_email, l.method, l.path, l.status_code, l.duration_ms, l.ip_address, l.error_message, l.created_at
       FROM api_request_logs l
       LEFT JOIN users u ON l.user_id = u.id
       ${whereClause}
       ORDER BY l.created_at DESC
       LIMIT $${idx}`,
      params
    );

    return res.json({ success: true, logs: result.rows });
  } catch (err) {
    console.error('[Admin] Error request logs:', err.message);
    return res.status(500).json({ error: 'Error obteniendo logs de API' });
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
    const limit = parseLimit(req.query.limit, 2000, 20000);
    const hours = parseHours(req.query.hours, 48);

    const [userQ, tokenLogsQ, transactionsQ, adminActionsQ, requestLogsQ, voicesQ] = await Promise.all([
      pool.query(
        `SELECT id, email, plan, tokens, role, created_at, last_seen, is_suspended, suspended_until, suspension_reason
         FROM users WHERE id::text = $1::text`,
        [id]
      ),
      pool.query(
        `SELECT action, tokens_used, characters_count, voice_name, timestamp
         FROM token_logs
         WHERE user_id::text = $1::text
           AND timestamp >= NOW() - ($3::int * INTERVAL '1 hour')
         ORDER BY timestamp DESC
         LIMIT $2`,
        [id, limit, hours]
      ),
      pool.query(
        `SELECT id, tokens_purchased, amount_usd, status, created_at, stripe_payment_id
         FROM transactions
         WHERE user_id::text = $1::text
           AND created_at >= NOW() - ($3::int * INTERVAL '1 hour')
         ORDER BY created_at DESC
         LIMIT $2`,
        [id, limit, hours]
      ),
      pool.query(
        `SELECT aal.action, aal.details, aal.created_at,
                actor.email AS admin_email
         FROM admin_audit_logs aal
         LEFT JOIN users actor ON aal.actor_user_id::text = actor.id::text
         WHERE aal.target_user_id::text = $1::text
           AND aal.created_at >= NOW() - ($3::int * INTERVAL '1 hour')
         ORDER BY aal.created_at DESC
         LIMIT $2`,
        [id, limit, hours]
      ),
      pool.query(
        `SELECT method, path, status_code, duration_ms, ip_address, error_message, created_at
         FROM api_request_logs
         WHERE user_id::text = $1::text
           AND created_at >= NOW() - ($3::int * INTERVAL '1 hour')
         ORDER BY created_at DESC
         LIMIT $2`,
        [id, limit, hours]
      ),
      pool.query(
        `SELECT id, voice_name, voice_id, provider, created_at
         FROM user_voices
         WHERE user_id::text = $1::text
           AND created_at >= NOW() - ($3::int * INTERVAL '1 hour')
         ORDER BY created_at DESC
         LIMIT $2`,
        [id, limit, hours]
      )
    ]);

    if (userQ.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    return res.json({
      success: true,
      user: userQ.rows[0],
      filters: { limit, hours },
      activity: {
        tokenLogs: tokenLogsQ.rows,
        transactions: transactionsQ.rows,
        adminActions: adminActionsQ.rows,
        requestLogs: requestLogsQ.rows,
        voices: voicesQ.rows,
      }
    });
  } catch (err) {
    console.error('[Admin] Error user activity:', err.message);
    return res.status(500).json({ error: 'Error obteniendo actividad del usuario' });
  }
});

/**
 * GET /api/admin/users/:id/activity/export - Exportar actividad/logs del usuario
 */
router.get('/users/:id/activity/export', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const limit = parseLimit(req.query.limit, 5000, 50000);
    const hours = parseHours(req.query.hours, 48);
    const format = String(req.query.format || 'json').toLowerCase();

    const [userQ, tokenLogsQ, transactionsQ, adminActionsQ, requestLogsQ, voicesQ] = await Promise.all([
      pool.query(
        `SELECT id, email, plan, tokens, role, created_at, last_seen, is_suspended, suspended_until, suspension_reason
         FROM users WHERE id::text = $1::text`,
        [id]
      ),
      pool.query(
        `SELECT action, tokens_used, characters_count, voice_name, timestamp
         FROM token_logs
         WHERE user_id::text = $1::text
           AND timestamp >= NOW() - ($3::int * INTERVAL '1 hour')
         ORDER BY timestamp DESC
         LIMIT $2`,
        [id, limit, hours]
      ),
      pool.query(
        `SELECT id, tokens_purchased, amount_usd, status, created_at, stripe_payment_id
         FROM transactions
         WHERE user_id::text = $1::text
           AND created_at >= NOW() - ($3::int * INTERVAL '1 hour')
         ORDER BY created_at DESC
         LIMIT $2`,
        [id, limit, hours]
      ),
      pool.query(
        `SELECT aal.action, aal.details, aal.created_at,
                actor.email AS admin_email
         FROM admin_audit_logs aal
         LEFT JOIN users actor ON aal.actor_user_id::text = actor.id::text
         WHERE aal.target_user_id::text = $1::text
           AND aal.created_at >= NOW() - ($3::int * INTERVAL '1 hour')
         ORDER BY aal.created_at DESC
         LIMIT $2`,
        [id, limit, hours]
      ),
      pool.query(
        `SELECT method, path, status_code, duration_ms, ip_address, error_message, created_at
         FROM api_request_logs
         WHERE user_id::text = $1::text
           AND created_at >= NOW() - ($3::int * INTERVAL '1 hour')
         ORDER BY created_at DESC
         LIMIT $2`,
        [id, limit, hours]
      ),
      pool.query(
        `SELECT id, voice_name, voice_id, provider, created_at
         FROM user_voices
         WHERE user_id::text = $1::text
           AND created_at >= NOW() - ($3::int * INTERVAL '1 hour')
         ORDER BY created_at DESC
         LIMIT $2`,
        [id, limit, hours]
      )
    ]);

    if (userQ.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      filters: { hours, limit },
      user: userQ.rows[0],
      activity: {
        tokenLogs: tokenLogsQ.rows,
        transactions: transactionsQ.rows,
        adminActions: adminActionsQ.rows,
        requestLogs: requestLogsQ.rows,
        voices: voicesQ.rows,
      }
    };

    if (format === 'csv') {
      const lines = [
        'section,timestamp,field1,field2,field3,field4,field5',
        ...tokenLogsQ.rows.map((row) => [
          'token_logs',
          row.timestamp || '',
          row.action || '',
          row.tokens_used ?? '',
          row.characters_count ?? '',
          row.voice_name || '',
          ''
        ].map(csvEscape).join(',')),
        ...transactionsQ.rows.map((row) => [
          'transactions',
          row.created_at || '',
          row.status || '',
          row.tokens_purchased ?? '',
          row.amount_usd ?? '',
          row.stripe_payment_id || '',
          row.id ?? ''
        ].map(csvEscape).join(',')),
        ...adminActionsQ.rows.map((row) => [
          'admin_actions',
          row.created_at || '',
          row.action || '',
          row.admin_email || '',
          JSON.stringify(row.details || {}),
          '',
          ''
        ].map(csvEscape).join(',')),
        ...requestLogsQ.rows.map((row) => [
          'request_logs',
          row.created_at || '',
          row.method || '',
          row.path || '',
          row.status_code ?? '',
          row.duration_ms ?? '',
          row.error_message || ''
        ].map(csvEscape).join(',')),
        ...voicesQ.rows.map((row) => [
          'voices',
          row.created_at || '',
          row.voice_name || '',
          row.voice_id || '',
          row.provider || '',
          row.id ?? '',
          ''
        ].map(csvEscape).join(','))
      ];

      const safeEmail = String(userQ.rows[0].email || `user-${id}`).replace(/[^a-zA-Z0-9._-]/g, '_');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="voltvoice-activity-${safeEmail}-${hours}h.csv"`);
      return res.send(lines.join('\n'));
    }

    const safeEmail = String(userQ.rows[0].email || `user-${id}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="voltvoice-activity-${safeEmail}-${hours}h.json"`);
    return res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[Admin] Error exporting user activity:', err.message);
    return res.status(500).json({ error: 'Error exportando actividad del usuario' });
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

/**
 * GET /api/admin/audio-cache/settings - Obtener configuracion del cache de audio
 */
router.get('/audio-cache/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await audioCacheService.getSettings(true);
    return res.json({ success: true, settings });
  } catch (err) {
    console.error('[Admin] Error audio-cache/settings:', err.message);
    return res.status(500).json({ error: 'Error obteniendo configuracion de cache' });
  }
});

/**
 * PUT /api/admin/audio-cache/settings - Actualizar configuracion de cache de audio
 */
router.put('/audio-cache/settings', requireAdmin, async (req, res) => {
  try {
    const payload = req.body || {};
    const updates = {
      enabled: payload.enabled !== undefined ? Boolean(payload.enabled) : true,
      maxCacheableChars: parseIntRange(payload.maxCacheableChars, 120, 20, 500),
      personalTtlSeconds: parseIntRange(payload.personalTtlSeconds, 86400, 60, 30 * 24 * 3600),
      globalTtlSeconds: parseIntRange(payload.globalTtlSeconds, 604800, 300, 90 * 24 * 3600),
      personalFreeTtlSeconds: parseIntRange(payload.personalFreeTtlSeconds, 172800, 60, 30 * 24 * 3600),
      personalPaidTtlSeconds: parseIntRange(payload.personalPaidTtlSeconds, 604800, 300, 90 * 24 * 3600),
      personalFreeMaxEntries: parseIntRange(payload.personalFreeMaxEntries, 200, 10, 5000),
      personalPaidMaxEntries: parseIntRange(payload.personalPaidMaxEntries, 1000, 10, 50000),
      globalMaxEntries: parseIntRange(payload.globalMaxEntries, 1500, 100, 50000),
      globalInactiveDays: parseIntRange(payload.globalInactiveDays, 30, 1, 365),
      globalLowUsageThreshold: parseIntRange(payload.globalLowUsageThreshold, 8, 0, 100000),
      subscriptionGraceDays: parseIntRange(payload.subscriptionGraceDays, 15, 1, 180),
      purgePersonalizationAfterGrace: payload.purgePersonalizationAfterGrace === true,
      hotCacheMaxEntries: parseIntRange(payload.hotCacheMaxEntries, 1500, 100, 50000),
      globalRepeatThreshold: parseIntRange(payload.globalRepeatThreshold, 4, 2, 100),
      lookupTimeoutMs: parseIntRange(payload.lookupTimeoutMs, 35, 5, 250),
    };

    await pool.query(
      `INSERT INTO audio_cache_settings
       (
        id, enabled, max_cacheable_chars, personal_ttl_seconds, global_ttl_seconds,
        personal_free_ttl_seconds, personal_paid_ttl_seconds, personal_free_max_entries, personal_paid_max_entries,
        global_max_entries, global_inactive_days, global_low_usage_threshold,
        subscription_grace_days, purge_personalization_after_grace,
        hot_cache_max_entries, global_repeat_threshold, lookup_timeout_ms, updated_at
       )
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           max_cacheable_chars = EXCLUDED.max_cacheable_chars,
           personal_ttl_seconds = EXCLUDED.personal_ttl_seconds,
           global_ttl_seconds = EXCLUDED.global_ttl_seconds,
           personal_free_ttl_seconds = EXCLUDED.personal_free_ttl_seconds,
           personal_paid_ttl_seconds = EXCLUDED.personal_paid_ttl_seconds,
           personal_free_max_entries = EXCLUDED.personal_free_max_entries,
           personal_paid_max_entries = EXCLUDED.personal_paid_max_entries,
           global_max_entries = EXCLUDED.global_max_entries,
           global_inactive_days = EXCLUDED.global_inactive_days,
           global_low_usage_threshold = EXCLUDED.global_low_usage_threshold,
           subscription_grace_days = EXCLUDED.subscription_grace_days,
           purge_personalization_after_grace = EXCLUDED.purge_personalization_after_grace,
           hot_cache_max_entries = EXCLUDED.hot_cache_max_entries,
           global_repeat_threshold = EXCLUDED.global_repeat_threshold,
           lookup_timeout_ms = EXCLUDED.lookup_timeout_ms,
           updated_at = CURRENT_TIMESTAMP`,
      [
        updates.enabled,
        updates.maxCacheableChars,
        updates.personalTtlSeconds,
        updates.globalTtlSeconds,
        updates.personalFreeTtlSeconds,
        updates.personalPaidTtlSeconds,
        updates.personalFreeMaxEntries,
        updates.personalPaidMaxEntries,
        updates.globalMaxEntries,
        updates.globalInactiveDays,
        updates.globalLowUsageThreshold,
        updates.subscriptionGraceDays,
        updates.purgePersonalizationAfterGrace,
        updates.hotCacheMaxEntries,
        updates.globalRepeatThreshold,
        updates.lookupTimeoutMs,
      ]
    );

    await logAdminAction({
      actorId: req.user.userId,
      action: 'update_audio_cache_settings',
      details: updates
    });

    const settings = await audioCacheService.getSettings(true);
    return res.json({ success: true, settings });
  } catch (err) {
    console.error('[Admin] Error updating audio cache settings:', err.message);
    return res.status(500).json({ error: 'Error actualizando configuracion de cache' });
  }
});

/**
 * GET /api/admin/audio-cache/stats - Estadisticas del cache
 */
router.get('/audio-cache/stats', requireAdmin, async (req, res) => {
  try {
    const [scopeRows, topRows, phraseRows, runtimeRows] = await Promise.all([
      pool.query(`
        SELECT scope,
               COUNT(*)::int AS entries,
               COALESCE(SUM(char_count), 0)::bigint AS total_chars,
               COALESCE(SUM(hits), 0)::bigint AS total_hits
        FROM audio_cache_entries
        WHERE expires_at IS NULL OR expires_at > NOW()
        GROUP BY scope
      `),
      pool.query(`
        SELECT cache_key, scope, voice_id, char_count, hits, last_hit_at
        FROM audio_cache_entries
        WHERE expires_at IS NULL OR expires_at > NOW()
        ORDER BY hits DESC, last_hit_at DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT phrase_key, voice_id, seen_count, last_seen_at
        FROM audio_cache_phrase_stats
        ORDER BY seen_count DESC, last_seen_at DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT total_requests, cacheable_requests, bypassed_requests, hot_hits, persistent_hits,
               misses, rendered_requests, saved_render_count, tokens_saved_estimate, chars_served_from_cache, updated_at
        FROM audio_cache_runtime_stats
        WHERE id = 1
      `),
    ]);

    const byScope = { personal: { entries: 0, totalChars: 0, totalHits: 0 }, global: { entries: 0, totalChars: 0, totalHits: 0 } };
    for (const row of scopeRows.rows) {
      byScope[row.scope] = {
        entries: Number(row.entries || 0),
        totalChars: Number(row.total_chars || 0),
        totalHits: Number(row.total_hits || 0),
      };
    }

    const runtime = runtimeRows.rows[0] || {
      total_requests: 0,
      cacheable_requests: 0,
      bypassed_requests: 0,
      hot_hits: 0,
      persistent_hits: 0,
      misses: 0,
      rendered_requests: 0,
      saved_render_count: 0,
      tokens_saved_estimate: 0,
      chars_served_from_cache: 0,
      updated_at: null
    };
    const totalHits = Number(runtime.hot_hits || 0) + Number(runtime.persistent_hits || 0);
    const totalRequests = Number(runtime.total_requests || 0);
    const hitRate = totalRequests > 0 ? Number(((totalHits / totalRequests) * 100).toFixed(2)) : 0;

    return res.json({
      success: true,
      stats: {
        byScope,
        hotCacheEntries: audioCacheService.hotCache.size,
        runtime: {
          ...runtime,
          total_requests: totalRequests,
          hit_rate_percent: hitRate,
          total_hits: totalHits
        },
        topEntries: topRows.rows,
        topPhrases: phraseRows.rows,
      }
    });
  } catch (err) {
    console.error('[Admin] Error audio-cache/stats:', err.message);
    return res.status(500).json({ error: 'Error obteniendo estadisticas de cache' });
  }
});

/**
 * GET /api/admin/audio-cache/entries - Listar entradas del cache
 */
router.get('/audio-cache/entries', requireAdmin, async (req, res) => {
  try {
    const scope = String(req.query.scope || 'all').toLowerCase();
    const userId = String(req.query.userId || '').trim();
    const limit = parseLimit(req.query.limit, 100, 500);

    const conditions = ['(e.expires_at IS NULL OR e.expires_at > NOW())'];
    const params = [];
    let idx = 1;

    if (scope === 'personal' || scope === 'global') {
      conditions.push(`e.scope = $${idx++}`);
      params.push(scope);
    }
    if (userId) {
      conditions.push(`e.user_id::text = $${idx++}::text`);
      params.push(userId);
    }

    params.push(limit);
    const result = await pool.query(
      `SELECT e.cache_key, e.scope, e.user_id, u.email AS user_email, e.voice_id, e.char_count, e.hits, e.last_hit_at, e.expires_at, e.created_at
       FROM audio_cache_entries e
       LEFT JOIN users u ON e.user_id = u.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.last_hit_at DESC, e.created_at DESC
       LIMIT $${idx}`,
      params
    );

    return res.json({ success: true, entries: result.rows });
  } catch (err) {
    console.error('[Admin] Error audio-cache/entries:', err.message);
    return res.status(500).json({ error: 'Error listando entradas de cache' });
  }
});

/**
 * DELETE /api/admin/audio-cache/entries/:cacheKey - Eliminar entrada especifica
 */
router.delete('/audio-cache/entries/:cacheKey', requireAdmin, async (req, res) => {
  try {
    const cacheKey = String(req.params.cacheKey || '').trim();
    if (!cacheKey) return res.status(400).json({ error: 'cacheKey requerido' });

    const deleted = await pool.query(
      'DELETE FROM audio_cache_entries WHERE cache_key = $1 RETURNING cache_key, scope, user_id, voice_id',
      [cacheKey]
    );

    if (deleted.rows.length === 0) {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }

    audioCacheService.hotCache.delete(cacheKey);
    await logAdminAction({
      actorId: req.user.userId,
      targetUserId: deleted.rows[0].user_id || null,
      action: 'delete_audio_cache_entry',
      details: { cacheKey, scope: deleted.rows[0].scope, voiceId: deleted.rows[0].voice_id }
    });

    return res.json({ success: true, deleted: deleted.rows[0] });
  } catch (err) {
    console.error('[Admin] Error deleting audio cache entry:', err.message);
    return res.status(500).json({ error: 'Error eliminando entrada de cache' });
  }
});

/**
 * POST /api/admin/audio-cache/purge - Purga de cache por scope/expirado
 */
router.post('/audio-cache/purge', requireAdmin, async (req, res) => {
  try {
    const scope = String(req.body.scope || 'all').toLowerCase();
    const expiredOnly = Boolean(req.body.expiredOnly);

    const conditions = [];
    const params = [];
    let idx = 1;

    if (scope === 'personal' || scope === 'global') {
      conditions.push(`scope = $${idx++}`);
      params.push(scope);
    }
    if (expiredOnly) {
      conditions.push('expires_at IS NOT NULL AND expires_at <= NOW()');
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const deleted = await pool.query(
      `DELETE FROM audio_cache_entries
       ${whereClause}
       RETURNING cache_key`,
      params
    );

    if (!scope || scope === 'all' || !expiredOnly) {
      audioCacheService.clearHotCache();
    } else {
      for (const row of deleted.rows) {
        audioCacheService.hotCache.delete(row.cache_key);
      }
    }

    await logAdminAction({
      actorId: req.user.userId,
      action: 'purge_audio_cache',
      details: { scope, expiredOnly, deleted: deleted.rowCount }
    });

    return res.json({
      success: true,
      deleted: deleted.rowCount,
      scope,
      expiredOnly
    });
  } catch (err) {
    console.error('[Admin] Error purging audio cache:', err.message);
    return res.status(500).json({ error: 'Error purgando cache' });
  }
});

export default router;
