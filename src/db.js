import pg from 'pg';
import dotenv from 'dotenv';

// Load environment variables from .env file (for local development)
dotenv.config();

const { Pool } = pg;

// Log for debugging
console.log('[DB] Checking environment variables...');
console.log('[DB] DATABASE_URL is', process.env.DATABASE_URL ? 'SET' : 'NOT SET');
console.log('[DB] NODE_ENV:', process.env.NODE_ENV);

// Build connection config
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      // Fallback to individual env variables (Railway sets these)
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD,
      host: process.env.PGHOST || 'localhost',
      port: process.env.PGPORT || 5432,
      database: process.env.PGDATABASE || 'railway'
    };

console.log('[DB] Connection config:', poolConfig.connectionString ? 'Using DATABASE_URL' : `Using host:${poolConfig.host}, db:${poolConfig.database}`);

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client', err);
});

// Test connection on startup
pool.query('SELECT 1', (err, res) => {
  if (err) {
    console.error('[DB] ✗ Connection test failed:', err.message);
  } else {
    console.log('[DB] ✓ Connection successful');
  }
});

export default pool;
