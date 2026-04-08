const MAX_TTS_TEXT_LENGTH = 200;

export const buildGoogleTtsUrl = (text, lang = 'es-MX') => {
  const normalized = String(text || '').trim();
  if (!normalized) {
    throw new Error('Text cannot be empty');
  }

  const safeText = normalized.length > MAX_TTS_TEXT_LENGTH
    ? normalized.slice(0, MAX_TTS_TEXT_LENGTH)
    : normalized;

  const params = new URLSearchParams({
    ie: 'UTF-8',
    q: safeText,
    tl: lang,
    client: 'tw-ob'
  });

  return `https://translate.google.com/translate_tts?${params.toString()}`;
};

export default { buildGoogleTtsUrl };
