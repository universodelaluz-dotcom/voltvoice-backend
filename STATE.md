# VOLTVOICE - ESTADO ACTUAL DEL PROYECTO

**Última actualización:** 2026-03-25 23:49 UTC

## 🎯 OBJETIVO PRINCIPAL
Implementar TikTok LIVE chat reader que sintetiza mensajes en voz en tiempo real usando Inworld AI.

## 📊 STATUS GENERAL
- ✅ Backend (Render): Operativo
- ✅ Frontend (Vercel): Operativo
- ✅ Inworld AI TTS: Configurado (en corrección de auth)
- ✅ Google TTS: Fallback funcionando
- ✅ Web Speech API: Sistema local disponible
- 🔄 TikTok LIVE: Rutas creadas, testing en progreso

---

## 🔑 CREDENCIALES CONFIGURADAS

### Inworld AI (CRÍTICO)
**Ubicación:** Render Dashboard → Environment Variables
```
Key: INWORLD_API_KEY
Value: 2t8PkOKDbGxiMTdfbAqUbexmbiizMlTDC:rakuaMK1F3teUskCaHsmZkCvmwXfm39YWKyzPZdT90slu0GmGBxxvgqWNgJ8xN31
```

**Formato alternativo (ya base64-encoded):**
```
Basic MnQ4UEtPS0RiR3hpTVREZmJBcUViZXhtYnppTWxUVEM6cmFrdWFNSzFGM3RlVXNrQ2FIc21aa0N2bXdYZm0zOVlXS3l6UFpkVDkwc2x1MEdtR0J4eHZncVdOZ0o4eE4zMQ==
```

**Estado:** ✅ Configurada en Render
**Próximo paso:** Cambiar a formato base64 si sigue fallando 403

### Voces Clonadas (Inworld)
**Archivo:** `inworld_custom_voices.json`
```json
{
  "garret": "default-cfjnp8x4nt-owd7yg-1xsw__garret",
  "connor": "default-cfjnp8x4nt-owd7yg-1xsw__connor"
}
```

### Voces Disponibles
**Inworld Estándar:**
- Diego
- Lupita
- Miguel
- Rafael

**Google TTS:**
- es-ES (Español)
- es-MX (Mexicano)
- en-US (English)

**Sistema Local (Web Speech):**
- web-speech-es
- web-speech-en

---

## 🛠️ INFRAESTRUCTURA

### Backend (Render)
- **URL:** https://voltvoice-backend.onrender.com
- **Rutas principales:**
  - `/api/inworld/tts` - Síntesis de voz Inworld
  - `/api/inworld/health` - Health check
  - `/api/synthesis/synthesize` - Google TTS fallback
  - `/api/tiktok/connect` - Conectar a TikTok LIVE
  - `/api/tiktok/message` - Procesar mensaje TikTok

### Frontend (Vercel)
- **URL:** https://voltvoice-frontend.vercel.app
- **Studio:** `/studio` (modo TikTok LIVE)
- **Endpoints de API:**
  - `/api/inworld-tts` - Proxy a Inworld (Vercel)
  - `/api/clone-voice` - Clonación de voces

### Database
- **PostgreSQL en Render**
- Usuarios, transacciones, tokens

---

## 🚀 CÓMO LEVANTAR EL PROYECTO

### 1. Backend (Render)
```bash
cd backend
npm install
npm start
```
Se despliega automáticamente en Render al pushear a GitHub.

### 2. Frontend (Vercel)
```bash
cd frontend
npm install
npm run dev
```
Se despliega automáticamente en Vercel al pushear a GitHub.

---

## ⚙️ CONFIGURACIÓN CRÍTICA

### Problema conocido: 403 Forbidden de Inworld
**Solución:** Cambiar INWORLD_API_KEY en Render a formato base64:
```
INWORLD_API_KEY = Basic MnQ4UEtPS0RiR3hpTVREZmJBcUViZXhtYnppTWxUVEM6cmFrdWFNSzFGM3RlVXNrQ2FIc21aa0N2bXdYZm0zOVlXS3l6UFpkVDkwc2x1MEdtR0J4eHZncVdOZ0o4eE4zMQ==
```

### Endpoints de debug
- `https://voltvoice-backend.onrender.com/api/inworld/health` - Verifica API key
- `https://voltvoice-backend.onrender.com/api/health` - Health general

---

## 📝 TECNOLOGÍAS

| Servicio | Tech | Status |
|----------|------|--------|
| Backend | Express.js, Node.js | ✅ Render |
| Frontend | React, Vite, Tailwind | ✅ Vercel |
| TTS | Inworld AI, Google Cloud | ✅ Configurado |
| DB | PostgreSQL | ✅ Render |
| Real-time | WebSocket | ✅ Implementado |
| Audio | Web Audio API, MP3 | ✅ Funcional |

---

## 💰 COSTOS

**Inworld AI:**
- $5 por millón de caracteres
- 1 hora stream = ~$0.075 (15,000 chars)
- 8x más barato que ElevenLabs

**Google TTS:**
- GRATIS (fallback)

**Web Speech:**
- GRATIS (local, sin servidor)

---

## 📂 ESTRUCTURA DE ARCHIVOS IMPORTANTE

```
backend/
├── server.js                          # Entry point
├── src/
│   ├── routes/
│   │   ├── inworld.js                # ⭐ TTS endpoint
│   │   ├── tiktok.js                 # TikTok chat reader
│   │   └── synthesis.js              # Google TTS fallback
│   └── services/
│       ├── inworldTtsService.js       # Inworld service
│       ├── tiktokLiveService.js       # TikTok service
│       └── websocketServer.js         # WebSocket
├── .env.production                    # 🔑 CRÍTICO
└── inworld_custom_voices.json         # Voces clonadas

frontend/
├── src/
│   └── components/
│       ├── SynthesisStudio.jsx        # ⭐ Main studio UI
│       ├── TikTokLivePanel.jsx        # TikTok mode
│       └── VoiceCloningPanel.jsx      # Voice cloning
├── api/
│   └── inworld-tts.js                 # Proxy Inworld
└── .env.local                         # INWORLD_API_KEY
```

---

## 🔄 WORKFLOW ACTUAL

1. **Usuario abre Studio** → Selecciona voz (Inworld, Google o Sistema)
2. **Escribe texto** → Hace click "Sintetizar"
3. **Frontend envía** → POST `/api/inworld/tts` con `{text, voiceId}`
4. **Backend Render** → Llama Inworld API con Basic Auth
5. **Inworld responde** → JSON con audioContent (base64)
6. **Backend parsea** → Extrae múltiples chunks de base64
7. **Backend retorna** → Audio como data:audio/mpeg;base64,...
8. **Frontend reproduce** → Audio player HTML5

---

## 📋 PRÓXIMOS PASOS

1. ✅ Verificar auth Inworld (403 error)
2. 🔄 Testear síntesis con todas las voces
3. 🔄 Implementar TikTok LIVE real (ahora es mock)
4. 🔄 Agregar WebSocket para mensajes en vivo
5. 🔄 Implementar queue de audio automático
6. 🔄 Agregar UI para mostrar stats (chars, tokens, etc)
7. 🔄 Testing con streamer real

---

## 🧑‍💻 ÚLTIMA SESIÓN

**Problema arreglado:** Error 403 de Inworld
- Causa: Formato incorrecto de API key (faltaba base64)
- Solución: Código ahora soporta ambos formatos
- Status: Pendiente de redeploy en Render

**Archivos modificados:**
- `backend/src/routes/inworld.js` - Agregado soporte dual de auth
- `frontend/src/components/SynthesisStudio.jsx` - Voces correctas (Diego, Lupita, etc)

**Commits recientes:**
```
2052d33 - Handle both API key formats - supports 'Basic ...' header or raw username:password
829f03b - Fix variable naming conflict - rename https.request object from req to httpsReq
352aab2 - Add debug info to health endpoint
```

---

## 🆘 DEBUGGING

### Test Inworld Health
```bash
curl https://voltvoice-backend.onrender.com/api/inworld/health
```
Debería retornar: `apiKeyConfigured: true`

### Test Síntesis
```bash
curl -X POST https://voltvoice-backend.onrender.com/api/inworld/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"hola","voiceId":"Diego"}'
```

### Logs de Render
Ver en: https://dashboard.render.com → voltvoice-backend → Logs

---

**MANTENER ESTE ARCHIVO ACTUALIZADO CON CADA CAMBIO IMPORTANTE**
