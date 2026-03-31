import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

const BACKEND_URL = 'https://voltvoice-backend.onrender.com';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (!ADMIN_API_KEY) {
  console.error('❌ ADMIN_API_KEY no está configurada en .env');
  process.exit(1);
}

async function addHaythamVoice() {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      email: 'alainsh@gmail.com',
      voiceName: 'Haytham',
      voiceId: 'default-cfjnp8x4nt-owd7yg-1xsw__haytham'
    });

    const options = {
      hostname: 'voltvoice-backend.onrender.com',
      path: '/api/settings/voices/add-to-user',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-admin-key': ADMIN_API_KEY
      }
    };

    console.log('📝 Agregando voz Haytham a alainsh@gmail.com...');

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 201 || res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            console.log('✅ ¡Voz Haytham agregada exitosamente!');
            console.log('📌 Detalles:', result.voice);
            resolve(result);
          } catch (e) {
            reject(new Error(`Error parseando respuesta: ${e.message}`));
          }
        } else {
          console.error(`❌ Error ${res.statusCode}: ${data}`);
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error('❌ Error en request:', err.message);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

addHaythamVoice()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
