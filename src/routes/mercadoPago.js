// Routes para pagos con Mercado Pago

import crypto from 'crypto';
import express from 'express';
import mercadoPagoService from '../services/mercadoPagoService.js';
import { verifyToken } from '../../middleware/auth.js';
import { config } from '../../config.js';
import monitoring from '../services/monitoring.js';

function verifyMercadoPagoSignature(req) {
  const secret = config.MERCADO_PAGO_WEBHOOK_SECRET;
  if (!secret) return true; // omitir si aún no está configurado

  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];

  if (!xSignature || !xRequestId) return false;

  const parts = {};
  xSignature.split(',').forEach(part => {
    const [k, v] = part.trim().split('=');
    if (k && v) parts[k] = v;
  });

  const ts = parts['ts'];
  const v1 = parts['v1'];
  if (!ts || !v1) return false;

  const dataId = req.body?.data?.id;
  if (!dataId) return false;

  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'));
  } catch {
    return false;
  }
}

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

    if (preference.requiresPayment === false) {
      return res.json({
        success: true,
        requiresPayment: false,
        action: preference.action,
        message: preference.message,
        subscription: preference.subscription,
        quote: preference.quote
      });
    }

    const tokenLooksTest = String(config.MERCADO_PAGO_ACCESS_TOKEN || '').startsWith('TEST-');
    const preferSandboxCheckout = Boolean(preference.sandboxInitPoint) && tokenLooksTest;

    return res.json({
      success: true,
      requiresPayment: true,
      action: preference.action,
      quote: preference.quote,
      preferenceId: preference.preferenceId,
      // Elegir checkout por tipo de credencial, no por localhost.
      // TEST-* -> sandbox, APP_USR-* -> init_point normal.
      checkoutUrl: preferSandboxCheckout ? preference.sandboxInitPoint : preference.initPoint,
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
    if (!verifyMercadoPagoSignature(req)) {
      console.warn('[MERCADO_PAGO] Webhook rechazado: firma inválida');
      return res.status(401).json({ error: 'Invalid signature' });
    }

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

// POST - Reconciliar pagos aprobados cuando webhook no llegó (útil en local)
router.post('/reconcile', authMiddleware, async (req, res) => {
  try {
    const result = await mercadoPagoService.reconcileUserPayments(req.userId);
    return res.json(result);
  } catch (error) {
    console.error('[MERCADO_PAGO_ROUTE] Reconcile error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
