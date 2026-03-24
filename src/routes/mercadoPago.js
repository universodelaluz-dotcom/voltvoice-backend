// Routes para pagos con Mercado Pago

import express from 'express';
import mercadoPagoService from '../services/mercadoPagoService.js';

const router = express.Router();

// Middleware para verificar autenticación
const authMiddleware = (req, res, next) => {
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
    const { tokensPackage } = req.body;

    if (!tokensPackage) {
      return res.status(400).json({ error: 'Missing tokensPackage' });
    }

    const preference = await mercadoPagoService.createPaymentPreference(
      req.userId,
      tokensPackage
    );

    res.json({
      success: true,
      preferenceId: preference.preferenceId,
      // Usar init_point para producción, sandbox_init_point para testing
      checkoutUrl: preference.initPoint,
      sandboxUrl: preference.sandboxInitPoint
    });
  } catch (error) {
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

// GET - Demo checkout (for testing without Mercado Pago token)
router.get('/demo-checkout', (req, res) => {
  const { preference, user, tokens } = req.query;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>VoltVoice - Demo Checkout</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 12px;
          box-shadow: 0 10px 40px rgba(0,0,0,0.3);
          padding: 40px;
          max-width: 500px;
          width: 100%;
          text-align: center;
        }
        .logo {
          font-size: 48px;
          margin-bottom: 20px;
        }
        h1 {
          color: #333;
          font-size: 28px;
          margin-bottom: 15px;
        }
        .badge {
          background: #fff3cd;
          color: #856404;
          padding: 10px 15px;
          border-radius: 6px;
          margin-bottom: 20px;
          font-size: 14px;
        }
        .order-summary {
          background: #f8f9fa;
          padding: 20px;
          border-radius: 8px;
          margin-bottom: 30px;
          text-align: left;
        }
        .order-summary p {
          margin: 8px 0;
          color: #666;
        }
        .order-summary strong {
          color: #333;
        }
        .success-btn, .cancel-btn {
          padding: 12px 30px;
          border: none;
          border-radius: 6px;
          font-size: 16px;
          cursor: pointer;
          margin: 10px;
          transition: all 0.3s ease;
        }
        .success-btn {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
        }
        .success-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
        }
        .cancel-btn {
          background: #e9ecef;
          color: #495057;
        }
        .cancel-btn:hover {
          background: #dee2e6;
        }
        .footer {
          margin-top: 20px;
          font-size: 12px;
          color: #999;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">🎵</div>
        <h1>Checkout VoltVoice</h1>
        <div class="badge">⚠️ Modo Demo - No se realizará cargo</div>

        <div class="order-summary">
          <p><strong>Tokens:</strong> ${tokens}</p>
          <p><strong>Usuario ID:</strong> ${user}</p>
          <p><strong>Estado:</strong> Listo para procesar</p>
        </div>

        <button class="success-btn" onclick="completePayment()">✓ Confirmar Pago</button>
        <button class="cancel-btn" onclick="cancelPayment()">✗ Cancelar</button>

        <div class="footer">
          <p>Este es un ambiente de prueba</p>
        </div>
      </div>

      <script>
        function completePayment() {
          window.location.href = '${process.env.FRONTEND_URL || 'http://localhost:3000'}?payment=success&preference=${preference}';
        }

        function cancelPayment() {
          window.location.href = '${process.env.FRONTEND_URL || 'http://localhost:3000'}?payment=failed&preference=${preference}';
        }
      </script>
    </body>
    </html>
  `);
});

export default router;
