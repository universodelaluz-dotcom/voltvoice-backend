import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
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
import opsRoutes from './src/routes/ops.js';
import supportRoutes from './src/routes/support.js';

// WebSocket
import websocketServer from './src/services/websocketServer.js';
import monitoring from './src/services/monitoring.js';
import inactiveUserCleanupService from './src/services/inactiveUserCleanupService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
if (config.TRUST_PROXY) app.set('trust proxy', 1);

const parseCookieHeader = (cookieHeader = '') => {
  if (!cookieHeader || typeof cookieHeader !== 'string') return {};
  return cookieHeader.split(';').reduce((acc, pair) => {
    const index = pair.indexOf('=');
    if (index < 0) return acc;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key) return acc;
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
};

const resolveAuthUserId = (req) => {
  const directUserId = Number(req?.user?.userId || req?.user?.id);
  if (Number.isFinite(directUserId) && directUserId > 0) return directUserId;

  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';

  const cookieToken = parseCookieHeader(req.headers.cookie || '')[config.AUTH_COOKIE_NAME] || '';
  const token = bearerToken || cookieToken;
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    const userId = Number(decoded?.userId || decoded?.id);
    return Number.isFinite(userId) && userId > 0 ? userId : null;
  } catch {
    return null;
  }
};

// ===== MIDDLEWARE =====
// Serve static files FIRST (before CORS and other middleware)
app.use(express.static(join(__dirname, './public')));

// CORS configuration - allow frontend and any Vercel preview deployments
const allowedOrigins = [
  config.FRONTEND_URL,
  'https://landing-page-zeta-two-23.vercel.app', // Old deployment
  'https://voltvoice-frontend.vercel.app', // New deployment
  'http://localhost:5173', // Local development
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Remover cualquier CSP header para desarrollo
app.use((req, res, next) => {
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('Content-Security-Policy-Report-Only');
  next();
});

// Helmet deshabilitado en desarrollo para permitir Google OAuth y APIs externas
if (config.NODE_ENV !== 'development') {
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
}


const globalLimiter = rateLimit({
  windowMs: config.GLOBAL_RATE_LIMIT_WINDOW_MS,
  max: config.GLOBAL_RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    monitoring.recordRateLimit({ path: req.path, ip: req.ip });
    return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' });
  },
});
app.use(globalLimiter);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
  const startedAt = Date.now();
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && body.error) {
      res.locals.responseError = String(body.error).slice(0, 500);
    }
    return originalJson(body);
  };

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    monitoring.recordRequest({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs,
    });

    if (req.path.startsWith('/api/')) {
      const authUserId = resolveAuthUserId(req);
      const errorMessage = res.locals.responseError || (res.statusCode >= 500 ? 'internal_server_error' : null);
      pool.query(
        `INSERT INTO api_request_logs
         (user_id, method, path, status_code, duration_ms, ip_address, user_agent, error_message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          authUserId,
          req.method,
          String(req.originalUrl || req.path || '').slice(0, 500),
          res.statusCode,
          durationMs,
          (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0, 80),
          String(req.headers['user-agent'] || '').slice(0, 500),
          errorMessage ? String(errorMessage).slice(0, 500) : null
        ]
      ).catch(() => {});
    }
  });
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
      -- Ensure plan is always valid VARCHAR (reset corrupted/integer values to 'free')
      UPDATE users SET plan = 'free' WHERE plan IS NULL OR plan = '' OR plan ~ '^[0-9]+$';
      DO $$ BEGIN
        ALTER TABLE users ALTER COLUMN plan TYPE VARCHAR(50);
        ALTER TABLE users ALTER COLUMN plan SET DEFAULT 'free';
      EXCEPTION WHEN others THEN NULL;
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

      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        code_hash VARCHAR(64) NOT NULL,
        attempts INT DEFAULT 0,
        max_attempts INT DEFAULT 5,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        request_ip VARCHAR(80),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_password_resets_email ON password_resets(email);
      CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
      CREATE INDEX IF NOT EXISTS idx_password_resets_expires_at ON password_resets(expires_at);
      CREATE INDEX IF NOT EXISTS idx_password_resets_used_at ON password_resets(used_at);
      CREATE TABLE IF NOT EXISTS local_tts_usage_events (
        id BIGSERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        duration_ms INT NOT NULL,
        voice_id VARCHAR(120),
        text_chars INT DEFAULT 0,
        source VARCHAR(40) DEFAULT 'api_tts_say',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_local_tts_usage_events_user_created
        ON local_tts_usage_events(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_local_tts_usage_events_created
        ON local_tts_usage_events(created_at DESC);
      CREATE TABLE IF NOT EXISTS token_logs (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id),
        action VARCHAR(255),
        tokens_used INT,
        characters_count INT,
        voice_name VARCHAR(255),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      -- Ensure legacy token_logs columns exist
      DO $$ BEGIN
        ALTER TABLE token_logs ADD COLUMN IF NOT EXISTS action VARCHAR(255);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE token_logs ADD COLUMN IF NOT EXISTS tokens_used INT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE token_logs ADD COLUMN IF NOT EXISTS characters_count INT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE token_logs ADD COLUMN IF NOT EXISTS voice_name VARCHAR(255);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE token_logs ADD COLUMN IF NOT EXISTS timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id),
        tokens_purchased INT,
        amount_usd DECIMAL(10, 2),
        stripe_payment_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      -- Ensure legacy transactions columns exist
      DO $$ BEGIN
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tokens_purchased INT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
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
      -- User suspension / security controls for admin
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_password_reset_at TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS session_token VARCHAR(64);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_billing_cycle VARCHAR(20) DEFAULT 'monthly';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_current_period_start TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_cancel_at_period_end BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_cancelled_at TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_pending_plan_key VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_pending_billing_cycle VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_pending_effective_at TIMESTAMP;
      CREATE INDEX IF NOT EXISTS idx_users_suspended ON users(is_suspended);

      -- Admin audit log
      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id SERIAL PRIMARY KEY,
        actor_user_id INT REFERENCES users(id) ON DELETE SET NULL,
        target_user_id INT REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(100) NOT NULL,
        details JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_target ON admin_audit_logs(target_user_id);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_action ON admin_audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created ON admin_audit_logs(created_at DESC);

      -- Global broadcasts / in-app notifications / maintenance alerts
      CREATE TABLE IF NOT EXISTS admin_broadcasts (
        id SERIAL PRIMARY KEY,
        kind VARCHAR(40) NOT NULL, -- global_message | in_app_notification | maintenance_alert
        title VARCHAR(140) NOT NULL,
        message TEXT NOT NULL,
        audience_plan VARCHAR(40) DEFAULT 'all',
        priority VARCHAR(20) DEFAULT 'normal',
        status VARCHAR(20) DEFAULT 'active', -- draft | active | paused | archived
        starts_at TIMESTAMP,
        ends_at TIMESTAMP,
        created_by INT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_admin_broadcasts_status ON admin_broadcasts(status);
      CREATE INDEX IF NOT EXISTS idx_admin_broadcasts_kind ON admin_broadcasts(kind);

      -- ===== AUDIO CACHE (hybrid: personal + global) =====
      CREATE TABLE IF NOT EXISTS audio_cache_settings (
        id INT PRIMARY KEY,
        enabled BOOLEAN DEFAULT TRUE,
        max_cacheable_chars INT DEFAULT 120,
        personal_ttl_seconds INT DEFAULT 86400,
        global_ttl_seconds INT DEFAULT 604800,
        personal_free_ttl_seconds INT DEFAULT 172800,
        personal_paid_ttl_seconds INT DEFAULT 604800,
        personal_free_max_entries INT DEFAULT 200,
        personal_paid_max_entries INT DEFAULT 1000,
        global_max_entries INT DEFAULT 1500,
        global_inactive_days INT DEFAULT 30,
        global_low_usage_threshold INT DEFAULT 8,
        subscription_grace_days INT DEFAULT 15,
        purge_personalization_after_grace BOOLEAN DEFAULT FALSE,
        hot_cache_max_entries INT DEFAULT 1500,
        global_repeat_threshold INT DEFAULT 4,
        lookup_timeout_ms INT DEFAULT 35,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE audio_cache_settings ADD COLUMN IF NOT EXISTS personal_free_ttl_seconds INT DEFAULT 172800;
      ALTER TABLE audio_cache_settings ADD COLUMN IF NOT EXISTS personal_paid_ttl_seconds INT DEFAULT 604800;
      ALTER TABLE audio_cache_settings ADD COLUMN IF NOT EXISTS personal_free_max_entries INT DEFAULT 200;
      ALTER TABLE audio_cache_settings ADD COLUMN IF NOT EXISTS personal_paid_max_entries INT DEFAULT 1000;
      ALTER TABLE audio_cache_settings ADD COLUMN IF NOT EXISTS global_max_entries INT DEFAULT 1500;
      ALTER TABLE audio_cache_settings ADD COLUMN IF NOT EXISTS global_inactive_days INT DEFAULT 30;
      ALTER TABLE audio_cache_settings ADD COLUMN IF NOT EXISTS global_low_usage_threshold INT DEFAULT 8;
      ALTER TABLE audio_cache_settings ADD COLUMN IF NOT EXISTS subscription_grace_days INT DEFAULT 15;
      ALTER TABLE audio_cache_settings ADD COLUMN IF NOT EXISTS purge_personalization_after_grace BOOLEAN DEFAULT FALSE;
      INSERT INTO audio_cache_settings (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS audio_cache_user_state (
        user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        last_plan VARCHAR(50) DEFAULT 'free',
        last_paid_at TIMESTAMP,
        grace_until TIMESTAMP,
        grace_expired_at TIMESTAMP,
        last_reset_at TIMESTAMP,
        last_checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_audio_cache_user_state_grace ON audio_cache_user_state(grace_until);

      CREATE TABLE IF NOT EXISTS audio_cache_entries (
        id BIGSERIAL PRIMARY KEY,
        cache_key VARCHAR(120) UNIQUE NOT NULL,
        scope VARCHAR(20) NOT NULL CHECK (scope IN ('personal', 'global')),
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        voice_id VARCHAR(255) NOT NULL,
        text_normalized TEXT NOT NULL,
        params_hash VARCHAR(64) NOT NULL,
        model_version VARCHAR(120) DEFAULT '',
        content_type VARCHAR(80) NOT NULL DEFAULT 'audio/mpeg',
        audio_data BYTEA NOT NULL,
        char_count INT DEFAULT 0,
        hits BIGINT DEFAULT 0,
        last_hit_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_audio_cache_entries_scope_expires ON audio_cache_entries(scope, expires_at);
      CREATE INDEX IF NOT EXISTS idx_audio_cache_entries_user ON audio_cache_entries(user_id);
      CREATE INDEX IF NOT EXISTS idx_audio_cache_entries_voice ON audio_cache_entries(voice_id);
      CREATE INDEX IF NOT EXISTS idx_audio_cache_entries_last_hit ON audio_cache_entries(last_hit_at DESC);

      CREATE TABLE IF NOT EXISTS audio_cache_phrase_stats (
        id BIGSERIAL PRIMARY KEY,
        phrase_key VARCHAR(120) UNIQUE NOT NULL,
        voice_id VARCHAR(255) NOT NULL,
        text_normalized TEXT NOT NULL,
        params_hash VARCHAR(64) NOT NULL,
        model_version VARCHAR(120) DEFAULT '',
        seen_count INT DEFAULT 1,
        last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_audio_cache_phrase_stats_seen ON audio_cache_phrase_stats(seen_count DESC, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS audio_cache_runtime_stats (
        id INT PRIMARY KEY,
        total_requests BIGINT DEFAULT 0,
        cacheable_requests BIGINT DEFAULT 0,
        bypassed_requests BIGINT DEFAULT 0,
        hot_hits BIGINT DEFAULT 0,
        persistent_hits BIGINT DEFAULT 0,
        misses BIGINT DEFAULT 0,
        rendered_requests BIGINT DEFAULT 0,
        saved_render_count BIGINT DEFAULT 0,
        tokens_saved_estimate BIGINT DEFAULT 0,
        chars_served_from_cache BIGINT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO audio_cache_runtime_stats (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING;

      -- API request logs (diagnostico real para soporte)
      CREATE TABLE IF NOT EXISTS api_request_logs (
        id BIGSERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE SET NULL,
        method VARCHAR(12) NOT NULL,
        path VARCHAR(255) NOT NULL,
        status_code INT NOT NULL,
        duration_ms INT DEFAULT 0,
        ip_address VARCHAR(80),
        user_agent VARCHAR(500),
        error_message VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_api_request_logs_created ON api_request_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_api_request_logs_user ON api_request_logs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_api_request_logs_path ON api_request_logs(path, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_api_request_logs_status ON api_request_logs(status_code, created_at DESC);

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
  app.use('/api/ops', opsRoutes);
  console.log('[STARTUP] ✓ Ops routes loaded');
  app.use('/api/support', supportRoutes);
  console.log('[STARTUP] ✓ Support routes loaded');
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
  const snapshot = monitoring.getSnapshot();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: 'REST-API-v1',
    mercadoPagoConfigured: !!config.MERCADO_PAGO_ACCESS_TOKEN,
    paypalConfigured: !!config.PAYPAL_CLIENT_ID,
    monitoring: {
      avgLatencyMs: snapshot.avgLatencyMs,
      p95LatencyMs: snapshot.p95LatencyMs,
      errors5xx: snapshot.errors5xx,
      rateLimited: snapshot.rateLimited,
      paymentFailures: snapshot.paymentFailures,
    },
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
inactiveUserCleanupService.startInactiveUserCleanupJob();

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
