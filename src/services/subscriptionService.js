import pool from '../db.js';

const PLAN_CATALOG = {
  free: { planKey: 'free', backendPlan: 'free', tier: 0, monthlyPrice: 0, annualPrice: 0, tokens: 100 },
  start: { planKey: 'start', backendPlan: 'pro', tier: 1, monthlyPrice: 6.99, annualPrice: 59.0, tokens: 200000 },
  creator: { planKey: 'creator', backendPlan: 'premium', tier: 2, monthlyPrice: 12.99, annualPrice: 109.0, tokens: 500000 },
  pro: { planKey: 'pro', backendPlan: 'elite', tier: 3, monthlyPrice: 17.99, annualPrice: 149.0, tokens: 800000 },
};

const BACKEND_PLAN_TO_PLAN_KEY = {
  free: 'free',
  pro: 'start',
  premium: 'creator',
  elite: 'pro',
  on_demand: 'pro',
};

const roundCurrency = (value) => Math.max(0, Math.round((Number(value) || 0) * 100) / 100);
const toIsoOrNull = (value) => (value ? new Date(value).toISOString() : null);

const normalizePlanKey = (value) => String(value || 'free').trim().toLowerCase();
const normalizeCycle = (value) => (String(value || 'monthly').toLowerCase() === 'annual' ? 'annual' : 'monthly');

const addBillingCycle = (startDate, billingCycle) => {
  const next = new Date(startDate);
  if (normalizeCycle(billingCycle) === 'annual') {
    next.setFullYear(next.getFullYear() + 1);
  } else {
    next.setMonth(next.getMonth() + 1);
  }
  return next;
};

const nowUtc = () => new Date();

const fromUserRow = (row) => {
  const currentPlanKey = BACKEND_PLAN_TO_PLAN_KEY[String(row.plan || 'free').toLowerCase()] || 'free';
  return {
    userId: row.id,
    backendPlan: String(row.plan || 'free').toLowerCase(),
    currentPlanKey,
    currentPlan: PLAN_CATALOG[currentPlanKey] || PLAN_CATALOG.free,
    billingCycle: normalizeCycle(row.subscription_billing_cycle || 'monthly'),
    periodStart: row.subscription_current_period_start ? new Date(row.subscription_current_period_start) : null,
    periodEnd: row.subscription_current_period_end ? new Date(row.subscription_current_period_end) : null,
    cancelAtPeriodEnd: Boolean(row.subscription_cancel_at_period_end),
    pendingPlanKey: row.subscription_pending_plan_key ? normalizePlanKey(row.subscription_pending_plan_key) : null,
    pendingBillingCycle: row.subscription_pending_billing_cycle ? normalizeCycle(row.subscription_pending_billing_cycle) : null,
    pendingEffectiveAt: row.subscription_pending_effective_at ? new Date(row.subscription_pending_effective_at) : null,
    tokens: Number(row.tokens || 0),
  };
};

const isPaidPlan = (planKey) => normalizePlanKey(planKey) !== 'free';

const computeProration = ({ periodStart, periodEnd, oldPrice, newPrice, now }) => {
  if (!periodStart || !periodEnd) return { credit: 0, totalMs: 0, remainingMs: 0, ratio: 0 };
  const totalMs = Math.max(1, periodEnd.getTime() - periodStart.getTime());
  const remainingMs = Math.max(0, periodEnd.getTime() - now.getTime());
  const ratio = remainingMs / totalMs;
  const credit = roundCurrency((Number(oldPrice) || 0) * ratio);
  const payable = roundCurrency((Number(newPrice) || 0) - credit);
  return { credit, payable, totalMs, remainingMs, ratio };
};

class SubscriptionService {
  async ensureColumns() {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_billing_cycle VARCHAR(20) DEFAULT 'monthly';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_current_period_start TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_cancel_at_period_end BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_cancelled_at TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_pending_plan_key VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_pending_billing_cycle VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_pending_effective_at TIMESTAMP;
    `);
  }

  async getUserRow(client, userId, forUpdate = false) {
    const sql = `
      SELECT id, plan, tokens,
             subscription_billing_cycle,
             subscription_current_period_start,
             subscription_current_period_end,
             subscription_cancel_at_period_end,
             subscription_cancelled_at,
             subscription_pending_plan_key,
             subscription_pending_billing_cycle,
             subscription_pending_effective_at
      FROM users
      WHERE id = $1
      ${forUpdate ? 'FOR UPDATE' : ''}
    `;
    const result = await client.query(sql, [userId]);
    return result.rows[0] || null;
  }

  async applyPeriodBoundaryTransitions(client, userRow) {
    const sub = fromUserRow(userRow);
    const now = nowUtc();
    const periodEnded = sub.periodEnd && now.getTime() >= sub.periodEnd.getTime();
    if (!periodEnded) return userRow;

    if (sub.cancelAtPeriodEnd) {
      await client.query(
        `UPDATE users
         SET plan = 'free',
             subscription_current_period_start = NULL,
             subscription_current_period_end = NULL,
             subscription_cancel_at_period_end = FALSE,
             subscription_cancelled_at = COALESCE(subscription_cancelled_at, NOW()),
             subscription_pending_plan_key = NULL,
             subscription_pending_billing_cycle = NULL,
             subscription_pending_effective_at = NULL
         WHERE id = $1`,
        [sub.userId]
      );
      return this.getUserRow(client, sub.userId, false);
    }

    if (sub.pendingPlanKey && PLAN_CATALOG[sub.pendingPlanKey]) {
      const nextPlan = PLAN_CATALOG[sub.pendingPlanKey];
      const nextCycle = sub.pendingBillingCycle || sub.billingCycle || 'monthly';
      const nextStart = sub.periodEnd;
      const nextEnd = addBillingCycle(nextStart, nextCycle);
      await client.query(
        `UPDATE users
         SET plan = $2,
             tokens = GREATEST(tokens, $3),
             subscription_billing_cycle = $4,
             subscription_current_period_start = $5,
             subscription_current_period_end = $6,
             subscription_cancel_at_period_end = FALSE,
             subscription_pending_plan_key = NULL,
             subscription_pending_billing_cycle = NULL,
             subscription_pending_effective_at = NULL
         WHERE id = $1`,
        [sub.userId, nextPlan.backendPlan, nextPlan.tokens, nextCycle, nextStart, nextEnd]
      );
      return this.getUserRow(client, sub.userId, false);
    }

    await client.query(
      `UPDATE users
       SET plan = 'free',
           subscription_current_period_start = NULL,
           subscription_current_period_end = NULL,
           subscription_cancel_at_period_end = FALSE,
           subscription_pending_plan_key = NULL,
           subscription_pending_billing_cycle = NULL,
           subscription_pending_effective_at = NULL
       WHERE id = $1`,
      [sub.userId]
    );
    return this.getUserRow(client, sub.userId, false);
  }

  buildPlanQuote(userRow, targetPlanKey, targetBillingCycle) {
    const now = nowUtc();
    const sub = fromUserRow(userRow);
    const targetKey = normalizePlanKey(targetPlanKey);
    const target = PLAN_CATALOG[targetKey];
    if (!target || target.planKey === 'free') {
      return { action: 'invalid', reason: 'invalid_target_plan' };
    }

    const billingCycle = normalizeCycle(targetBillingCycle);
    const targetPrice = billingCycle === 'annual' ? target.annualPrice : target.monthlyPrice;
    const current = sub.currentPlan;
    const currentPaidActive = isPaidPlan(sub.currentPlanKey) && sub.periodEnd && sub.periodEnd.getTime() > now.getTime();

    if (!currentPaidActive) {
      return {
        action: 'immediate_purchase',
        payableAmountUsd: roundCurrency(targetPrice),
        prorationCreditUsd: 0,
        remainingMs: 0,
        totalMs: 0,
      };
    }

    if (target.tier > current.tier) {
      const currentPrice = sub.billingCycle === 'annual' ? current.annualPrice : current.monthlyPrice;
      const proration = computeProration({
        periodStart: sub.periodStart,
        periodEnd: sub.periodEnd,
        oldPrice: currentPrice,
        newPrice: targetPrice,
        now,
      });
      return {
        action: 'upgrade_immediate',
        payableAmountUsd: proration.payable,
        prorationCreditUsd: proration.credit,
        remainingMs: proration.remainingMs,
        totalMs: proration.totalMs,
        ratio: proration.ratio,
      };
    }

    if (target.tier < current.tier) {
      return {
        action: 'downgrade_next_cycle',
        payableAmountUsd: 0,
        prorationCreditUsd: 0,
        remainingMs: Math.max(0, (sub.periodEnd?.getTime() || 0) - now.getTime()),
        totalMs: Math.max(0, (sub.periodEnd?.getTime() || 0) - (sub.periodStart?.getTime() || 0)),
      };
    }

    if (billingCycle !== sub.billingCycle) {
      // Cambio de ciclo del mismo plan:
      // - mensual -> anual: permitir cambio inmediato con prorrateo.
      // - anual -> mensual: mantener programación al siguiente ciclo.
      if (sub.billingCycle === 'monthly' && billingCycle === 'annual') {
        const currentPrice = current.monthlyPrice;
        const proration = computeProration({
          periodStart: sub.periodStart,
          periodEnd: sub.periodEnd,
          oldPrice: currentPrice,
          newPrice: targetPrice,
          now,
        });
        return {
          action: 'billing_cycle_upgrade_immediate',
          payableAmountUsd: proration.payable,
          prorationCreditUsd: proration.credit,
          remainingMs: proration.remainingMs,
          totalMs: proration.totalMs,
          ratio: proration.ratio,
        };
      }

      return {
        action: 'billing_cycle_next_cycle',
        payableAmountUsd: 0,
        prorationCreditUsd: 0,
        remainingMs: Math.max(0, (sub.periodEnd?.getTime() || 0) - now.getTime()),
        totalMs: Math.max(0, (sub.periodEnd?.getTime() || 0) - (sub.periodStart?.getTime() || 0)),
      };
    }

    return {
      action: 'already_on_plan',
      payableAmountUsd: 0,
      prorationCreditUsd: 0,
      remainingMs: Math.max(0, (sub.periodEnd?.getTime() || 0) - now.getTime()),
      totalMs: Math.max(0, (sub.periodEnd?.getTime() || 0) - (sub.periodStart?.getTime() || 0)),
    };
  }

  async quotePlanChange(userId, targetPlanKey, targetBillingCycle) {
    await this.ensureColumns();
    const client = await pool.connect();
    try {
      const row = await this.getUserRow(client, userId, false);
      if (!row) throw new Error('Usuario no encontrado');
      const quote = this.buildPlanQuote(row, targetPlanKey, targetBillingCycle);
      return quote;
    } finally {
      client.release();
    }
  }

  async schedulePlanChange(userId, targetPlanKey, targetBillingCycle) {
    await this.ensureColumns();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.getUserRow(client, userId, true);
      if (!row) throw new Error('Usuario no encontrado');
      const normalizedRow = await this.applyPeriodBoundaryTransitions(client, row);
      const quote = this.buildPlanQuote(normalizedRow, targetPlanKey, targetBillingCycle);

      if (!['downgrade_next_cycle', 'billing_cycle_next_cycle'].includes(quote.action)) {
        await client.query('ROLLBACK');
        return { scheduled: false, quote, subscription: this.toResponse(normalizedRow) };
      }

      const targetKey = normalizePlanKey(targetPlanKey);
      const targetCycle = normalizeCycle(targetBillingCycle);
      await client.query(
        `UPDATE users
         SET subscription_pending_plan_key = $2,
             subscription_pending_billing_cycle = $3,
             subscription_pending_effective_at = subscription_current_period_end,
             subscription_cancel_at_period_end = FALSE
         WHERE id = $1`,
        [userId, targetKey, targetCycle]
      );
      const updated = await this.getUserRow(client, userId, false);
      await client.query('COMMIT');
      return { scheduled: true, quote, subscription: this.toResponse(updated) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async applyPaidPlanChange({ userId, planKey, billingCycle }) {
    await this.ensureColumns();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.getUserRow(client, userId, true);
      if (!row) throw new Error('Usuario no encontrado');
      const normalizedRow = await this.applyPeriodBoundaryTransitions(client, row);
      const sub = fromUserRow(normalizedRow);
      const quote = this.buildPlanQuote(normalizedRow, planKey, billingCycle);
      const targetKey = normalizePlanKey(planKey);
      const targetPlan = PLAN_CATALOG[targetKey];
      if (!targetPlan) throw new Error('Plan inválido');

      const now = nowUtc();
      let nextStart = sub.periodStart;
      let nextEnd = sub.periodEnd;
      let nextCycle = normalizeCycle(billingCycle);
      let tokenIncrement = 0;

      if (quote.action === 'immediate_purchase') {
        nextStart = now;
        nextEnd = addBillingCycle(now, nextCycle);
      } else if (quote.action === 'upgrade_immediate') {
        // Mantiene el ciclo actual y ajusta cupo de tokens de forma proporcional.
        const baseCurrent = sub.currentPlan || PLAN_CATALOG.free;
        const ratio = Number(quote.ratio || 0);
        tokenIncrement = Math.max(0, Math.round((targetPlan.tokens - baseCurrent.tokens) * ratio));
        nextCycle = sub.billingCycle || nextCycle;
      } else if (quote.action === 'billing_cycle_upgrade_immediate') {
        nextStart = now;
        nextEnd = addBillingCycle(now, nextCycle);
      } else if (['downgrade_next_cycle', 'billing_cycle_next_cycle'].includes(quote.action)) {
        // Pago recibido para un cambio programado: conserva plan actual y agenda el cambio
        // al cierre del periodo vigente.
        await client.query(
          `UPDATE users
           SET subscription_pending_plan_key = $2,
               subscription_pending_billing_cycle = $3,
               subscription_pending_effective_at = subscription_current_period_end,
               subscription_cancel_at_period_end = FALSE
           WHERE id = $1`,
          [userId, targetKey, nextCycle]
        );
        const updated = await this.getUserRow(client, userId, false);
        await client.query('COMMIT');
        return { quote, subscription: this.toResponse(updated) };
      } else {
        throw new Error('Este cambio no requiere pago inmediato');
      }

      await client.query(
        `UPDATE users
         SET plan = $2,
             tokens = GREATEST(tokens + $3, $4),
             subscription_billing_cycle = $5,
             subscription_current_period_start = $6,
             subscription_current_period_end = $7,
             subscription_cancel_at_period_end = FALSE,
             subscription_cancelled_at = NULL,
             subscription_pending_plan_key = NULL,
             subscription_pending_billing_cycle = NULL,
             subscription_pending_effective_at = NULL
         WHERE id = $1`,
        [
          userId,
          targetPlan.backendPlan,
          tokenIncrement,
          (quote.action === 'immediate_purchase' || quote.action === 'billing_cycle_upgrade_immediate')
            ? targetPlan.tokens
            : 0,
          nextCycle,
          nextStart,
          nextEnd,
        ]
      );

      const updated = await this.getUserRow(client, userId, false);
      await client.query('COMMIT');
      return { quote, subscription: this.toResponse(updated) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelAtPeriodEnd(userId) {
    await this.ensureColumns();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.getUserRow(client, userId, true);
      if (!row) throw new Error('Usuario no encontrado');
      const normalizedRow = await this.applyPeriodBoundaryTransitions(client, row);
      const sub = fromUserRow(normalizedRow);

      if (!isPaidPlan(sub.currentPlanKey) || !sub.periodEnd) {
        await client.query(
          `UPDATE users
           SET plan = 'free',
               subscription_current_period_start = NULL,
               subscription_current_period_end = NULL,
               subscription_cancel_at_period_end = FALSE,
               subscription_cancelled_at = NOW(),
               subscription_pending_plan_key = NULL,
               subscription_pending_billing_cycle = NULL,
               subscription_pending_effective_at = NULL
           WHERE id = $1`,
          [userId]
        );
      } else {
        await client.query(
          `UPDATE users
           SET subscription_cancel_at_period_end = TRUE,
               subscription_cancelled_at = NOW(),
               subscription_pending_plan_key = NULL,
               subscription_pending_billing_cycle = NULL,
               subscription_pending_effective_at = NULL
           WHERE id = $1`,
          [userId]
        );
      }

      const updated = await this.getUserRow(client, userId, false);
      await client.query('COMMIT');
      return this.toResponse(updated);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getSubscription(userId) {
    await this.ensureColumns();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.getUserRow(client, userId, true);
      if (!row) throw new Error('Usuario no encontrado');
      const updated = await this.applyPeriodBoundaryTransitions(client, row);
      await client.query('COMMIT');
      return this.toResponse(updated);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  toResponse(userRow) {
    const sub = fromUserRow(userRow);
    const now = nowUtc();
    const isActive = Boolean(sub.periodEnd && sub.periodEnd.getTime() > now.getTime() && isPaidPlan(sub.currentPlanKey));
    return {
      userId: sub.userId,
      currentPlanKey: sub.currentPlanKey,
      backendPlan: sub.backendPlan,
      billingCycle: sub.billingCycle,
      tokens: sub.tokens,
      active: isActive,
      currentPeriodStart: toIsoOrNull(sub.periodStart),
      currentPeriodEnd: toIsoOrNull(sub.periodEnd),
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      cancelledAt: toIsoOrNull(userRow.subscription_cancelled_at),
      pendingPlanKey: sub.pendingPlanKey,
      pendingBillingCycle: sub.pendingBillingCycle,
      pendingEffectiveAt: toIsoOrNull(sub.pendingEffectiveAt),
    };
  }
}

export const subscriptionCatalog = PLAN_CATALOG;
export default new SubscriptionService();
