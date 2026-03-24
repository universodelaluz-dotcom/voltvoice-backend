# 🚀 Deployment en Railway

## Paso 1: Crear cuenta en Railway

1. Ve a https://railway.app
2. Haz login con GitHub (recomendado)
3. Crea un nuevo proyecto

## Paso 2: Conectar repositorio GitHub

1. **Opción A - Si tienes repo en GitHub:**
   - En Railway → New Project → Deploy from GitHub
   - Selecciona el repositorio

2. **Opción B - Sin repo en GitHub (local):**
   - Usa Railway CLI:
   ```bash
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```

## Paso 3: Configurar PostgreSQL en Railway

1. En Railway dashboard → New Service → Add PostgreSQL
2. Railway creará automáticamente:
   - Base de datos
   - Usuario
   - Contraseña
   - `DATABASE_URL`

## Paso 4: Configurar variables de ambiente

En Railway → Variables:

```
DATABASE_URL=postgresql://user:pass@host:5432/railway
PORT=8000
NODE_ENV=production
FRONTEND_URL=https://landing-page-zeta-two-23.vercel.app
BACKEND_URL=https://voltvoice-backend.railway.app

# Mercado Pago
MERCADO_PAGO_ACCESS_TOKEN=APP_USR-321299952980044-100609-a87787449103b2cec28b568309afc698-174576838
MERCADO_PAGO_PUBLIC_KEY=APP_USR-df93f1dd-8db5-4269-bf98-87c37c13bf06

# ElevenLabs
ELEVENLABS_API_KEY=tu_api_key_aqui
```

## Paso 5: Ejecutar migraciones de BD

Una vez deployado, ejecuta:

```bash
railway run npm run migrate
```

Esto creará las tablas en PostgreSQL.

## Paso 6: Conectar Frontend

Actualiza en Vercel:
```
NEXT_PUBLIC_API_URL=https://voltvoice-backend.railway.app
```

## ✅ Done!

Tu backend estará en vivo en: `https://voltvoice-backend.railway.app`

## Troubleshooting

**Si ves "Cannot GET /":**
- Es normal, no hay ruta en `/`, prueba `/api/health`

**Si Mercado Pago no funciona:**
- Verifica que `MERCADO_PAGO_ACCESS_TOKEN` esté bien copiado
- Sin espacios al inicio/final

**Si la BD no conecta:**
- Usa `railway run npm run migrate` para crear tablas
- Verifica que `DATABASE_URL` sea correcta en Railway
