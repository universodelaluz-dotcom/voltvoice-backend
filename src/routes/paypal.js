// Rutas de PayPal
import express from 'express';
import { createPaypalOrder, capturePaypalOrder } from '../services/paypalService.js';
import { config } from '../config.js';
import { verifyToken } from '../../middleware/auth.js';

const router = express.Router();

const authMiddleware = (req, res, next) => {
  if (req.headers.authorization) {
    return verifyToken(req, res, () => {
      req.userId = req.user.userId;
      next();
    });
  }

  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  req.userId = userId;
  next();
};

// GET - Obtener Client ID público (para cargar PayPal SDK en frontend)
router.get('/client-id', (req, res) => {
  const clientId = config.PAYPAL_CLIENT_ID;
  const mode = config.PAYPAL_MODE || 'sandbox';
  if (!clientId) return res.status(500).json({ error: 'PayPal not configured' });
  res.json({ clientId, mode });
});

// Crear orden de PayPal (el frontend la crea via SDK popup)
router.post('/create-order', authMiddleware, async (req, res) => {
  try {
    const { tokensPackage, planId, billingCycle, itemType } = req.body;
    if (!tokensPackage && !planId) return res.status(400).json({ error: 'Missing checkout item' });

    const result = await createPaypalOrder(req.userId, { tokensPackage, planId, billingCycle, itemType });
    res.json({ success: true, orderId: result.orderId, approvalUrl: result.approvalUrl });
  } catch (error) {
    console.error('[PAYPAL] Error creating order:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Capturar pago (después de que el usuario aprueba en el popup)
router.post('/capture-order', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

    const result = await capturePaypalOrder(orderId);
    res.json({ success: true, result });
  } catch (error) {
    console.error('[PAYPAL] Error capturing order:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
