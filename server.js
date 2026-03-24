import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from './config.js';

// Routes (Web version)
import tokenRoutes from './src/routes/tokens.js';
import synthesisRoutes from './src/routes/synthesis.js';
import mercadoPagoRoutes from './src/routes/mercadoPago.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// ===== MIDDLEWARE =====
app.use(cors({
  origin: config.FRONTEND_URL,
  credentials: true,
}));

app.use(express.json());
app.use(express.static(join(__dirname, '../frontend/public')));

// Logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ===== ROUTES =====
console.log('[STARTUP] Loading routes...');
try {
  app.use('/api/tokens', tokenRoutes);
  console.log('[STARTUP] ✓ Token routes loaded');
  app.use('/api/synthesis', synthesisRoutes);
  console.log('[STARTUP] ✓ Synthesis routes loaded');
  app.use('/api/mercadopago', mercadoPagoRoutes);
  console.log('[STARTUP] ✓ Mercado Pago routes loaded');
} catch (err) {
  console.error('[STARTUP] ✗ Error loading routes:', err.message);
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'VoltVoice Web Backend',
    status: 'running',
    timestamp: new Date().toISOString(),
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({
    error: config.isDevelopment ? err.message : 'Internal server error'
  });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 8000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════╗
║   🔊 VoltVoice Web Backend Started   ║
╠══════════════════════════════════════╣
║ Server: http://0.0.0.0:${PORT}
║ Env: ${config.NODE_ENV}
║ Frontend: ${config.FRONTEND_URL}
╚══════════════════════════════════════╝
  `);
});
