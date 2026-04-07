// Servicio de Stripe para pagos

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../db');

class StripeService {
  // Crear sesión de checkout para comprar tokens
  async createCheckoutSession(userId, tokensPackage) {
    try {
      const packages = {
        150000: { price: 499, tokens: 150000 },
        350000: { price: 999, tokens: 350000 },
        700000: { price: 1499, tokens: 700000 }
      };

      const pkg = packages[tokensPackage];
      if (!pkg) {
        throw new Error('Invalid token package');
      }

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: `VoltVoice - ${tokensPackage} Tokens`,
                description: `Compra ${tokensPackage} tokens para sintetizar voces`,
              },
              unit_amount: pkg.price,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: `${process.env.FRONTEND_URL}/app?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.FRONTEND_URL}/app?payment=cancelled`,
        metadata: {
          userId: userId,
          tokensPackage: tokensPackage,
          tokens: pkg.tokens
        }
      });

      return session;
    } catch (error) {
      console.error('Error creating checkout session:', error);
      throw error;
    }
  }

  // Verificar y procesar el pago completado
  async handlePaymentSuccess(sessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status === 'paid') {
        const userId = session.metadata.userId;
        const tokens = parseInt(session.metadata.tokens);

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
        const transactionResult = await db.query(transactionQuery, [
          userId,
          tokens,
          session.amount_total / 100, // Stripe usa centavos
          sessionId,
          'completed'
        ]);

        return {
          success: true,
          userId: userId,
          tokensAdded: tokens,
          newBalance: result.rows[0].tokens,
          transaction: transactionResult.rows[0]
        };
      }

      throw new Error('Payment not completed');
    } catch (error) {
      console.error('Error processing payment:', error);
      throw error;
    }
  }

  // Webhook para procesar pagos (async)
  async handleWebhook(event) {
    try {
      switch (event.type) {
        case 'checkout.session.completed':
          const session = event.data.object;
          return await this.handlePaymentSuccess(session.id);

        case 'payment_intent.payment_failed':
          console.log('Payment failed:', event.data.object);
          break;

        default:
          console.log('Unhandled event type:', event.type);
      }
    } catch (error) {
      console.error('Error handling webhook:', error);
      throw error;
    }
  }

  // Obtener transacciones de un usuario
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

module.exports = new StripeService();
