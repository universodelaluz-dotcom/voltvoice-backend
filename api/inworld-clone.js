// Vercel serverless function for Inworld voice cloning
// Clone a voice with 2-15 seconds of audio reference
// Much cheaper than ElevenLabs: $5 per million characters

import inworldTtsService from '../src/services/inworldTtsService.js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { voiceName, base64Audio, contentType } = req.body;

    if (!voiceName || !base64Audio) {
      return res.status(400).json({
        error: 'voiceName and base64Audio required'
      });
    }

    // Convertir base64 a Buffer
    const audioBuffer = Buffer.from(base64Audio, 'base64');

    console.log(`[Inworld Clone] Clonando voz: "${voiceName}" (${audioBuffer.length} bytes)`);

    // Clonar voz con Inworld
    const clonedVoiceId = await inworldTtsService.cloneVoice(voiceName, audioBuffer);

    return res.status(200).json({
      success: true,
      voiceId: clonedVoiceId,
      voiceName: voiceName,
      message: `Voz clonada exitosamente como: ${voiceName}`
    });
  } catch (error) {
    console.error('[Inworld Clone] Error:', error);
    return res.status(500).json({
      error: error.message || 'Error clonando voz',
      details: error.toString()
    });
  }
}
