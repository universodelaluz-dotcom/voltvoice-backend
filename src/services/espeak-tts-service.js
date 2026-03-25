// Servicio de Text-to-Speech local usando espeak-ng
// Opción gratuita sin API externa

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const execPromise = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Crear directorio temp si no existe
const tmpDir = path.join(__dirname, '../../tmp');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

class EspeakTtsService {
  constructor() {
    this.tmpDir = tmpDir;
  }

  // Mapear voice IDs a idiomas espeak
  getLanguageCode(voiceId) {
    const voiceMap = {
      'EXAVITQu4vr4xnSDxMaL': 'es',      // Bella -> Spanish
      '21m00Tcm4TlvDq8ikWAM': 'en',      // Rachel -> English
      'AZnzlk1uvptSRtMUZeKw': 'en',      // Domi -> English
      'EL1QtFI7ePme4xLqrPzT': 'en-gb',   // Elli -> English (GB)
      'MF3mGyEYCl7XYWbV7PLe': 'en',      // Gigi -> English
      'TxGEqnHWrfWFTfGW9XjX': 'en',      // Harry -> English
    };
    return voiceMap[voiceId] || 'es';
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
      const outputFile = path.join(this.tmpDir, `speech-${Date.now()}-${Math.random().toString(36).substring(7)}.wav`);

      // Ejecutar espeak-ng
      const command = `espeak-ng -v ${language} -w "${outputFile}" "${text.replace(/"/g, '\\"')}"`;

      try {
        await execPromise(command);
      } catch (error) {
        console.error('[espeak] Error executing command:', error.message);
        throw new Error('espeak-ng not available or error generating speech');
      }

      // Leer archivo WAV generado
      if (!fs.existsSync(outputFile)) {
        throw new Error('Failed to generate audio file');
      }

      const audioBuffer = fs.readFileSync(outputFile);

      // Limpiar archivo temporal
      try {
        fs.unlinkSync(outputFile);
      } catch (e) {
        console.warn('[espeak] Failed to delete temp file:', outputFile);
      }

      return {
        success: true,
        audio: audioBuffer,
        contentType: 'audio/wav'
      };
    } catch (error) {
      console.error('[espeak TTS] Error synthesizing:', error.message);
      throw error;
    }
  }

  async synthesizeAndSave(text, voiceId, userId) {
    try {
      const audioBuffer = await this.synthesize(text, voiceId);

      // Retornar como base64 data URL
      const base64 = audioBuffer.audio.toString('base64');
      const audioUrl = `data:audio/wav;base64,${base64}`;

      return {
        success: true,
        audioUrl: audioUrl,
        duration: null
      };
    } catch (error) {
      console.error('[espeak TTS] Error in synthesizeAndSave:', error.message);
      throw error;
    }
  }

  // Métodos stub para compatibilidad con googleTtsService
  async getAvailableVoices() {
    return [
      { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella - Spanish', category: 'premade' },
      { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel - English', category: 'premade' },
      { voice_id: 'AZnzlk1uvptSRtMUZeKw', name: 'Domi - English', category: 'premade' },
      { voice_id: 'EL1QtFI7ePme4xLqrPzT', name: 'Elli - English (UK)', category: 'premade' },
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
      tier: 'local'
    };
  }

  async cloneVoice(name, files) {
    throw new Error('Voice cloning not available with local TTS');
  }

  async deleteVoice(voiceId) {
    throw new Error('Voice deletion not available with local TTS');
  }
}

export default new EspeakTtsService();
