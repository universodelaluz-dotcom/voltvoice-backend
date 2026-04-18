import { Router } from 'express';
import pool from '../db.js';

const router = Router();

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

const getFirstFourUsers = async () => {
  const result = await pool.query(
    `SELECT
       id,
       email,
       plan,
       tokens,
       subscription_billing_cycle,
       subscription_current_period_end
     FROM users
     ORDER BY id ASC
     LIMIT 4`
  );

  return result.rows.map((row, index) => ({
    slot: index + 1,
    id: Number(row.id),
    email: String(row.email || ''),
    plan: toPublicPlan(row.plan),
    tokens: Number(row.tokens || 0),
    billingCycle: String(row.subscription_billing_cycle || 'monthly').toLowerCase(),
    subscriptionEndsAt: row.subscription_current_period_end || null,
  }));
};

// GET /api/test-lab/users
router.get('/users', async (_req, res) => {
  try {
    const users = await getFirstFourUsers();
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

    const users = await getFirstFourUsers();
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

export default router;
