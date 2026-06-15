// === Resolución de configuración de voz por usuario ===
// Lee la config global del usuario (tabla user_settings.config) y la traduce a
// las opciones que entiende el sintetizador de Inworld.
//
// Diseño (acordado): un solo switch "modo emociones" controla modelo + steering,
// porque el steering SOLO es seguro en tts-2 (en 1.5-max los tags se leerían en voz alta).
//   - emotionMode OFF (default) -> 1.5-max realista, sin steering.
//   - emotionMode ON            -> tts-2, con detector de emoción.
// La temperatura es un control aparte (slider), aplica en cualquiera de los dos modos.

import pool from '../db.js';

export const REALISTIC_MODEL = process.env.INWORLD_MODEL || 'inworld-tts-1.5-max';
export const EMOTION_MODEL = 'inworld-tts-2';
export const DEFAULT_TEMPERATURE = 0.98;
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 2;

/**
 * Traduce el objeto config (JSON guardado del usuario) a opciones de síntesis.
 * @param {object} config
 * @returns {{ emotionMode: boolean, modelId: string, temperature: number, steer: boolean }}
 */
export function resolveVoiceOptions(config = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const emotionMode = cfg.emotionMode === true || cfg.emotionMode === 'true';

  let temperature = Number(cfg.voiceTemperature);
  if (!Number.isFinite(temperature)) temperature = DEFAULT_TEMPERATURE;
  temperature = Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, temperature));

  return {
    emotionMode,
    modelId: emotionMode ? EMOTION_MODEL : REALISTIC_MODEL,
    temperature,
    steer: emotionMode,
  };
}

/**
 * Carga la config del usuario desde la BD y devuelve las opciones resueltas.
 * Si no hay usuario o falla la consulta, devuelve los defaults (realista, 0.98, sin emoción).
 * @param {number|string} userId
 */
export async function loadUserVoiceOptions(userId) {
  if (!userId) return resolveVoiceOptions({});
  try {
    const r = await pool.query('SELECT config FROM user_settings WHERE user_id = $1', [userId]);
    let cfg = r.rows[0]?.config || {};
    if (typeof cfg === 'string') {
      try { cfg = JSON.parse(cfg); } catch { cfg = {}; }
    }
    return resolveVoiceOptions(cfg);
  } catch (e) {
    console.warn('[voiceConfig] No se pudo cargar config del usuario, usando defaults:', e.message);
    return resolveVoiceOptions({});
  }
}

export default { resolveVoiceOptions, loadUserVoiceOptions, REALISTIC_MODEL, EMOTION_MODEL, DEFAULT_TEMPERATURE };
