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
  personalFreeTtlSeconds: 172800,
  personalPaidTtlSeconds: 604800,
  personalFreeMaxEntries: 200,
  personalPaidMaxEntries: 1000,
  globalMaxEntries: 1500,
  globalInactiveDays: 30,
  globalLowUsageThreshold: 8,
  subscriptionGraceDays: 15,
  purgePersonalizationAfterGrace: false,
  hotCacheMaxEntries: 1500,
  globalRepeatThreshold: 4,
  lookupTimeoutMs: 35,
};

class AudioCacheService {
  constructor() {
    this.hotCache = new Map();
    this.userPolicyCache = new Map();
    this.lastGlobalPruneAt = 0;
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
               personal_free_ttl_seconds, personal_paid_ttl_seconds, personal_free_max_entries, personal_paid_max_entries,
               global_max_entries, global_inactive_days, global_low_usage_threshold,
               subscription_grace_days, purge_personalization_after_grace,
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
          personalFreeTtlSeconds: Number(row.personal_free_ttl_seconds || row.personal_ttl_seconds || DEFAULT_SETTINGS.personalFreeTtlSeconds),
          personalPaidTtlSeconds: Number(row.personal_paid_ttl_seconds || DEFAULT_SETTINGS.personalPaidTtlSeconds),
          personalFreeMaxEntries: Number(row.personal_free_max_entries || DEFAULT_SETTINGS.personalFreeMaxEntries),
          personalPaidMaxEntries: Number(row.personal_paid_max_entries || DEFAULT_SETTINGS.personalPaidMaxEntries),
          globalMaxEntries: Number(row.global_max_entries || row.hot_cache_max_entries || DEFAULT_SETTINGS.globalMaxEntries),
          globalInactiveDays: Number(row.global_inactive_days || DEFAULT_SETTINGS.globalInactiveDays),
          globalLowUsageThreshold: Number(row.global_low_usage_threshold || DEFAULT_SETTINGS.globalLowUsageThreshold),
          subscriptionGraceDays: Number(row.subscription_grace_days || DEFAULT_SETTINGS.subscriptionGraceDays),
          purgePersonalizationAfterGrace: row.purge_personalization_after_grace === true,
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

  getCachedUserPolicy(userId) {
    const key = String(userId || '');
    if (!key) return null;
    const cached = this.userPolicyCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.userPolicyCache.delete(key);
      return null;
    }
    return cached.value;
  }

  setCachedUserPolicy(userId, policy, ttlMs = 15000) {
    const key = String(userId || '');
    if (!key) return;
    this.userPolicyCache.set(key, {
      value: policy,
      expiresAt: Date.now() + Math.max(1000, Number(ttlMs) || 15000),
    });
  }

  isPaidPlan(plan = '') {
    return ['start', 'creator', 'pro', 'admin'].includes(String(plan || '').toLowerCase());
  }

  async resolveUserPolicy(userId, settings) {
    const numericUserId = Number(userId);
    if (!Number.isFinite(numericUserId) || numericUserId <= 0) {
      return {
        userId: null,
        plan: 'free',
        tier: 'free',
        subscriptionEligible: false,
        graceActive: false,
      };
    }

    const cached = this.getCachedUserPolicy(numericUserId);
    if (cached) return cached;

    try {
      const timeoutMs = Math.max(10, Math.min(120, Number(settings?.lookupTimeoutMs || DEFAULT_SETTINGS.lookupTimeoutMs)));
      const policy = await this.withTimeout(this.resolveUserPolicyFromDb(numericUserId, settings).catch(() => null), timeoutMs);
      if (!policy) {
        const fallback = {
          userId: numericUserId,
          plan: 'free',
          tier: 'free',
          subscriptionEligible: false,
          graceActive: false,
          fallback: true,
        };
        this.setCachedUserPolicy(numericUserId, fallback, 5000);
        return fallback;
      }
      this.setCachedUserPolicy(numericUserId, policy);
      return policy;
    } catch {
      const fallback = {
        userId: numericUserId,
        plan: 'free',
        tier: 'free',
        subscriptionEligible: false,
        graceActive: false,
        fallback: true,
      };
      this.setCachedUserPolicy(numericUserId, fallback, 5000);
      return fallback;
    }
  }

  async resolveUserPolicyFromDb(userId, settings) {
    const userResult = await pool.query('SELECT plan FROM users WHERE id = $1 LIMIT 1', [userId]);
    if (!userResult.rows.length) {
      return {
        userId,
        plan: 'free',
        tier: 'free',
        subscriptionEligible: false,
        graceActive: false,
      };
    }

    const plan = String(userResult.rows[0].plan || 'free').toLowerCase();
    const paid = this.isPaidPlan(plan);

    if (paid) {
      pool.query(
        `INSERT INTO audio_cache_user_state (user_id, last_plan, last_paid_at, grace_until, last_checked_at)
         VALUES ($1, $2, NOW(), NULL, NOW())
         ON CONFLICT (user_id) DO UPDATE
         SET last_plan = EXCLUDED.last_plan,
             last_paid_at = NOW(),
             grace_until = NULL,
             grace_expired_at = NULL,
             last_checked_at = NOW()`,
        [userId, plan]
      ).catch(() => {});

      return {
        userId,
        plan,
        tier: 'paid',
        subscriptionEligible: true,
        graceActive: false,
      };
    }

    const stateResult = await pool.query(
      `SELECT last_paid_at, grace_until, grace_expired_at, last_reset_at
       FROM audio_cache_user_state
       WHERE user_id = $1`,
      [userId]
    );
    const state = stateResult.rows[0] || null;
    const nowMs = Date.now();
    const graceDays = Math.max(1, Number(settings?.subscriptionGraceDays || DEFAULT_SETTINGS.subscriptionGraceDays));

    if (!state?.last_paid_at) {
      pool.query(
        `INSERT INTO audio_cache_user_state (user_id, last_plan, last_checked_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_plan = EXCLUDED.last_plan, last_checked_at = NOW()`,
        [userId, plan]
      ).catch(() => {});

      return {
        userId,
        plan,
        tier: 'free',
        subscriptionEligible: false,
        graceActive: false,
      };
    }

    const lastPaidAtMs = new Date(state.last_paid_at).getTime();
    const computedGraceUntilMs = lastPaidAtMs + graceDays * 24 * 60 * 60 * 1000;
    const graceUntilMs = state.grace_until
      ? new Date(state.grace_until).getTime()
      : computedGraceUntilMs;

    if (!state.grace_until) {
      pool.query(
        `UPDATE audio_cache_user_state
         SET last_plan = $2,
             grace_until = to_timestamp($3 / 1000.0),
             last_checked_at = NOW()
         WHERE user_id = $1`,
        [userId, plan, graceUntilMs]
      ).catch(() => {});
    } else {
      pool.query(
        `UPDATE audio_cache_user_state SET last_plan = $2, last_checked_at = NOW() WHERE user_id = $1`,
        [userId, plan]
      ).catch(() => {});
    }

    if (graceUntilMs > nowMs) {
      return {
        userId,
        plan,
        tier: 'grace',
        subscriptionEligible: true,
        graceActive: true,
        graceUntil: new Date(graceUntilMs).toISOString(),
      };
    }

    pool.query(
      `UPDATE audio_cache_user_state
       SET grace_expired_at = COALESCE(grace_expired_at, NOW()),
           last_checked_at = NOW()
       WHERE user_id = $1`,
      [userId]
    ).catch(() => {});

    if (settings?.purgePersonalizationAfterGrace && (!state.last_reset_at || new Date(state.last_reset_at).getTime() < graceUntilMs)) {
      this.purgeUserPersonalization(userId).catch(() => {});
      pool.query(
        `UPDATE audio_cache_user_state
         SET last_reset_at = NOW(),
             last_checked_at = NOW()
         WHERE user_id = $1`,
        [userId]
      ).catch(() => {});
    }

    return {
      userId,
      plan,
      tier: 'free_after_grace',
      subscriptionEligible: false,
      graceActive: false,
      graceUntil: new Date(graceUntilMs).toISOString(),
    };
  }

  async purgeUserPersonalization(userId) {
    const numericUserId = Number(userId);
    if (!Number.isFinite(numericUserId) || numericUserId <= 0) return;
    try {
      await Promise.all([
        pool.query('DELETE FROM audio_cache_entries WHERE scope = $1 AND user_id = $2', ['personal', numericUserId]),
        pool.query('DELETE FROM user_voices WHERE user_id = $1', [numericUserId]),
        pool.query('DELETE FROM user_settings WHERE user_id = $1', [numericUserId]),
      ]);
    } catch (err) {
      console.warn('[AudioCache] purgeUserPersonalization failed:', err.message);
    }
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
    const numericUserId = Number(userId) || null;

    let userPolicy = null;
    if (scope === 'personal' && numericUserId) {
      userPolicy = await this.resolveUserPolicy(numericUserId, settings);
    }

    const requiresSubscription = scope === 'personal' && String(provider || '').toLowerCase() === 'inworld';
    const subscriptionAllowed = !requiresSubscription || (userPolicy?.subscriptionEligible === true);
    const enabled = settings.enabled && !!scope && cacheAllowedByText && subscriptionAllowed;
    const paramsHash = this.buildParamsHash(params);
    const cacheKey = enabled
      ? this.buildCacheKey({
          scope,
          userId: numericUserId,
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
      userId: numericUserId,
      voiceId: String(voiceId || ''),
      normalizedText,
      paramsHash,
      modelVersion: String(modelVersion || ''),
      userPolicy,
      requiresSubscription,
      cacheKey,
      cacheableBecauseText: cacheAllowedByText,
      skipReason: enabled
        ? null
        : (!settings.enabled
          ? 'cache_disabled'
          : (!scope
            ? 'unsupported_scope'
            : (!cacheAllowedByText
              ? textRule.reason
              : (!subscriptionAllowed ? 'subscription_required_for_personal_voice' : 'unknown')))),
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
      .map((key) => `${key} = audio_cache_runtime_stats.${key} + ${Math.trunc(Number(patch[key]))}`);

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

    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : Date.now() + 2 * 60 * 60 * 1000;
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

  computePolicyForStore(context) {
    if (context.scope === 'global') {
      return {
        ttlSeconds: null,
        maxEntries: Math.max(100, Number(context.settings.globalMaxEntries || DEFAULT_SETTINGS.globalMaxEntries)),
      };
    }

    const tier = context.userPolicy?.tier || 'free';
    const isPaidLike = tier === 'paid' || tier === 'grace';
    if (isPaidLike) {
      return {
        ttlSeconds: Math.max(60, Number(context.settings.personalPaidTtlSeconds || DEFAULT_SETTINGS.personalPaidTtlSeconds)),
        maxEntries: Math.max(10, Number(context.settings.personalPaidMaxEntries || DEFAULT_SETTINGS.personalPaidMaxEntries)),
      };
    }

    return {
      ttlSeconds: Math.max(60, Number(context.settings.personalFreeTtlSeconds || context.settings.personalTtlSeconds || DEFAULT_SETTINGS.personalFreeTtlSeconds)),
      maxEntries: Math.max(10, Number(context.settings.personalFreeMaxEntries || DEFAULT_SETTINGS.personalFreeMaxEntries)),
    };
  }

  async prunePersonalCache(userId, maxEntries) {
    const numericUserId = Number(userId);
    if (!Number.isFinite(numericUserId) || numericUserId <= 0) return;

    await pool.query(
      `DELETE FROM audio_cache_entries
       WHERE scope = 'personal' AND user_id = $1 AND expires_at IS NOT NULL AND expires_at <= NOW()`,
      [numericUserId]
    );

    await pool.query(
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (ORDER BY hits DESC, last_hit_at DESC, created_at DESC) AS rn
         FROM audio_cache_entries
         WHERE scope = 'personal' AND user_id = $1
       )
       DELETE FROM audio_cache_entries e
       USING ranked r
       WHERE e.id = r.id
         AND r.rn > $2`,
      [numericUserId, Math.max(1, Number(maxEntries) || 1)]
    );
  }

  async pruneGlobalCache(settings) {
    const now = Date.now();
    if (now - this.lastGlobalPruneAt < 60000) return;
    this.lastGlobalPruneAt = now;

    const inactiveDays = Math.max(1, Number(settings?.globalInactiveDays || DEFAULT_SETTINGS.globalInactiveDays));
    const lowUsageThreshold = Math.max(0, Number(settings?.globalLowUsageThreshold || DEFAULT_SETTINGS.globalLowUsageThreshold));
    const maxEntries = Math.max(100, Number(settings?.globalMaxEntries || DEFAULT_SETTINGS.globalMaxEntries));

    await pool.query(
      `DELETE FROM audio_cache_entries
       WHERE scope = 'global'
         AND last_hit_at < NOW() - ($1::int * INTERVAL '1 day')
         AND hits <= $2`,
      [inactiveDays, lowUsageThreshold]
    );

    await pool.query(
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (ORDER BY hits DESC, last_hit_at DESC, created_at DESC) AS rn
         FROM audio_cache_entries
         WHERE scope = 'global'
       )
       DELETE FROM audio_cache_entries e
       USING ranked r
       WHERE e.id = r.id
         AND r.rn > $1`,
      [maxEntries]
    );
  }

  async storeAfterRender(context, audioBuffer, contentType = 'audio/mpeg') {
    if (!context?.enabled || !context.cacheKey || !audioBuffer?.length) return;

    if (context.scope === 'global') {
      const shouldPromote = await this.shouldPromoteToGlobal(context);
      if (!shouldPromote) return;
    }

    const policy = this.computePolicyForStore(context);
    const ttlSeconds = policy.ttlSeconds;
    const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null;
    const hotExpiresAtMs = expiresAt ? expiresAt.getTime() : Date.now() + 2 * 60 * 60 * 1000;

    this.setHotCache(
      context.cacheKey,
      { audioBuffer, contentType, expiresAt: hotExpiresAtMs },
      context.settings.hotCacheMaxEntries
    );

    pool.query(
      `INSERT INTO audio_cache_entries
       (cache_key, scope, user_id, voice_id, text_normalized, params_hash, model_version, content_type, audio_data, char_count, expires_at, hits, last_hit_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, NOW())
       ON CONFLICT (cache_key) DO UPDATE
       SET content_type = EXCLUDED.content_type,
           audio_data = EXCLUDED.audio_data,
           char_count = EXCLUDED.char_count,
           expires_at = EXCLUDED.expires_at,
           model_version = EXCLUDED.model_version,
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

    if (context.scope === 'global') {
      this.pruneGlobalCache(context.settings).catch(() => {});
    } else if (context.scope === 'personal' && context.userId) {
      this.prunePersonalCache(context.userId, policy.maxEntries).catch(() => {});
    }
  }

  clearHotCache() {
    this.hotCache.clear();
    this.userPolicyCache.clear();
  }
}

export default new AudioCacheService();
