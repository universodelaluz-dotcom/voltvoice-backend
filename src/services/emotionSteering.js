// === Detector de emoción para steering de Inworld TTS-2 ===
// EXPERIMENTAL. Lee pistas del texto (signos, MAYÚSCULAS, emojis, palabras clave)
// y devuelve una instrucción de steering EN INGLÉS para anteponer al texto.
//
// Reglas importantes confirmadas con la doc oficial de Inworld:
//  - Solo funciona bien en el modelo inworld-tts-2 (en otros se leería en voz alta).
//  - La instrucción debe ir EN INGLÉS aunque el texto sea español.
//  - Un solo tag, al inicio del texto.
//  - Si no hay una señal clara de emoción, NO se mete tag (se queda neutral).
//
// Para afinar: edita las listas de emojis/palabras o los textos de steering.
// Para desactivar: en VOICE_EXPERIMENTS quita el flag `steer` de la voz.

const ANGRY_EMOJIS = ['😡', '🤬', '👿', '💢', '😤', '👊'];
const EXCITED_EMOJIS = ['🎉', '🤩', '😎', '🙌', '💪', '⚡', '🚀', '✨', '🔥'];
const LAUGH_EMOJIS = ['😂', '🤣', '😆', '😹', '😄'];
const SAD_EMOJIS = ['😢', '😭', '😔', '💔', '🥺', '😞'];
const SURPRISE_EMOJIS = ['😮', '😱', '😲', '🤯', '😳'];
const LOVE_EMOJIS = ['🥰', '😍', '❤️', '💕', '💖', '😘', '💗'];

const ANGRY_WORDS = /\b(c[aá]llate|idiota|est[uú]pido|odio|maldito|basta|c[aá]llense|imb[eé]cil|p[eé]simo|asco)\b/i;
const EXCITED_WORDS = /\b(vamos|wow|incre[ií]ble|brutal|genial|epic[oa]|vamo+s|eso+|grande|crack|d[ií]os)\b/i;
const SAD_WORDS = /\b(triste|lo siento|perd[oó]n|qu[eé] pena|extra[ñn]o|llor[ao]|deprimid[oa])\b/i;
const SURPRISE_WORDS = /\b(no manches|en serio|no puede ser|qu[eé]\?|c[oó]mo\?|wtf|qu[eé] dices)\b/i;
const LOVE_WORDS = /\b(te amo|te quiero|linda|hermosa|preciosa|gracias|bonita|amor)\b/i;
const LAUGH_WORDS = /(jaja|jeje|jiji|jaja|haha|hehe|lol|lmao|xd|ptm jaja)/i;

const STEERING = {
  angry: '[say angrily, with intensity and force] ',
  excited: '[say with high energy and excitement] ',
  laugh: '[say with amusement, lightly laughing] ',
  sad: '[say sadly, in a low and subdued voice] ',
  surprise: '[say with surprise and disbelief] ',
  love: '[say warmly and affectionately] ',
};

function hasAny(text, list) {
  return list.some((token) => text.includes(token));
}

function hasShoutingCaps(text) {
  // Una palabra de 3+ letras totalmente en mayúsculas (excluye URLs/@menciones simples)
  return /\b[A-ZÁÉÍÓÚÑ]{3,}\b/.test(text);
}

/**
 * Devuelve el prefijo de steering (con espacio final) o '' si no hay emoción clara.
 * @param {string} rawText
 * @returns {{ tag: string, emotion: string|null }}
 */
export function detectSteering(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) return { tag: '', emotion: null };

  const exclamations = (text.match(/!/g) || []).length;

  // Prioridad: enojo > emoción fuerte > risa > tristeza > sorpresa > cariño
  if (hasAny(text, ANGRY_EMOJIS) || /!{3,}/.test(text) || ANGRY_WORDS.test(text) || (hasShoutingCaps(text) && exclamations >= 1)) {
    return { tag: STEERING.angry, emotion: 'angry' };
  }
  if (hasAny(text, EXCITED_EMOJIS) || exclamations >= 2 || EXCITED_WORDS.test(text)) {
    return { tag: STEERING.excited, emotion: 'excited' };
  }
  if (hasAny(text, LAUGH_EMOJIS) || LAUGH_WORDS.test(text)) {
    return { tag: STEERING.laugh, emotion: 'laugh' };
  }
  if (hasAny(text, SAD_EMOJIS) || SAD_WORDS.test(text)) {
    return { tag: STEERING.sad, emotion: 'sad' };
  }
  if (hasAny(text, SURPRISE_EMOJIS) || /\?{2,}/.test(text) || SURPRISE_WORDS.test(text)) {
    return { tag: STEERING.surprise, emotion: 'surprise' };
  }
  if (hasAny(text, LOVE_EMOJIS) || LOVE_WORDS.test(text)) {
    return { tag: STEERING.love, emotion: 'love' };
  }

  return { tag: '', emotion: null };
}

export default { detectSteering };
