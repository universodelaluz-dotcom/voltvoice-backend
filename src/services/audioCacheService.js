import crypto from 'crypto';
import pool from '../db.js';

const NATURAL_INWORLD_VOICES = new Set(['Diego', 'Lupita', 'Miguel', 'Rafael']);
const LOCAL_VOICES = new Set(['es-ES', 'en-US', 'es-MX']);
const SETTINGS_CACHE_TTL_MS = 5000;

const DEFAULT_SETTINGS = {
  enabled: true,
  maxCacheableChars: 120,
  personalTtlSeconds: 86400,
  globalTtlSeconds: 604800,
  hotCacheMaxEntries: 1500,
  globalRepeatThreshold: 3,
  lookupTimeoutMs: 35,
};

class AudioCacheService {
  constructor() {
    this.hotCache = new Map();
    this.settingsCache = {
      loadedAt: 0,
      value: { ...DEFAULT_SETTINGS },
    };
  }

  isGreetingLike(text = '') {
    return /\b(hola|buenas|bienvenid|welcome|hello|gracias|thank you|saludos)\b/i.test(text);
  }

  isAlertOrNotificationLike(text = '') {
    return /\b(alerta|notificacion|donacion|follow|gift|regalo|suscriptor|subscriber|meta|goal|like|share|encuesta|poll)\b/i.test(text);
  }

  isCommonStreamResponse(text = '') {
    return /\b(gracias por|vamos|dale|empezamos|listos|siguiente|chat|stream|en vivo|live)\b/i.test(text);
  }

  normalizeText(text = '') {
    return String(text || '')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeParams(params = {}) {
    const normalized = {};
    const entries = Object.entries(params)
      .filter(([_, value]) => value !== undefined && value !== null && value !== '')
      .sort(([a], [b]) => a.localeCompare(b));

    for (const [key, value] of entries) {
      if (typeof value === 'number') {
        normalized[key] = Number(value.toFixed(4));
      } else if (typeof value === 'string') {
        normalized[key] = value.trim();
      } else if (typeof value === 'boolean') {
        normalized[key] = value;
      } else if (Array.isArray(value)) {
        normalized[key] = value.map((item) => String(item).trim());
      } else if (typeof value === 'object') {
        normalized[key] = this.normalizeParams(value);
      } else {
        normalized[key] = value;
      }
    }

    return normalized;
  }

  buildParamsHash(params = {}) {
    const payload = JSON.stringify(this.normalizeParams(params));
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  buildCacheKey({
    scope,
    userId,
    voiceId,
    normalizedText,
    paramsHash,
    modelVersion = '',
  }) {
    const raw = [
      'v1',
      scope,
      scope === 'personal' ? String(userId || '') : 'shared',
      String(voiceId || ''),
      String(modelVersion || ''),
      normalizedText,
      paramsHash,
    ].join('|');

    return `ac_${scope}_${crypto.createHash('sha256').update(raw).digest('hex')}`;
  }

  buildGlobalPhraseKey({ voiceId, normalizedText, paramsHash, modelVersion = '' }) {
    const raw = ['phrase_v1', String(voiceId || ''), String(modelVersion || ''), normalizedText, paramsHash].join('|');
    return `gp_${crypto.createHash('sha256').update(raw).digest('hex')}`;
  }

  isLocalVoice(voiceId) {
    return LOCAL_VOICES.has(String(voiceId || ''));
  }

  isNaturalInworldVoice(voiceId) {
    return NATURAL_INWORLD_VOICES.has(String(voiceId || ''));
  }

  isHighlyVariableText(text = '') {
    if (/(https?:\/\/|www\.)/i.test(text)) return true;
    if (/@\w+/.test(text) && /#[\w-]+/.test(text)) return true;
    const digits = (text.match(/\d/g) || []).length;
    const symbols = (text.match(/[^\p{L}\p{N}\s]/gu) || []).length;
    const len = Math.max(text.length, 1);
    return (digits + symbols) / len > 0.38;
  }

  shouldCacheText(normalizedText, maxCacheableChars) {
    if (!normalizedText) return { allowed: false, reason: 'empty' };
    if (normalizedText.length > maxCacheableChars) return { allowed: false, reason: 'too_long' };
    if (normalizedText.length < 2) return { allowed: false, reason: 'too_short' };
    if (this.isHighlyVariableText(normalizedText)) return { allowed: false, reason: 'high_variability' };

    const words = normalizedText.split(' ').filter(Boolean).length;
    const greetingLike = this.isGreetingLike(normalizedText);
    const alertLike = this.isAlertOrNotificationLike(normalizedText);
    const commonLike = this.isCommonStreamResponse(normalizedText);
    const shortPhrase = normalizedText.length <= 80 && words <= 14;
    const longImprovised = normalizedText.length > 95 || words > 20;

    if (longImprovised && !alertLike) {
      return { allowed: false, reason: 'likely_unique_long_form' };
    }

    if (shortPhrase || greetingLike || alertLike || commonLike) {
      return { allowed: true, reason: 'stream_friendly_phrase' };
    }

    return { allowed: true, reason: 'generic_short_text' };
  }

  async getSettings(force = false) {
    const now = Date.now();
    if (!force && now - this.settingsCache.loadedAt < SETTINGS_CACHE_TTL_MS) {
      return this.settingsCache.value;
    }

    try {
      const result = await pool.query(`
        SELECT enabled, max_cacheable_chars, personal_ttl_seconds, global_ttl_seconds,
               hot_cache_max_entries, global_repeat_threshold, lookup_timeout_ms
        FROM audio_cache_settings
        WHERE id = 1
      `);

      if (result.rows.length > 0) {
        const row = result.rows[0];
        this.settingsCache.value = {
          enabled: row.enabled !== false,
          maxCacheableChars: Number(row.max_cacheable_chars || DEFAULT_SETTINGS.maxCacheableChars),
          personalTtlSeconds: Number(row.personal_ttl_seconds || DEFAULT_SETTINGS.personalTtlSeconds),
          globalTtlSeconds: Number(row.global_ttl_seconds || DEFAULT_SETTINGS.globalTtlSeconds),
          hotCacheMaxEntries: Number(row.hot_cache_max_entries || DEFAULT_SETTINGS.hotCacheMaxEntries),
          globalRepeatThreshold: Number(row.global_repeat_threshold || DEFAULT_SETTINGS.globalRepeatThreshold),
          lookupTimeoutMs: Number(row.lookup_timeout_ms || DEFAULT_SETTINGS.lookupTimeoutMs),
        };
      } else {
        this.settingsCache.value = { ...DEFAULT_SETTINGS };
      }
    } catch (err) {
      console.warn('[AudioCache] Using default settings due to DB error:', err.message);
      this.settingsCache.value = { ...DEFAULT_SETTINGS };
    }

    this.settingsCache.loadedAt = now;
    return this.settingsCache.value;
  }

  pruneHotCache(maxEntries) {
    while (this.hotCache.size > maxEntries) {
      const oldestKey = this.hotCache.keys().next().value;
      if (!oldestKey) break;
      this.hotCache.delete(oldestKey);
    }
  }

  getFromHotCache(cacheKey, nowMs = Date.now()) {
    const hit = this.hotCache.get(cacheKey);
    if (!hit) return null;

    if (hit.expiresAt <= nowMs) {
      this.hotCache.delete(cacheKey);
      return null;
    }

    this.hotCache.delete(cacheKey);
    this.hotCache.set(cacheKey, hit);
    return hit;
  }

  setHotCache(cacheKey, value, maxEntries) {
    this.hotCache.set(cacheKey, value);
    this.pruneHotCache(maxEntries);
  }

  resolveScope({ voiceId, provider, userId }) {
    const normalizedProvider = String(provider || '').toLowerCase();
    const hasUser = Number.isFinite(Number(userId)) && Number(userId) > 0;

    if (normalizedProvider === 'local' || this.isLocalVoice(voiceId)) {
      return hasUser ? 'personal' : null;
    }

    if (normalizedProvider === 'inworld') {
      if (this.isNaturalInworldVoice(voiceId)) return 'global';
      return hasUser ? 'personal' : null;
    }

    return null;
  }

  async prepareContext({
    provider,
    userId,
    voiceId,
    text,
    params = {},
    modelVersion = '',
  }) {
    const settings = await this.getSettings();
    const normalizedText = this.normalizeText(text);
    const scope = this.resolveScope({ voiceId, provider, userId });
    const textRule = this.shouldCacheText(normalizedText, settings.maxCacheableChars);
    const cacheAllowedByText = textRule.allowed;
    const enabled = settings.enabled && !!scope && cacheAllowedByText;
    const paramsHash = this.buildParamsHash(params);
    const cacheKey = enabled
      ? this.buildCacheKey({
          scope,
          userId,
          voiceId,
          normalizedText,
          paramsHash,
          modelVersion,
        })
      : null;

    return {
      enabled,
      settings,
      provider: String(provider || ''),
      scope,
      userId: Number(userId) || null,
      voiceId: String(voiceId || ''),
      normalizedText,
      paramsHash,
      modelVersion: String(modelVersion || ''),
      cacheKey,
      cacheableBecauseText: cacheAllowedByText,
      skipReason: enabled ? null : (!settings.enabled ? 'cache_disabled' : (!scope ? 'unsupported_scope' : textRule.reason)),
      allowReason: textRule.reason,
      phraseKey: this.buildGlobalPhraseKey({ voiceId, normalizedText, paramsHash, modelVersion }),
    };
  }

  trackMetric(patch = {}) {
    const keys = [
      'total_requests',
      'cacheable_requests',
      'bypassed_requests',
      'hot_hits',
      'persistent_hits',
      'misses',
      'rendered_requests',
      'saved_render_count',
      'tokens_saved_estimate',
      'chars_served_from_cache'
    ];

    const increments = keys
      .filter((key) => Number.isFinite(Number(patch[key])) && Number(patch[key]) !== 0)
      .map((key) => `${key} = ${key} + ${Math.trunc(Number(patch[key]))}`);

    if (!increments.length) return;

    const query = `
      INSERT INTO audio_cache_runtime_stats
      (id, total_requests, cacheable_requests, bypassed_requests, hot_hits, persistent_hits, misses, rendered_requests, saved_render_count, tokens_saved_estimate, chars_served_from_cache, updated_at)
      VALUES (1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NOW())
      ON CONFLICT (id) DO UPDATE
      SET ${increments.join(', ')}, updated_at = NOW()
    `;

    pool.query(query).catch(() => {});
  }

  withTimeout(promise, timeoutMs) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  }

  async lookupPersistent(cacheKey, timeoutMs) {
    const query = pool.query(
      `SELECT cache_key, content_type, audio_data, expires_at
       FROM audio_cache_entries
       WHERE cache_key = $1
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [cacheKey]
    );

    const result = await this.withTimeout(query, timeoutMs);
    if (!result || !result.rows || result.rows.length === 0) return null;
    return result.rows[0];
  }

  async lookup(context) {
    this.trackMetric({
      total_requests: 1,
      cacheable_requests: context?.enabled ? 1 : 0,
      bypassed_requests: context?.enabled ? 0 : 1,
    });

    if (!context?.enabled || !context.cacheKey) {
      return { hit: false, source: 'none' };
    }

    const hotHit = this.getFromHotCache(context.cacheKey);
    if (hotHit) {
      this.trackMetric({
        hot_hits: 1,
        saved_render_count: 1,
        chars_served_from_cache: context.normalizedText.length,
        tokens_saved_estimate: context.provider === 'inworld' ? context.normalizedText.length : 0,
      });
      return {
        hit: true,
        source: 'hot',
        contentType: hotHit.contentType,
        audioBuffer: hotHit.audioBuffer,
      };
    }

    const row = await this.lookupPersistent(context.cacheKey, context.settings.lookupTimeoutMs);
    if (!row) {
      this.trackMetric({ misses: 1 });
      return { hit: false, source: 'miss' };
    }

    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : Date.now() + 60000;
    const audioBuffer = Buffer.isBuffer(row.audio_data)
      ? row.audio_data
      : Buffer.from(row.audio_data || '', 'base64');

    this.setHotCache(
      context.cacheKey,
      { audioBuffer, contentType: row.content_type || 'audio/mpeg', expiresAt },
      context.settings.hotCacheMaxEntries
    );

    this.trackMetric({
      persistent_hits: 1,
      saved_render_count: 1,
      chars_served_from_cache: context.normalizedText.length,
      tokens_saved_estimate: context.provider === 'inworld' ? context.normalizedText.length : 0,
    });

    pool.query(
      `UPDATE audio_cache_entries
       SET hits = hits + 1, last_hit_at = NOW()
       WHERE cache_key = $1`,
      [context.cacheKey]
    ).catch(() => {});

    return {
      hit: true,
      source: 'persistent',
      contentType: row.content_type || 'audio/mpeg',
      audioBuffer,
    };
  }

  async shouldPromoteToGlobal(context) {
    if (!context?.enabled || context.scope !== 'global') return false;

    try {
      const result = await pool.query(
        `INSERT INTO audio_cache_phrase_stats (phrase_key, voice_id, text_normalized, params_hash, model_version, seen_count, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, 1, NOW())
         ON CONFLICT (phrase_key) DO UPDATE
         SET seen_count = audio_cache_phrase_stats.seen_count + 1,
             last_seen_at = NOW()
         RETURNING seen_count`,
        [context.phraseKey, context.voiceId, context.normalizedText, context.paramsHash, context.modelVersion]
      );
      const seenCount = Number(result.rows[0]?.seen_count || 1);
      return seenCount >= context.settings.globalRepeatThreshold;
    } catch (err) {
      console.warn('[AudioCache] Global phrase tracking failed:', err.message);
      return false;
    }
  }

  async storeAfterRender(context, audioBuffer, contentType = 'audio/mpeg') {
    if (!context?.enabled || !context.cacheKey || !audioBuffer?.length) return;

    if (context.scope === 'global') {
      const shouldPromote = await this.shouldPromoteToGlobal(context);
      if (!shouldPromote) return;
    }

    const ttlSeconds = context.scope === 'personal'
      ? context.settings.personalTtlSeconds
      : context.settings.globalTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    this.setHotCache(
      context.cacheKey,
      { audioBuffer, contentType, expiresAt: expiresAt.getTime() },
      context.settings.hotCacheMaxEntries
    );

    this.trackMetric({ rendered_requests: 1 });

    pool.query(
      `INSERT INTO audio_cache_entries
       (cache_key, scope, user_id, voice_id, text_normalized, params_hash, model_version, content_type, audio_data, char_count, expires_at, hits, last_hit_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, NOW())
       ON CONFLICT (cache_key) DO UPDATE
       SET content_type = EXCLUDED.content_type,
           audio_data = EXCLUDED.audio_data,
           char_count = EXCLUDED.char_count,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
      [
        context.cacheKey,
        context.scope,
        context.scope === 'personal' ? context.userId : null,
        context.voiceId,
        context.normalizedText,
        context.paramsHash,
        context.modelVersion,
        contentType,
        audioBuffer,
        context.normalizedText.length,
        expiresAt,
      ]
    ).catch((err) => {
      console.warn('[AudioCache] Persistent store failed:', err.message);
    });
  }

  clearHotCache() {
    this.hotCache.clear();
  }
}

export default new AudioCacheService();
