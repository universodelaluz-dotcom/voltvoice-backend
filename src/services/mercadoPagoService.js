import axios from 'axios';
import db from '../db.js';
import { config } from '../config.js';
import subscriptionService from './subscriptionService.js';

const TOKEN_PACKAGES = {
  100: { kind: 'tokens', price: 15, tokens: 100, description: 'TEST - 100 tokens' },
  150000: { kind: 'tokens', price: 4.99, tokens: 150000, description: 'MINI BOOST - 150K caracteres' },
  350000: { kind: 'tokens', price: 9.99, tokens: 350000, description: 'POWER BOOST - 350K caracteres' },
  700000: { kind: 'tokens', price: 14.99, tokens: 700000, description: 'MAX BOOST - 700K caracteres' }
};

const PLAN_PACKAGES = {
  'start_monthly': { kind: 'plan', planKey: 'start', backendPlan: 'pro', price: 6.99, tokens: 200000, description: 'Plan START Mensual' },
  'start_annual': { kind: 'plan', planKey: 'start', backendPlan: 'pro', price: 59.00, tokens: 200000, description: 'Plan START Anual' },
  'creator_monthly': { kind: 'plan', planKey: 'creator', backendPlan: 'premium', price: 12.99, tokens: 500000, description: 'Plan CREATOR Mensual' },
  'creator_annual': { kind: 'plan', planKey: 'creator', backendPlan: 'premium', price: 109.00, tokens: 500000, description: 'Plan CREATOR Anual' },
  'pro_monthly': { kind: 'plan', planKey: 'pro', backendPlan: 'elite', price: 17.99, tokens: 800000, description: 'Plan PRO Mensual' },
  'pro_annual': { kind: 'plan', planKey: 'pro', backendPlan: 'elite', price: 149.00, tokens: 800000, description: 'Plan PRO Anual' }
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

  async getPayerData(userId) {
    if (!userId) return {};
    try {
      const result = await db.query(
        'SELECT email FROM users WHERE id = $1 LIMIT 1',
        [userId]
      );
      const email = String(result.rows?.[0]?.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) return {};
      return { email };
    } catch (error) {
      console.warn('[MERCADO_PAGO] Could not load payer data:', error.message);
      return {};
    }
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
      let quotedPlan = null;
      let chargedPrice = item.price;

      if (item.kind === 'plan') {
        quotedPlan = await subscriptionService.quotePlanChange(Number(userId), item.planKey, billingCycle);

        const shouldChargeNowForScheduledChange =
          quotedPlan.action === 'downgrade_next_cycle' && billingCycle === 'annual';

        if (['downgrade_next_cycle', 'billing_cycle_next_cycle'].includes(quotedPlan.action) && !shouldChargeNowForScheduledChange) {
          const scheduled = await subscriptionService.schedulePlanChange(Number(userId), item.planKey, billingCycle);
          return {
            success: true,
            action: quotedPlan.action,
            requiresPayment: false,
            message: 'Cambio de plan programado para el siguiente ciclo de facturación.',
            subscription: scheduled.subscription,
            quote: quotedPlan
          };
        }

        if (quotedPlan.action === 'already_on_plan') {
          return {
            success: true,
            action: quotedPlan.action,
            requiresPayment: false,
            message: 'Ya tienes este plan activo para el ciclo actual.',
            quote: quotedPlan
          };
        }

        chargedPrice = quotedPlan.payableAmountUsd;
        if (shouldChargeNowForScheduledChange && chargedPrice <= 0) {
          chargedPrice = item.price;
        }
      }

      const externalReference = item.kind === 'plan'
        ? `user_${userId}_plan_${item.planKey}_${billingCycle}`
        : `user_${userId}_tokens_${payload.tokensPackage}`;

      const isLocalFrontend = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(config.FRONTEND_URL || '');

      const payer = await this.getPayerData(userId);

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
            unit_price: chargedPrice,
            currency_id: 'MXN'
          }
        ],
        payer,
        back_urls: {
          success: `${config.FRONTEND_URL}?payment=success`,
          failure: `${config.FRONTEND_URL}?payment=failed`,
          pending: `${config.FRONTEND_URL}?payment=pending`
        },
        notification_url: `${config.BACKEND_URL}/api/mercadopago/webhook`,
        external_reference: externalReference,
        currency_id: 'MXN'
      };

      // Mercado Pago puede rechazar auto_return cuando back_urls usa localhost.
      if (!isLocalFrontend) {
        preferenceData.auto_return = 'approved';
      }

      // En credenciales TEST, forzar pruebas con tarjeta para evitar desvíos
      // a flujos de medios offline durante QA local.
      if (this.token?.startsWith('TEST-')) {
        preferenceData.payment_methods = {
          excluded_payment_types: [
            { id: 'ticket' },
            { id: 'atm' },
            { id: 'bank_transfer' }
          ],
          installments: 1,
          default_installments: 1
        };
      }


      const response = await axios.post(this.apiUrl, preferenceData, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        }
      });

      return {
        success: true,
        action: quotedPlan?.action || 'purchase',
        requiresPayment: true,
        quote: quotedPlan,
        preferenceId: response.data.id,
        // Usar init_point como URL principal incluso con credenciales TEST.
        // sandbox_init_point puede causar bucles de redirect/challenge en algunos flujos.
        initPoint: response.data.init_point || response.data.sandbox_init_point,
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

      // Idempotencia: no procesar el mismo pago dos veces
      const existing = await db.query(
        'SELECT id FROM transactions WHERE stripe_payment_id = $1',
        [String(paymentId)]
      );
      if (existing.rows.length > 0) {
        console.log(`[MERCADO_PAGO] Pago ${paymentId} ya fue procesado, ignorando.`);
        return { success: true, status: 'already_processed' };
      }

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

        const applied = await subscriptionService.applyPaidPlanChange({
          userId: Number(userId),
          planKey: item.planKey,
          billingCycle: parts[4]
        });

        const scheduledChange = ['downgrade_next_cycle', 'billing_cycle_next_cycle'].includes(applied.quote?.action);
        const tokensPurchased = scheduledChange ? 0 : item.tokens;

        await db.query(
          `INSERT INTO transactions (user_id, tokens_purchased, amount_usd, stripe_payment_id, status)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, tokensPurchased, payment.transaction_amount, paymentId, 'completed']
        );

        return {
          success: true,
          userId,
          plan: applied.subscription.backendPlan,
          newBalance: applied.subscription.tokens,
          tokensAdded: tokensPurchased,
          scheduled: scheduledChange,
          quote: applied.quote
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
