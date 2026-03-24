// Routes para pagos con Stripe

const express = require('express');
const router = express.Router();
const stripeService = require('../services/stripeService');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Middleware para verificar autenticación
const authMiddleware = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.userId = userId;
  next();
};

// POST - Crear sesión de checkout (redirige a Stripe)
router.post('/create-checkout', authMiddleware, async (req, res) => {
  try {
    const { tokensPackage } = req.body;

    if (!tokensPackage) {
      return res.status(400).json({ error: 'Missing tokensPackage' });
    }

    const session = await stripeService.createCheckoutSession(req.userId, tokensPackage);

    res.json({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET - Verificar estado de sesión de checkout
router.get('/verify-session/:sessionId', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === 'paid') {
      // Procesar el pago
      const result = await stripeService.handlePaymentSuccess(sessionId);
      return res.json({
        success: true,
        message: 'Pago completado',
        ...result
      });
    }

    res.json({
      success: false,
      status: session.payment_status,
      message: 'Pago no completado'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST - Webhook de Stripe (sin autenticación, verificar firma)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    // Procesar el evento
    await stripeService.handleWebhook(event);

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

// GET - Obtener historial de transacciones del usuario
router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const transactions = await stripeService.getUserTransactions(req.userId);
    res.json({ transactions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
