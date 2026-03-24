// Servicio de Mercado Pago para pagos

import MercadoPago from 'mercadopago';
import db from '../db.js';

class MercadoPagoService {
  constructor() {
    // Inicializar SDK de Mercado Pago
    MercadoPago.configure({
      access_token: process.env.MERCADO_PAGO_ACCESS_TOKEN
    });
  }

  // Crear preferencia de pago (checkout)
  async createPaymentPreference(userId, tokensPackage) {
    try {
      const packages = {
        500: { price: 49, tokens: 500, description: '500 Tokens' },
        1000: { price: 89, tokens: 1000, description: '1000 Tokens (Popular)' },
        5000: { price: 399, tokens: 5000, description: '5000 Tokens' }
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
            currency_id: 'MXN' // Pesos mexicanos
          }
        ],
        payer: {
          email: `user_${userId}@voltvoice.com` // Email placeholder
        },
        back_urls: {
          success: `${process.env.FRONTEND_URL}/app?payment=success`,
          failure: `${process.env.FRONTEND_URL}/app?payment=failed`,
          pending: `${process.env.FRONTEND_URL}/app?payment=pending`
        },
        auto_return: 'approved',
        notification_url: `${process.env.BACKEND_URL}/api/payments/webhook`,
        external_reference: `user_${userId}_tokens_${tokensPackage}`,
        metadata: {
          userId: userId,
          tokensPackage: tokensPackage,
          tokens: pkg.tokens
        }
      };

      const response = await MercadoPago.preferences.create(preference);

      return {
        success: true,
        preferenceId: response.body.id,
        initPoint: response.body.init_point, // URL para redirigir a MP
        sandboxInitPoint: response.body.sandbox_init_point
      };
    } catch (error) {
      console.error('Error creating payment preference:', error);
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
