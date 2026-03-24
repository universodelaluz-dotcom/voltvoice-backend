import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from './config.js';

// Routes
import authRoutes from './routes/auth.routes.js';
import streamRoutes from './routes/stream.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// ===== MIDDLEWARE =====
app.use(cors({
  origin: config.FRONTEND_URL,
  credentials: true,
}));

app.use(express.json());
app.use(express.static(join(__dirname, '../frontend/public')));

// Logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ===== ROUTES =====
app.use('/api/auth', authRoutes);
app.use('/api', streamRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({
    error: config.isDevelopment ? err.message : 'Internal server error'
  });
});

// ===== START SERVER =====
const PORT = config.PORT;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   🔊 VoltVoice Web Backend Started   ║
╠══════════════════════════════════════╣
║ Server: http://localhost:${PORT}
║ Env: ${config.NODE_ENV}
║ Frontend: ${config.FRONTEND_URL}
╚══════════════════════════════════════╝
  `);
});
