// Servicio de Mercado Pago para pagos

import MercadoPago from 'mercadopago';
import db from '../db.js';
import { config } from '../../config.js';

class MercadoPagoService {
  constructor() {
    // Inicializar SDK de Mercado Pago
    try {
      if (!config.MERCADO_PAGO_ACCESS_TOKEN) {
        console.warn('[MERCADO_PAGO] ⚠️  Access token not configured. Payments will not work.');
        console.warn('[MERCADO_PAGO] Please set MERCADO_PAGO_ACCESS_TOKEN environment variable');
      } else {
        MercadoPago.configure({
          access_token: config.MERCADO_PAGO_ACCESS_TOKEN
        });
        console.log('[MERCADO_PAGO] ✓ Service initialized with access token');
      }
    } catch (error) {
      console.error('[MERCADO_PAGO] ✗ Failed to initialize:', error.message);
    }
  }

  // Crear preferencia de pago (checkout)
  async createPaymentPreference(userId, tokensPackage) {
    try {
      console.log('[MERCADO_PAGO] Creating preference for userId:', userId, 'package:', tokensPackage);

      const packages = {
        500: { price: 4.99, tokens: 500, description: '500 Tokens' },
        1000: { price: 8.99, tokens: 1000, description: '1000 Tokens (Popular)' },
        5000: { price: 39.99, tokens: 5000, description: '5000 Tokens' }
      };

      const pkg = packages[tokensPackage];
      if (!pkg) {
        throw new Error('Invalid token package');
      }

      const preference = {
        items: [
          {
            id: `tokens_${tokensPackage}`,
            title: `VoltVoice - ${pkg.description}`,
            description: `Compra ${tokensPackage} tokens para sintetizar voces`,
            quantity: 1,
            unit_price: pkg.price,
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
        external_reference: `user_${userId}_tokens_${tokensPackage}`
      };

      console.log('[MERCADO_PAGO] Calling preferences.create...');
      const response = await MercadoPago.preferences.create(preference);
      console.log('[MERCADO_PAGO] Response received:', response.body);

      return {
        success: true,
        preferenceId: response.body.id,
        initPoint: response.body.init_point,
        sandboxInitPoint: response.body.sandbox_init_point
      };
    } catch (error) {
      console.error('[MERCADO_PAGO] ✗ Error creating payment preference');
      console.error('[MERCADO_PAGO] Error message:', error.message);
      console.error('[MERCADO_PAGO] Error stack:', error.stack);
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

      // Obtener detalles del pago
      const paymentInfo = await MercadoPago.payment.findById(paymentId);

      if (paymentInfo.body.status === 'approved') {
        // Pago aprobado
        const externalReference = paymentInfo.body.external_reference;
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
          paymentInfo.body.transaction_amount,
          paymentId,
          'completed'
        ]);

        return {
          success: true,
          userId: userId,
          tokensAdded: tokens,
          newBalance: result.rows[0].tokens
        };
      } else if (paymentInfo.body.status === 'pending') {
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
