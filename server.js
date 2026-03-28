import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';
import { config } from './config.js';

// Routes (Web version)
import tokenRoutes from './src/routes/tokens.js';
import synthesisRoutes from './src/routes/synthesis.js';
import mercadoPagoRoutes from './src/routes/mercadoPago.js';
import paypalRoutes from './src/routes/paypal.js';
import tiktokRoutes from './src/routes/tiktok.js';
import inworldRoutes from './src/routes/inworld.js';
import ttsRoutes from './src/routes/tts.js';
import authRoutes from './src/routes/auth.js';
import settingsRoutes from './src/routes/settings.js';

// WebSocket
import websocketServer from './src/services/websocketServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// ===== MIDDLEWARE =====
// CORS configuration - allow frontend and any Vercel preview deployments
const allowedOrigins = [
  config.FRONTEND_URL,
  'https://landing-page-zeta-two-23.vercel.app', // Old deployment
  'https://voltvoice-frontend.vercel.app', // New deployment
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin || allowedOrigins.includes(origin) || origin.includes('vercel.app')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json());
app.use(express.static(join(__dirname, '../frontend/public')));

// Handle preflight requests
app.options('*', cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || origin.includes('vercel.app')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ===== AUTO-MIGRATE DATABASE =====
import pool from './src/db.js';
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        plan VARCHAR(50) DEFAULT 'free',
        tokens INT DEFAULT 100,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      -- Add password_hash column if table exists but column doesn't
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      -- User settings (config por usuario)
      CREATE TABLE IF NOT EXISTS user_settings (
        id SERIAL PRIMARY KEY,
        user_id INT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        config JSONB DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      -- User voices (voces clonadas por usuario)
      CREATE TABLE IF NOT EXISTS user_voices (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        voice_name VARCHAR(255) NOT NULL,
        voice_id VARCHAR(255) NOT NULL,
        provider VARCHAR(50) DEFAULT 'inworld',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, voice_name)
      );
      CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_voices_user ON user_voices(user_id);
      CREATE TABLE IF NOT EXISTS token_logs (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id),
        action VARCHAR(255),
        tokens_used INT,
        characters_count INT,
        voice_name VARCHAR(255),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id),
        tokens_purchased INT,
        amount_usd DECIMAL(10, 2),
        stripe_payment_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] ✓ Auto-migration completed');
  } catch (err) {
    console.error('[DB] Migration error:', err.message);
  }
})();

// ===== ROUTES =====
console.log('[STARTUP] Loading routes...');
try {
  app.use('/api/tokens', tokenRoutes);
  console.log('[STARTUP] ✓ Token routes loaded');
  app.use('/api/synthesis', synthesisRoutes);
  console.log('[STARTUP] ✓ Synthesis routes loaded');
  app.use('/api/mercadopago', mercadoPagoRoutes);
  console.log('[STARTUP] ✓ Mercado Pago routes loaded');
  app.use('/api/paypal', paypalRoutes);
  console.log('[STARTUP] ✓ PayPal routes loaded');
  app.use('/api/tiktok', tiktokRoutes);
  console.log('[STARTUP] ✓ TikTok routes loaded');
  app.use('/api/inworld', inworldRoutes);
  console.log('[STARTUP] ✓ Inworld routes loaded');
  app.use('/api/tts', ttsRoutes);
  console.log('[STARTUP] ✓ TTS (Google) routes loaded');
  app.use('/api/auth', authRoutes);
  console.log('[STARTUP] ✓ Auth routes loaded');
  app.use('/api/settings', settingsRoutes);
  console.log('[STARTUP] ✓ Settings routes loaded');
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
    version: 'REST-API-v1',
    mercadoPagoConfigured: !!config.MERCADO_PAGO_ACCESS_TOKEN,
    paypalConfigured: !!config.PAYPAL_CLIENT_ID
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
const server = createServer(app);

// Inicializar WebSocket
websocketServer.initialize(server);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════╗
║   🔊 VoltVoice Web Backend Started   ║
╠══════════════════════════════════════╣
║ Server: http://0.0.0.0:${PORT}
║ WebSocket: ws://0.0.0.0:${PORT}/api/tiktok/ws
║ Env: ${config.NODE_ENV}
║ Frontend: ${config.FRONTEND_URL}
╚══════════════════════════════════════╝
  `);
});
