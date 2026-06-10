/**
 * clone-user.js
 * Crea una cuenta alternativa que apunta exactamente al mismo usuario que alainsh@gmail.com.
 * Todo (config, voces, tokens, plan) es compartido en tiempo real — es el mismo usuario con distinto login.
 *
 * Uso: node clone-user.js
 */

import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcrypt';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const SOURCE_EMAIL = 'alainsh@gmail.com';
const NEW_EMAIL    = 'streamvoicer@gmail.com';
const NEW_PASSWORD = '12345678';

async function run() {
  const client = await pool.connect();
  try {
    // 1. Buscar usuario fuente
    const srcRes = await client.query('SELECT id, plan, tokens FROM users WHERE email = $1', [SOURCE_EMAIL]);
    if (!srcRes.rows.length) { console.error('❌ No se encontró el usuario fuente:', SOURCE_EMAIL); process.exit(1); }
    const src = srcRes.rows[0];
    console.log(`✅ Usuario fuente: id=${src.id} (${SOURCE_EMAIL}), plan=${src.plan}, tokens=${src.tokens}`);

    const hash = await bcrypt.hash(NEW_PASSWORD, 12);

    // 2. Crear o actualizar cuenta alternativa con linked_user_id apuntando al fuente
    const existRes = await client.query('SELECT id FROM users WHERE email = $1', [NEW_EMAIL]);
    let newUserId;
    if (existRes.rows.length) {
      newUserId = existRes.rows[0].id;
      await client.query(
        `UPDATE users SET password_hash=$1, linked_user_id=$2, email_verified=TRUE, updated_at=NOW() WHERE id=$3`,
        [hash, src.id, newUserId]
      );
      console.log(`✅ Cuenta alternativa actualizada (id=${newUserId})`);
    } else {
      const newRes = await client.query(
        `INSERT INTO users (email, password_hash, plan, tokens, role, email_verified, linked_user_id, created_at, updated_at)
         VALUES ($1, $2, 'free', 0, 'user', TRUE, $3, NOW(), NOW())
         RETURNING id`,
        [NEW_EMAIL, hash, src.id]
      );
      newUserId = newRes.rows[0].id;
      console.log(`✅ Cuenta alternativa creada (id=${newUserId})`);
    }

    console.log('\n🎉 ¡Listo! Entrada alternativa configurada:');
    console.log(`   📧 Email:      ${NEW_EMAIL}`);
    console.log(`   🔑 Contraseña: ${NEW_PASSWORD}`);
    console.log(`   🔗 Linked a:   ${SOURCE_EMAIL} (id=${src.id})`);
    console.log('\n   Al iniciar sesión con esta cuenta, el sistema usa');
    console.log('   EXACTAMENTE los mismos datos que alainsh@gmail.com.');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
