import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    const result = await pool.query(
      "UPDATE users SET plan = 'elite' WHERE email = 'alainsh@gmail.com' RETURNING id, email, plan"
    );
    console.log('✅ Plan actualizado a ELITE:');
    console.log(result.rows);
    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
