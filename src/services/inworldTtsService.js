// Inworld AI Text-to-Speech Service
// $5 per million characters (Mini) or $10 per million (Max)
// ~8x cheaper than ElevenLabs

import axios from 'axios';

class InworldTtsService {
  constructor() {
    this.apiKey = process.env.INWORLD_API_KEY;
    this.baseUrl = 'https://api.inworld.ai/tts/v1';
    this.model = 'tts-1.5-max'; // Premium model with voice cloning

    if (!this.apiKey) {
      console.warn('[Inworld TTS] API key not configured');
    }
  }

  /**
   * Sintetizar texto a voz
   * @param {string} text - Texto a sintetizar
   * @param {string} voiceId - ID de la voz (preexistente o clonada)
   * @returns {Promise<Buffer>} Audio MP3
   */
  async synthesize(text, voiceId = 'default-cfjnp8x4nt-owd7yg-1xsw__garret') {
    try {
      if (!text || text.length === 0) {
        throw new Error('Text cannot be empty');
      }

      if (text.length > 5000) {
        throw new Error('Text too long. Maximum 5000 characters.');
      }

      if (!this.apiKey) {
        throw new Error('Inworld API key not configured');
      }

      console.log(`[Inworld TTS] Synthesizing: "${text.substring(0, 50)}..." with voice: ${voiceId}`);

      // Endpoint: voice:stream para respuesta streaming
      const response = await axios.post(
        `${this.baseUrl}/voice:stream`,
        {
          text: text,
          voice_id: voiceId,
          model_id: 'inworld-tts-1.5-max',
          audio_config: {
            audio_encoding: 'MP3',
            speaking_rate: 1
          },
          temperature: 1
        },
        {
          headers: {
            'Authorization': `Basic ${Buffer.from(this.apiKey).toString('base64')}`,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer',
          timeout: 30000
        }
      );

      console.log(`[Inworld TTS] Successfully synthesized ${text.length} characters (${response.data.length} bytes)`);

      return {
        success: true,
        audio: response.data,
        contentType: 'audio/mpeg'
      };
    } catch (error) {
      console.error('[Inworld TTS] Error synthesizing:', error.message);
      throw error;
    }
  }

  /**
   * Sintetizar y retornar como data URL
   */
  async synthesizeAndSave(text, voiceId, userId) {
    try {
      const result = await this.synthesize(text, voiceId);
      const base64 = Buffer.from(result.audio).toString('base64');
      const audioUrl = `data:audio/mpeg;base64,${base64}`;

      return {
        success: true,
        audioUrl: audioUrl,
        duration: null
      };
    } catch (error) {
      console.error('[Inworld TTS] Error in synthesizeAndSave:', error.message);
      throw error;
    }
  }

  /**
   * Clonar una voz con audio de referencia
   * @param {string} voiceName - Nombre para la voz clonada
   * @param {Buffer} audioBuffer - Audio de referencia (2-15 segundos)
   * @returns {Promise<string>} ID de la voz clonada
   */
  async cloneVoice(voiceName, audioBuffer) {
    try {
      if (!this.apiKey) {
        throw new Error('Inworld API key not configured');
      }

      console.log(`[Inworld TTS] Cloning voice: "${voiceName}"`);

      // Crear FormData con archivo de audio
      const FormData = require('form-data');
      const formData = new FormData();
      formData.append('name', voiceName);
      formData.append('audio', audioBuffer, { filename: 'reference.mp3' });

      const response = await axios.post(
        `${this.baseUrl}/voices:clone`,
        formData,
        {
          headers: {
            'Authorization': `Basic ${Buffer.from(this.apiKey).toString('base64')}`,
            ...formData.getHeaders()
          },
          timeout: 30000
        }
      );

      // Extraer voiceId de la respuesta
      const clonedVoiceId = response.data.voice_id || response.data.id;
      console.log(`[Inworld TTS] Voice cloned successfully: ${clonedVoiceId}`);

      return clonedVoiceId;
    } catch (error) {
      console.error('[Inworld TTS] Error cloning voice:', error.message);
      throw error;
    }
  }

  /**
   * Obtener voces disponibles (predefinidas + clonadas)
   */
  async getAvailableVoices() {
    return [
      // Voces predefinidas
      { voice_id: 'default-spanish', name: 'Spanish Default', category: 'premade' },
      { voice_id: 'default-english', name: 'English Default', category: 'premade' },

      // Voces clonadas del usuario
      { voice_id: 'default-cfjnp8x4nt-owd7yg-1xsw__garret', name: 'Garret (Clonada)', category: 'cloned' },
      { voice_id: 'default-cfjnp8x4nt-owd7yg-1xsw__connor', name: 'Connor (Clonada)', category: 'cloned' }
    ];
  }

  /**
   * Obtener voces del usuario (clonadas)
   */
  async getUserVoices(userId) {
    // TODO: Conectar a base de datos para obtener voces clonadas del usuario
    return [];
  }

  /**
   * Obtener uso de caracteres
   */
  async getUsage() {
    try {
      if (!this.apiKey) {
        return {
          characterLimit: 1000000,
          charactersUsed: 0,
          remainingCharacters: 1000000,
          tier: 'free'
        };
      }

      const response = await axios.get(
        `${this.baseUrl}/usage`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`
          }
        }
      );

      return response.data;
    } catch (error) {
      console.error('[Inworld TTS] Error getting usage:', error.message);
      return {
        characterLimit: 1000000,
        charactersUsed: 0,
        remainingCharacters: 1000000,
        tier: 'free'
      };
    }
  }

  /**
   * Eliminar una voz clonada
   */
  async deleteVoice(voiceId) {
    try {
      if (!this.apiKey) {
        throw new Error('Inworld API key not configured');
      }

      await axios.delete(
        `${this.baseUrl}/voices/${voiceId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`
          }
        }
      );

      console.log(`[Inworld TTS] Voice deleted: ${voiceId}`);
      return true;
    } catch (error) {
      console.error('[Inworld TTS] Error deleting voice:', error.message);
      throw error;
    }
  }

  /**
   * Obtener estadísticas de costo
   */
  getCostEstimate(characterCount) {
    // $5 per million characters (Mini)
    // $10 per million characters (Max)
    const costMini = (characterCount / 1000000) * 5;
    const costMax = (characterCount / 1000000) * 10;

    return {
      characters: characterCount,
      costMini: `$${costMini.toFixed(4)}`,
      costMax: `$${costMax.toFixed(4)}`,
      costMiniMXN: `$${(costMini * 18).toFixed(2)} MXN`,
      costMaxMXN: `$${(costMax * 18).toFixed(2)} MXN`
    };
  }
}

export default new InworldTtsService();
