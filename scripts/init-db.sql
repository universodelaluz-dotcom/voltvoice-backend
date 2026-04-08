-- ============================================================
-- VoltVoice DB init (alineado con server.js auto-migrate)
-- Objetivo: esquema consistente para auth y tablas base.
-- ============================================================

BEGIN;

-- ===== USERS (auth-critical) =====
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  email_verified BOOLEAN DEFAULT FALSE,
  role VARCHAR(50) DEFAULT 'user',
  plan VARCHAR(50) DEFAULT 'free',
  tokens INT DEFAULT 100,
  last_seen TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ===== EMAIL VERIFICATIONS (auth-critical) =====
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

CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(email);
CREATE INDEX IF NOT EXISTS idx_email_verifications_expires_at ON email_verifications(expires_at);

-- ===== USER SETTINGS =====
CREATE TABLE IF NOT EXISTS user_settings (
  id SERIAL PRIMARY KEY,
  user_id INT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config JSONB DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings(user_id);

-- ===== USER VOICES =====
CREATE TABLE IF NOT EXISTS user_voices (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voice_name VARCHAR(255) NOT NULL,
  voice_id VARCHAR(255) NOT NULL,
  provider VARCHAR(50) DEFAULT 'inworld',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, voice_name)
);

CREATE INDEX IF NOT EXISTS idx_user_voices_user ON user_voices(user_id);

-- ===== TOKEN LOGS =====
CREATE TABLE IF NOT EXISTS token_logs (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(255),
  tokens_used INT,
  characters_count INT,
  voice_name VARCHAR(255),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_token_logs_user_id ON token_logs(user_id);

-- ===== TRANSACTIONS =====
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tokens_purchased INT,
  amount_usd DECIMAL(10, 2),
  stripe_payment_id VARCHAR(255),
  mercado_pago_id VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);

-- ===== OPTIONAL LEGACY/ANALYTICS TABLES =====
CREATE TABLE IF NOT EXISTS synthesis_logs (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  text TEXT,
  voice_id VARCHAR(255),
  voice_name VARCHAR(255),
  audio_url TEXT,
  duration FLOAT,
  status VARCHAR(50) DEFAULT 'completed',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_synthesis_logs_user_id ON synthesis_logs(user_id);

CREATE TABLE IF NOT EXISTS streams (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  platform VARCHAR(50),
  channel_name VARCHAR(255),
  channel_id VARCHAR(255),
  is_active BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_streams_user_id ON streams(user_id);

COMMIT;

SELECT 'Database initialized successfully (auth schema aligned)' AS status;
