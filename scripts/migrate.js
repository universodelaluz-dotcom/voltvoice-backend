import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

async function migrate() {
  try {
    console.log('🔄 Starting database migration...\n');

    const sqlFile = path.join(__dirname, 'init-db.sql');
    const sql = fs.readFileSync(sqlFile, 'utf-8');

    console.log('📝 Executing SQL script...');
    await pool.query(sql);

    console.log('✅ Database migration completed successfully!\n');
    console.log('📊 Tables created:');
    console.log('   ✓ users');
    console.log('   ✓ token_logs');
    console.log('   ✓ synthesis_logs');
    console.log('   ✓ transactions');
    console.log('   ✓ streams');

    console.log('\n👥 Test users created:');
    console.log('   ✓ test-user-vip (1000 tokens)');
    console.log('   ✓ test-user-123 (500 tokens)');

    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    await pool.end();
    process.exit(1);
  }
}

migrate();
