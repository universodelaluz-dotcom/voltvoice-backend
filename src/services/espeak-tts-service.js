// Servicio de Text-to-Speech usando google-tts-api
// Opción gratuita, sin API key, funciona 100% en npm

import googleTTS from 'google-tts-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Crear directorio temp si no existe
const tmpDir = path.join(__dirname, '../../tmp');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

class GoogleTtsService {
  constructor() {
    this.tmpDir = tmpDir;
  }

  // Mapear voice IDs a idiomas
  getLanguageCode(voiceId) {
    const voiceMap = {
      'EXAVITQu4vr4xnSDxMaL': 'es',      // Bella -> Spanish
      '21m00Tcm4TlvDq8ikWAM': 'en',      // Rachel -> English
      'AZnzlk1uvptSRtMUZeKw': 'en',      // Domi -> English
      'EL1QtFI7ePme4xLqrPzT': 'en',      // Elli -> English
      'MF3mGyEYCl7XYWbV7PLe': 'en',      // Gigi -> English
      'TxGEqnHWrfWFTfGW9XjX': 'en',      // Harry -> English
    };
    return voiceMap[voiceId] || 'es';
  }

  // Descargar audio desde URL
  downloadAudio(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (response) => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
  }

  async synthesize(text, voiceId = 'EXAVITQu4vr4xnSDxMaL') {
    try {
      if (!text || text.length === 0) {
        throw new Error('Text cannot be empty');
      }

      if (text.length > 5000) {
        throw new Error('Text too long. Maximum 5000 characters.');
      }

      const language = this.getLanguageCode(voiceId);

      // Usar google-tts-api para obtener URL de audio
      const url = await googleTTS.getAudioUrl({
        text: text,
        lang: language,
        slow: false,
        host: 'https://translate.google.com',
      });

      // Descargar el audio
      const audioBuffer = await this.downloadAudio(url);

      return {
        success: true,
        audio: audioBuffer,
        contentType: 'audio/mpeg'
      };
    } catch (error) {
      console.error('[Google TTS] Error synthesizing:', error.message);
      throw error;
    }
  }

  async synthesizeAndSave(text, voiceId, userId) {
    try {
      const audioBuffer = await this.synthesize(text, voiceId);

      // Retornar como base64 data URL
      const base64 = audioBuffer.audio.toString('base64');
      const audioUrl = `data:audio/mpeg;base64,${base64}`;

      return {
        success: true,
        audioUrl: audioUrl,
        duration: null
      };
    } catch (error) {
      console.error('[Google TTS] Error in synthesizeAndSave:', error.message);
      throw error;
    }
  }

  // Métodos stub para compatibilidad
  async getAvailableVoices() {
    return [
      { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella - Spanish', category: 'premade' },
      { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel - English', category: 'premade' },
      { voice_id: 'AZnzlk1uvptSRtMUZeKw', name: 'Domi - English', category: 'premade' },
      { voice_id: 'EL1QtFI7ePme4xLqrPzT', name: 'Elli - English', category: 'premade' },
      { voice_id: 'MF3mGyEYCl7XYWbV7PLe', name: 'Gigi - English', category: 'premade' },
      { voice_id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Harry - English', category: 'premade' }
    ];
  }

  async getUserVoices() {
    return [];
  }

  async getUsage() {
    return {
      characterLimit: 999999999,
      charactersUsed: 0,
      remainingCharacters: 999999999,
      tier: 'free'
    };
  }

  async cloneVoice(name, files) {
    throw new Error('Voice cloning not available');
  }

  async deleteVoice(voiceId) {
    throw new Error('Voice deletion not available');
  }
}

export default new GoogleTtsService();
