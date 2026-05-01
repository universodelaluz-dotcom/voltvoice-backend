import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { google } from 'googleapis';
import pool from '../db.js';
import { config } from '../../config.js';

/**
 * IMPORTANT: YouTube voice synthesis security
 * - Google TTS (tts/say) is free but limited to 2hrs/day for FREE users
 * - If adding Inworld TTS endpoints to YouTube, they MUST require auth and deduct tokens
 * - Follow the same pattern as /api/tiktok/message and /api/inworld/tts
 * - Always verify userId exists before any synthesis
 **/

const router = Router();
const liveChatSessions = new Map(); // userId -> { liveChatId, videoId, nextPageToken, connectedAt }

const YT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

const parseCookieHeader = (cookieHeader = '') => {
  if (!cookieHeader || typeof cookieHeader !== 'string') return {};
  return cookieHeader.split(';').reduce((acc, pair) => {
    const index = pair.indexOf('=');
    if (index < 0) return acc;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key) return acc;
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
};

const getUserIdFromRequest = (req) => {
  const authHeader = String(req.headers.authorization || '').trim();
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const cookieToken = parseCookieHeader(req.headers.cookie || '')[config.AUTH_COOKIE_NAME] || '';
  const queryToken = String(req.query.authToken || req.body?.authToken || '').trim();
  const token = bearerToken || cookieToken || queryToken;
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    const userId = Number(decoded?.userId || decoded?.id);
    return Number.isFinite(userId) && userId > 0 ? userId : null;
  } catch {
    return null;
  }
};

const getOauthClient = () => {
  const clientId = String(process.env.YOUTUBE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.YOUTUBE_CLIENT_SECRET || '').trim();
  const redirectUri = String(
    process.env.YOUTUBE_OAUTH_REDIRECT_URI
    || config.YOUTUBE_OAUTH_REDIRECT_URI
    || 'http://localhost:3000/api/youtube/auth/callback'
  ).trim();

  if (!clientId || !clientSecret || !redirectUri) {
    return { client: null, error: 'YouTube OAuth no configurado en backend' };
  }

  return { client: new google.auth.OAuth2(clientId, clientSecret, redirectUri), error: null };
};

const signState = (payload) => jwt.sign(payload, config.JWT_SECRET, { expiresIn: '10m' });

const verifyState = (raw) => {
  try {
    return jwt.verify(String(raw || ''), config.JWT_SECRET);
  } catch {
    return null;
  }
};

const sanitizeReturnUrl = (value = '') => {
  const raw = String(value || '').trim();
  const defaultYoutubeReturn = 'http://localhost:5173/youtube/';

  const enforceYoutubePath = (urlString) => {
    try {
      const parsed = new URL(urlString);
      const normalizedPath = String(parsed.pathname || '');
      if (!normalizedPath.startsWith('/youtube')) {
        parsed.pathname = '/youtube/';
        parsed.search = '';
      }
      return parsed.toString();
    } catch {
      return defaultYoutubeReturn;
    }
  };

  if (!raw) return enforceYoutubePath(config.YOUTUBE_FRONTEND_SUCCESS_URL || defaultYoutubeReturn);
  try {
    const parsed = new URL(raw);
    const allowed = new Set([
      'http://localhost:5173',
      'http://localhost:3000',
      'https://voltvoice-frontend.vercel.app',
      'https://streamvoicer.com',
      'https://www.streamvoicer.com',
    ]);
    if (!allowed.has(parsed.origin)) {
      return enforceYoutubePath(config.YOUTUBE_FRONTEND_SUCCESS_URL || defaultYoutubeReturn);
    }
    return enforceYoutubePath(parsed.toString());
  } catch {
    return enforceYoutubePath(config.YOUTUBE_FRONTEND_SUCCESS_URL || defaultYoutubeReturn);
  }
};

const parseYoutubeVideoId = (rawInput = '') => {
  const input = String(rawInput || '').trim();
  if (!input) return '';

  const directId = input.match(/^[A-Za-z0-9_-]{11}$/);
  if (directId) return directId[0];

  try {
    const url = new URL(input);
    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.split('/').filter(Boolean)[0] || '';
      if (id.length >= 6) return id.slice(0, 11);
    }
    const byV = url.searchParams.get('v');
    if (byV && byV.length >= 6) return byV.slice(0, 11);
    const parts = url.pathname.split('/').filter(Boolean);
    const shortsIndex = parts.indexOf('shorts');
    if (shortsIndex >= 0 && parts[shortsIndex + 1]) return String(parts[shortsIndex + 1]).slice(0, 11);
    const liveIndex = parts.indexOf('live');
    if (liveIndex >= 0 && parts[liveIndex + 1]) return String(parts[liveIndex + 1]).slice(0, 11);
  } catch {
    // ignore parse errors
  }

  const fallback = input.match(/(?:v=|\/live\/|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{6,})/i);
  if (fallback?.[1]) return fallback[1].slice(0, 11);
  return '';
};

const getStoredOauthForUser = async (userId) => {
  const result = await pool.query(
    `SELECT channel_id, channel_title, access_token, refresh_token, token_type, scope, expiry_date
     FROM youtube_oauth_connections
     WHERE user_id = $1
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
};

const buildYoutubeClientForUser = async (userId) => {
  const stored = await getStoredOauthForUser(userId);
  if (!stored) {
    return { youtube: null, client: null, oauthRow: null, error: 'Conecta tu cuenta de YouTube primero' };
  }

  const { client, error } = getOauthClient();
  if (!client) return { youtube: null, client: null, oauthRow: null, error };

  client.setCredentials({
    access_token: String(stored.access_token || ''),
    refresh_token: String(stored.refresh_token || ''),
    token_type: String(stored.token_type || 'Bearer'),
    scope: String(stored.scope || ''),
    expiry_date: stored.expiry_date ? new Date(stored.expiry_date).getTime() : undefined,
  });

  try {
    await client.getAccessToken();
  } catch (refreshErr) {
    console.error('[YouTube OAuth] token refresh error:', refreshErr?.message || refreshErr);
  }

  const nextCreds = client.credentials || {};
  const nextAccess = String(nextCreds.access_token || '');
  const nextRefresh = String(nextCreds.refresh_token || '');
  const nextType = String(nextCreds.token_type || stored.token_type || '');
  const nextScope = String(nextCreds.scope || stored.scope || '');
  const nextExpiry = Number.isFinite(Number(nextCreds.expiry_date)) ? new Date(Number(nextCreds.expiry_date)) : null;

  if (nextAccess && nextAccess !== String(stored.access_token || '')) {
    await pool.query(
      `UPDATE youtube_oauth_connections
       SET access_token = $2,
           refresh_token = COALESCE(NULLIF($3, ''), refresh_token),
           token_type = $4,
           scope = $5,
           expiry_date = COALESCE($6, expiry_date),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`,
      [userId, nextAccess, nextRefresh, nextType, nextScope, nextExpiry]
    );
  }

  return {
    youtube: google.youtube({ version: 'v3', auth: client }),
    client,
    oauthRow: stored,
    error: null,
  };
};

router.get('/auth/start', async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ success: false, error: 'No autenticado' });

  const { client, error } = getOauthClient();
  if (!client) return res.status(500).json({ success: false, error });

  const returnUrl = sanitizeReturnUrl(req.query.returnUrl || config.YOUTUBE_FRONTEND_SUCCESS_URL);
  const state = signState({ userId, returnUrl, kind: 'youtube_oauth' });

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: YT_SCOPES,
    include_granted_scopes: true,
    state,
  });

  return res.redirect(authUrl);
});

router.get('/auth/callback', async (req, res) => {
  const { client } = getOauthClient();
  const fallbackErrorUrl = sanitizeReturnUrl(
    process.env.YOUTUBE_FRONTEND_ERROR_URL || config.YOUTUBE_FRONTEND_ERROR_URL || 'http://localhost:5173/youtube/'
  );
  if (!client) {
    const failUrl = new URL(fallbackErrorUrl);
    failUrl.searchParams.set('youtube_auth', 'error');
    failUrl.searchParams.set('reason', 'backend_oauth_not_configured');
    return res.redirect(failUrl.toString());
  }

  const state = verifyState(req.query.state);
  if (!state || state.kind !== 'youtube_oauth' || !Number.isFinite(Number(state.userId))) {
    const failUrl = new URL(fallbackErrorUrl);
    failUrl.searchParams.set('youtube_auth', 'error');
    failUrl.searchParams.set('reason', 'invalid_state');
    return res.redirect(failUrl.toString());
  }

  const returnUrl = sanitizeReturnUrl(state.returnUrl || config.YOUTUBE_FRONTEND_SUCCESS_URL);

  try {
    const code = String(req.query.code || '').trim();
    if (!code) throw new Error('missing_code');

    const tokenResp = await client.getToken(code);
    const tokens = tokenResp?.tokens || {};
    if (!tokens.access_token) throw new Error('missing_access_token');

    client.setCredentials(tokens);
    const youtube = google.youtube({ version: 'v3', auth: client });
    const chRes = await youtube.channels.list({
      mine: true,
      part: ['id', 'snippet'],
      maxResults: 1,
    });

    const channel = chRes?.data?.items?.[0] || null;
    const channelId = String(channel?.id || '').trim();
    const channelTitle = String(channel?.snippet?.title || '').trim();

    await pool.query(
      `INSERT INTO youtube_oauth_connections
       (user_id, channel_id, channel_title, access_token, refresh_token, token_type, scope, expiry_date, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET
         channel_id = EXCLUDED.channel_id,
         channel_title = EXCLUDED.channel_title,
         access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(NULLIF(EXCLUDED.refresh_token, ''), youtube_oauth_connections.refresh_token),
         token_type = EXCLUDED.token_type,
         scope = EXCLUDED.scope,
         expiry_date = EXCLUDED.expiry_date,
         updated_at = CURRENT_TIMESTAMP`,
      [
        Number(state.userId),
        channelId || null,
        channelTitle || null,
        String(tokens.access_token || ''),
        String(tokens.refresh_token || ''),
        String(tokens.token_type || ''),
        String(tokens.scope || ''),
        Number.isFinite(Number(tokens.expiry_date)) ? new Date(Number(tokens.expiry_date)) : null,
      ]
    );

    const okUrl = new URL(returnUrl);
    okUrl.searchParams.set('youtube_auth', 'success');
    return res.redirect(okUrl.toString());
  } catch (callbackErr) {
    console.error('[YouTube OAuth] callback error:', callbackErr?.message || callbackErr);
    const failUrl = new URL(returnUrl || fallbackErrorUrl);
    failUrl.searchParams.set('youtube_auth', 'error');
    failUrl.searchParams.set('reason', 'oauth_callback_failed');
    return res.redirect(failUrl.toString());
  }
});

router.get('/auth/status', async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ success: false, error: 'No autenticado' });
  try {
    const result = await pool.query(
      `SELECT channel_id, channel_title, scope, expiry_date, updated_at
       FROM youtube_oauth_connections
       WHERE user_id = $1
       LIMIT 1`,
      [userId]
    );
    if (!result.rows.length) {
      return res.json({ success: true, connected: false });
    }
    const row = result.rows[0];
    return res.json({
      success: true,
      connected: true,
      channelId: row.channel_id || null,
      channelTitle: row.channel_title || null,
      scope: row.scope || null,
      expiryDate: row.expiry_date || null,
      updatedAt: row.updated_at || null,
    });
  } catch (errorStatus) {
    console.error('[YouTube OAuth] status error:', errorStatus?.message || errorStatus);
    return res.status(500).json({ success: false, error: 'No se pudo consultar estado de YouTube OAuth' });
  }
});

router.post('/auth/disconnect', async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ success: false, error: 'No autenticado' });
  try {
    await pool.query('DELETE FROM youtube_oauth_connections WHERE user_id = $1', [userId]);
    liveChatSessions.delete(userId);
    return res.json({ success: true });
  } catch (disconnectError) {
    console.error('[YouTube OAuth] disconnect error:', disconnectError?.message || disconnectError);
    return res.status(500).json({ success: false, error: 'No se pudo desconectar YouTube' });
  }
});

router.post('/chat/connect', async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    console.warn('[YouTube] UNAUTHORIZED: Chat connect without authentication');
    return res.status(401).json({ success: false, error: 'No autenticado. Debes estar logueado para conectar a YouTube chat.' });
  }
  console.log(`[YouTube] User ${userId} connecting to YouTube chat`);

  const streamUrl = String(req.body?.streamUrl || '').trim();
  const videoId = parseYoutubeVideoId(streamUrl);
  if (!videoId) {
    return res.status(400).json({ success: false, error: 'Link de YouTube inválido. Usa un link tipo watch?v=...' });
  }

  try {
    const { youtube, oauthRow, error } = await buildYoutubeClientForUser(userId);
    if (!youtube) return res.status(400).json({ success: false, error });

    const videoResp = await youtube.videos.list({
      id: [videoId],
      part: ['snippet', 'liveStreamingDetails'],
      maxResults: 1,
    });

    const video = videoResp?.data?.items?.[0] || null;
    const liveChatId = String(video?.liveStreamingDetails?.activeLiveChatId || '').trim();
    if (!liveChatId) {
      return res.status(400).json({
        success: false,
        error: 'Ese video no tiene chat en vivo activo ahora mismo.',
      });
    }

    liveChatSessions.set(userId, {
      liveChatId,
      videoId,
      nextPageToken: '',
      connectedAt: Date.now(),
    });

    return res.json({
      success: true,
      connected: true,
      liveChatId,
      videoId,
      videoTitle: String(video?.snippet?.title || ''),
      channelTitle: String(video?.snippet?.channelTitle || oauthRow?.channel_title || ''),
    });
  } catch (connectErr) {
    console.error('[YouTube Chat] connect error:', connectErr?.message || connectErr);
    return res.status(500).json({ success: false, error: 'No se pudo conectar al chat de YouTube' });
  }
});

router.get('/chat/messages', async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    console.warn('[YouTube] UNAUTHORIZED: Chat messages request without authentication');
    return res.status(401).json({ success: false, error: 'No autenticado. Debes estar logueado para obtener mensajes.' });
  }

  const session = liveChatSessions.get(userId);
  if (!session?.liveChatId) {
    return res.status(400).json({ success: false, error: 'Chat de YouTube no conectado' });
  }

  try {
    const { youtube, error } = await buildYoutubeClientForUser(userId);
    if (!youtube) return res.status(400).json({ success: false, error });

    const response = await youtube.liveChatMessages.list({
      liveChatId: session.liveChatId,
      part: ['id', 'snippet', 'authorDetails'],
      maxResults: 200,
      pageToken: session.nextPageToken || undefined,
    });

    const nextPageToken = String(response?.data?.nextPageToken || '');
    const pollingIntervalMillis = Number(response?.data?.pollingIntervalMillis || 2000);
    session.nextPageToken = nextPageToken;
    liveChatSessions.set(userId, session);

    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    const messages = items.map((item) => {
      const messageType = String(item?.snippet?.type || '').trim();
      const isDonationEvent = messageType === 'superChatEvent' || messageType === 'superStickerEvent';
      const superChatAmount = String(item?.snippet?.superChatDetails?.amountDisplayString || '').trim();
      const superStickerAmount = String(item?.snippet?.superStickerDetails?.amountDisplayString || '').trim();
      const donationAmount = superChatAmount || superStickerAmount;
      let text = String(item?.snippet?.displayMessage || '').trim();
      if (!text && isDonationEvent) {
        const donationLabel = messageType === 'superStickerEvent' ? 'Super Sticker' : 'Super Chat';
        // No incluir monto en el texto leído por voz: solo etiqueta del evento.
        text = donationLabel;
      }
      const publishedAt = item?.snippet?.publishedAt ? Date.parse(item.snippet.publishedAt) : Date.now();
      return {
        id: String(item?.id || ''),
        text,
        user: String(item?.authorDetails?.displayName || 'usuario'),
        userChannelId: String(item?.authorDetails?.channelId || ''),
        timestamp: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
        isModerator: Boolean(item?.authorDetails?.isChatModerator),
        isSubscriber: Boolean(item?.authorDetails?.isChatSponsor),
        isDonor: isDonationEvent,
        donationType: isDonationEvent ? messageType : '',
        donationAmount,
      };
    }).filter((msg) => msg.id && msg.text);

    return res.json({
      success: true,
      liveChatId: session.liveChatId,
      videoId: session.videoId,
      pollingIntervalMillis,
      messages,
    });
  } catch (messagesErr) {
    console.error('[YouTube Chat] messages error:', messagesErr?.message || messagesErr);
    return res.status(500).json({ success: false, error: 'No se pudieron obtener mensajes del chat de YouTube' });
  }
});

router.post('/chat/disconnect', async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ success: false, error: 'No autenticado' });
  liveChatSessions.delete(userId);
  return res.json({ success: true });
});

export default router;
