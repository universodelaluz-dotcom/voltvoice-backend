// Servicio de ElevenLabs para síntesis de voz - usando librería oficial

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

class ElevenLabsService {
  constructor() {
    this.apiKey = this.getApiKey();
    this.client = new ElevenLabsClient({ apiKey: this.apiKey });
  }

  getApiKey() {
    return (process.env.ELEVENLABS_API_KEY || '').trim().replace(/^['"]|['"]$/g, '');
  }

  // Obtener lista de voces disponibles
  async getAvailableVoices() {
    try {
      const response = await this.client.voices.getAll();
      return response.voices || [];
    } catch (error) {
      console.error('[ElevenLabs] Error fetching voices:', error.message);
      throw error;
    }
  }

  // Sintetizar texto a voz
  async synthesize(text, voiceId = 'EXAVITQu4vr4xnSDxMaL') {
    try {
      if (!text || text.length === 0) {
        throw new Error('Text cannot be empty');
      }

      if (text.length > 5000) {
        throw new Error('Text too long. Maximum 5000 characters.');
      }

      const audioStream = await this.client.textToSpeech.convert(voiceId, {
        text: text,
        modelId: 'eleven_flash_v2_5',
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75
        }
      });

      // Convertir stream a buffer
      const chunks = [];
      for await (const chunk of audioStream) {
        chunks.push(chunk);
      }
      const audioBuffer = Buffer.concat(chunks);

      return {
        success: true,
        audio: audioBuffer,
        contentType: 'audio/mpeg'
      };
    } catch (error) {
      console.error('[ElevenLabs] Error synthesizing:', error.message);
      throw error;
    }
  }

  // Sintetizar y retornar como URL base64
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
      console.error('[ElevenLabs] Error in synthesizeAndSave:', error.message);
      throw error;
    }
  }

  // Clonar voz
  async cloneVoice(name, description, files) {
    try {
      // Implementación para clonar voces
      throw new Error('Voice cloning not implemented yet');
    } catch (error) {
      console.error('[ElevenLabs] Error cloning voice:', error.message);
      throw error;
    }
  }

  // Obtener voces del usuario
  async getUserVoices(userId) {
    try {
      const voices = await this.client.voices.getAll();
      return voices.filter(v => v.category === 'cloned');
    } catch (error) {
      console.error('[ElevenLabs] Error fetching user voices:', error.message);
      throw error;
    }
  }

  // Obtener uso de la API
  async getUsage() {
    try {
      const subscription = await this.client.user.getSubscriptionInfo();
      return {
        characterLimit: subscription.character_limit,
        charactersUsed: subscription.characters_used,
        remainingCharacters: subscription.character_limit - subscription.characters_used,
        tier: subscription.tier
      };
    } catch (error) {
      console.error('[ElevenLabs] Error fetching usage:', error.message);
      throw error;
    }
  }

  // Eliminar voz
  async deleteVoice(voiceId) {
    try {
      await this.client.voices.delete(voiceId);
      return { success: true };
    } catch (error) {
      console.error('[ElevenLabs] Error deleting voice:', error.message);
      throw error;
    }
  }
}

export default new ElevenLabsService();
