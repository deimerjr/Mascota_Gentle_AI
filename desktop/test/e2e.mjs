#!/usr/bin/env node
/**
 * E2E: lanza el shell real con Playwright + Electron, conecta un cliente falso
 * al pipe, empuja estados/layout/comandos y verifica ventana y renderer.
 */
import { _electron as electron } from 'playwright';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACTS = path.join(HERE, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const PIPE = '\\\\.\\pipe\\pi-mascot-e2e-' + process.pid;
const env = { ...process.env, MASCOT_E2E: '1', PI_MASCOT_PIPE: PIPE, MASCOT_DEBUG: '1' };
delete env.ELECTRON_RUN_AS_NODE;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function connectClient() {
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const candidate = net.connect(PIPE);
        candidate.once('connect', () => resolve(candidate));
        candidate.once('error', reject);
      });
      socket.setEncoding('utf8');
      return socket;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError || new Error('no se pudo conectar al pipe');
}

const received = [];
function send(socket, message) {
  socket.write(JSON.stringify({ v: 1, ...message }) + '\n');
}
function collect(socket) {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try { received.push(JSON.parse(line)); } catch (error) { /* ignorar */ }
      }
      index = buffer.indexOf('\n');
    }
  });
}

const app = await electron.launch({ args: ['.'], cwd: ROOT, env });
const page = await app.firstWindow();
await page.waitForFunction(() => window.__mascotMounted === true, null, { timeout: 30000 });
console.log('[e2e] ventana lista');

const socket = await connectClient();
collect(socket);
send(socket, { type: 'hello', clientId: 'e2e-client', pid: process.pid, cwd: ROOT, session: { id: 'sess-e2e', name: 'E2E' } });
send(socket, { type: 'layout', layout: { x: 200, y: 320, scale: 1 } });
await sleep(200);

const windowInfo = await app.evaluate(({ BrowserWindow, screen }) => {
  const win = BrowserWindow.getAllWindows()[0];
  const display = screen.getPrimaryDisplay();
  return {
    bounds: win.getBounds(),
    displayBounds: display.workArea,
    alwaysOnTop: win.isAlwaysOnTop(),
    visible: win.isVisible(),
    transparent: win.isResizable(),
  };
});
console.log('[e2e] ventana: ' + JSON.stringify(windowInfo));
if (windowInfo.bounds.width !== windowInfo.displayBounds.width || windowInfo.bounds.height !== windowInfo.displayBounds.height) {
  throw new Error('la ventana no cubre la pantalla: ' + JSON.stringify(windowInfo));
}
if (!windowInfo.alwaysOnTop) throw new Error('la ventana no está always-on-top');
if (!windowInfo.visible) throw new Error('la ventana no se mostró');

// fondo solo para la captura
await page.addStyleTag({ content: 'html,body{background:radial-gradient(circle at 30% 20%, #2b2f3a, #14161b 70%) !important;}' });

async function emitFacts(facts, expectedPhase, name) {
  send(socket, { type: 'facts', facts });
  await sleep(320);
  const phase = await page.evaluate(() => document.querySelector('.dsh-mascot')?.getAttribute('data-phase'));
  const element = await page.$('.dsh-mascot');
  const box = await element.boundingBox();
  await page.screenshot({
    path: path.join(ARTIFACTS, '20-' + name + '.png'),
    clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 24), width: Math.min(windowInfo.displayBounds.width, box.width + 48), height: Math.min(windowInfo.displayBounds.height, box.height + 48) },
  });
  console.log('[e2e] ' + name.padEnd(10) + ' phase=' + phase + ' (esperado ' + expectedPhase + ')');
  if (expectedPhase && phase !== expectedPhase) throw new Error('fase inesperada en ' + name + ': ' + phase);
  return { phase, box };
}

const base = { id: 'sess-e2e', running: false, pending: false, error: null, tool: null, streaming: false };
send(socket, { type: 'facts', facts: base });
send(socket, { type: 'layout', layout: { x: 200, y: 320, scale: 1 } });
// el primer cambio de id dispara la caminata de transición (900 ms)
await sleep(1200);
const rest = await emitFacts(base, 'rest', 'rest');
if (Math.abs(rest.box.x - 200) > 2 || Math.abs(rest.box.y - 320) > 2) throw new Error('el layout del plugin no se aplicó: ' + JSON.stringify(rest.box));

await emitFacts({ ...base, running: true }, 'thinking', 'thinking');
await emitFacts({ ...base, running: true, tool: 'write' }, 'coding', 'coding');
await emitFacts({ ...base, running: true, tool: 'bash' }, 'verifying', 'verifying');
await emitFacts({ ...base, running: true, tool: 'read' }, 'walking', 'walking');
await emitFacts({ ...base, running: true, streaming: true }, 'singing', 'singing');
await emitFacts({ ...base, running: true, pending: true }, 'attention', 'attention');
await emitFacts({ ...base, running: true }, 'thinking', 'back-to-thinking');
await emitFacts({ ...base, running: false }, 'done', 'done');
await sleep(1600);
await emitFacts({ ...base, running: false, error: 'boom' }, 'error', 'error');
await sleep(3800);

// layout en caliente desde el plugin
send(socket, { type: 'layout', layout: { x: 500, y: 250, scale: 1.4 } });
await sleep(500);
const moved = await page.evaluate(() => {
  const node = document.querySelector('.dsh-mascot');
  const rect = node.getBoundingClientRect();
  const raw = window.localStorage.getItem('dsh.mascot.layout.v1');
  return { rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width) }, cached: raw ? JSON.parse(raw) : null };
});
console.log('[e2e] layout caliente: ' + JSON.stringify(moved));
if (Math.abs(moved.rect.x - 500) > 2 || Math.abs(moved.rect.y - 250) > 2) throw new Error('el layout caliente no se aplicó');

// reset desde el plugin
send(socket, { type: 'command', action: 'reset' });
await sleep(600);
const reset = await page.evaluate(() => {
  const node = document.querySelector('.dsh-mascot');
  const rect = node.getBoundingClientRect();
  const raw = window.localStorage.getItem('dsh.mascot.layout.v1');
  return { rect: { x: Math.round(rect.x), y: Math.round(rect.y) }, cached: raw ? JSON.parse(raw) : null };
});
console.log('[e2e] reset: ' + JSON.stringify(reset));
if (reset.cached.x !== 24 || reset.cached.scale !== 1) throw new Error('el reset no funcionó: ' + JSON.stringify(reset));

// el shell reporta el layout al plugin
await sleep(400);
const layoutReports = received.filter((message) => message.type === 'layout');
console.log('[e2e] reportes de layout recibidos: ' + layoutReports.length);
if (layoutReports.length === 0) throw new Error('el shell no reportó layout al plugin');

// hide/show por comando
send(socket, { type: 'command', action: 'hide' });
await sleep(300);
const hidden = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
send(socket, { type: 'command', action: 'show' });
await sleep(300);
const shown = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
console.log('[e2e] hide=' + hidden + ' show=' + shown);
if (hidden || !shown) throw new Error('hide/show no funcionó');

socket.end();
await app.close();
console.log('[e2e] OK — capturas en ' + ARTIFACTS);