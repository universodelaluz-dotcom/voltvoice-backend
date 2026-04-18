import { Router } from 'express';
import pool from '../db.js';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';

const router = Router();
const TEST_USERS = [
  { slot: 1, email: 'test.user1@streamvoicer.local' },
  { slot: 2, email: 'test.user2@streamvoicer.local' },
  { slot: 3, email: 'test.user3@streamvoicer.local' },
  { slot: 4, email: 'test.user4@streamvoicer.local' },
];

const BACKEND_PLAN_TO_PUBLIC = {
  free: 'free',
  pro: 'start',
  premium: 'creator',
  elite: 'pro',
  on_demand: 'free',
  admin: 'admin',
};

const toPublicPlan = (rawPlan = 'free') => {
  const normalized = String(rawPlan || 'free').trim().toLowerCase();
  return BACKEND_PLAN_TO_PUBLIC[normalized] || normalized || 'free';
};

const ensureTestUsers = async () => {
  for (const spec of TEST_USERS) {
    await pool.query(
      `INSERT INTO users (email, plan, tokens, role, email_verified)
       VALUES ($1, 'free', 0, 'user', TRUE)
       ON CONFLICT (email) DO NOTHING`,
      [spec.email]
    );
  }
};

const getTestUsers = async () => {
  await ensureTestUsers();
  const result = await pool.query(
    `SELECT
       id,
       email,
       plan,
       tokens,
       subscription_billing_cycle,
       subscription_current_period_end
     FROM users
     WHERE email = ANY($1::text[])`,
    [TEST_USERS.map((u) => u.email)]
  );

  const byEmail = new Map(result.rows.map((row) => [String(row.email || '').toLowerCase(), row]));

  return TEST_USERS.map((spec) => {
    const row = byEmail.get(spec.email.toLowerCase());
    if (!row) {
      return {
        slot: spec.slot,
        id: null,
        email: spec.email,
        plan: 'free',
        tokens: 0,
        billingCycle: 'monthly',
        subscriptionEndsAt: null,
      };
    }
    return {
      slot: spec.slot,
    id: Number(row.id),
    email: String(row.email || ''),
    plan: toPublicPlan(row.plan),
    tokens: Number(row.tokens || 0),
    billingCycle: String(row.subscription_billing_cycle || 'monthly').toLowerCase(),
    subscriptionEndsAt: row.subscription_current_period_end || null,
    };
  });
};

const getUserById = async (userId) => {
  const result = await pool.query(
    `SELECT id, email, plan, tokens, role
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  return result.rows?.[0] || null;
};

const isAllowedTestUser = (email = '') =>
  TEST_USERS.some((u) => u.email.toLowerCase() === String(email || '').toLowerCase());

// GET /api/test-lab/users
router.get('/users', async (_req, res) => {
  try {
    const users = await getTestUsers();
    return res.json({ success: true, users });
  } catch (error) {
    console.error('[TEST_LAB] users error:', error.message);
    return res.status(500).json({ error: 'No se pudieron cargar los usuarios de prueba.' });
  }
});

// POST /api/test-lab/users/:id/reset
router.post('/users/:id/reset', async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ error: 'ID de usuario inválido.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const exists = await client.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [userId]);
    if (!exists.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    const verifyUser = await client.query('SELECT email FROM users WHERE id = $1 LIMIT 1', [userId]);
    if (!isAllowedTestUser(verifyUser.rows?.[0]?.email)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Solo usuarios de prueba permitidos.' });
    }

    // Reset completo para pruebas rápidas.
    await client.query(
      `UPDATE users
       SET
         plan = 'free',
         tokens = 0,
         subscription_billing_cycle = 'monthly',
         subscription_current_period_start = NULL,
         subscription_current_period_end = NULL,
         subscription_cancel_at_period_end = FALSE,
         subscription_cancelled_at = NULL,
         subscription_pending_plan_key = NULL,
         subscription_pending_billing_cycle = NULL,
         subscription_pending_effective_at = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );

    await client.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM token_logs WHERE user_id::text = $1::text', [String(userId)]);

    await client.query('COMMIT');

    const users = await getTestUsers();
    return res.json({
      success: true,
      message: `Usuario ${userId} reiniciado: tokens=0, plan=free, pagos borrados.`,
      users,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[TEST_LAB] reset error:', error.message);
    return res.status(500).json({ error: 'No se pudo reiniciar el usuario de prueba.' });
  } finally {
    client.release();
  }
});

// POST /api/test-lab/users/:id/assume
router.post('/users/:id/assume', async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ error: 'ID de usuario inválido.' });
  }

  try {
    const row = await getUserById(userId);
    if (!row) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    if (!isAllowedTestUser(row.email)) {
      return res.status(403).json({ error: 'Solo usuarios de prueba permitidos.' });
    }

    const token = jwt.sign(
      { userId: Number(row.id), email: String(row.email), role: String(row.role || 'user') },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN || '7d' }
    );

    return res.json({
      success: true,
      token,
      user: {
        id: Number(row.id),
        email: String(row.email),
        role: String(row.role || 'user'),
        plan: toPublicPlan(row.plan),
        tokens: Number(row.tokens || 0),
      },
    });
  } catch (error) {
    console.error('[TEST_LAB] assume error:', error.message);
    return res.status(500).json({ error: 'No se pudo iniciar sesión temporal.' });
  }
});

export default router;
