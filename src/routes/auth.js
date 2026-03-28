import { Router } from 'express';
import bcrypt from 'bcrypt';
import pool from '../db.js';
import { generateToken, verifyToken } from '../../middleware/auth.js';

const router = Router();

/**
 * POST /api/auth/register - Crear cuenta nueva
 */
router.post('/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }

  try {
    // Verificar si el email ya existe
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Este email ya está registrado' });
    }

    // Hash de contraseña
    const password_hash = await bcrypt.hash(password, 10);

    // Crear usuario con 100 tokens gratis
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, plan, tokens) VALUES ($1, $2, $3, $4) RETURNING id, email, plan, tokens, created_at',
      [email.toLowerCase(), password_hash, 'free', 100]
    );

    const user = result.rows[0];
    const token = generateToken(user.id);

    console.log(`[Auth] Nuevo usuario registrado: ${user.email} (ID: ${user.id})`);

    return res.status(201).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        tokens: user.tokens,
      }
    });
  } catch (error) {
    console.error('[Auth] Error en registro:', error);
    return res.status(500).json({ error: 'Error creando la cuenta' });
  }
});

/**
 * POST /api/auth/login - Iniciar sesión
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, plan, tokens FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const token = generateToken(user.id);

    // Actualizar last login
    await pool.query('UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

    console.log(`[Auth] Login exitoso: ${user.email}`);

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        tokens: user.tokens,
      }
    });
  } catch (error) {
    console.error('[Auth] Error en login:', error);
    return res.status(500).json({ error: 'Error iniciando sesión' });
  }
});

/**
 * GET /api/auth/me - Obtener datos del usuario actual
 */
router.get('/me', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, plan, tokens, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = result.rows[0];
    return res.status(200).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        tokens: user.tokens,
        created_at: user.created_at,
      }
    });
  } catch (error) {
    console.error('[Auth] Error obteniendo perfil:', error);
    return res.status(500).json({ error: 'Error obteniendo datos' });
  }
});

export default router;
