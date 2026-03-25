// Servicio de ElevenLabs para síntesis de voz

import axios from 'axios';

class ElevenLabsService {
  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY;
    this.baseUrl = 'https://api.elevenlabs.io/v1';
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json'
      }
    });
  }

  // Obtener lista de voces disponibles
  async getAvailableVoices() {
    try {
      const response = await this.client.get('/voices');
      return response.data.voices;
    } catch (error) {
      console.error('Error fetching voices:', error.response?.data || error.message);
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

      const response = await this.client.post(
        `/text-to-speech/${voiceId}`,
        {
          text: text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        },
        {
          responseType: 'arraybuffer' // Obtener como buffer de audio
        }
      );

      return {
        success: true,
        audio: Buffer.from(response.data),
        contentType: response.headers['content-type']
      };
    } catch (error) {
      console.error('Error synthesizing:', error.response?.data || error.message);
      throw error;
    }
  }

  // Sintetizar y retornar URL (si se guarda en storage)
  async synthesizeAndSave(text, voiceId, userId) {
    try {
      const audioBuffer = await this.synthesize(text, voiceId);

      // Aquí iría la lógica para guardar en Cloudflare R2 o S3
      // Por ahora, retornamos el buffer en base64
      const base64 = audioBuffer.audio.toString('base64');
      const audioUrl = `data:audio/mpeg;base64,${base64}`;

      return {
        success: true,
        audioUrl: audioUrl,
        duration: null // ElevenLabs no retorna duración, necesitaría procesarlo
      };
    } catch (error) {
      console.error('Error synthesizing and saving:', error);
      throw error;
    }
  }

  // Clonar una voz (requiere archivo de audio)
  async cloneVoice(name, audioFile) {
    try {
      const formData = new FormData();
      formData.append('name', name);
      formData.append('files', audioFile);

      const response = await axios.post(
        `${this.baseUrl}/voices/add`,
        formData,
        {
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'multipart/form-data'
          }
        }
      );

      return response.data;
    } catch (error) {
      console.error('Error cloning voice:', error.response?.data || error.message);
      throw error;
    }
  }

  // Obtener voces del usuario (clonadas)
  async getUserVoices() {
    try {
      const response = await this.client.get('/voices');
      // Filtrar solo voces personalizadas
      return response.data.voices.filter(v => v.category === 'cloned');
    } catch (error) {
      console.error('Error fetching user voices:', error);
      throw error;
    }
  }

  // Obtener detalles de una voz específica
  async getVoiceDetails(voiceId) {
    try {
      const response = await this.client.get(`/voices/${voiceId}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching voice details:', error);
      throw error;
    }
  }

  // Eliminar una voz (solo clonadas)
  async deleteVoice(voiceId) {
    try {
      await this.client.delete(`/voices/${voiceId}`);
      return { success: true, message: 'Voice deleted' };
    } catch (error) {
      console.error('Error deleting voice:', error);
      throw error;
    }
  }

  // Obtener uso de API
  async getUsage() {
    try {
      const response = await this.client.get('/user');
      return {
        characterLimit: response.data.subscription.character_limit,
        charactersUsed: response.data.subscription.characters_used,
        remainingCharacters: response.data.subscription.character_limit - response.data.subscription.characters_used
      };
    } catch (error) {
      console.error('Error fetching usage:', error);
      throw error;
    }
  }
}

export default new ElevenLabsService();
