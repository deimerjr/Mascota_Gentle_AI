#!/usr/bin/env node
/**
 * Lanzador robusto: genera el renderer y arranca Electron limpiando
 * ELECTRON_RUN_AS_NODE (algunos entornos —incluido DSH— la dejan puesta y
 * Electron arrancaría como Node en vez de como app).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

await import('./build-ui.mjs');

const candidates = process.platform === 'win32'
  ? [
      path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
      path.resolve(ROOT, '..', 'node_modules', 'electron', 'dist', 'electron.exe'),
    ]
  : [
      path.join(ROOT, 'node_modules', '.bin', 'electron'),
      path.resolve(ROOT, '..', 'node_modules', '.bin', 'electron'),
    ];

const binary = candidates.find((candidate) => fs.existsSync(candidate));
if (!binary) {
  console.error('[start] no se encontró Electron. Ejecuta: npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(binary, [ROOT], {
  cwd: ROOT,
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('exit', (code, signal) => {
  process.exit(code === null ? 0 : code);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { child.kill(); } catch (error) { /* ignorar */ }
  });
}
