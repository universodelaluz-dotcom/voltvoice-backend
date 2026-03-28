// Blacklist de proveedores de email temporales/desechables
const TEMPORARY_EMAIL_DOMAINS = new Set([
  // Proveedores comunes de email temporal
  'tempmail.com',
  '10minutemail.com',
  '10minutemail.net',
  '10minutemail.org',
  '10minutemail.co',
  '10minutemail.one',
  '10minemail.com',
  '10minutes.email',
  'throwaway.email',
  'mailinator.com',
  'maildrop.cc',
  'sharklasers.com',
  'spam4.me',
  'trashmail.com',
  'yopmail.com',
  'mailnesia.com',
  'temp-mail.org',
  'temp-mail.io',
  'temp-mail.in',
  'temp-mail.de',
  'tempmail.email',
  'mytrashmail.com',
  'grocerycouponnetwork.com',
  'test.com',
  'example.com',
  'guerrillamail.com',
  'tempmail.io',
  'tempmail.de',
  'tempmail.net',
  'tempmail.so',
  '10minutemail.info',
  '10minutemail.fr',
  '10minutemail.it',
  '10minutemail.nl',
  '10minutemail.ru',
  '10minutemail.se',
  '10minutemail.de',
  '10minute-mail.ml',
  'minute-email.de',
  'guerrillamail.info',
  'guerrillamail.net',
  'pokemail.net',
  'tempail.com',
  'maildisposable.com',
  'emailondeck.com',
  'trashmail.de',
  'yopmail.fr',
  'yopmail.net',
  '33mail.com',
  'mailsac.com',
  'temp-mail.com',
  'disposablemail.com',
  'fakeinbox.com',
  'fake-email.pro',
  'freeemail.ir',
  'freemail.ws',
  'freemail.ms',
  'mail-temp.com',
  'mail.tm',
  'mail.gw',
  'mvrht.com',
  'grr.la',
  'mailporary.com',
  'minuteinbox.com',
  'email10min.com',
  'trashlify.com',
  'tmailor.com',
  'lroid.com',
  'protonmail.com',
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
