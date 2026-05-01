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
  RECAPTCHA_REQUIRED_IN_DEV: parseBoolean(process.env.RECAPTCHA_REQUIRED_IN_DEV, false),

  // APIs
  YOUTUBE_API_KEYS: [
    process.env.YOUTUBE_API_KEY_1,
    process.env.YOUTUBE_API_KEY_2,
    process.env.YOUTUBE_API_KEY_3,
    process.env.YOUTUBE_API_KEY_4,
  ].filter(Boolean),
  YOUTUBE_OAUTH_REDIRECT_URI: process.env.YOUTUBE_OAUTH_REDIRECT_URI || 'http://localhost:3000/api/youtube/auth/callback',
  YOUTUBE_FRONTEND_SUCCESS_URL: process.env.YOUTUBE_FRONTEND_SUCCESS_URL || 'http://localhost:5173/youtube/',
  YOUTUBE_FRONTEND_ERROR_URL: process.env.YOUTUBE_FRONTEND_ERROR_URL || 'http://localhost:5173/youtube/',

  // Stripe
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,

  // Mercado Pago
  MERCADO_PAGO_ACCESS_TOKEN: process.env.MERCADO_PAGO_ACCESS_TOKEN,
  MERCADO_PAGO_WEBHOOK_SECRET: process.env.MERCADO_PAGO_WEBHOOK_SECRET,
  MERCADO_PAGO_CURRENCY: String(process.env.MERCADO_PAGO_CURRENCY || 'MXN').trim().toUpperCase(),
  MERCADO_PAGO_USD_MXN_RATE: Number(process.env.MERCADO_PAGO_USD_MXN_RATE || 17),

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
  FREE_CACHE_INACTIVE_PURGE_DAYS: Number(process.env.FREE_CACHE_INACTIVE_PURGE_DAYS || 15),
  FREE_ACCOUNT_DELETE_INACTIVE_DAYS: Number(process.env.FREE_ACCOUNT_DELETE_INACTIVE_DAYS || 30),
  LAPSED_PAID_CACHE_PURGE_DAYS: Number(process.env.LAPSED_PAID_CACHE_PURGE_DAYS || 30),
  LAPSED_PAID_ACCOUNT_DELETE_DAYS: Number(process.env.LAPSED_PAID_ACCOUNT_DELETE_DAYS || 45),
  INACTIVE_CLEANUP_INTERVAL_MINUTES: Number(process.env.INACTIVE_CLEANUP_INTERVAL_MINUTES || 60),
  INACTIVE_CLEANUP_BATCH_SIZE: Number(process.env.INACTIVE_CLEANUP_BATCH_SIZE || 200),

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
