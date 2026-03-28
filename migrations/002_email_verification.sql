-- Tabla para rastrear verificaciones de email pendientes
CREATE TABLE IF NOT EXISTS email_verifications (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  code VARCHAR(6) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  verified_at TIMESTAMP,
  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 3
);

-- Índices para optimizar búsquedas
CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(email);
CREATE INDEX IF NOT EXISTS idx_email_verifications_code ON email_verifications(code);
CREATE INDEX IF NOT EXISTS idx_email_verifications_expires ON email_verifications(expires_at);

-- Agregar columna verified a users si no existe
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_users_email_verified ON users(email_verified);
