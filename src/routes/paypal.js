// Rutas de PayPal
import express from 'express';
import { createPaypalOrder, capturePaypalOrder } from '../services/paypalService.js';

const router = express.Router();

const authMiddleware = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  req.userId = userId;
  next();
};

// Crear orden de PayPal
router.post('/create-order', authMiddleware, async (req, res) => {
  try {
    const { tokensPackage } = req.body;
    if (!tokensPackage) return res.status(400).json({ error: 'Missing tokensPackage' });

    const result = await createPaypalOrder(req.userId, tokensPackage);
    res.json({ success: true, orderId: result.orderId, approvalUrl: result.approvalUrl });
  } catch (error) {
    console.error('[PAYPAL] Error creating order:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Capturar pago (después de que el usuario aprueba en PayPal)
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
