// Routes para pagos con Mercado Pago

import express from 'express';
import mercadoPagoService from '../services/mercadoPagoService.js';
import { verifyToken } from '../../middleware/auth.js';
import { config } from '../../config.js';
import monitoring from '../services/monitoring.js';

const router = express.Router();

// Middleware para verificar autenticación
const authMiddleware = (req, res, next) => {
  const hasAuthHeader = Boolean(req.headers.authorization);
  const hasAuthCookie = String(req.headers.cookie || '').includes(`${config.AUTH_COOKIE_NAME}=`);
  if (hasAuthHeader || hasAuthCookie) {
    return verifyToken(req, res, () => {
      req.userId = req.user.userId;
      next();
    });
  }

  if (config.isProduction) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.userId = userId;
  next();
};

// POST - Crear preferencia de pago (checkout)
router.post('/create-preference', authMiddleware, async (req, res) => {
  try {
    const { tokensPackage, planId, billingCycle, itemType } = req.body;

    if (!tokensPackage && !planId) {
      return res.status(400).json({ error: 'Missing checkout item' });
    }

    const preference = await mercadoPagoService.createPaymentPreference(
      req.userId,
      { tokensPackage, planId, billingCycle, itemType }
    );

    res.json({
      success: true,
      preferenceId: preference.preferenceId,
      // Usar init_point para producción, sandbox_init_point para testing
      checkoutUrl: preference.initPoint,
      sandboxUrl: preference.sandboxInitPoint
    });
  } catch (error) {
    console.error('[MERCADO_PAGO_ROUTE] Error:', error.message);
    monitoring.recordPaymentFailure({
      provider: 'mercado_pago',
      action: 'create_preference',
      errorMessage: error.message,
      userId: req.userId,
    });
    res.status(500).json({ error: error.message });
  }
});

// POST - Webhook de Mercado Pago (sin autenticación)
router.post('/webhook', express.json(), async (req, res) => {
  try {
    // Mercado Pago envía notificaciones en query params
    const { type, data } = req.body;

    if (type === 'payment') {
      const result = await mercadoPagoService.handlePaymentNotification({ data });

      if (result.success) {
        res.json({ success: true, message: 'Payment processed' });
      } else {
        res.json({ success: false, status: result.status });
      }
    } else {
      res.json({ received: true });
    }
  } catch (error) {
    console.error('Webhook error:', error);
    monitoring.recordPaymentFailure({
      provider: 'mercado_pago',
      action: 'webhook',
      errorMessage: error.message,
      userId: null,
    });
    res.status(400).json({ error: error.message });
  }
});

// GET - Obtener historial de transacciones
router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const transactions = await mercadoPagoService.getUserTransactions(req.userId);
    res.json({ transactions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
