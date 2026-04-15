import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import pool from '../src/db.js';

const parseCookieHeader = (cookieHeader = '') => {
  if (!cookieHeader || typeof cookieHeader !== 'string') return {};
  return cookieHeader.split(';').reduce((acc, pair) => {
    const index = pair.indexOf('=');
    if (index < 0) return acc;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key) return acc;
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
};

const getTokenFromRequest = (req) => {
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (bearerToken) return bearerToken;

  const cookies = parseCookieHeader(req.headers.cookie || '');
  return cookies[config.AUTH_COOKIE_NAME] || '';
};

/**
 * Middleware para verificar JWT
 */
export const verifyToken = async (req, res, next) => {
  const token = getTokenFromRequest(req);

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    req.user = decoded;
    let result;
    try {
      result = await pool.query(
        `SELECT is_suspended, suspended_until, session_token
         FROM users
         WHERE id::text = $1::text`,
        [decoded.userId]
      );
    } catch (queryError) {
      if (queryError?.code !== '42703') throw queryError;
      console.warn('[Auth] session_token no existe en users, validando en modo compatible');
      result = await pool.query(
        `SELECT is_suspended, suspended_until
         FROM users
         WHERE id::text = $1::text`,
        [decoded.userId]
      );
      result.rows = result.rows.map((row) => ({ ...row, session_token: null }));
    }
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid token' });
    const user = result.rows[0];
    const blockedByFlag = user.is_suspended === true;
    const blockedByTime = user.suspended_until && new Date(user.suspended_until).getTime() > Date.now();
    if (blockedByFlag || blockedByTime) {
      return res.status(403).json({ error: 'Cuenta suspendida temporalmente' });
    }
    // Verificar sesión única: si el token de sesión no coincide, significa que
    // el usuario inició sesión desde otro dispositivo y esta sesión fue desplazada
    if (decoded.sessionToken && user.session_token && decoded.sessionToken !== user.session_token) {
      return res.status(401).json({ error: 'SESSION_DISPLACED', message: 'Tu sesión fue iniciada en otro dispositivo.' });
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

/**
 * Middleware para verificar que el usuario es admin
 */
export const requireAdmin = async (req, res, next) => {
  const token = getTokenFromRequest(req);

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    req.user = decoded;

    const result = await pool.query(
      `SELECT role, is_suspended, suspended_until
       FROM users
       WHERE id::text = $1::text`,
      [decoded.userId]
    );
    if (result.rows.length === 0 || result.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    const user = result.rows[0];
    const blockedByFlag = user.is_suspended === true;
    const blockedByTime = user.suspended_until && new Date(user.suspended_until).getTime() > Date.now();
    if (blockedByFlag || blockedByTime) {
      return res.status(403).json({ error: 'Admin suspendido' });
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

/**
 * Generar JWT con sessionToken embebido
 */
export const generateToken = (userId, sessionToken = null) => {
  return jwt.sign(
    { userId, sessionToken, iat: Math.floor(Date.now() / 1000) },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN }
  );
};

export default { verifyToken, requireAdmin, generateToken };
