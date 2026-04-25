// Rutas de PayPal
import express from 'express';
import { createPaypalOrder, capturePaypalOrder } from '../services/paypalService.js';
import { config } from '../config.js';
import { verifyToken } from '../../middleware/auth.js';
import monitoring from '../services/monitoring.js';

const router = express.Router();

const getAllowedFrontendHosts = () => {
  const hosts = new Set(['streamvoicer.com', 'www.streamvoicer.com', 'voltvoice-frontend.vercel.app', 'localhost', '127.0.0.1']);
  try {
    const configuredHost = new URL(String(config.FRONTEND_URL || '').trim()).host;
    if (configuredHost) hosts.add(configuredHost);
  } catch (_) {}
  return hosts;
};

const resolveFrontendBaseUrl = (rawOrigin = '') => {
  const fallback = String(config.FRONTEND_URL || '').trim().replace(/\/+$/, '');
  const value = String(rawOrigin || '').trim();
  if (!value) return fallback;
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol)) return fallback;
    if (!getAllowedFrontendHosts().has(parsed.host)) return fallback;
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return fallback;
  }
};

const resolveFrontendReturnUrl = (rawUrl = '') => {
  const fallbackBase = resolveFrontendBaseUrl('');
  const fallback = `${fallbackBase}/`;
  const value = String(rawUrl || '').trim();
  if (!value) return fallback;
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol)) return fallback;
    if (!getAllowedFrontendHosts().has(parsed.host)) return fallback;
    const safePath = String(parsed.pathname || '/').replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${parsed.host}${safePath}`;
  } catch (_) {
    return fallback;
  }
};

const appendQueryParams = (baseUrl, params = {}) => {
  try {
    const target = new URL(baseUrl);
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      target.searchParams.set(String(key), String(value));
    });
    return target.toString();
  } catch (_) {
    return baseUrl;
  }
};

const resolvePublicBackendBaseUrl = (req) => {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req.get('host') || '';
  const proto = forwardedProto || req.protocol || 'https';
  if (host) return `${proto}://${host}`.replace(/\/+$/, '');
  return String(config.BACKEND_URL || '').trim().replace(/\/+$/, '');
};

const authMiddleware = (req, res, next) => {
  const hasAuthHeader = Boolean(req.headers.authorization);
  const hasAuthCookie = String(req.headers.cookie || '').includes(`${config.AUTH_COOKIE_NAME}=`);
  if (hasAuthHeader || hasAuthCookie) {
    return verifyToken(req, res, () => {
      req.userId = req.user.userId;
      next();
    });
  }

  if (config.isProduction) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  req.userId = userId;
  next();
};

const authOptionalMiddleware = (req, res, next) => {
  const hasAuthHeader = Boolean(req.headers.authorization);
  const hasAuthCookie = String(req.headers.cookie || '').includes(`${config.AUTH_COOKIE_NAME}=`);

  if (hasAuthHeader || hasAuthCookie) {
    return verifyToken(req, res, () => {
      req.userId = req.user?.userId;
      next();
    });
  }

  req.userId = null;
  next();
};

// GET - Obtener Client ID público (para cargar PayPal SDK en frontend)
router.get('/client-id', (req, res) => {
  const clientId = config.PAYPAL_CLIENT_ID;
  const mode = config.PAYPAL_MODE || 'sandbox';
  if (!clientId) return res.status(500).json({ error: 'PayPal not configured' });
  res.json({ clientId, mode });
});

// Return URL desde PayPal: captura server-side y redirige al frontend
router.get('/return', async (req, res) => {
  const orderId = String(req.query?.token || req.query?.orderId || '').trim();
  const frontendReturnUrl = resolveFrontendReturnUrl(req.query?.front_return || req.query?.frontend_return || '');
  if (!orderId) {
    return res.redirect(appendQueryParams(frontendReturnUrl, {
      payment: 'error',
      provider: 'paypal',
      reason: 'missing_order',
    }));
  }

  try {
    await capturePaypalOrder(orderId);
    return res.redirect(appendQueryParams(frontendReturnUrl, {
      payment: 'success',
      provider: 'paypal',
      captured: '1',
      token: orderId,
    }));
  } catch (error) {
    console.error('[PAYPAL] Return capture error:', error.message);
    monitoring.recordPaymentFailure({
      provider: 'paypal',
      action: 'return_capture',
      errorMessage: error.message,
    });
    return res.redirect(appendQueryParams(frontendReturnUrl, {
      payment: 'error',
      provider: 'paypal',
      reason: 'capture_failed',
    }));
  }
});

// Crear orden de PayPal (el frontend la crea via SDK popup)
router.post('/create-order', authMiddleware, async (req, res) => {
  try {
    const { tokensPackage, planId, billingCycle, itemType, couponCode, couponId, frontendOrigin, frontendReturnUrl, returnUrlBase } = req.body;
    if (!tokensPackage && !planId) return res.status(400).json({ error: 'Missing checkout item' });

    const backendBaseUrl = resolvePublicBackendBaseUrl(req);
    const clientIp = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || null;
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 500) || null;
    const result = await createPaypalOrder(
      req.userId,
      { tokensPackage, planId, billingCycle, itemType, couponCode, couponId },
      {
        backendBaseUrl,
        clientIp,
        userAgent,
        frontendOrigin: resolveFrontendBaseUrl(frontendOrigin || returnUrlBase),
        frontendReturnUrl: resolveFrontendReturnUrl(frontendReturnUrl || returnUrlBase),
      }
    );
    if (result.requiresPayment === false) {
      return res.json({
        success: true,
        requiresPayment: false,
        action: result.action,
        message: result.message,
        subscription: result.subscription,
        quote: result.quote
      });
    }

    res.json({
      success: true,
      requiresPayment: true,
      orderId: result.orderId,
      approvalUrl: result.approvalUrl,
      action: result.action,
      quote: result.quote
    });
  } catch (error) {
    console.error('[PAYPAL] Error creating order:', error.message);
    monitoring.recordPaymentFailure({
      provider: 'paypal',
      action: 'create_order',
      errorMessage: error.message,
      userId: req.userId,
    });
    const statusCode = Number(error?.statusCode || 500);
    res.status(statusCode).json({ error: error.message });
  }
});

// Capturar pago (después de que el usuario aprueba en el popup)
router.post('/capture-order', authOptionalMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

    const clientIp = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || null;
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 500) || null;
    const result = await capturePaypalOrder(orderId, { clientIp, userAgent });
    res.json({ success: true, result });
  } catch (error) {
    console.error('[PAYPAL] Error capturing order:', error.message);
    monitoring.recordPaymentFailure({
      provider: 'paypal',
      action: 'capture_order',
      errorMessage: error.message,
      userId: req.userId,
    });
    res.status(500).json({ error: error.message });
  }
});

export default router;
