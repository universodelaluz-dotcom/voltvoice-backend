import WebSocket, { WebSocketServer } from 'ws';
import tiktokLiveService from './tiktokLiveService.js';

class WebSocketServerManager {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // username -> Set of WebSocket clients
  }

  /**
   * Inicializar servidor WebSocket
   */
  initialize(server) {
    this.wss = new WebSocketServer({ server, path: '/api/tiktok/ws' });

    this.wss.on('connection', (ws, req) => {
      console.log('[WebSocket] Nuevo cliente conectado');

      let clientUsername = null;

      // Manejar mensajes del cliente
      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'subscribe') {
            // Cliente se suscribe a un stream
            const { username } = message;
            clientUsername = username;

            console.log(`[WebSocket] Cliente suscrito a @${username}`);

            // Registrar callback para este cliente
            const callback = (msg) => {
              ws.send(
                JSON.stringify({
                  type: 'message',
                  data: msg
                })
              );
            };

            if (!this.clients.has(username)) {
              this.clients.set(username, new Set());
            }

            this.clients.get(username).add(ws);
            tiktokLiveService.registerClientCallback(username, callback);

            // Enviar confirmación
            ws.send(
              JSON.stringify({
                type: 'subscribed',
                username: username,
                timestamp: new Date().toISOString()
              })
            );
          } else if (message.type === 'unsubscribe') {
            // Cliente se desuscribe
            if (clientUsername) {
              const clients = this.clients.get(clientUsername);
              if (clients) {
                clients.delete(ws);
              }
            }
          } else if (message.type === 'status') {
            // Solicitar estado del stream
            const status = tiktokLiveService.getStreamStatus(clientUsername);
            ws.send(
              JSON.stringify({
                type: 'status',
                data: status
              })
            );
          } else if (message.type === 'ping') {
            // Keep-alive
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch (err) {
          console.error('[WebSocket] Error procesando mensaje:', err);
          ws.send(
            JSON.stringify({
              type: 'error',
              message: err.message
            })
          );
        }
      });

      ws.on('close', () => {
        console.log('[WebSocket] Cliente desconectado');
        if (clientUsername) {
          const clients = this.clients.get(clientUsername);
          if (clients) {
            clients.delete(ws);
          }
        }
      });

      ws.on('error', (error) => {
        console.error('[WebSocket] Error en cliente:', error);
      });
    });

    console.log('[WebSocket] Servidor inicializado en /api/tiktok/ws');
    return this.wss;
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
   * Obtener número de clientes conectados a un stream
   */
  getClientCount(username) {
    const clients = this.clients.get(username);
    return clients ? clients.size : 0;
  }

  /**
   * Obtener estadísticas del servidor
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
