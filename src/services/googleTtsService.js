// Google Cloud Text-to-Speech Service

import textToSpeech from '@google-cloud/text-to-speech';

class GoogleTtsService {
  constructor() {
    // Usar credenciales del ambiente
    this.client = new textToSpeech.TextToSpeechClient({
      credentials: this.getCredentials()
    });
  }

  getCredentials() {
    const credentialsJson = process.env.GOOGLE_CLOUD_CREDENTIALS;
    if (!credentialsJson) {
      // Si no hay credenciales JSON, usar credenciales del ambiente
      return undefined;
    }
    try {
      return JSON.parse(credentialsJson);
    } catch (err) {
      console.error('Error parsing Google Cloud credentials:', err);
      return undefined;
    }
  }

  async synthesize(text, voiceId = 'es-MX-Neural2-A') {
    try {
      if (!text || text.length === 0) {
        throw new Error('Text cannot be empty');
      }

      if (text.length > 5000) {
        throw new Error('Text too long. Maximum 5000 characters.');
      }

      // Mapear voiceId de ElevenLabs y voces básicas a Google Cloud voice names
      const voiceMap = {
        // Voces básicas (limitadas)
        'en-US': 'en-US-Neural2-C',  // Voz Básica Inglés
        'es-ES': 'es-ES-Neural2-A',  // Voz Básica Español
        // ElevenLabs voices
        'EXAVITQu4vr4xnSDxMaL': 'es-MX-Neural2-A', // Bella -> Spanish (Mexico)
        '21m00Tcm4TlvDq8ikWAM': 'en-US-Neural2-C', // Rachel -> English (US)
        'AZnzlk1uvptSRtMUZeKw': 'en-US-Neural2-A', // Domi -> English (US)
        'EL1QtFI7ePme4xLqrPzT': 'en-GB-Neural2-A', // Elli -> English (UK)
        'MF3mGyEYCl7XYWbV7PLe': 'en-US-Neural2-E', // Gigi -> English (US)
        'TxGEqnHWrfWFTfGW9XjX': 'en-US-Neural2-B', // Harry -> English (US)
      };

      const googleVoice = voiceMap[voiceId] || 'es-MX-Neural2-A';

      const request = {
        input: { text: text },
        voice: {
          languageCode: googleVoice.split('-').slice(0, 2).join('-'),
          name: googleVoice
        },
        audioConfig: {
          audioEncoding: 'MP3'
        }
      };

      const [response] = await this.client.synthesizeSpeech(request);
      const audioContent = response.audioContent;

      return {
        success: true,
        audio: audioContent,
        contentType: 'audio/mpeg'
      };
    } catch (error) {
      console.error('[Google Cloud TTS] Error synthesizing:', error.message);
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
      console.error('[Google Cloud TTS] Error in synthesizeAndSave:', error.message);
      throw error;
    }
  }

  // Métodos stub para compatibilidad
  async getAvailableVoices() {
    return [
      { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella - Spanish (Mexico)', category: 'premade' },
      { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel - English (US)', category: 'premade' },
      { voice_id: 'AZnzlk1uvptSRtMUZeKw', name: 'Domi - English (US)', category: 'premade' },
      { voice_id: 'EL1QtFI7ePme4xLqrPzT', name: 'Elli - English (UK)', category: 'premade' },
      { voice_id: 'MF3mGyEYCl7XYWbV7PLe', name: 'Gigi - English (US)', category: 'premade' },
      { voice_id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Harry - English (US)', category: 'premade' }
    ];
  }

  async getUserVoices() {
    return [];
  }

  async getUsage() {
    return {
      characterLimit: 1000000,
      charactersUsed: 0,
      remainingCharacters: 1000000,
      tier: 'free'
    };
  }

  async cloneVoice(name, files) {
    throw new Error('Voice cloning not available with Google Cloud TTS');
  }

  async deleteVoice(voiceId) {
    throw new Error('Voice deletion not available with Google Cloud TTS');
  }
}

export default new GoogleTtsService();
