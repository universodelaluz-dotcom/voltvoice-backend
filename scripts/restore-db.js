import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';

const databaseUrl = process.env.DATABASE_URL;
const inputFile = process.argv[2];

if (!databaseUrl) {
  console.error('[restore-db] DATABASE_URL no esta configurada');
  process.exit(1);
}

if (!inputFile) {
  console.error('[restore-db] Uso: npm run restore:db -- <ruta-al-backup.sql|.sql.gz>');
  process.exit(1);
}

const resolvedInput = path.resolve(inputFile);
if (!fs.existsSync(resolvedInput)) {
  console.error(`[restore-db] No existe el archivo: ${resolvedInput}`);
  process.exit(1);
}

const restore = spawn('psql', [databaseUrl], { stdio: ['pipe', 'pipe', 'pipe'] });

restore.stdout.on('data', (chunk) => process.stdout.write(chunk));
restore.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  if (resolvedInput.toLowerCase().endsWith('.gz')) {
    await pipeline(fs.createReadStream(resolvedInput), createGunzip(), restore.stdin);
  } else {
    await pipeline(fs.createReadStream(resolvedInput), restore.stdin);
  }
} catch (error) {
  console.error('[restore-db] Fallo restaurando respaldo:', error.message);
  process.exit(1);
}

const exitCode = await new Promise((resolve) => restore.on('close', resolve));
if (exitCode !== 0) {
  console.error(`[restore-db] psql termino con codigo ${exitCode}`);
  process.exit(1);
}

console.log(`[restore-db] Restauracion completada desde: ${resolvedInput}`);
