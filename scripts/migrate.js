// Script para crear tablas en PostgreSQL

import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../.env') });

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const createTablesSQL = `
-- Usuarios
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  plan VARCHAR(50) DEFAULT 'free',
  tokens INT DEFAULT 100,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Historial de uso de tokens
CREATE TABLE IF NOT EXISTS token_logs (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(255),
  tokens_used INT,
  characters_count INT,
  voice_name VARCHAR(255),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Transacciones (pagos)
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tokens_purchased INT,
  amount_usd DECIMAL(10, 2),
  stripe_payment_id VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para optimizar queries
CREATE INDEX IF NOT EXISTS idx_user_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_token_logs_user ON token_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
`;

async function migrate() {
  const client = await pool.connect();

  try {
    console.log('🔄 Iniciando migraciones...');
    console.log('📦 Conectando a:', process.env.DATABASE_URL?.replace(/:[^:]*@/, ':***@'));

    await client.query(createTablesSQL);

    console.log('✅ ¡Migraciones completadas exitosamente!');
    console.log('📊 Tablas creadas:');
    console.log('  - users');
    console.log('  - token_logs');
    console.log('  - transactions');

  } catch (error) {
    console.error('❌ Error en migraciones:', error.message);
    process.exit(1);

  } finally {
    await client.release();
    await pool.end();
  }
}

migrate();
