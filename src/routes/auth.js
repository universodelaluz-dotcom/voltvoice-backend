import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';
import pool from '../db.js';
import { generateToken, verifyToken } from '../../middleware/auth.js';
import { sendVerificationEmail, sendWelcomeEmail, sendPasswordResetEmail } from '../services/mail.js';
import { isTemporaryEmail, validateEmailFormat, sanitizeEmail } from '../services/email-validator.js';
import { config } from '../../config.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const router = Router();
const isRecaptchaRequired = config.isProduction
  ? config.RECAPTCHA_REQUIRED_IN_PROD
  : config.RECAPTCHA_REQUIRED_IN_DEV;

const buildAuthCookie = (token) => {
  const parts = [
    `${config.AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${config.AUTH_COOKIE_SAMESITE}`,
  ];
  if (config.AUTH_COOKIE_SECURE) parts.push('Secure');
  if (config.AUTH_COOKIE_DOMAIN) parts.push(`Domain=${config.AUTH_COOKIE_DOMAIN}`);
  parts.push(`Max-Age=${7 * 24 * 60 * 60}`);
  return parts.join('; ');
};

const clearAuthCookie = () => {
  const parts = [
    `${config.AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    `SameSite=${config.AUTH_COOKIE_SAMESITE}`,
    'Max-Age=0',
  ];
  if (config.AUTH_COOKIE_SECURE) parts.push('Secure');
  if (config.AUTH_COOKIE_DOMAIN) parts.push(`Domain=${config.AUTH_COOKIE_DOMAIN}`);
  return parts.join('; ');
};

const attachAuthToResponse = (res, token, payload) => {
  res.setHeader('Set-Cookie', buildAuthCookie(token));
  if (config.AUTH_INCLUDE_TOKEN_RESPONSE) return { ...payload, token };
  return payload;
};

// ===== RATE LIMITING EN MEMORIA =====
const loginAttempts = new Map();
const registerAttempts = new Map();
const forgotPasswordAttempts = new Map();

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 30 * 60 * 1000;

const REGISTER_MAX_ATTEMPTS = 1; // Cambio: de 3 a 1 registro por hora
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

const VERIFICATION_CODE_LENGTH = 6;
const VERIFICATION_EXPIRY_MS = 15 * 60 * 1000; // 15 minutos
const RESET_CODE_LENGTH = 6;
const RESET_EXPIRY_MS = 15 * 60 * 1000; // 15 minutos
const FORGOT_MAX_ATTEMPTS = 5;
const FORGOT_WINDOW_MS = 60 * 60 * 1000;

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
  for (const [ip, data] of forgotPasswordAttempts) {
    if (now - data.firstAttempt > FORGOT_WINDOW_MS) {
      forgotPasswordAttempts.delete(ip);
    }
  }
}, 10 * 60 * 1000);

// Limpiar email_verifications expiradas cada 5 minutos
setInterval(async () => {
  try {
    await pool.query('DELETE FROM email_verifications WHERE expires_at < CURRENT_TIMESTAMP');
    await pool.query('DELETE FROM password_resets WHERE expires_at < CURRENT_TIMESTAMP OR used_at IS NOT NULL');
  } catch (error) {
    console.error('[Auth] Error limpiando verificaciones expiradas:', error.message);
  }
}, 5 * 60 * 1000);

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || 'unknown';
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>'"\\]/g, '').trim().substring(0, 255);
}

function generateVerificationCode() {
  return Math.random().toString().substring(2, 2 + VERIFICATION_CODE_LENGTH);
}

function generateResetCode() {
  return Math.random().toString().substring(2, 2 + RESET_CODE_LENGTH);
}

function hashResetCode(email, code) {
  return crypto.createHash('sha256').update(`${String(email || '').toLowerCase()}|${String(code || '')}`).digest('hex');
}

async function verifyRecaptcha(token) {
  if (!token) {
    return false;
  }

  if (!RECAPTCHA_SECRET) {
    if (isRecaptchaRequired) {
      console.error('[Auth] RECAPTCHA_SECRET no configurado y CAPTCHA requerido');
      return false;
    }
    console.warn('[Auth] RECAPTCHA_SECRET no configurado - saltando validacion');
    return true;
  }

  try {
    const response = await axios.post(
      'https://www.google.com/recaptcha/api/siteverify',
      null,
      {
        params: {
          secret: RECAPTCHA_SECRET,
          response: token
        }
      }
    );

    return response.data.success && response.data.score > 0.5;
  } catch (error) {
    console.error('[Auth] Error validando reCAPTCHA:', error.message);
    return false;
  }
}
/**
 * POST /api/auth/register - Enviar código de verificación
 * Ahora NO crea usuario, solo envía código
 */
router.post('/register', async (req, res) => {
  const ip = getClientIp(req);
  const now = Date.now();

  // Rate limit por IP
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
  const recaptchaToken = req.body.recaptchaToken;

  if (!rawEmail || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  const email = sanitizeEmail(rawEmail);

  // Validar formato
  if (!validateEmailFormat(email)) {
    return res.status(400).json({ error: 'El formato del email no es válido' });
  }

  // Validar que no sea email temporal (con API en tiempo real)
  const isTemp = await isTemporaryEmail(email);
  if (isTemp) {
    return res.status(400).json({ error: 'No se permiten emails temporales. Por favor usa un email válido.' });
  }

  // Validar contraseña
  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  if (password.length > 128) {
    return res.status(400).json({ error: 'Contraseña demasiado larga' });
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).json({ error: 'La contraseña debe tener letras y números' });
  }

  // Validar reCAPTCHA (obligatorio según entorno/configuración)
  if (isRecaptchaRequired && !recaptchaToken) {
    return res.status(400).json({ error: 'CAPTCHA requerido para crear cuenta' });
  }
  if (recaptchaToken || isRecaptchaRequired) {
    const captchaValid = await verifyRecaptcha(recaptchaToken);
    if (!captchaValid) {
      console.warn(`[Auth] reCAPTCHA fallido para IP ${ip}`);
      return res.status(400).json({ error: 'Validación de CAPTCHA fallida' });
    }
  }

  try {
    // Registrar intento
    if (registerAttempts.has(ip) && now - registerAttempts.get(ip).firstAttempt < REGISTER_WINDOW_MS) {
      registerAttempts.get(ip).count++;
    } else {
      registerAttempts.set(ip, { count: 1, firstAttempt: now });
    }

    // Verificar si email ya existe
    let existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Este email ya está registrado' });
    }

    // Verificar si ya hay código de verificación pendiente
    existing = await pool.query('SELECT id FROM email_verifications WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      // Borrar verificación anterior
      await pool.query('DELETE FROM email_verifications WHERE email = $1', [email]);
    }

    // Generar código
    const code = generateVerificationCode();
    const expiresAt = new Date(now + VERIFICATION_EXPIRY_MS);
    const passwordHash = await bcrypt.hash(password, 12);

    // Guardar verificación pendiente
    await pool.query(
      'INSERT INTO email_verifications (email, code, password_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [email, code, passwordHash, expiresAt]
    );

    // Enviar email
    const emailSent = await sendVerificationEmail(email, code);
    if (!emailSent) {
      // En desarrollo, mostrar código en consola
      console.log(`[Auth] Código de verificación para ${email}: ${code}`);
    }

    console.log(`[Auth] Código de verificación enviado a: ${email} desde IP: ${ip}`);

    return res.status(200).json({
      success: true,
      message: 'Código de verificación enviado. Revisa tu email.',
      email: email
    });
  } catch (error) {
    console.error('[Auth] Error en registro:', error.message);
    return res.status(500).json({ error: 'Error creando la cuenta' });
  }
});

/**
 * POST /api/auth/verify-email - Verificar código y crear usuario
 */
router.post('/verify-email', async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ error: 'Email y código son requeridos' });
  }

  const emailNorm = sanitizeEmail(email);

  try {
    // Buscar verificación pendiente
    const result = await pool.query(
      'SELECT * FROM email_verifications WHERE email = $1 AND expires_at > CURRENT_TIMESTAMP',
      [emailNorm]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Código expirado o no encontrado. Intenta registrarte de nuevo.' });
    }

    const verification = result.rows[0];

    // Validar código
    if (verification.code !== code) {
      // Incrementar intentos fallidos
      await pool.query(
        'UPDATE email_verifications SET attempts = attempts + 1 WHERE id = $1',
        [verification.id]
      );

      // Bloquear si hay demasiados intentos
      if (verification.attempts >= verification.max_attempts) {
        await pool.query('DELETE FROM email_verifications WHERE id = $1', [verification.id]);
        return res.status(429).json({ error: 'Demasiados intentos. Solicita un nuevo código.' });
      }

      return res.status(401).json({ error: 'Código incorrecto' });
    }

    // Código correcto - crear usuario
    const userResult = await pool.query(
      'INSERT INTO users (email, password_hash, plan, tokens, email_verified) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, plan, tokens',
      [emailNorm, verification.password_hash, 'free', 100, true]
    );

    const user = userResult.rows[0];
    const token = generateToken(user.id);

    // Limpiar verificación
    await pool.query('DELETE FROM email_verifications WHERE id = $1', [verification.id]);

    // Enviar email de bienvenida
    await sendWelcomeEmail(emailNorm);

    console.log(`[Auth] Usuario registrado exitosamente: ${user.email} (ID: ${user.id})`);

    return res.status(201).json(attachAuthToResponse(res, token, {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        tokens: user.tokens,
      }
    }));
  } catch (error) {
    console.error('[Auth] Error verificando email:', error.message);
    return res.status(500).json({ error: 'Error verificando email' });
  }
});

/**
 * POST /api/auth/resend-code - Reenviar código de verificación
 */
router.post('/resend-code', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email requerido' });
  }

  const emailNorm = sanitizeEmail(email);

  try {
    const result = await pool.query(
      'SELECT * FROM email_verifications WHERE email = $1 AND expires_at > CURRENT_TIMESTAMP',
      [emailNorm]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No hay verificación pendiente para este email' });
    }

    const verification = result.rows[0];
    const code = generateVerificationCode();
    const now = Date.now();
    const expiresAt = new Date(now + VERIFICATION_EXPIRY_MS);

    // Actualizar código y reset intentos
    await pool.query(
      'UPDATE email_verifications SET code = $1, expires_at = $2, attempts = 0 WHERE id = $3',
      [code, expiresAt, verification.id]
    );

    // Enviar email
    await sendVerificationEmail(emailNorm, code);
    console.log(`[Auth] Código reenviado a: ${emailNorm}`);

    return res.status(200).json({
      success: true,
      message: 'Nuevo código enviado'
    });
  } catch (error) {
    console.error('[Auth] Error reenviando código:', error.message);
    return res.status(500).json({ error: 'Error reenviando código' });
  }
});

/**
 * POST /api/auth/forgot-password - Solicitar codigo de recuperacion por email
 */
router.post('/forgot-password', async (req, res) => {
  const ip = getClientIp(req);
  const now = Date.now();
  const rawEmail = req.body.email;
  const genericResponse = {
    success: true,
    message: 'Si el email existe, enviamos un código de recuperación.'
  };

  if (!rawEmail) {
    return res.status(200).json(genericResponse);
  }

  const email = sanitizeEmail(rawEmail);
  if (!validateEmailFormat(email)) {
    return res.status(200).json(genericResponse);
  }

  const attempt = forgotPasswordAttempts.get(ip);
  if (attempt && now - attempt.firstAttempt < FORGOT_WINDOW_MS && attempt.count >= FORGOT_MAX_ATTEMPTS) {
    return res.status(200).json(genericResponse);
  }
  if (attempt && now - attempt.firstAttempt >= FORGOT_WINDOW_MS) {
    forgotPasswordAttempts.delete(ip);
  }

  try {
    if (forgotPasswordAttempts.has(ip) && now - forgotPasswordAttempts.get(ip).firstAttempt < FORGOT_WINDOW_MS) {
      forgotPasswordAttempts.get(ip).count += 1;
    } else {
      forgotPasswordAttempts.set(ip, { count: 1, firstAttempt: now });
    }

    const userResult = await pool.query(
      'SELECT id, email_verified FROM users WHERE email = $1 LIMIT 1',
      [email]
    );
    const user = userResult.rows[0];
    if (!user || !user.email_verified) {
      return res.status(200).json(genericResponse);
    }

    await pool.query(
      `UPDATE password_resets
       SET used_at = NOW()
       WHERE email = $1 AND used_at IS NULL`,
      [email]
    );

    const code = generateResetCode();
    const codeHash = hashResetCode(email, code);
    const expiresAt = new Date(now + RESET_EXPIRY_MS);

    await pool.query(
      `INSERT INTO password_resets
       (user_id, email, code_hash, attempts, max_attempts, expires_at, request_ip)
       VALUES ($1, $2, $3, 0, 5, $4, $5)`,
      [user.id, email, codeHash, expiresAt, String(ip).slice(0, 80)]
    );

    const sent = await sendPasswordResetEmail(email, code);
    if (!sent) {
      console.log(`[Auth] Código de recuperación para ${email}: ${code}`);
    }

    return res.status(200).json(genericResponse);
  } catch (error) {
    console.error('[Auth] Error forgot-password:', error.message);
    return res.status(200).json(genericResponse);
  }
});

/**
 * POST /api/auth/reset-password - Confirmar codigo y actualizar contraseña
 */
router.post('/reset-password', async (req, res) => {
  const rawEmail = req.body.email;
  const rawCode = req.body.code;
  const newPassword = req.body.newPassword;

  if (!rawEmail || !rawCode || !newPassword) {
    return res.status(400).json({ error: 'Email, código y nueva contraseña son requeridos' });
  }

  const email = sanitizeEmail(rawEmail);
  const code = String(rawCode || '').trim();

  if (!validateEmailFormat(email)) {
    return res.status(400).json({ error: 'Solicitud inválida' });
  }
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Código inválido' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  if (newPassword.length > 128) {
    return res.status(400).json({ error: 'Contraseña demasiado larga' });
  }
  if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return res.status(400).json({ error: 'La contraseña debe tener letras y números' });
  }

  try {
    const resetResult = await pool.query(
      `SELECT id, user_id, attempts, max_attempts, expires_at
       FROM password_resets
       WHERE email = $1
         AND used_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP
       ORDER BY created_at DESC
       LIMIT 1`,
      [email]
    );

    if (resetResult.rows.length === 0) {
      return res.status(404).json({ error: 'Código expirado o no encontrado' });
    }

    const reset = resetResult.rows[0];
    const codeHash = hashResetCode(email, code);
    const validResult = await pool.query(
      `SELECT id
       FROM password_resets
       WHERE id = $1 AND code_hash = $2`,
      [reset.id, codeHash]
    );

    if (validResult.rows.length === 0) {
      await pool.query(
        `UPDATE password_resets
         SET attempts = attempts + 1
         WHERE id = $1`,
        [reset.id]
      );
      if (Number(reset.attempts || 0) + 1 >= Number(reset.max_attempts || 5)) {
        await pool.query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [reset.id]);
      }
      return res.status(401).json({ error: 'Código incorrecto' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           updated_at = CURRENT_TIMESTAMP,
           last_password_reset_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [passwordHash, reset.user_id]
    );

    await pool.query(
      `UPDATE password_resets
       SET used_at = NOW()
       WHERE id = $1 OR user_id = $2`,
      [reset.id, reset.user_id]
    );

    return res.status(200).json({ success: true, message: 'Contraseña actualizada correctamente' });
  } catch (error) {
    console.error('[Auth] Error reset-password:', error.message);
    return res.status(500).json({ error: 'Error restableciendo contraseña' });
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
    if (attempt.lockedUntil && now < attempt.lockedUntil) {
      const minutesLeft = Math.ceil((attempt.lockedUntil - now) / 60000);
      console.warn(`[Auth] Login bloqueado para IP ${ip}`);
      return res.status(429).json({ error: `Cuenta bloqueada. Intenta en ${minutesLeft} minutos.` });
    }
    if (now - attempt.firstAttempt >= LOGIN_WINDOW_MS && (!attempt.lockedUntil || now >= attempt.lockedUntil)) {
      loginAttempts.delete(ip);
    }
  }

  const rawEmail = req.body.email;
  const password = req.body.password;

  if (!rawEmail || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  const email = sanitizeEmail(rawEmail);

  if (!validateEmailFormat(email)) {
    return res.status(400).json({ error: 'Email o contraseña incorrectos' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, plan, tokens, role, email_verified, is_suspended, suspended_until FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      recordFailedLogin(ip, now);
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const user = result.rows[0];

    // Verificar que el email esté verificado
    if (!user.email_verified) {
      return res.status(403).json({ error: 'Por favor verifica tu email primero' });
    }
    const blockedByFlag = user.is_suspended === true;
    const blockedByTime = user.suspended_until && new Date(user.suspended_until).getTime() > Date.now();
    if (blockedByFlag || blockedByTime) {
      return res.status(403).json({ error: 'Cuenta suspendida temporalmente' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      recordFailedLogin(ip, now);
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    loginAttempts.delete(ip);
    const token = generateToken(user.id);

    await pool.query('UPDATE users SET updated_at = CURRENT_TIMESTAMP, last_seen = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

    console.log(`[Auth] Login exitoso: ${user.email} desde IP: ${ip}`);

    return res.status(200).json(attachAuthToResponse(res, token, {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        plan: user.role === 'admin' ? 'admin' : user.plan,
        tokens: user.role === 'admin' ? 999999999 : user.tokens,
        role: user.role || 'user',
      }
    }));
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
    return res.status(500).json({ error: 'Google login no configurado' });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase();
    const name = payload.name || '';
    const picture = payload.picture || '';

    console.log(`[Auth] Google login para: ${email}`);

    let result = await pool.query(
      'SELECT id, email, plan, tokens, role, is_suspended, suspended_until FROM users WHERE email = $1',
      [email]
    );

    let user;

    if (result.rows.length > 0) {
      user = result.rows[0];
      const blockedByFlag = user.is_suspended === true;
      const blockedByTime = user.suspended_until && new Date(user.suspended_until).getTime() > Date.now();
      if (blockedByFlag || blockedByTime) {
        return res.status(403).json({ error: 'Cuenta suspendida temporalmente' });
      }
      console.log(`[Auth] Google login exitoso (existente): ${email} (ID: ${user.id})`);
    } else {
      const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
      result = await pool.query(
        'INSERT INTO users (email, password_hash, plan, tokens, email_verified, role, last_seen) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP) RETURNING id, email, plan, tokens, role',
        [email, randomHash, 'free', 100, true, 'user']
      );
      user = result.rows[0];
      console.log(`[Auth] Nuevo usuario creado via Google: ${email} (ID: ${user.id})`);
    }

    const token = generateToken(user.id);
    // Update last_seen for all Google logins
    await pool.query('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

    return res.status(200).json(attachAuthToResponse(res, token, {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        plan: user.role === 'admin' ? 'admin' : user.plan,
        tokens: user.role === 'admin' ? 999999999 : user.tokens,
        role: user.role || 'user',
        name,
        picture,
      }
    }));
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
      console.warn(`[Auth] IP ${ip} bloqueada por ${LOGIN_LOCKOUT_MS / 60000} minutos`);
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
      'UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, email, plan, tokens, role, created_at',
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
        plan: user.role === 'admin' ? 'admin' : user.plan,
        tokens: user.role === 'admin' ? 999999999 : user.tokens,
        role: user.role || 'user',
        created_at: user.created_at,
      }
    });
  } catch (error) {
    console.error('[Auth] Error obteniendo perfil:', error.message);
    return res.status(500).json({ error: 'Error obteniendo datos' });
  }
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearAuthCookie());
  return res.status(200).json({ success: true, message: 'SesiÃ³n cerrada' });
});

export default router;



