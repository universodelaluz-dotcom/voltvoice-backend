import gTTS from 'google-tts-api';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { config } from '../config.js';

const log = (msg, ...args) => console.log(`[TTS]`, msg, ...args);

/**
 * Obtiene URL de audio desde Google TTS
 * @param {string} text - Texto a sintetizar
 * @returns {Promise<string>} URL del audio MP3
 */
export const synthesizeText = async (text) => {
  if (!text || text.trim().length === 0) {
    throw new Error('Text cannot be empty');
  }

  try {
    log(`Sintetizando: "${text.substring(0, 50)}..."`);

    const url = gTTS.getAudioUrl(text, {
      lang: config.GOOGLE_TTS_LANG,
      slow: false,
    });

    // Validar que la URL sea válida
    if (!url || !url.startsWith('http')) {
      throw new Error('Invalid audio URL generated');
    }

    return url;
  } catch (err) {
    log(`Error: ${err.message}`);
    throw err;
  }
};

/**
 * Descarga audio de URL
 * @param {string} url - URL del audio
 * @returns {Promise<Buffer>} Buffer del audio
 */
export const downloadAudio = async (url) => {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      const chunks = [];

      response.on('data', (chunk) => {
        chunks.push(chunk);
      });

      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        log(`Audio descargado: ${buffer.length} bytes`);
        resolve(buffer);
      });

      response.on('error', (err) => {
        reject(new Error(`Download error: ${err.message}`));
      });
    }).on('error', (err) => {
      reject(new Error(`HTTPS error: ${err.message}`));
    });
  });
};

/**
 * Sintetiza y descarga audio en un paso
 * @param {string} text
 * @returns {Promise<{url: string, buffer: Buffer}>}
 */
export const synthesizeAndDownload = async (text) => {
  const url = await synthesizeText(text);
  const buffer = await downloadAudio(url);
  return { url, buffer };
};

/**
 * Censura palabras fuertes (es-MX)
 */
const badWords = [
  'mierda', 'puta', 'pendejo', 'cabrón', 'jodido', 'culo', 'coño',
  'carajo', 'puto', 'bastardo', 'maldito', 'hijo de', 'culero',
  'mamada', 'verga', 'chingada', 'chingado', 'culada', 'maricon',
  'marica', 'pájaro', 'boludo', 'chamaco', 'pelotudo'
];

export const censorBadWords = (text) => {
  let result = text;
  badWords.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    result = result.replace(regex, '*'.repeat(word.length));
  });
  return result;
};

export default {
  synthesizeText,
  downloadAudio,
  synthesizeAndDownload,
  censorBadWords,
};
