# ⚡ QUICK START GUIDE - VOLTVOICE

## 🔥 PROBLEMA ACTUAL (2026-03-25)
**Error 403 de Inworld TTS**

### Solución Inmediata
1. Ve a: https://dashboard.render.com
2. Selecciona: **voltvoice-backend**
3. Click: **Environment**
4. Busca: **INWORLD_API_KEY**
5. Cámbialo a:
```
Basic MnQ4UEtPS0RiR3hpTVREZmJBcUViZXhtYnppTWxUVEM6cmFrdWFNSzFGM3RlVXNrQ2FIc21aa0N2bXdYZm0zOVlXS3l6UFpkVDkwc2x1MEdtR0J4eHZncVdOZ0o4eE4zMQ==
```
6. Click: **Save** → Render redeploy automático (2-3 min)
7. Prueba en: https://voltvoice-frontend.vercel.app

---

## 🎙️ VOCES DISPONIBLES

| Voz | Tipo | Costo |
|-----|------|-------|
| Diego, Lupita, Miguel, Rafael | Inworld Estándar | $5/1M chars |
| Garret, Connor | Inworld Clonada | $5/1M chars |
| es-ES, es-MX, en-US | Google TTS | GRATIS |
| web-speech-es, web-speech-en | Sistema Local | GRATIS |

---

## 📱 URLS IMPORTANTES

| Servicio | URL |
|----------|-----|
| **Frontend** | https://voltvoice-frontend.vercel.app |
| **Backend** | https://voltvoice-backend.onrender.com |
| **Health Check** | https://voltvoice-backend.onrender.com/api/inworld/health |
| **Studio** | https://voltvoice-frontend.vercel.app/studio |

---

## 🔧 COMANDOS DE DEBUG

### Verificar API Key
```bash
curl https://voltvoice-backend.onrender.com/api/inworld/health
```

### Test Síntesis (Diego)
```bash
curl -X POST https://voltvoice-backend.onrender.com/api/inworld/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"hola mundo","voiceId":"Diego"}'
```

---

## 📂 ARCHIVOS CRÍTICOS

**Backend:** backend/src/routes/inworld.js
**Frontend:** frontend/src/components/SynthesisStudio.jsx
**Config:** inworld_custom_voices.json, STATE.md

---

## ✅ CHECKLIST PRÓXIMA SESIÓN

- [ ] Cambiar INWORLD_API_KEY a formato base64 en Render
- [ ] Testear síntesis con voces estándar
- [ ] Testear síntesis con voces clonadas
- [ ] Probar TikTok LIVE mode

---

**Last Updated:** 2026-03-25 23:50 UTC
