#!/usr/bin/env node
/**
 * Verificación del renderer sin Electron: Chromium + API mockeada.
 * Genera capturas de cada fase en test/artifacts/.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACTS = path.join(HERE, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const STATES = [
  ['thinking', { id: 's1', running: true, pending: false, error: null, tool: null, streaming: false }],
  ['coding', { id: 's1', running: true, pending: false, error: null, tool: 'write', streaming: false }],
  ['verifying', { id: 's1', running: true, pending: false, error: null, tool: 'bash', streaming: false }],
  ['walking', { id: 's1', running: true, pending: false, error: null, tool: 'read', streaming: false }],
  ['singing', { id: 's1', running: true, pending: false, error: null, tool: null, streaming: true }],
  ['attention', { id: 's1', running: true, pending: true, error: null, tool: null, streaming: false }],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

await page.addInitScript(() => {
  const listeners = new Set();
  const mock = {
    facts: { id: 's1', running: false, pending: false, error: null, tool: null, streaming: false },
    layout: { x: 40, y: 400, scale: 1.1 },
    sent: [],
  };
  window.__mock = mock;
  window.mascotAPI = {
    platform: 'win32',
    versions: { shell: 'test', protocol: 1 },
    getState: async () => ({ layout: mock.layout, facts: mock.facts, session: { id: 's1' }, enabled: true }),
    onMessage: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    reportLayout: (layout) => mock.sent.push({ type: 'layout', layout }),
    setInteractive: (flag) => mock.sent.push({ type: 'interactive', flag }),
    quit: () => {},
  };
  window.__mock.emit = (message) => {
    for (const callback of listeners) callback(message);
  };
});

const url = 'file:///' + path.join(ROOT, 'renderer', 'index.html').replace(/\\/g, '/');
await page.goto(url);
await page.waitForFunction(() => window.__mascotMounted === true, null, { timeout: 15000 });
// el cambio de id inicial dispara la caminata de transición (900 ms)
await page.waitForTimeout(1100);

// fondo para que las capturas no salgan con alfa (solo en test)
await page.addStyleTag({ content: 'html,body{background:radial-gradient(circle at 30% 20%, #2b2f3a, #14161b 70%) !important;}' });

await page.screenshot({ path: path.join(ARTIFACTS, '00-initial.png'), fullPage: false });

for (const [name, facts] of STATES) {
  await page.evaluate((next) => window.__mock.emit({ type: 'facts', facts: next }), facts);
  await page.waitForTimeout(260);
  const phase = await page.evaluate(() => document.querySelector('.dsh-mascot')?.getAttribute('data-phase'));
  const element = await page.$('.dsh-mascot');
  if (!element) throw new Error('no hay mascota en fase ' + name);
  const box = await element.boundingBox();
  await page.screenshot({
    path: path.join(ARTIFACTS, '10-' + name + '.png'),
    clip: { x: Math.max(0, box.x - 20), y: Math.max(0, box.y - 20), width: Math.min(1280, box.width + 40), height: Math.min(800, box.height + 40) },
  });
  console.log('[ui] ' + name.padEnd(10) + ' phase=' + String(phase).padEnd(12) + ' box=' + Math.round(box.x) + ',' + Math.round(box.y) + ' ' + Math.round(box.width) + 'x' + Math.round(box.height));
}

// done: pasar de running a reposo dispara la celebración (1,4 s)
await page.evaluate(() => window.__mock.emit({ type: 'facts', facts: { id: 's1', running: false, pending: false, error: null, tool: null, streaming: false } }));
await page.waitForTimeout(180);
{
  const phase = await page.evaluate(() => document.querySelector('.dsh-mascot')?.getAttribute('data-phase'));
  const element = await page.$('.dsh-mascot');
  const box = await element.boundingBox();
  await page.screenshot({ path: path.join(ARTIFACTS, '10-done.png'), clip: { x: box.x - 20, y: box.y - 20, width: box.width + 40, height: box.height + 40 } });
  console.log('[ui] done       phase=' + phase);
  if (phase !== 'done') throw new Error('no se reprodujo la celebración: ' + phase);
}

// error: un error nuevo dispara el temblor (3,6 s)
await page.evaluate(() => window.__mock.emit({ type: 'facts', facts: { id: 's1', running: true, pending: false, error: 'boom', tool: 'bash', streaming: false } }));
await page.waitForTimeout(180);
{
  const phase = await page.evaluate(() => document.querySelector('.dsh-mascot')?.getAttribute('data-phase'));
  const element = await page.$('.dsh-mascot');
  const box = await element.boundingBox();
  await page.screenshot({ path: path.join(ARTIFACTS, '10-error.png'), clip: { x: box.x - 20, y: box.y - 20, width: box.width + 40, height: box.height + 40 } });
  console.log('[ui] error      phase=' + phase);
  if (phase !== 'error') throw new Error('no se reprodujo el error: ' + phase);
}

// drag
const element = await page.$('.dsh-mascot');
const box = await element.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(500);
const afterDrag = await page.evaluate(() => {
  const raw = window.localStorage.getItem('dsh.mascot.layout.v1');
  return { layout: raw ? JSON.parse(raw) : null, sent: window.__mock.sent.filter((entry) => entry.type === 'layout').slice(-3) };
});
console.log('[ui] drag layout=' + JSON.stringify(afterDrag.layout) + ' reportado=' + JSON.stringify(afterDrag.sent.at(-1)));
if (!afterDrag.layout || afterDrag.layout.x === 40) throw new Error('el drag no movió el layout');

// wheel
const box2 = await (await page.$('.dsh-mascot')).boundingBox();
await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
await page.mouse.wheel(0, -240);
await page.waitForTimeout(400);
const afterWheel = await page.evaluate(() => JSON.parse(window.localStorage.getItem('dsh.mascot.layout.v1')));
console.log('[ui] wheel scale=' + afterWheel.scale);
if (!(afterWheel.scale > afterDrag.layout.scale)) throw new Error('la rueda no cambió el tamaño');

// reset por comando (dos clics no; probamos el comando del shell)
await page.evaluate(() => window.__mock.emit({ type: 'command', action: 'reset' }));
await page.waitForTimeout(600);
const afterReset = await page.evaluate(() => {
  const raw = window.localStorage.getItem('dsh.mascot.layout.v1');
  return raw ? JSON.parse(raw) : null;
});
console.log('[ui] reset layout=' + JSON.stringify(afterReset));
if (!afterReset || afterReset.scale !== 1 || afterReset.x !== 24) throw new Error('el reset no restauró el layout: ' + JSON.stringify(afterReset));

// selector de mascotas: cambiar al gato original
await page.evaluate(() => window.localStorage.removeItem('dsh.mascot.preset.v2'));
await page.reload();
await page.waitForFunction(() => window.__mascotMounted === true, null, { timeout: 15000 });
await page.waitForTimeout(1100);
await page.addStyleTag({ content: 'html,body{background:radial-gradient(circle at 30% 20%, #2b2f3a, #14161b 70%) !important;}' });
const presetButton = await page.$('.dsh-mascot-preset');
if (!presetButton) throw new Error('no se encontró el selector de mascotas');
await presetButton.click();
await page.waitForSelector('.dsh-mascot-preset-menu');
const items = await page.$$eval('.dsh-mascot-preset-item', (nodes) => nodes.map((node) => node.textContent));
console.log('[ui] presets: ' + JSON.stringify(items));
if (!items.includes('Gato original')) throw new Error('falta el preset Gato original: ' + JSON.stringify(items));
if (!items.includes('Gato Vaquero')) throw new Error('falta el preset Gato Vaquero: ' + JSON.stringify(items));
const item = await page.$('.dsh-mascot-preset-item:has-text("Gato original")');
if (!item) throw new Error('no se encontró el item Gato original');
await item.click();
await page.waitForTimeout(400);
const presetState = await page.evaluate(() => ({
  stored: window.localStorage.getItem('dsh.mascot.preset.v2'),
  phase: document.querySelector('.dsh-mascot')?.getAttribute('data-phase'),
}));
console.log('[ui] preset gato original: ' + JSON.stringify(presetState));
if (presetState.stored !== '1') throw new Error('no se guardó el preset Gato original: ' + presetState.stored);
const presetBox = await (await page.$('.dsh-mascot')).boundingBox();
await page.screenshot({ path: path.join(ARTIFACTS, 'docs-gato-original.png'), clip: { x: presetBox.x - 20, y: presetBox.y - 20, width: presetBox.width + 40, height: presetBox.height + 40 } });

// capturas de los cuatro presets para docs/
const presets = ['kimono', 'gato', 'majin', 'neko', 'vaquero'];
for (let index = 0; index < presets.length; index += 1) {
  await page.evaluate((value) => window.localStorage.setItem('dsh.mascot.preset.v2', String(value)), index);
  await page.reload();
  await page.waitForFunction(() => window.__mascotMounted === true, null, { timeout: 15000 });
  await page.waitForTimeout(1100);
  await page.addStyleTag({ content: 'html,body{background:radial-gradient(circle at 30% 20%, #2b2f3a, #14161b 70%) !important;}' });
  const shot = await page.$('.dsh-mascot');
  if (!shot) throw new Error('sin mascota para preset ' + presets[index]);
  const shotBox = await shot.boundingBox();
  await page.screenshot({ path: path.join(ARTIFACTS, 'preset-' + presets[index] + '.png'), clip: { x: shotBox.x - 20, y: shotBox.y - 20, width: shotBox.width + 40, height: shotBox.height + 40 } });
}
console.log('[ui] capturas de presets: ' + presets.join(', '));

const phases = await page.evaluate(() => document.querySelectorAll('.dsh-mascot').length);
if (phases !== 1) throw new Error('se clonó la mascota: ' + phases);

await browser.close();
console.log('[ui] OK — capturas en ' + ARTIFACTS);