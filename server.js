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
import statsRoutes from './src/routes/stats.js';
import banRoutes from './src/routes/bans.js';
import nickRoutes from './src/routes/nicks.js';
import botRoutes from './src/routes/bot.js';
import adminRoutes from './src/routes/admin.js';
import couponRoutes from './src/routes/coupons.js';

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

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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
      -- Auth hardening columns for email verification flow
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT FALSE;
      UPDATE users SET email_verified = TRUE WHERE email_verified IS NULL;
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
      -- Pending email verifications (register + verify-email flow)
      CREATE TABLE IF NOT EXISTS email_verifications (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        code VARCHAR(10) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        attempts INT DEFAULT 0,
        max_attempts INT DEFAULT 5,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      -- Ensure auth-required columns exist even if table was created by an older schema
      DO $$ BEGIN
        ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS email VARCHAR(255);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS code VARCHAR(10);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS max_attempts INT DEFAULT 5;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      ALTER TABLE email_verifications ALTER COLUMN attempts SET DEFAULT 0;
      ALTER TABLE email_verifications ALTER COLUMN max_attempts SET DEFAULT 5;
      ALTER TABLE email_verifications ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
      CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(email);
      CREATE INDEX IF NOT EXISTS idx_email_verifications_expires_at ON email_verifications(expires_at);
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
      -- Banned users (para persistir bans entre streams)
      CREATE TABLE IF NOT EXISTS banned_users (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        banned_username VARCHAR(255) NOT NULL,
        reason VARCHAR(500),
        banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        banned_by VARCHAR(255) NOT NULL,
        UNIQUE(user_id, banned_username)
      );
      CREATE INDEX IF NOT EXISTS idx_banned_users_user ON banned_users(user_id);
      -- Nick overrides (para persistir nicks editados entre streams)
      CREATE TABLE IF NOT EXISTS nick_overrides (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        original_username VARCHAR(255) NOT NULL,
        new_nickname VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, original_username)
      );
      CREATE INDEX IF NOT EXISTS idx_nick_overrides_user ON nick_overrides(user_id);
      -- Bot characters (custom AI characters para cada usuario)
      CREATE TABLE IF NOT EXISTS bot_characters (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        system_prompt TEXT NOT NULL,
        voice_id VARCHAR(255),
        avatar_url VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_bot_characters_user_id ON bot_characters(user_id);
      -- Bot moderation log (registro de acciones de moderación ejecutadas por bot)
      CREATE TABLE IF NOT EXISTS bot_moderations_log (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action_type VARCHAR(50) NOT NULL,
        target_username VARCHAR(255) NOT NULL,
        reason TEXT,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(50) DEFAULT 'executed'
      );
      CREATE INDEX IF NOT EXISTS idx_bot_moderations_log_user_id ON bot_moderations_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_bot_moderations_log_executed ON bot_moderations_log(executed_at);
      -- Admin role
      UPDATE users SET role = 'admin' WHERE email = 'alainsh@gmail.com';
      -- Last seen for online tracking
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP;

      -- ===== COUPON SYSTEM =====
      CREATE TABLE IF NOT EXISTS coupons (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        internal_name VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(20) DEFAULT 'draft',
        discount_type VARCHAR(20) NOT NULL,
        discount_value DECIMAL(10,2) NOT NULL,
        max_discount DECIMAL(10,2),
        min_purchase DECIMAL(10,2) DEFAULT 0,
        max_uses_total INT,
        max_uses_per_user INT DEFAULT 1,
        uses_count INT DEFAULT 0,
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        applies_to VARCHAR(50) DEFAULT 'all',
        applicable_products TEXT[] DEFAULT '{}',
        eligible_user_type VARCHAR(50) DEFAULT 'all',
        eligible_user_ids INT[] DEFAULT '{}',
        first_purchase_only BOOLEAN DEFAULT FALSE,
        once_per_email BOOLEAN DEFAULT FALSE,
        once_per_phone BOOLEAN DEFAULT FALSE,
        compatible_with_others BOOLEAN DEFAULT TRUE,
        limit_per_ip INT,
        limit_per_device INT,
        limit_per_card INT,
        campaign VARCHAR(255),
        priority INT DEFAULT 0,
        scheduled_activate_at TIMESTAMP,
        scheduled_deactivate_at TIMESTAMP,
        created_by INT REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);
      CREATE INDEX IF NOT EXISTS idx_coupons_status ON coupons(status);
      CREATE INDEX IF NOT EXISTS idx_coupons_campaign ON coupons(campaign);

      CREATE TABLE IF NOT EXISTS coupon_redemptions (
        id SERIAL PRIMARY KEY,
        coupon_id INT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        transaction_id INT REFERENCES transactions(id),
        discount_applied DECIMAL(10,2) NOT NULL,
        original_amount DECIMAL(10,2) NOT NULL,
        final_amount DECIMAL(10,2) NOT NULL,
        status VARCHAR(20) DEFAULT 'applied',
        ip_address VARCHAR(45),
        user_agent TEXT,
        redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        reverted_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon ON coupon_redemptions(coupon_id);
      CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user ON coupon_redemptions(user_id);
      CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_status ON coupon_redemptions(status);

      CREATE TABLE IF NOT EXISTS coupon_audit_log (
        id SERIAL PRIMARY KEY,
        coupon_id INT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
        action VARCHAR(50) NOT NULL,
        changed_by INT REFERENCES users(id),
        old_values JSONB,
        new_values JSONB,
        ip_address VARCHAR(45),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_coupon_audit_log_coupon ON coupon_audit_log(coupon_id);

      CREATE TABLE IF NOT EXISTS coupon_failed_attempts (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        code_attempted VARCHAR(100),
        reason VARCHAR(255),
        ip_address VARCHAR(45),
        user_agent TEXT,
        attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_coupon_failed_attempts_ip ON coupon_failed_attempts(ip_address);
      CREATE INDEX IF NOT EXISTS idx_coupon_failed_attempts_user ON coupon_failed_attempts(user_id);
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
  app.use('/api', statsRoutes);
  console.log('[STARTUP] ✓ Stats routes loaded');
  app.use('/api', banRoutes);
  console.log('[STARTUP] ✓ Ban routes loaded');
  app.use('/api', nickRoutes);
  console.log('[STARTUP] ✓ Nick override routes loaded');
  app.use('/api/bot', botRoutes);
  console.log('[STARTUP] ✓ Bot routes loaded');
  app.use('/api/admin', adminRoutes);
  console.log('[STARTUP] ✓ Admin routes loaded');
  app.use('/api/coupons', couponRoutes);
  console.log('[STARTUP] ✓ Coupon routes loaded');
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
