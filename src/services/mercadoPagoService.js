import axios from 'axios';
import db from '../db.js';
import { config } from '../config.js';

const TOKEN_PACKAGES = {
  100000: { kind: 'tokens', price: 3.00, tokens: 100000, description: '100K Tokens - Pequeno' },
  250000: { kind: 'tokens', price: 7.00, tokens: 250000, description: '250K Tokens - Mediano' },
  500000: { kind: 'tokens', price: 12.00, tokens: 500000, description: '500K Tokens - Grande' },
  1000000: { kind: 'tokens', price: 20.00, tokens: 1000000, description: '1M Tokens - Maximo' }
};

const PLAN_PACKAGES = {
  'creator_monthly': { kind: 'plan', planKey: 'creator', backendPlan: 'pro', price: 7.99, tokens: 120000, description: 'Plan Creator Mensual' },
  'creator_annual': { kind: 'plan', planKey: 'creator', backendPlan: 'pro', price: 79.00, tokens: 120000, description: 'Plan Creator Anual' },
  'pro_monthly': { kind: 'plan', planKey: 'pro', backendPlan: 'premium', price: 19.99, tokens: 500000, description: 'Plan Pro Mensual' },
  'pro_annual': { kind: 'plan', planKey: 'pro', backendPlan: 'premium', price: 199.00, tokens: 500000, description: 'Plan Pro Anual' },
  'elite_monthly': { kind: 'plan', planKey: 'elite', backendPlan: 'elite', price: 39.99, tokens: 1500000, description: 'Plan Elite Mensual' },
  'elite_annual': { kind: 'plan', planKey: 'elite', backendPlan: 'elite', price: 399.00, tokens: 1500000, description: 'Plan Elite Anual' }
};

class MercadoPagoService {
  constructor() {
    this.apiUrl = 'https://api.mercadopago.com/checkout/preferences';
    this.token = config.MERCADO_PAGO_ACCESS_TOKEN;

    if (!this.token) {
      console.warn('[MERCADO_PAGO] Access token not configured. Payments will not work.');
    } else {
      console.log('[MERCADO_PAGO] Service initialized');
    }
  }

  getCheckoutItem(payload = {}) {
    if (payload.itemType === 'plan' || payload.planId) {
      const key = `${String(payload.planId || '').toLowerCase()}_${String(payload.billingCycle || 'monthly').toLowerCase()}`;
      return PLAN_PACKAGES[key] || null;
    }

    return TOKEN_PACKAGES[payload.tokensPackage] || null;
  }

  async createPaymentPreference(userId, payload) {
    try {
      if (!this.token) {
        throw new Error('MERCADO_PAGO_ACCESS_TOKEN is not configured');
      }

      const item = this.getCheckoutItem(payload);
      if (!item) {
        throw new Error('Invalid checkout item');
      }

      const billingCycle = String(payload.billingCycle || 'monthly').toLowerCase();
      const externalReference = item.kind === 'plan'
        ? `user_${userId}_plan_${item.planKey}_${billingCycle}`
        : `user_${userId}_tokens_${payload.tokensPackage}`;

      const preferenceData = {
        items: [
          {
            id: item.kind === 'plan'
              ? `plan_${item.planKey}_${billingCycle}`
              : `tokens_${payload.tokensPackage}`,
            title: `VoltVoice - ${item.description}`,
            description: item.kind === 'plan'
              ? `Compra del ${item.description}`
              : `Compra ${payload.tokensPackage} tokens para sintetizar voces`,
            quantity: 1,
            unit_price: item.price,
            currency_id: 'USD'
          }
        ],
        payer: {
          email: `user_${userId}@voltvoice.com`
        },
        back_urls: {
          success: `${config.FRONTEND_URL}?payment=success`,
          failure: `${config.FRONTEND_URL}?payment=failed`,
          pending: `${config.FRONTEND_URL}?payment=pending`
        },
        auto_return: 'approved',
        notification_url: `${config.BACKEND_URL}/api/mercadopago/webhook`,
        external_reference: externalReference,
        currency_id: 'USD'
      };

      const response = await axios.post(this.apiUrl, preferenceData, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        }
      });

      return {
        success: true,
        preferenceId: response.data.id,
        initPoint: response.data.init_point,
        sandboxInitPoint: response.data.sandbox_init_point
      };
    } catch (error) {
      console.error('[MERCADO_PAGO] Error creating payment preference:', error.response?.data || error.message);
      throw error;
    }
  }

  async handlePaymentNotification(paymentData) {
    try {
      const paymentId = paymentData.data.id;

      const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      const payment = response.data;
      if (payment.status !== 'approved') {
        return { success: false, status: payment.status };
      }

      const parts = String(payment.external_reference || '').split('_');
      const userId = parts[1];
      const kind = parts[2];

      if (!userId || !kind) {
        throw new Error('Invalid external reference');
      }

      if (kind === 'plan') {
        const item = this.getCheckoutItem({
          itemType: 'plan',
          planId: parts[3],
          billingCycle: parts[4]
        });

        if (!item) {
          throw new Error('Invalid plan reference');
        }

        const result = await db.query(
          `UPDATE users
           SET plan = $1, tokens = GREATEST(tokens, $2)
           WHERE id = $3
           RETURNING tokens, plan`,
          [item.backendPlan, item.tokens, userId]
        );

        await db.query(
          `INSERT INTO transactions (user_id, tokens_purchased, amount_usd, stripe_payment_id, status)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, item.tokens, payment.transaction_amount, paymentId, 'completed']
        );

        return {
          success: true,
          userId,
          plan: result.rows[0].plan,
          newBalance: result.rows[0].tokens,
          tokensAdded: item.tokens
        };
      }

      const tokens = parseInt(parts[3], 10);
      const result = await db.query(
        `UPDATE users
         SET tokens = tokens + $1
         WHERE id = $2
         RETURNING tokens`,
        [tokens, userId]
      );

      await db.query(
        `INSERT INTO transactions (user_id, tokens_purchased, amount_usd, stripe_payment_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, tokens, payment.transaction_amount, paymentId, 'completed']
      );

      return {
        success: true,
        userId,
        tokensAdded: tokens,
        newBalance: result.rows[0].tokens
      };
    } catch (error) {
      console.error('[MERCADO_PAGO] Error processing payment:', error.response?.data || error.message);
      throw error;
    }
  }

  async getUserTransactions(userId) {
    const query = `
      SELECT * FROM transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `;
    const result = await db.query(query, [userId]);
    return result.rows;
  }
}

export default new MercadoPagoService();
