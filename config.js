import dotenv from 'dotenv';

dotenv.config();

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

export const config = {
  // Server
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || 5000,
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:5000',

  // Database
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  // Auth
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  AUTH_COOKIE_NAME: process.env.AUTH_COOKIE_NAME || 'vv_auth',
  AUTH_COOKIE_DOMAIN: process.env.AUTH_COOKIE_DOMAIN || '',
  AUTH_COOKIE_SAMESITE: process.env.AUTH_COOKIE_SAMESITE || (process.env.NODE_ENV === 'production' ? 'None' : 'Lax'),
  AUTH_COOKIE_SECURE: parseBoolean(process.env.AUTH_COOKIE_SECURE, process.env.NODE_ENV === 'production'),
  AUTH_INCLUDE_TOKEN_RESPONSE: parseBoolean(process.env.AUTH_INCLUDE_TOKEN_RESPONSE, true),
  RECAPTCHA_REQUIRED_IN_PROD: parseBoolean(process.env.RECAPTCHA_REQUIRED_IN_PROD, true),

  // APIs
  YOUTUBE_API_KEYS: [
    process.env.YOUTUBE_API_KEY_1,
    process.env.YOUTUBE_API_KEY_2,
    process.env.YOUTUBE_API_KEY_3,
    process.env.YOUTUBE_API_KEY_4,
  ].filter(Boolean),

  // Stripe
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,

  // Mercado Pago
  MERCADO_PAGO_ACCESS_TOKEN: process.env.MERCADO_PAGO_ACCESS_TOKEN,

  // PayPal
  PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE: process.env.PAYPAL_MODE || 'sandbox',

  // Google TTS
  GOOGLE_TTS_LANG: process.env.GOOGLE_TTS_LANG || 'es-MX',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL || '',

  // Security / Rate limiting
  TRUST_PROXY: parseBoolean(process.env.TRUST_PROXY, true),
  GLOBAL_RATE_LIMIT_WINDOW_MS: Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  GLOBAL_RATE_LIMIT_MAX_REQUESTS: Number(process.env.GLOBAL_RATE_LIMIT_MAX_REQUESTS || 300),

  // Operations
  DB_BACKUP_RETENTION_DAYS: Number(process.env.DB_BACKUP_RETENTION_DAYS || 7),

  // Validation
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV === 'development',
};

// Validate required env vars
const required = ['JWT_SECRET'];
const missing = required.filter(key => !process.env[key]);

if (missing.length > 0 && config.isProduction) {
  throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}
