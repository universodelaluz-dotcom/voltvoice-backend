// Servicio TTS ultra-simple usando Google Translate API directamente
// Sin dependencias complicadas, solo HTTPS nativo

import https from 'https';
import { URL } from 'url';

class SimpleTtsService {
  constructor() {
    this.baseUrl = 'https://translate.google.com/translate_tts';
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

  // Descargar desde URL
  downloadFromUrl(url) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);

      https.get(parsedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
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

      const lang = this.getLanguageCode(voiceId);

      // Construir URL de Google Translate TTS
      const ttsUrl = `${this.baseUrl}?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob&prev=input&ttsspeed=1`;

      console.log('[SimpleTTS] Downloading from:', ttsUrl.substring(0, 100) + '...');

      // Descargar audio
      const audioBuffer = await this.downloadFromUrl(ttsUrl);

      console.log('[SimpleTTS] Audio downloaded, size:', audioBuffer.length);

      return {
        success: true,
        audio: audioBuffer,
        contentType: 'audio/mpeg'
      };
    } catch (error) {
      console.error('[SimpleTTS] Error synthesizing:', error.message);
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
      console.error('[SimpleTTS] Error in synthesizeAndSave:', error.message);
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

export default new SimpleTtsService();
