// Servicio de Mercado Pago para pagos

import axios from 'axios';
import db from '../db.js';
import { config } from '../../config.js';

class MercadoPagoService {
  constructor() {
    this.apiUrl = 'https://api.mercadopago.com/checkout/preferences';
    this.token = config.MERCADO_PAGO_ACCESS_TOKEN;

    if (!this.token) {
      console.warn('[MERCADO_PAGO] ⚠️  Access token not configured. Payments will not work.');
    } else {
      console.log('[MERCADO_PAGO] ✓ Service initialized');
    }
  }

  // Crear preferencia de pago (checkout)
  async createPaymentPreference(userId, tokensPackage) {
    try {
      console.log('[MERCADO_PAGO] Creating preference for userId:', userId, 'package:', tokensPackage);

      if (!this.token) {
        throw new Error('MERCADO_PAGO_ACCESS_TOKEN is not configured');
      }

      const packages = {
        500: { price: 4.99, tokens: 500, description: '500 Tokens' },
        1000: { price: 8.99, tokens: 1000, description: '1000 Tokens (Popular)' },
        5000: { price: 39.99, tokens: 5000, description: '5000 Tokens' }
      };

      const pkg = packages[tokensPackage];
      if (!pkg) {
        throw new Error('Invalid token package');
      }

      const preferenceData = {
        items: [
          {
            id: `tokens_${tokensPackage}`,
            title: `VoltVoice - ${pkg.description}`,
            description: `Compra ${tokensPackage} tokens para sintetizar voces`,
            quantity: 1,
            unit_price: pkg.price
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
        external_reference: `user_${userId}_tokens_${tokensPackage}`
      };

      console.log('[MERCADO_PAGO] Sending request to Mercado Pago API...');

      const response = await axios.post(this.apiUrl, preferenceData, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        }
      });

      console.log('[MERCADO_PAGO] ✓ Preference created successfully');
      console.log('[MERCADO_PAGO] Preference ID:', response.data.id);

      return {
        success: true,
        preferenceId: response.data.id,
        initPoint: response.data.init_point,
        sandboxInitPoint: response.data.sandbox_init_point
      };
    } catch (error) {
      console.error('[MERCADO_PAGO] ✗ Error creating payment preference');
      console.error('[MERCADO_PAGO] Error message:', error.message);
      if (error.response) {
        console.error('[MERCADO_PAGO] Response status:', error.response.status);
        console.error('[MERCADO_PAGO] Response data:', error.response.data);
      }
      throw error;
    }
  }

  // Procesar notificación de pago (webhook)
  async handlePaymentNotification(paymentData) {
    try {
      const paymentId = paymentData.data.id;

      // Obtener detalles del pago desde Mercado Pago
      const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      const payment = response.data;

      if (payment.status === 'approved') {
        // Pago aprobado
        const externalReference = payment.external_reference;
        const [, userId, , tokensStr] = externalReference.split('_');
        const tokens = parseInt(tokensStr);

        // Agregar tokens al usuario
        const updateQuery = `
          UPDATE users
          SET tokens = tokens + $1
          WHERE id = $2
          RETURNING tokens
        `;
        const result = await db.query(updateQuery, [tokens, userId]);

        // Registrar transacción
        const transactionQuery = `
          INSERT INTO transactions (user_id, tokens_purchased, amount_usd, stripe_payment_id, status)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `;
        await db.query(transactionQuery, [
          userId,
          tokens,
          payment.transaction_amount,
          paymentId,
          'completed'
        ]);

        return {
          success: true,
          userId: userId,
          tokensAdded: tokens,
          newBalance: result.rows[0].tokens
        };
      } else if (payment.status === 'pending') {
        console.log('Pago pendiente:', paymentId);
        return { success: false, status: 'pending' };
      } else {
        console.log('Pago rechazado:', paymentId);
        return { success: false, status: 'rejected' };
      }
    } catch (error) {
      console.error('Error processing payment:', error);
      throw error;
    }
  }

  // Obtener transacciones del usuario
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
