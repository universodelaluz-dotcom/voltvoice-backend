import axios from 'axios';

class TikTokLiveService {
  constructor() {
    this.activeStreams = new Map();
    this.messageQueue = new Map();
  }

  /**
   * Obtener ID del stream activo de un usuario
   */
  async getRoomIdByUsername(username) {
    try {
      console.log(`[TikTok] Buscando stream de @${username}...`);

      // Intentar obtener info del usuario
      const response = await axios.get(
        `https://www.tiktok.com/@${username}/live`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      // Extraer room ID del HTML (método simple)
      const roomIdMatch = response.data.match(/"roomId":"(\d+)"/);
      const liveMatch = response.data.match(/"liveRoomId":"(\d+)"/);

      const roomId = roomIdMatch?.[1] || liveMatch?.[1];

      if (!roomId) {
        throw new Error('Usuario no está en vivo o stream no encontrado');
      }

      console.log(`[TikTok] Room ID encontrado: ${roomId}`);
      return roomId;
    } catch (error) {
      console.error('[TikTok] Error obteniendo room ID:', error.message);
      throw error;
    }
  }

  /**
   * Conectar a stream de TikTok y leer mensajes
   */
  async connectToStream(username, onMessage) {
    try {
      const roomId = await this.getRoomIdByUsername(username);

      // Simular conexión (en producción usarías WebSocket real de TikTok)
      const stream = {
        username,
        roomId,
        isConnected: true,
        messageCount: 0,
        startTime: Date.now()
      };

      this.activeStreams.set(username, stream);
      this.messageQueue.set(username, []);

      console.log(`[TikTok] Conectado a @${username} (room: ${roomId})`);

      // Simular lectura de mensajes (en producción sería WebSocket real)
      this.simulateMessages(username, onMessage);

      return stream;
    } catch (error) {
      console.error('[TikTok] Error conectando:', error.message);
      throw error;
    }
  }

  /**
   * Simular mensajes de chat (en producción sería WebSocket real)
   */
  simulateMessages(username, onMessage) {
    // En producción, aquí iría la conexión real al WebSocket de TikTok
    // Por ahora, permite que el usuario simule mensajes

    console.log(`[TikTok] Escuchando mensajes de @${username}...`);
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

    console.log(`[TikTok] Mensaje agregado: @${message.username}: ${message.text}`);

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
  disconnectStream(username) {
    this.activeStreams.delete(username);
    this.messageQueue.delete(username);

    console.log(`[TikTok] Desconectado de @${username}`);
  }

  /**
   * Obtener estado del stream
   */
  getStreamStatus(username) {
    return this.activeStreams.get(username) || null;
  }
}

export default new TikTokLiveService();
