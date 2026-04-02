import { WebcastPushConnection } from 'tiktok-live-connector';
import axios from 'axios';

class TikTokLiveService {
  constructor() {
    this.activeStreams = new Map();
    this.messageQueue = new Map();
    this.tiktokConnections = new Map(); // Almacenar conexiones de TikTok
    this.clientCallbacks = new Map(); // Callbacks para enviar mensajes a clientes
    this.donors = new Map(); // username -> Set de usuarios que han donado
    this.communityMembers = new Map(); // username -> Set de usuarios Fan Club detectados
    this.debugEvents = new Map(); // username -> eventos decodificados recientes
  }

  _hasCommunityMemberBadge(data = {}) {
    const user = data?.user || {};
    const fansClub = user?.fansClub || data?.fansClub;
    const fansClubInfo = user?.fansClubInfo || data?.fansClubInfo;
    const badgeCandidates = [
      ...(Array.isArray(user?.badges) ? user.badges : []),
      ...(Array.isArray(data?.badges) ? data.badges : []),
      ...(Array.isArray(data?.userBadges) ? data.userBadges : []),
    ];
    const userSceneTypes = Array.isArray(data?.userSceneTypes) ? data.userSceneTypes : [];
    const teamMemberLevel = Number(data?.teamMemberLevel || user?.teamMemberLevel || 0);

    const hasActiveFansClubStatus =
      Number(fansClub?.data?.userFansClubStatus) === 1
      || Number(fansClub?.userFansClubStatus) === 1;

    const hasActiveFansClubInfo =
      Number(fansClubInfo?.fansLevel) > 0
      && fansClubInfo?.isSleeping === false;

    const hasFansBadgeScene = badgeCandidates.some((badge) =>
      Number(badge?.badgeScene) === 10 || Number(badge?.badgeSceneType) === 10
    );

    const hasFansSceneType = userSceneTypes.some((scene) => Number(scene) === 10);
    const hasTeamMemberLevel = teamMemberLevel > 0;

    return hasActiveFansClubStatus || hasActiveFansClubInfo || hasFansBadgeScene || hasFansSceneType || hasTeamMemberLevel;
  }

  _normalizeUsername(username = '') {
    return String(username || '').trim().replace(/^@+/, '');
  }

  _extractCommunityUsername(data = {}) {
    const candidates = [
      data.uniqueId,
      data.nickname,
      data?.user?.uniqueId,
      data?.fromUser?.uniqueId,
      data?.fansLevelParam?.user?.uniqueId,
      data?.userGradeParam?.user?.uniqueId,
      data?.event?.params?.unique_id,
      data?.event?.params?.uniqueId,
      data?.event?.params?.user_unique_id,
      data?.event?.params?.userId
    ];

    const resolved = candidates.find((value) => typeof value === 'string' && value.trim());
    return this._normalizeUsername(resolved || '');
  }

  _hasBadgeScene10Deep(value, depth = 0) {
    if (value == null || depth > 6) return false;
    if (Array.isArray(value)) {
      return value.some((item) => this._hasBadgeScene10Deep(item, depth + 1));
    }
    if (typeof value !== 'object') return false;

    if (Number(value.badgeSceneType) === 10 || Number(value.badgeScene) === 10) {
      return true;
    }

    return Object.values(value).some((inner) => this._hasBadgeScene10Deep(inner, depth + 1));
  }

  _isCommunityMemberFromDecodedData(type, decodedData = {}) {
    const user = decodedData?.user || {};
    const fansClub = user?.fansClub || decodedData?.fansClub;
    const fansClubInfo = user?.fansClubInfo || decodedData?.fansClubInfo;

    const hasActiveFansClubStatus =
      Number(fansClub?.data?.userFansClubStatus) === 1
      || Number(fansClub?.userFansClubStatus) === 1;

    const hasFansLevel =
      Number(user?.fansClubInfo?.fansLevel || 0) > 0
      || Number(fansClubInfo?.fansLevel || 0) > 0
      || Number(decodedData?.teamMemberLevel || 0) > 0
      || Number(decodedData?.fansLevel || 0) > 0;

    const hasFansBadgeScene10 = this._hasBadgeScene10Deep(user?.badges)
      || this._hasBadgeScene10Deep(decodedData?.badges)
      || this._hasBadgeScene10Deep(decodedData?.userBadges);

    const isSuperFanEvent = type === 'WebcastBarrageMessage'
      && String(decodedData?.content?.displayType || '').includes('ttlive_superFan');

    return Boolean(hasActiveFansClubStatus || hasFansLevel || hasFansBadgeScene10 || isSuperFanEvent);
  }

  _getPortraitTags(data = {}) {
    const portraitTags = data?.publicAreaMessageCommon?.portraitInfo?.portraitTag;
    return Array.isArray(portraitTags) ? portraitTags : [];
  }

  _getUserSceneTypes(data = {}) {
    return Array.isArray(data?.userSceneTypes) ? data.userSceneTypes : [];
  }

  _hasPortraitTag(data = {}, needle = '') {
    const normalizedNeedle = String(needle || '').toLowerCase();
    if (!normalizedNeedle) return false;

    return this._getPortraitTags(data).some((tag) =>
      String(tag?.showValue || '').toLowerCase().includes(normalizedNeedle)
    );
  }

  _isSubscriber(data = {}) {
    return Boolean(
      data.isSubscriber
      || data?.userIdentity?.isSubscriberOfAnchor
      || this._hasPortraitTag(data, 'subformo')
    );
  }

  _isModerator(data = {}) {
    return Boolean(
      data.isModerator
      || data?.userIdentity?.isModeratorOfAnchor
    );
  }

  _isCommunityMember(data = {}) {
    return Boolean(
      Number(data?.teamMemberLevel || 0) > 0
      || Number(data?.communityflaggedStatus || 0) > 0
      || Number(data?.fansLevel || 0) > 0
      || Number(data?.fansClubInfo?.fansLevel || 0) > 0
      || this._hasCommunityMemberBadge(data)
      || this._hasPortraitTag(data, 'memberdays')
      || this._hasPortraitTag(data, 'fan club')
      || this._hasPortraitTag(data, 'fans club')
      || this._hasPortraitTag(data, 'super fan')
    );
  }

  _isDonorSignal(data = {}) {
    return Boolean(
      data.isDonor
      || data.isNewGifter
      || Number(data.topGifterRank || 0) > 0
      || Number(data.gifterLevel || 0) > 0
      || data?.user?.isGifter
      || data?.user?.isGiftGiverOfAnchor
      || data?.userIdentity?.isGiftGiverOfAnchor
      || this._hasPortraitTag(data, 'gift')
      || this._hasPortraitTag(data, 'gifter')
    );
  }

  _markCommunityMember(streamUsername, memberUsername) {
    const normalizedStream = this._normalizeUsername(streamUsername);
    const normalizedMember = this._normalizeUsername(memberUsername);

    if (!normalizedStream || !normalizedMember) {
      return false;
    }

    if (!this.communityMembers.has(normalizedStream)) {
      this.communityMembers.set(normalizedStream, new Set());
    }

    this.communityMembers.get(normalizedStream).add(normalizedMember);
    return true;
  }

  _sanitizeDebugValue(value, depth = 0) {
    if (value == null) return value;
    if (depth >= 6) return '[max-depth]';
    if (typeof value === 'string') {
      return value.length > 240 ? `${value.slice(0, 240)}...` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 8).map((item) => this._sanitizeDebugValue(item, depth + 1));
    }
    if (typeof value === 'object') {
      const output = {};
      Object.entries(value).slice(0, 40).forEach(([key, innerValue]) => {
        output[key] = this._sanitizeDebugValue(innerValue, depth + 1);
      });
      return output;
    }
    return String(value);
  }

  _recordDebugEvent(streamUsername, type, payload = {}) {
    const normalizedStream = this._normalizeUsername(streamUsername);
    if (!normalizedStream) return;

    if (!this.debugEvents.has(normalizedStream)) {
      this.debugEvents.set(normalizedStream, []);
    }

    const events = this.debugEvents.get(normalizedStream);
    events.push({
      timestamp: Date.now(),
      type,
      payload: this._sanitizeDebugValue(payload)
    });

    if (events.length > 60) {
      events.splice(0, events.length - 60);
    }
  }

  getDebugEvents(username, limit = 25) {
    const normalizedUsername = this._normalizeUsername(username);
    const events = this.debugEvents.get(normalizedUsername) || [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 60));
    return events.slice(-safeLimit);
  }

  /**
   * Registrar callback para enviar mensajes a cliente
   */
  registerClientCallback(username, callback) {
    const normalizedUsername = this._normalizeUsername(username);
    if (!this.clientCallbacks.has(normalizedUsername)) {
      this.clientCallbacks.set(normalizedUsername, []);
    }
    this.clientCallbacks.get(normalizedUsername).push(callback);
  }

  /**
   * Desregistrar callback de cliente
   */
  unregisterClientCallback(username, callback) {
    const callbacks = this.clientCallbacks.get(this._normalizeUsername(username));
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) callbacks.splice(index, 1);
    }
  }

  /**
   * Emitir mensaje a todos los clientes conectados
   */
  emitMessageToClients(username, message) {
    const callbacks = this.clientCallbacks.get(this._normalizeUsername(username));
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(message);
        } catch (err) {
          console.error('[TikTok] Error en callback de cliente:', err);
        }
      });
    }
  }

  /**
   * Conectar a stream de TikTok en tiempo real
   */
  async connectToStream(username, onMessage) {
    try {
      const normalizedUsername = this._normalizeUsername(username);

      if (!normalizedUsername) {
        throw new Error('Username de TikTok invalido');
      }

      console.log(`[TikTok] Conectando a @${normalizedUsername}...`);

      // Crear nueva conexión de TikTok
      const tiktokConnection = new WebcastPushConnection(normalizedUsername);

      // Configurar listeners
      tiktokConnection.on('decodedData', (type, decodedData) => {
        if (![
          'WebcastChatMessage',
          'WebcastMemberMessage',
          'WebcastSocialMessage',
          'WebcastBarrageMessage',
          'WebcastGiftMessage'
        ].includes(type)) {
          return;
        }

        const decodedCommunityUser = this._extractCommunityUsername(decodedData);
        const decodedCommunity = this._isCommunityMemberFromDecodedData(type, decodedData);
        if (decodedCommunity && decodedCommunityUser) {
          this._markCommunityMember(normalizedUsername, decodedCommunityUser);
        }

        this._recordDebugEvent(normalizedUsername, type, decodedData);
        this._recordDebugEvent(normalizedUsername, `${type}:communitySignals`, {
          username: decodedCommunityUser,
          isCommunityMember: decodedCommunity,
          teamMemberLevel: decodedData?.teamMemberLevel,
          userFansClubStatus: decodedData?.user?.fansClub?.data?.userFansClubStatus ?? decodedData?.fansClub?.data?.userFansClubStatus,
          fansLevel: decodedData?.user?.fansClubInfo?.fansLevel ?? decodedData?.fansClubInfo?.fansLevel,
          communityflaggedStatus: decodedData?.communityflaggedStatus
        });
      });

      tiktokConnection.on('chat', (data) => {
        const donorsSet = this.donors.get(normalizedUsername);
        const communitySet = this.communityMembers.get(normalizedUsername);
        const normalizedCommentUser = this._normalizeUsername(data.uniqueId);
        const donorFromSet = donorsSet ? donorsSet.has(normalizedCommentUser) : false;
        const donorFromSignal = this._isDonorSignal(data);
        const isDonor = donorFromSet || donorFromSignal;

        if (isDonor && normalizedCommentUser) {
          if (!this.donors.has(normalizedUsername)) {
            this.donors.set(normalizedUsername, new Set());
          }
          this.donors.get(normalizedUsername).add(normalizedCommentUser);
        }

        // Los campos están DIRECTAMENTE en data, no en sub-objetos
        const isModerator = this._isModerator(data);
        const isSubscriber = this._isSubscriber(data);
        const isCommunityMember =
          this._isCommunityMember(data)
          || (communitySet ? communitySet.has(normalizedCommentUser) : false);
        const topGifterRank = data.topGifterRank || 0;
        const isNewGifter = data.isNewGifter || false;
        const gifterLevel = data.gifterLevel || 0;

        if (isCommunityMember) {
          this._markCommunityMember(normalizedUsername, normalizedCommentUser);
        }

        console.log(`[DEBUG] @${data.uniqueId}: mod=${isModerator}, sub=${isSubscriber}, community=${isCommunityMember}, topGifter=${topGifterRank}, newGifter=${isNewGifter}, gifterLvl=${gifterLevel}`);

        const message = {
          id: `${normalizedUsername}-${Date.now()}-${Math.random()}`,
          username: data.uniqueId,
          nickname: data.nickname || data.uniqueId,
          text: data.comment,
          timestamp: Date.now(),
          status: 'received',
          isDonor,
          isModerator,
          isSubscriber,
          isCommunityMember,
          topGifterRank
        };

        console.log(`[TikTok] Nuevo mensaje: @${message.username}: ${message.text}`, {
          isDonor,
          isModerator,
          isSubscriber,
          isCommunityMember,
          topGifterRank
        });

        this._recordDebugEvent(normalizedUsername, 'chat:resolved', {
          username: message.username,
          nickname: message.nickname,
          isModerator,
          isSubscriber,
          isCommunityMember,
          topGifterRank,
          teamMemberLevel: data.teamMemberLevel,
          fanTicketCount: data.fanTicketCount,
          badges: data.userBadges,
          portraitTag: this._getPortraitTags(data),
          userIdentity: data.userIdentity,
          commentTag: data.commentTag,
          publicAreaMessageCommon: data.publicAreaMessageCommon,
          rawKeys: Object.keys(data || {})
        });

        // Agregar a cola
        this.addMessage(normalizedUsername, {
          username: message.username,
          text: message.text
        });

        // Emitir a callback si existe
        if (onMessage) onMessage(message);

        // Emitir a todos los clientes WebSocket conectados
        this.emitMessageToClients(normalizedUsername, message);
      });

      tiktokConnection.on('superFan', (data) => {
        const memberUsername = this._extractCommunityUsername(data);
        const marked = this._markCommunityMember(normalizedUsername, memberUsername);

        this._recordDebugEvent(normalizedUsername, 'superFan:resolved', {
          memberUsername,
          marked,
          displayType: data?.content?.displayType,
          eventName: data?.event?.eventName,
          eventParams: data?.event?.params,
          fansLevelParam: data?.fansLevelParam,
          userGradeParam: data?.userGradeParam,
          badge: data?.badge
        });

        console.log(`[TikTok] SUPER_FAN detectado en @${normalizedUsername}`, {
          memberUsername,
          marked,
          displayType: data?.content?.displayType,
          eventName: data?.event?.eventName
        });
      });

      // Detectar regalos/donaciones
      tiktokConnection.on('gift', (data) => {
        const normalizedDonorUser = this._normalizeUsername(
          data.uniqueId || data?.user?.uniqueId || data?.fromUser?.uniqueId || ''
        );
        const donorUser = data.uniqueId || data.nickname || 'anónimo';
        const giftName = data.giftName || 'regalo';
        const repeatCount = data.repeatCount || 1;

        console.log(`[TikTok] 🎁 Regalo de @${donorUser}: ${giftName} x${repeatCount}`);

        // Registrar como donador
        if (!this.donors.has(normalizedUsername)) {
          this.donors.set(normalizedUsername, new Set());
        }
        const donorKey = normalizedDonorUser || this._normalizeUsername(donorUser);
        if (donorKey) {
          this.donors.get(normalizedUsername).add(donorKey);
        }

        // Emitir evento de regalo a los clientes
        this.emitMessageToClients(normalizedUsername, {
          id: `gift-${normalizedUsername}-${Date.now()}`,
          type: 'gift',
          username: donorUser,
          giftName,
          repeatCount,
          timestamp: Date.now()
        });
      });

      // Detectar seguidores y shares
      tiktokConnection.on('social', (data) => {
        const socialUser = data.uniqueId || data.nickname || 'alguien';
        if (data.displayType === 'follow' || data.label === 'follow') {
          console.log(`[TikTok] 👤 Nuevo seguidor: @${socialUser}`);
          this.emitMessageToClients(normalizedUsername, {
            type: 'follow', username: socialUser, timestamp: Date.now()
          });
        } else {
          console.log(`[TikTok] 📤 Share de @${socialUser}`);
          this.emitMessageToClients(normalizedUsername, {
            type: 'share', username: socialUser, timestamp: Date.now()
          });
        }
      });

      // Detectar likes
      tiktokConnection.on('like', (data) => {
        console.log(`[TikTok] ❤️ ${data.totalLikeCount} likes totales`);
        this.emitMessageToClients(normalizedUsername, {
          type: 'like', totalLikeCount: data.totalLikeCount, username: data.uniqueId || '', timestamp: Date.now()
        });
      });

      // Detectar viewers
      tiktokConnection.on('roomUser', (data) => {
        console.log(`[TikTok] 👁️ ${data.viewerCount} viewers`);
        this.emitMessageToClients(normalizedUsername, {
          type: 'viewer_count', viewerCount: data.viewerCount, timestamp: Date.now()
        });
      });

      // Detectar batallas
      tiktokConnection.on('linkMicBattle', (data) => {
        console.log(`[TikTok] ⚔️ Batalla detectada`);
        this.emitMessageToClients(normalizedUsername, {
          type: 'battle', timestamp: Date.now()
        });
      });

      // Detectar encuestas
      tiktokConnection.on('poll', (data) => {
        console.log(`[TikTok] 📊 Encuesta detectada`);
        this.emitMessageToClients(normalizedUsername, {
          type: 'poll', text: data?.questionText || 'Nueva encuesta', timestamp: Date.now()
        });
      });

      // Detectar metas/goals
      tiktokConnection.on('goalUpdate', (data) => {
        console.log(`[TikTok] 🎯 Meta actualizada`);
        this.emitMessageToClients(normalizedUsername, {
          type: 'goal', text: 'Avance en meta del stream', timestamp: Date.now()
        });
      });

      // Agregar isModerator a mensajes de chat
      tiktokConnection.on('error', (error) => {
        console.error(`[TikTok] Error en stream @${normalizedUsername}:`, error);
      });

      tiktokConnection.on('disconnect', () => {
        console.log(`[TikTok] Desconectado de @${normalizedUsername}`);
        this.disconnectStream(normalizedUsername);
      });

      // Conectar
      await tiktokConnection.connect();
      console.log(`[TikTok] ✓ Conectado a @${username}`);

      // Registrar conexión
      const stream = {
        username: normalizedUsername,
        isConnected: true,
        messageCount: 0,
        startTime: Date.now(),
        tiktokConnection
      };

      this.activeStreams.set(normalizedUsername, stream);
      this.messageQueue.set(normalizedUsername, []);
      this.tiktokConnections.set(normalizedUsername, tiktokConnection);

      return stream;
    } catch (error) {
      console.error('[TikTok] Error conectando:', error.message);
      throw new Error(`No se pudo conectar a @${this._normalizeUsername(username)}: ${error.message}`);
    }
  }

  /**
   * Agregar mensaje a procesar
   */
  addMessage(username, message) {
    const normalizedUsername = this._normalizeUsername(username);
    const stream = this.activeStreams.get(normalizedUsername);
    if (!stream) return null;

    const msg = {
      id: `${normalizedUsername}-${Date.now()}`,
      username: message.username,
      text: message.text,
      timestamp: Date.now(),
      status: 'pending'
    };

    stream.messageCount++;
    this.messageQueue.get(normalizedUsername).push(msg);

    console.log(`[TikTok] Mensaje en cola: @${message.username}: ${message.text}`);

    return msg;
  }

  /**
   * Obtener siguientes mensajes a procesar
   */
  getNextMessage(username) {
    const queue = this.messageQueue.get(this._normalizeUsername(username));
    if (!queue || queue.length === 0) return null;

    return queue.shift();
  }

  /**
   * Desconectar de stream
   */
  async disconnectStream(username) {
    const normalizedUsername = this._normalizeUsername(username);
    const tiktokConnection = this.tiktokConnections.get(normalizedUsername);

    if (tiktokConnection) {
      try {
        await tiktokConnection.disconnect();
      } catch (err) {
        console.error('[TikTok] Error desconectando:', err);
      }
      this.tiktokConnections.delete(normalizedUsername);
    }

    this.activeStreams.delete(normalizedUsername);
    this.messageQueue.delete(normalizedUsername);
    this.clientCallbacks.delete(normalizedUsername);
    this.donors.delete(normalizedUsername);
    this.communityMembers.delete(normalizedUsername);
    this.debugEvents.delete(normalizedUsername);

    console.log(`[TikTok] ✓ Desconectado de @${username}`);
  }

  /**
   * Obtener estado del stream
   */
  getStreamStatus(username) {
    const stream = this.activeStreams.get(this._normalizeUsername(username));
    if (!stream) return null;

    return {
      username: stream.username,
      isConnected: stream.isConnected,
      messageCount: stream.messageCount,
      startTime: stream.startTime,
      uptime: Date.now() - stream.startTime
    };
  }

  /**
   * Obtener todos los streams activos
   */
  getActiveStreams() {
    return Array.from(this.activeStreams.values());
  }
}

export default new TikTokLiveService();
