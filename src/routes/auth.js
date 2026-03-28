import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import pool from '../db.js';
import { generateToken, verifyToken } from '../../middleware/auth.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const router = Router();

// ===== RATE LIMITING EN MEMORIA =====
// Bloqueo por IP: máximo 5 intentos de login fallidos en 15 minutos
// Máximo 3 registros por IP en 1 hora
const loginAttempts = new Map();  // ip -> { count, firstAttempt, lockedUntil }
const registerAttempts = new Map(); // ip -> { count, firstAttempt }

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutos
const LOGIN_LOCKOUT_MS = 30 * 60 * 1000; // 30 minutos de bloqueo

const REGISTER_MAX_ATTEMPTS = 3;
const REGISTER_WINDOW_MS = 60 * 60 * 1000; // 1 hora

// Limpiar intentos viejos cada 10 minutos
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttempts) {
    if (now - data.firstAttempt > LOGIN_WINDOW_MS && (!data.lockedUntil || now > data.lockedUntil)) {
      loginAttempts.delete(ip);
    }
  }
  for (const [ip, data] of registerAttempts) {
    if (now - data.firstAttempt > REGISTER_WINDOW_MS) {
      registerAttempts.delete(ip);
    }
  }
}, 10 * 60 * 1000);

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || 'unknown';
}

// Validación de email estricta
function isValidEmail(email) {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email) && email.length <= 255;
}

// Sanitizar input (prevenir inyección en logs)
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>'"\\]/g, '').trim().substring(0, 255);
}

/**
 * POST /api/auth/register - Crear cuenta nueva
 */
router.post('/register', async (req, res) => {
  const ip = getClientIp(req);
  const now = Date.now();

  // Rate limit por IP para registro
  const regData = registerAttempts.get(ip);
  if (regData) {
    if (now - regData.firstAttempt < REGISTER_WINDOW_MS && regData.count >= REGISTER_MAX_ATTEMPTS) {
      const minutesLeft = Math.ceil((REGISTER_WINDOW_MS - (now - regData.firstAttempt)) / 60000);
      console.warn(`[Auth] Registro bloqueado para IP ${ip} - demasiados intentos`);
      return res.status(429).json({ error: `Demasiados intentos. Espera ${minutesLeft} minutos.` });
    }
    if (now - regData.firstAttempt >= REGISTER_WINDOW_MS) {
      registerAttempts.delete(ip);
    }
  }

  const rawEmail = req.body.email;
  const password = req.body.password;

  if (!rawEmail || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  const email = sanitize(rawEmail).toLowerCase();

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'El formato del email no es válido' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }

  if (password.length > 128) {
    return res.status(400).json({ error: 'Contraseña demasiado larga' });
  }

  // Contraseña debe tener al menos una letra y un número
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).json({ error: 'La contraseña debe tener letras y números' });
  }

  try {
    // Registrar intento
    const existing_reg = registerAttempts.get(ip);
    if (existing_reg && now - existing_reg.firstAttempt < REGISTER_WINDOW_MS) {
      existing_reg.count++;
    } else {
      registerAttempts.set(ip, { count: 1, firstAttempt: now });
    }

    // Verificar si el email ya existe (sin revelar cuál email)
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Este email ya está registrado' });
    }

    // Hash con cost factor 12 (más seguro que 10)
    const password_hash = await bcrypt.hash(password, 12);

    // Crear usuario con 100 tokens gratis
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, plan, tokens) VALUES ($1, $2, $3, $4) RETURNING id, email, plan, tokens, created_at',
      [email, password_hash, 'free', 100]
    );

    const user = result.rows[0];
    const token = generateToken(user.id);

    console.log(`[Auth] Nuevo usuario registrado: ${user.email} (ID: ${user.id}) desde IP: ${ip}`);

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
    console.error('[Auth] Error en registro:', error.message);
    return res.status(500).json({ error: 'Error creando la cuenta' });
  }
});

/**
 * POST /api/auth/login - Iniciar sesión
 */
router.post('/login', async (req, res) => {
  const ip = getClientIp(req);
  const now = Date.now();

  // Rate limit por IP para login
  const attempt = loginAttempts.get(ip);
  if (attempt) {
    // Si está bloqueado
    if (attempt.lockedUntil && now < attempt.lockedUntil) {
      const minutesLeft = Math.ceil((attempt.lockedUntil - now) / 60000);
      console.warn(`[Auth] Login bloqueado para IP ${ip} - lockout activo`);
      return res.status(429).json({ error: `Cuenta bloqueada por seguridad. Intenta en ${minutesLeft} minutos.` });
    }
    // Si pasó la ventana, resetear
    if (now - attempt.firstAttempt >= LOGIN_WINDOW_MS && (!attempt.lockedUntil || now >= attempt.lockedUntil)) {
      loginAttempts.delete(ip);
    }
  }

  const rawEmail = req.body.email;
  const password = req.body.password;

  if (!rawEmail || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  const email = sanitize(rawEmail).toLowerCase();

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Email o contraseña incorrectos' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, plan, tokens FROM users WHERE email = $1',
      [email]
    );

    // Respuesta genérica para no revelar si el email existe
    if (result.rows.length === 0) {
      recordFailedLogin(ip, now);
      // Delay artificial para prevenir timing attacks
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      recordFailedLogin(ip, now);
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    // Login exitoso - limpiar intentos
    loginAttempts.delete(ip);

    const token = generateToken(user.id);

    // Actualizar last login
    await pool.query('UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

    console.log(`[Auth] Login exitoso: ${user.email} desde IP: ${ip}`);

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
    console.error('[Auth] Error en login:', error.message);
    return res.status(500).json({ error: 'Error iniciando sesión' });
  }
});

/**
 * POST /api/auth/google - Iniciar sesión con Google
 */
router.post('/google', async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ error: 'Token de Google requerido' });
  }

  if (!GOOGLE_CLIENT_ID) {
    console.error('[Auth] GOOGLE_CLIENT_ID no configurado');
    return res.status(500).json({ error: 'Google login no configurado en el servidor' });
  }

  try {
    // Verificar el token de Google
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase();
    const name = payload.name || '';
    const picture = payload.picture || '';

    console.log(`[Auth] Google login para: ${email}`);

    // Buscar si el usuario ya existe
    let result = await pool.query(
      'SELECT id, email, plan, tokens FROM users WHERE email = $1',
      [email]
    );

    let user;

    if (result.rows.length > 0) {
      // Usuario existente - actualizar last login
      user = result.rows[0];
      await pool.query('UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
      console.log(`[Auth] Google login exitoso (existente): ${email} (ID: ${user.id})`);
    } else {
      // Usuario nuevo - crear cuenta automáticamente
      const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
      result = await pool.query(
        'INSERT INTO users (email, password_hash, plan, tokens) VALUES ($1, $2, $3, $4) RETURNING id, email, plan, tokens',
        [email, randomHash, 'free', 100]
      );
      user = result.rows[0];
      console.log(`[Auth] Nuevo usuario creado via Google: ${email} (ID: ${user.id})`);
    }

    const token = generateToken(user.id);

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        tokens: user.tokens,
        name,
        picture,
      }
    });
  } catch (error) {
    console.error('[Auth] Error Google login:', error.message);
    return res.status(401).json({ error: 'Token de Google inválido' });
  }
});

function recordFailedLogin(ip, now) {
  const attempt = loginAttempts.get(ip);
  if (attempt && now - attempt.firstAttempt < LOGIN_WINDOW_MS) {
    attempt.count++;
    if (attempt.count >= LOGIN_MAX_ATTEMPTS) {
      attempt.lockedUntil = now + LOGIN_LOCKOUT_MS;
      console.warn(`[Auth] IP ${ip} bloqueada por ${LOGIN_LOCKOUT_MS / 60000} minutos tras ${attempt.count} intentos fallidos`);
    }
  } else {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  }
}

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
    console.error('[Auth] Error obteniendo perfil:', error.message);
    return res.status(500).json({ error: 'Error obteniendo datos' });
  }
});

export default router;
