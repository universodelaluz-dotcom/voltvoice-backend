-- Crear tabla de usuarios (si no existe)
-- Nota: Si la tabla ya existe, no se recreará
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255),
  tokens INTEGER DEFAULT 100,
  plan VARCHAR(50) DEFAULT 'free',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Crear tabla de token logs
CREATE TABLE IF NOT EXISTS token_logs (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50),
  action VARCHAR(100),
  tokens_used INTEGER DEFAULT 0,
  characters_count INTEGER,
  voice_name VARCHAR(255),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Crear tabla de síntesis de voz
CREATE TABLE IF NOT EXISTS synthesis_logs (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50),
  text TEXT,
  voice_id VARCHAR(255),
  voice_name VARCHAR(255),
  audio_url TEXT,
  duration FLOAT,
  status VARCHAR(50) DEFAULT 'completed',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Crear tabla de transacciones
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50),
  tokens_purchased INTEGER,
  amount_usd FLOAT,
  stripe_payment_id VARCHAR(255),
  mercado_pago_id VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Crear tabla de streams
CREATE TABLE IF NOT EXISTS streams (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50),
  platform VARCHAR(50),
  channel_name VARCHAR(255),
  channel_id VARCHAR(255),
  is_active BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Actualizar tokens de usuarios de prueba (si existen)
UPDATE users SET tokens = 1000 WHERE email ILIKE 'test@%';
UPDATE users SET tokens = 500 WHERE email ILIKE 'test2@%';

-- Crear índices para mejorar performance
CREATE INDEX IF NOT EXISTS idx_token_logs_user_id ON token_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_synthesis_logs_user_id ON synthesis_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_streams_user_id ON streams(user_id);

-- Mostrar resultado
SELECT 'Database initialized successfully!' as status;
