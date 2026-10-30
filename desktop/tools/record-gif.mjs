#!/usr/bin/env node
/**
 * Graba un GIF del preset "Gato original" recorriendo los estados principales.
 * Uso: node desktop/tools/record-gif.mjs
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const HTML = path.join(REPO, 'desktop', 'renderer', 'index.html');
const OUT = path.join(REPO, 'docs', 'gato-original.gif');
const FRAMES = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-gif-'));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 600 }, deviceScaleFactor: 1 });

await page.addInitScript(() => {
  const listeners = new Set();
  const mock = {
    facts: { id: 'gif', running: false, pending: false, error: null, tool: null, streaming: false },
    layout: { x: 159, y: 60, scale: 1.4 },
    sent: [],
  };
  window.__mock = mock;
  window.mascotAPI = {
    platform: 'win32',
    versions: { shell: 'gif', protocol: 1 },
    getState: async () => ({ layout: mock.layout, facts: mock.facts, session: { id: 'gif' }, enabled: true }),
    onMessage: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
    reportLayout: () => {},
    setInteractive: () => {},
    quit: () => {},
  };
  window.__mock.emit = (message) => { for (const callback of listeners) callback(message); };
});

const url = 'file:///' + HTML.replace(/\\/g, '/');
await page.goto(url);
await page.waitForFunction(() => window.__mascotMounted === true, null, { timeout: 15000 });

// seleccionar Gato original (preset 1), layout centrado
await page.evaluate(() => {
  window.localStorage.setItem('dsh.mascot.preset.v2', '1');
  window.localStorage.setItem('dsh.mascot.layout.v1', JSON.stringify({ x: 159, y: 60, scale: 1.4 }));
});
await page.reload();
await page.waitForFunction(() => window.__mascotMounted === true, null, { timeout: 15000 });
await page.waitForTimeout(1300); // transición inicial de sesión
await page.addStyleTag({ content: 'html,body{background:radial-gradient(circle at 30% 20%, #2b2f3a, #14161b 70%) !important;}' });

const rect = await (await page.$('.dsh-mascot')).boundingBox();
const clip = {
  x: Math.max(0, Math.round(rect.x - 20)),
  y: Math.max(0, Math.round(rect.y - 20)),
  width: Math.round(rect.width + 40),
  height: Math.round(rect.height + 40),
};

const base = { id: 'gif', running: false, pending: false, error: null, tool: null, streaming: false };
const schedule = [
  { at: 0.0, state: 'rest', facts: { ...base } },
  { at: 0.8, state: 'thinking', facts: { ...base, running: true } },
  { at: 1.8, state: 'coding', facts: { ...base, running: true, tool: 'write' } },
  { at: 2.8, state: 'verifying', facts: { ...base, running: true, tool: 'bash' } },
  { at: 3.8, state: 'singing', facts: { ...base, running: true, streaming: true } },
  { at: 4.8, state: 'attention', facts: { ...base, running: true, pending: true } },
  { at: 5.8, state: 'done', facts: { ...base, running: false } },
  { at: 7.0, state: 'rest', facts: { ...base } },
];
const TOTAL = 7.7;
const INTERVAL = 120;

const start = Date.now();
let index = 0;
let nextCapture = 0;
let nextState = 0;
while (true) {
  const elapsed = (Date.now() - start) / 1000;
  if (elapsed >= TOTAL) break;
  while (nextState < schedule.length && schedule[nextState].at <= elapsed) {
    const step = schedule[nextState];
    await page.evaluate((facts) => window.__mock.emit({ type: 'facts', facts }), step.facts);
    nextState += 1;
  }
  const state = schedule[Math.max(0, nextState - 1)].state;
  const file = path.join(FRAMES, 'frame-' + String(index).padStart(3, '0') + '-' + state + '.png');
  await page.screenshot({ path: file, clip });
  index += 1;
  nextCapture += INTERVAL;
  const wait = nextCapture - (Date.now() - start);
  if (wait > 0) await page.waitForTimeout(wait);
}

await browser.close();
console.log('[gif] ' + index + ' frames en ' + FRAMES);

execFileSync('python', [path.join(HERE, 'make-gif.py'), FRAMES, OUT, String(INTERVAL), '240'], { stdio: 'inherit' });
const size = fs.statSync(OUT).size;
console.log('[gif] ' + OUT + ' (' + (size / 1024).toFixed(0) + ' KB)');
