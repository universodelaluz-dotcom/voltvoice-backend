// Routes para pagos con Mercado Pago

import express from 'express';
import mercadoPagoService from '../services/mercadoPagoService.js';
import { verifyToken } from '../../middleware/auth.js';

const router = express.Router();

// Middleware para verificar autenticación (JWT obligatorio)
const authMiddleware = (req, res, next) => {
  return verifyToken(req, res, () => {
    req.userId = req.user.userId;
    next();
  });
};

// POST - Crear preferencia de pago (checkout)
router.post('/create-preference', authMiddleware, async (req, res) => {
  try {
    const { tokensPackage, planId, billingCycle, itemType, couponCode, couponId } = req.body;

    if (!tokensPackage && !planId) {
      return res.status(400).json({ error: 'Missing checkout item' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress;
    const preference = await mercadoPagoService.createPaymentPreference(
      req.userId,
      { tokensPackage, planId, billingCycle, itemType, couponCode, couponId },
      ip
    );

    res.json({
      success: true,
      preferenceId: preference.preferenceId,
      checkoutUrl: preference.initPoint,
      sandboxUrl: preference.sandboxInitPoint,
      couponApplied: preference.couponApplied || null
    });
  } catch (error) {
    console.error('[MERCADO_PAGO_ROUTE] Error:', error.message);
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
