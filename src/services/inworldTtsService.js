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
   * Clonar voz usando Inworld AI Voice Cloning API
   * Endpoint: POST https://api.inworld.ai/voices/v1/voices:clone
   * Audio: 10-15 segundos, WAV o MP3
   */
  async cloneVoice(voiceName, audioBuffer, transcription = '', langCode = 'ES_ES') {
    return new Promise((resolve, reject) => {
      if (!voiceName) {
        reject(new Error('Voice name is required'));
        return;
      }

      if (!audioBuffer || audioBuffer.length === 0) {
        reject(new Error('Audio data is required'));
        return;
      }

      if (!this.apiKey) {
        reject(new Error('Inworld API key not configured'));
        return;
      }

      console.log(`[Inworld Clone] Cloning voice: "${voiceName}" (${audioBuffer.length} bytes, lang: ${langCode})`);

      const base64Audio = Buffer.isBuffer(audioBuffer)
        ? audioBuffer.toString('base64')
        : audioBuffer;

      const requestBody = JSON.stringify({
        displayName: voiceName,
        langCode: langCode,
        voiceSamples: [
          {
            audioData: base64Audio,
            transcription: transcription || `Sample audio for voice ${voiceName}`
          }
        ],
        description: `Voz clonada: ${voiceName} - StreamVoicer`,
        audioProcessingConfig: {
          removeBackgroundNoise: true
        }
      });

      const options = {
        hostname: 'api.inworld.ai',
        port: 443,
        path: '/voices/v1/voices:clone',
        method: 'POST',
        headers: {
          'Authorization': `Basic ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));

        res.on('end', () => {
          try {
            const dataBuffer = Buffer.concat(chunks);
            const data = dataBuffer.toString('utf-8');

            console.log(`[Inworld Clone] Response status: ${res.statusCode}`);

            if (res.statusCode !== 200) {
              console.error(`[Inworld Clone] API error: ${res.statusCode} - ${data.substring(0, 500)}`);
              reject(new Error(`Inworld clone error: ${res.statusCode} - ${data}`));
              return;
            }

            const result = JSON.parse(data);
            const voiceId = result.voice?.voiceId || result.voice?.name || null;

            if (!voiceId) {
              console.error('[Inworld Clone] No voiceId in response:', data.substring(0, 300));
              reject(new Error('No voiceId returned from Inworld'));
              return;
            }

            console.log(`[Inworld Clone] ✓ Voice cloned successfully: ${voiceName} → ${voiceId}`);

            // Verificar warnings del audio
            if (result.audioSamplesValidated) {
              result.audioSamplesValidated.forEach((sample, i) => {
                if (sample.warnings?.length > 0) {
                  console.warn(`[Inworld Clone] Audio warnings: ${sample.warnings.join(', ')}`);
                }
                if (sample.errors?.length > 0) {
                  console.error(`[Inworld Clone] Audio errors: ${sample.errors.join(', ')}`);
                }
              });
            }

            resolve({
              success: true,
              voiceId: voiceId,
              voiceName: result.voice?.displayName || voiceName,
              provider: 'inworld'
            });

          } catch (err) {
            console.error('[Inworld Clone] Error parsing response:', err.message);
            reject(err);
          }
        });
      });

      req.on('error', (err) => {
        console.error('[Inworld Clone] Request error:', err.message);
        reject(err);
      });

      req.write(requestBody);
      req.end();
    });
  }

  /**
   * Diseñar una voz personalizada usando Inworld AI Voice Design
   * Endpoint: POST https://api.inworld.ai/voices/v1/voices:design
   * Params: designPrompt, langCode, previewText
   */
  async designVoice(designPrompt, langCode = 'ES_ES', previewText = '') {
    return new Promise((resolve, reject) => {
      if (!designPrompt || designPrompt.length === 0) {
        reject(new Error('Design prompt is required'));
        return;
      }

      if (!this.apiKey) {
        reject(new Error('Inworld API key not configured'));
        return;
      }

      console.log(`[Inworld Design] Diseñando voz: "${designPrompt.substring(0, 50)}..." (lang: ${langCode})`);

      const requestBody = JSON.stringify({
        designPrompt: designPrompt,
        langCode: langCode,
        previewText: previewText || designPrompt.substring(0, 100),
        voiceDesignConfig: {
          numberOfSamples: 1
        }
      });

      const options = {
        hostname: 'api.inworld.ai',
        port: 443,
        path: '/voices/v1/voices:design',
        method: 'POST',
        headers: {
          'Authorization': `Basic ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));

        res.on('end', () => {
          try {
            const dataBuffer = Buffer.concat(chunks);
            const data = dataBuffer.toString('utf-8');

            console.log(`[Inworld Design] Response status: ${res.statusCode}`);

            if (res.statusCode !== 200) {
              console.error(`[Inworld Design] API error: ${res.statusCode} - ${data.substring(0, 500)}`);
              reject(new Error(`Inworld design error: ${res.statusCode} - ${data}`));
              return;
            }

            const result = JSON.parse(data);
            const previewVoices = result.previewVoices || [];

            if (previewVoices.length === 0) {
              console.error('[Inworld Design] No preview voices generated');
              reject(new Error('No preview voices generated from Inworld'));
              return;
            }

            const voiceId = previewVoices[0].voiceId;
            console.log(`[Inworld Design] ✓ Voz diseñada exitosamente: ${voiceId}`);

            resolve({
              success: true,
              voiceId: voiceId,
              langCode: result.langCode,
              previewText: previewVoices[0].previewText,
              previewAudio: previewVoices[0].previewAudio
            });

          } catch (err) {
            console.error('[Inworld Design] Error parseando respuesta:', err.message);
            reject(err);
          }
        });
      });

      req.on('error', (err) => {
        console.error('[Inworld Design] Error en request:', err.message);
        reject(err);
      });

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
