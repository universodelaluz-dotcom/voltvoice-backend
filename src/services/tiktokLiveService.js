import { WebcastPushConnection } from 'tiktok-live-connector';
import axios from 'axios';

class TikTokLiveService {
  constructor() {
    this.activeStreams = new Map();
    this.messageQueue = new Map();
    this.tiktokConnections = new Map(); // Almacenar conexiones de TikTok
    this.clientCallbacks = new Map(); // Callbacks para enviar mensajes a clientes
    this.donors = new Map(); // username -> Set de usuarios que han donado
  }

  /**
   * Registrar callback para enviar mensajes a cliente
   */
  registerClientCallback(username, callback) {
    if (!this.clientCallbacks.has(username)) {
      this.clientCallbacks.set(username, []);
    }
    this.clientCallbacks.get(username).push(callback);
  }

  /**
   * Desregistrar callback de cliente
   */
  unregisterClientCallback(username, callback) {
    const callbacks = this.clientCallbacks.get(username);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) callbacks.splice(index, 1);
    }
  }

  /**
   * Emitir mensaje a todos los clientes conectados
   */
  emitMessageToClients(username, message) {
    const callbacks = this.clientCallbacks.get(username);
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
      console.log(`[TikTok] Conectando a @${username}...`);

      // Crear nueva conexión de TikTok
      const tiktokConnection = new WebcastPushConnection(username);

      // Configurar listeners
      tiktokConnection.on('chat', (data) => {
        const donorsSet = this.donors.get(username);
        const isDonor = donorsSet ? donorsSet.has(data.uniqueId) : false;

        const message = {
          id: `${username}-${Date.now()}-${Math.random()}`,
          username: data.uniqueId,
          text: data.comment,
          timestamp: Date.now(),
          status: 'received',
          isDonor
        };

        console.log(`[TikTok] Nuevo mensaje: @${message.username}: ${message.text}`);

        // Agregar a cola
        this.addMessage(username, {
          username: message.username,
          text: message.text
        });

        // Emitir a callback si existe
        if (onMessage) onMessage(message);

        // Emitir a todos los clientes WebSocket conectados
        this.emitMessageToClients(username, message);
      });

      // Detectar regalos/donaciones
      tiktokConnection.on('gift', (data) => {
        const donorUser = data.uniqueId || data.nickname || 'anónimo';
        const giftName = data.giftName || 'regalo';
        const repeatCount = data.repeatCount || 1;

        console.log(`[TikTok] 🎁 Regalo de @${donorUser}: ${giftName} x${repeatCount}`);

        // Registrar como donador
        if (!this.donors.has(username)) {
          this.donors.set(username, new Set());
        }
        this.donors.get(username).add(donorUser);

        // Emitir evento de regalo a los clientes
        this.emitMessageToClients(username, {
          id: `gift-${username}-${Date.now()}`,
          type: 'gift',
          username: donorUser,
          giftName,
          repeatCount,
          timestamp: Date.now()
        });
      });

      tiktokConnection.on('error', (error) => {
        console.error(`[TikTok] Error en stream @${username}:`, error);
      });

      tiktokConnection.on('disconnect', () => {
        console.log(`[TikTok] Desconectado de @${username}`);
        this.disconnectStream(username);
      });

      // Conectar
      await tiktokConnection.connect();
      console.log(`[TikTok] ✓ Conectado a @${username}`);

      // Registrar conexión
      const stream = {
        username,
        isConnected: true,
        messageCount: 0,
        startTime: Date.now(),
        tiktokConnection
      };

      this.activeStreams.set(username, stream);
      this.messageQueue.set(username, []);
      this.tiktokConnections.set(username, tiktokConnection);

      return stream;
    } catch (error) {
      console.error('[TikTok] Error conectando:', error.message);
      throw new Error(`No se pudo conectar a @${username}: ${error.message}`);
    }
  }

  /**
   * Agregar mensaje a procesar
   */
  addMessage(username, message) {
    const stream = this.activeStreams.get(username);
    if (!stream) return null;

    const msg = {
      id: `${username}-${Date.now()}`,
      username: message.username,
      text: message.text,
      timestamp: Date.now(),
      status: 'pending'
    };

    stream.messageCount++;
    this.messageQueue.get(username).push(msg);

    console.log(`[TikTok] Mensaje en cola: @${message.username}: ${message.text}`);

    return msg;
  }

  /**
   * Obtener siguientes mensajes a procesar
   */
  getNextMessage(username) {
    const queue = this.messageQueue.get(username);
    if (!queue || queue.length === 0) return null;

    return queue.shift();
  }

  /**
   * Desconectar de stream
   */
  async disconnectStream(username) {
    const tiktokConnection = this.tiktokConnections.get(username);

    if (tiktokConnection) {
      try {
        await tiktokConnection.disconnect();
      } catch (err) {
        console.error('[TikTok] Error desconectando:', err);
      }
      this.tiktokConnections.delete(username);
    }

    this.activeStreams.delete(username);
    this.messageQueue.delete(username);
    this.clientCallbacks.delete(username);
    this.donors.delete(username);

    console.log(`[TikTok] ✓ Desconectado de @${username}`);
  }

  /**
   * Obtener estado del stream
   */
  getStreamStatus(username) {
    const stream = this.activeStreams.get(username);
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
