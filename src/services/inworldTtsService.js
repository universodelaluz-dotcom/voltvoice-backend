// Inworld AI Text-to-Speech Service
// COPIADO DEL SISTEMA LOCAL QUE FUNCIONA PERFECTO
// Usa Node https nativo (NO axios) - igual que el local

import https from 'https';

class InworldTtsService {
  constructor() {
    // La API key ya viene en base64 desde el .env (igual que el local)
    this.apiKey = process.env.INWORLD_API_KEY;
    this.modelId = process.env.INWORLD_MODEL || 'inworld-tts-1.5-max';

    if (!this.apiKey) {
      console.warn('[Inworld TTS] API key not configured');
    }
  }

  /**
   * Sintetizar texto a voz - COPIA EXACTA del local speakInworld()
   */
  async synthesize(text, voiceId = 'Diego') {
    return new Promise((resolve, reject) => {
      if (!text || text.length === 0) {
        reject(new Error('Text cannot be empty'));
        return;
      }

      if (!this.apiKey) {
        reject(new Error('Inworld API key not configured'));
        return;
      }

      console.log(`[Inworld TTS] Synthesizing: "${text.substring(0, 50)}..." with voice: ${voiceId}`);

      // REQUEST BODY - EXACTO como el local (camelCase)
      const requestBody = JSON.stringify({
        text: text,
        voiceId: voiceId,
        modelId: this.modelId
      });

      // HTTP OPTIONS - EXACTO como el local
      const options = {
        hostname: 'api.inworld.ai',
        port: 443,
        path: '/tts/v1/voice:stream',
        method: 'POST',
        headers: {
          'Authorization': `Basic ${this.apiKey}`,  // Key YA es base64 desde .env
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];

        console.log(`[Inworld TTS] Response status: ${res.statusCode}`);

        res.on('data', (chunk) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              const dataBuffer = Buffer.concat(chunks);
              const data = dataBuffer.toString('utf-8');
              console.error(`[Inworld TTS] API error: ${res.statusCode} - ${data.substring(0, 300)}`);
              reject(new Error(`Inworld API error: ${res.statusCode} - ${data}`));
              return;
            }

            const dataBuffer = Buffer.concat(chunks);
            console.log(`[Inworld TTS] Response OK (${dataBuffer.length} bytes)`);

            if (dataBuffer.length === 0) {
              reject(new Error('Empty response from Inworld'));
              return;
            }

            // PARSEO - EXACTO como el local
            // La respuesta contiene MÚLTIPLES audioContent fields (streaming chunks)
            const data = dataBuffer.toString('utf-8');

            const allMatches = data.match(/"audioContent"\s*:\s*"([^"]*(?:\\.[^"]*)*?)"/g) || [];
            console.log(`[Inworld TTS] audioContent fields found: ${allMatches.length}`);

            if (allMatches.length === 0) {
              console.error(`[Inworld TTS] No audioContent found. Preview: ${data.substring(0, 300)}`);
              reject(new Error('No audioContent found'));
              return;
            }

            // Decodificar CADA chunk por separado y concatenar como BINARIO
            const audioChunks = [];

            for (let i = 0; i < allMatches.length; i++) {
              const match = allMatches[i];
              const contentMatch = match.match(/"audioContent"\s*:\s*"([^"]*(?:\\.[^"]*)*?)"/);
              if (contentMatch && contentMatch[1]) {
                const base64Content = contentMatch[1];
                try {
                  const chunk = Buffer.from(base64Content, 'base64');
                  audioChunks.push(chunk);
                } catch (e) {
                  console.error(`[Inworld TTS] Error decoding chunk ${i + 1}: ${e.message}`);
                }
              }
            }

            // Concatenar todos los chunks binarios
            const audioBuffer = Buffer.concat(audioChunks);
            console.log(`[Inworld TTS] Audio combined: ${audioBuffer.length} bytes from ${audioChunks.length} chunks`);

            if (!audioBuffer || audioBuffer.length === 0) {
              reject(new Error('No audio content found'));
              return;
            }

            resolve({
              success: true,
              audio: audioBuffer,
              contentType: 'audio/mpeg'
            });

          } catch (err) {
            console.error('[Inworld TTS] Error processing response:', err.message);
            reject(err);
          }
        });
      });

      req.on('error', (err) => {
        console.error('[Inworld TTS] Request error:', err.message);
        reject(err);
      });

      console.log(`[Inworld TTS] Sending request - voiceId: ${voiceId}, modelId: ${this.modelId}`);
      req.write(requestBody);
      req.end();
    });
  }

  /**
   * Obtener voces disponibles
   */
  async getAvailableVoices() {
    return [
      { voice_id: 'Diego', name: 'Diego', category: 'premade' },
      { voice_id: 'default-cfjnp8x4nt-owd7yg-1xsw__garret', name: 'Garret (Clonada)', category: 'cloned' },
      { voice_id: 'default-cfjnp8x4nt-owd7yg-1xsw__connor', name: 'Connor (Clonada)', category: 'cloned' }
    ];
  }
}

export default new InworldTtsService();
