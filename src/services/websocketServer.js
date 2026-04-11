import WebSocket, { WebSocketServer } from 'ws';
import tiktokLiveService from './tiktokLiveService.js';

class WebSocketServerManager {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // username -> Set of WebSocket clients
    this.clientMeta = new WeakMap(); // ws -> { username, callback }
    this.heartbeatInterval = null;
  }

  /**
   * Inicializar servidor WebSocket
   */
  initialize(server) {
    this.wss = new WebSocketServer({ server, path: '/api/tiktok/ws' });
    this._startHeartbeat();

    this.wss.on('connection', (ws) => {
      console.log('[WebSocket] Nuevo cliente conectado');

      ws.isAlive = true;
      this.clientMeta.set(ws, { username: null, callback: null });

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      const cleanupSubscription = () => {
        const meta = this.clientMeta.get(ws) || {};
        const username = meta.username;

        if (username) {
          const clients = this.clients.get(username);
          if (clients) {
            clients.delete(ws);
            if (clients.size === 0) {
              this.clients.delete(username);
            }
          }

          if (meta.callback) {
            tiktokLiveService.unregisterClientCallback(username, meta.callback);
          }
        }

        this.clientMeta.set(ws, { username: null, callback: null });
      };

      // Manejar mensajes del cliente
      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'subscribe') {
            const username = String(message.username || '').trim().replace(/^@+/, '');
            if (!username) {
              ws.send(JSON.stringify({ type: 'error', message: 'username required' }));
              return;
            }

            cleanupSubscription();
            console.log(`[WebSocket] Cliente suscrito a @${username}`);

            const callback = (msg) => {
              if (ws.readyState !== WebSocket.OPEN) {
                cleanupSubscription();
                return;
              }

              ws.send(JSON.stringify({
                type: 'message',
                data: msg
              }));
            };

            if (!this.clients.has(username)) {
              this.clients.set(username, new Set());
            }

            this.clients.get(username).add(ws);
            tiktokLiveService.registerClientCallback(username, callback);
            this.clientMeta.set(ws, { username, callback });

            ws.send(JSON.stringify({
              type: 'subscribed',
              username,
              timestamp: new Date().toISOString()
            }));
          } else if (message.type === 'unsubscribe') {
            cleanupSubscription();
          } else if (message.type === 'status') {
            const username = this.clientMeta.get(ws)?.username;
            const status = tiktokLiveService.getStreamStatus(username);
            ws.send(JSON.stringify({
              type: 'status',
              data: status
            }));
          } else if (message.type === 'ping') {
            ws.isAlive = true;
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          }
        } catch (err) {
          console.error('[WebSocket] Error procesando mensaje:', err);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'error',
              message: err.message
            }));
          }
        }
      });

      ws.on('close', () => {
        console.log('[WebSocket] Cliente desconectado');
        cleanupSubscription();
      });

      ws.on('error', (error) => {
        console.error('[WebSocket] Error en cliente:', error);
        cleanupSubscription();
      });
    });

    this.wss.on('close', () => {
      this._stopHeartbeat();
    });

    console.log('[WebSocket] Servidor inicializado en /api/tiktok/ws');
    return this.wss;
  }

  _startHeartbeat() {
    this._stopHeartbeat();

    // Ping-level heartbeat to keep long-running sessions alive behind proxies.
    this.heartbeatInterval = setInterval(() => {
      if (!this.wss) return;

      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          ws.terminate();
          return;
        }

        ws.isAlive = false;
        try {
          ws.ping();
        } catch (error) {
          ws.terminate();
        }
      });
    }, 30000);
  }

  _stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Enviar mensaje a todos los clientes de un stream
   */
  broadcastToStream(username, message) {
    const clients = this.clients.get(username);
    if (!clients) return;

    const payload = JSON.stringify({
      type: 'message',
      data: message
    });

    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  /**
   * Obtener numero de clientes conectados a un stream
   */
  getClientCount(username) {
    const clients = this.clients.get(username);
    return clients ? clients.size : 0;
  }

  /**
   * Obtener estadisticas del servidor
   */
  getStats() {
    let totalClients = 0;
    this.clients.forEach((clients) => {
      totalClients += clients.size;
    });

    return {
      activeStreams: this.clients.size,
      totalClients: totalClients,
      timestamp: new Date().toISOString()
    };
  }
}

export default new WebSocketServerManager();
