import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { createGzip } from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const databaseUrl = process.env.DATABASE_URL;
const backupDir = process.env.DB_BACKUP_DIR || path.resolve(__dirname, '../backups');
const retentionDays = Number(process.env.DB_BACKUP_RETENTION_DAYS || 7);

if (!databaseUrl) {
  console.error('[backup-db] DATABASE_URL no esta configurada');
  process.exit(1);
}

await fs.promises.mkdir(backupDir, { recursive: true });

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(backupDir, `backup-${stamp}.sql.gz`);

const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', `--dbname=${databaseUrl}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

dump.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

const out = fs.createWriteStream(backupFile);

try {
  await pipeline(dump.stdout, createGzip(), out);
} catch (error) {
  console.error('[backup-db] Fallo creando respaldo:', error.message);
  process.exit(1);
}

const exitCode = await new Promise((resolve) => dump.on('close', resolve));
if (exitCode !== 0) {
  console.error(`[backup-db] pg_dump termino con codigo ${exitCode}`);
  process.exit(1);
}

const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
const files = await fs.promises.readdir(backupDir);
for (const file of files) {
  const fullPath = path.join(backupDir, file);
  const stat = await fs.promises.stat(fullPath);
  if (!stat.isFile()) continue;
  if (stat.mtimeMs < cutoff) {
    await fs.promises.unlink(fullPath);
  }
}

console.log(`[backup-db] Respaldo creado: ${backupFile}`);
