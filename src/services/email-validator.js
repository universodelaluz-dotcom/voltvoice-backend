// Blacklist de proveedores de email temporales/desechables
const TEMPORARY_EMAIL_DOMAINS = new Set([
  // Proveedores comunes de email temporal
  'tempmail.com',
  '10minutemail.com',
  'throwaway.email',
  'mailinator.com',
  'maildrop.cc',
  'sharklasers.com',
  'spam4.me',
  'trashmail.com',
  'yopmail.com',
  'mailnesia.com',
  'temp-mail.org',
  'tempmail.email',
  'mytrashmail.com',
  'grocerycouponnetwork.com',
  'test.com',
  'example.com',
  'guerrillamail.com',
  'mailinator.com',
  '10minutemail.info',
  '10minute-mail.ml',
  'mvrht.com',
  'grr.la',
  '10minutemail.de',
  'minute-email.de',
  '10minutemail.fr',
  '10minutemail.it',
  '10minutemail.nl',
  '10minutemail.ru',
  '10minutemail.se',
  'guerrillamail.info',
  'pokemail.net',
  'spam4.me',
  'tempail.com',
  'temp-mail.io',
  'maildisposable.com',
  'emailondeck.com',
  'guerrillamail.net',
  'sharklasers.com',
  'mailnesia.com',
  'trashmail.de',
  'yopmail.fr',
  'yopmail.net',
  '33mail.com',
  'mailsac.com',
  'temp-mail.com',
  'disposablemail.com',
  'fakeinbox.com',
  'freeemail.ir',
  'freemail.ws',
  'freemail.ms',
  'mail-temp.com',
  'mail.tm',
  'protonmail.com', // Para testing/no verificados
  'protonmailrmez3btf.onion',
]);

export function isTemporaryEmail(email) {
  if (!email || typeof email !== 'string') return true;

  const domain = email.toLowerCase().split('@')[1];
  if (!domain) return true;

  return TEMPORARY_EMAIL_DOMAINS.has(domain);
}

export function validateEmailFormat(email) {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email) && email.length <= 255;
}

export function sanitizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}
