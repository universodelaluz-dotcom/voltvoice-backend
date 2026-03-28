import axios from 'axios';

// Cache local de dominios ya verificados (30 min)
const domainCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000;

// Blacklist local de dominios conocidos temporales
const TEMPORARY_EMAIL_DOMAINS = new Set([
  'tempmail.com', '10minutemail.com', '10minutemail.net', '10minutemail.org',
  '10minutemail.co', '10minutemail.one', '10minemail.com', '10minutes.email',
  'throwaway.email', 'mailinator.com', 'maildrop.cc', 'sharklasers.com',
  'spam4.me', 'trashmail.com', 'yopmail.com', 'mailnesia.com',
  'temp-mail.org', 'temp-mail.io', 'temp-mail.in', 'temp-mail.de',
  'tempmail.email', 'mytrashmail.com', 'test.com', 'example.com',
  'guerrillamail.com', 'tempmail.io', 'tempmail.de', 'tempmail.net',
  'tempmail.so', '10minutemail.info', '10minutemail.fr', '10minutemail.it',
  '10minutemail.nl', '10minutemail.ru', '10minutemail.se', '10minutemail.de',
  '10minute-mail.ml', 'minute-email.de', 'guerrillamail.info', 'guerrillamail.net',
  'pokemail.net', 'tempail.com', 'maildisposable.com', 'emailondeck.com',
  'trashmail.de', 'yopmail.fr', 'yopmail.net', '33mail.com', 'mailsac.com',
  'temp-mail.com', 'disposablemail.com', 'fakeinbox.com', 'fake-email.pro',
  'freeemail.ir', 'freemail.ws', 'freemail.ms', 'mail-temp.com', 'mail.tm',
  'mail.gw', 'mvrht.com', 'grr.la', 'mailporary.com', 'minuteinbox.com',
  'email10min.com', 'trashlify.com', 'tmailor.com', 'lroid.com',
]);

export async function isTemporaryEmail(email) {
  if (!email || typeof email !== 'string') return true;

  const domain = email.toLowerCase().split('@')[1];
  if (!domain) return true;

  // Primero: verificar blacklist local
  if (TEMPORARY_EMAIL_DOMAINS.has(domain)) {
    return true;
  }

  // Segundo: verificar cache
  const cached = domainCache.get(domain);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.isDisposable;
  }

  // Tercero: consultar API isitadisposable.com
  try {
    const response = await axios.get(
      `https://isitadisposable.com/api/v1/?email=${encodeURIComponent(email)}`,
      { timeout: 3000 } // timeout de 3 segundos
    );

    const isDisposable = response.data.disposable === 'true' || response.data.disposable === true;

    // Guardar en cache
    domainCache.set(domain, {
      isDisposable,
      timestamp: Date.now()
    });

    return isDisposable;
  } catch (error) {
    console.warn(`[EmailValidator] API check failed for ${domain}:`, error.message);
    // Si falla la API, ser estricto: rechazar dominios desconocidos
    // Solo permitir dominios conocidos confiables
    const trustedDomains = new Set(['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com', 'icloud.com', 'protonmail.com']);
    return !trustedDomains.has(domain);
  }
}

export function validateEmailFormat(email) {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email) && email.length <= 255;
}

export function sanitizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}
