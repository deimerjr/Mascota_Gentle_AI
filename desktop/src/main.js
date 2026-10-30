'use strict';

/**
 * pi-mascot-shell — ventana transparente always-on-top que pinta la mascota web
 * y obedece a la extensión de pi por un named pipe local.
 *
 * El shell no decide nada del estado: recibe "facts" del plugin, los reenvía al
 * renderer y hace de puente para el layout y los comandos.
 */

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PROTOCOL_VERSION = 1;
const PIPE_PREFIX = 'pi-mascot';
const SHELL_VERSION = require('../package.json').version;
const RENDERER_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const E2E = process.env.MASCOT_E2E === '1';

const DEFAULT_FACTS = { id: null, running: false, pending: false, error: null, tool: null, streaming: false };

let win = null;
let tray = null;
let server = null;
const clients = new Map();
let activeClientId = null;
let activeFacts = { ...DEFAULT_FACTS };
let activeSession = null;
let state = { enabled: true, lastLayout: null };
let saveTimer = null;

if (E2E) {
  app.setPath('userData', path.join(os.tmpdir(), 'pi-mascot-e2e-' + process.pid));
}

// ---------------------------------------------------------------------------
// estado persistido (solo caché de layout; la fuente de verdad es el plugin)
// ---------------------------------------------------------------------------

function statePath() {
  return path.join(app.getPath('userData'), 'shell-state.json');
}

function loadState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      state.enabled = parsed.enabled !== false;
      state.lastLayout = normalizeLayout(parsed.lastLayout);
    }
  } catch (error) { /* primera ejecución */ }
}

function saveStateSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
    } catch (error) { log('save-state: ' + error.message); }
  }, 250);
}

function log(message) {
  const line = '[' + new Date().toISOString() + '] ' + message + '\n';
  try {
    const file = path.join(app.getPath('userData'), 'shell.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
  } catch (error) { /* sin log */ }
  if (E2E || process.env.MASCOT_DEBUG === '1') process.stdout.write(line);
}

// ---------------------------------------------------------------------------
// protocolo
// ---------------------------------------------------------------------------

function pipeName() {
  if (process.env.PI_MASCOT_PIPE) return process.env.PI_MASCOT_PIPE;
  const user = os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (process.platform === 'win32') return '\\\\.\\pipe\\' + PIPE_PREFIX + '-' + user;
  return path.join(os.tmpdir(), PIPE_PREFIX + '-' + user + '.sock');
}

function normalizeLayout(layout) {
  if (!layout || typeof layout !== 'object') return null;
  const x = Number(layout.x);
  const y = Number(layout.y);
  const scale = Number(layout.scale);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return null;
  return { x: Math.round(x), y: Math.round(y), scale: Math.min(1.9, Math.max(0.55, scale)) };
}

function normalizeFacts(facts) {
  const source = facts && typeof facts === 'object' ? facts : {};
  return {
    id: source.id === undefined || source.id === null ? null : String(source.id),
    running: Boolean(source.running),
    pending: Boolean(source.pending),
    error: source.error ? String(source.error).slice(0, 500) : null,
    tool: source.tool ? String(source.tool).slice(0, 120) : null,
    streaming: Boolean(source.streaming),
  };
}

function sendToRenderer(message) {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
  win.webContents.send('mascot:event', message);
}

function notifyActiveClient(message) {
  const client = activeClientId ? clients.get(activeClientId) : null;
  if (client) sendToClient(client, message);
}

function sendToClient(client, message) {
  if (!client || !client.socket || client.socket.destroyed) return;
  try {
    client.socket.write(JSON.stringify(Object.assign({ v: PROTOCOL_VERSION }, message)) + '\n');
  } catch (error) { log('send: ' + error.message); }
}

function pushFacts() {
  sendToRenderer({ type: 'facts', facts: activeFacts, session: activeSession });
}

function idleFacts() {
  activeClientId = null;
  activeFacts = { ...DEFAULT_FACTS };
  activeSession = null;
  pushFacts();
  updateTray();
}

function selectActiveClient() {
  const withFacts = [];
  for (const client of clients.values()) {
    if (client.lastFactAt) withFacts.push(client);
  }
  // Las sesiones con UI (TUI/RPC) mandan sobre procesos headless: subagentes,
  // runners de gentle-ai y ejecuciones -p no deben pisar la mascota.
  const interactive = withFacts.filter((client) => client.hello && client.hello.interactive === true);
  const pool = interactive.length > 0 ? interactive : withFacts;
  let best = null;
  for (const client of pool) {
    if (!best || client.lastFactAt > best.lastFactAt) best = client;
  }
  if (!best) {
    idleFacts();
    return;
  }
  activeClientId = best.id;
  activeFacts = best.facts;
  activeSession = best.hello && best.hello.session ? best.hello.session : null;
  pushFacts();
  updateTray();
}

// ---------------------------------------------------------------------------
// servidor del pipe
// ---------------------------------------------------------------------------

function startServer() {
  const name = pipeName();
  if (process.platform !== 'win32') {
    try { if (fs.existsSync(name)) fs.unlinkSync(name); } catch (error) { /* ignorar */ }
  }

  server = net.createServer(handleConnection);
  server.on('error', (error) => {
    log('pipe-server: ' + error.message);
    if (error.code === 'EADDRINUSE') return;
    setTimeout(startServer, 1000);
  });
  server.listen(name, () => {
    log('pipe listening: ' + name);
    if (E2E) process.stdout.write('PIPE_READY ' + name + '\n');
  });
}

function handleConnection(socket) {
  socket.setEncoding('utf8');
  let buffer = '';
  let clientId = null;

  sendToClient({ socket }, { type: 'welcome', layout: state.lastLayout, shell: { version: SHELL_VERSION, platform: process.platform } });

  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (error) { continue; }
      clientId = handleMessage(socket, clientId, message);
    }
  });

  socket.on('error', () => { /* el close limpia */ });
  socket.on('close', () => {
    if (!clientId) return;
    const client = clients.get(clientId);
    if (!client || client.socket !== socket) return;
    clients.delete(clientId);
    log('client disconnected: ' + clientId);
    if (activeClientId === clientId) selectActiveClient();
    else updateTray();
  });
}

function handleMessage(socket, clientId, message) {
  if (!message || typeof message !== 'object') return clientId;
  const type = message.type;
  const now = Date.now();

  if (type === 'hello') {
    const id = String(message.clientId || socket.remotePort || now);
    const previous = clients.get(id);
    if (previous && previous.socket === socket) {
      previous.hello = message;
      previous.lastSeen = now;
      if (message.session) activeSession = message.session;
      return id;
    }
    if (previous) {
      try { previous.socket.destroy(); } catch (error) { /* ignorar */ }
    }
    clients.set(id, {
      id,
      socket,
      hello: message,
      facts: { ...DEFAULT_FACTS },
      connectedAt: now,
      lastSeen: now,
      lastFactAt: 0,
      layout: normalizeLayout(message.layout),
    });
    log('client hello: ' + id + ' (' + (message.cwd || '?') + ')');
    updateTray();
    return id;
  }

  if (!clientId) return clientId;
  const client = clients.get(clientId);
  if (!client) return clientId;
  client.lastSeen = now;

  if (type === 'facts') {
    client.facts = normalizeFacts(message.facts);
    client.lastSeen = now;
    client.lastFactAt = now;
    if (message.session) {
      client.hello = client.hello || {};
      client.hello.session = message.session;
    }
    selectActiveClient();
    return clientId;
  }

  if (type === 'session') {
    client.session = message.session;
    if (activeClientId === clientId) {
      activeSession = message.session;
      pushFacts();
    }
    return clientId;
  }

  if (type === 'layout') {
    const layout = normalizeLayout(message.layout);
    if (!layout) return clientId;
    state.lastLayout = layout;
    client.layout = layout;
    saveStateSoon();
    sendToRenderer({ type: 'layout', layout });
    return clientId;
  }

  if (type === 'command') {
    handleCommand(message, client);
    return clientId;
  }

  if (type === 'bye') {
    try { socket.end(); } catch (error) { /* ignorar */ }
    return clientId;
  }

  return clientId;
}

function handleCommand(message, client) {
  const action = message && message.action;
  if (action === 'show') {
    state.enabled = true;
    saveStateSoon();
    if (win && !win.isDestroyed()) win.showInactive();
  } else if (action === 'hide') {
    state.enabled = false;
    saveStateSoon();
    if (win && !win.isDestroyed()) win.hide();
  } else if (action === 'reset') {
    sendToRenderer({ type: 'command', action: 'reset' });
  } else if (action === 'quit') {
    app.quit();
  } else if (action === 'ping') {
    sendToClient(client, { type: 'pong' });
  }
}

// ---------------------------------------------------------------------------
// ventana
// ---------------------------------------------------------------------------

function applyScreenBounds() {
  if (!win || win.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  win.setBounds(display.workArea);
}

function showWindow() {
  if (!win || win.isDestroyed() || !state.enabled) return;
  if (!win.isVisible()) {
    win.showInactive();
    log('window shown: ' + JSON.stringify(win.getBounds()));
  }
  win.setIgnoreMouseEvents(true, { forward: true });
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true });
  if (process.platform !== 'linux') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  win.once('ready-to-show', showWindow);

  win.on('closed', () => { win = null; });
  win.webContents.on('did-finish-load', () => {
    pushFacts();
    showWindow();
    if (process.env.MASCOT_DEV === '1') win.webContents.openDevTools({ mode: 'detach' });
  });

  win.loadFile(RENDERER_HTML);

  screen.on('display-metrics-changed', applyScreenBounds);
  screen.on('display-added', applyScreenBounds);
  screen.on('display-removed', applyScreenBounds);
}

// ---------------------------------------------------------------------------
// IPC renderer
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('mascot:get-state', () => ({
    protocol: PROTOCOL_VERSION,
    shell: { version: SHELL_VERSION, platform: process.platform },
    layout: state.lastLayout,
    facts: activeFacts,
    session: activeSession,
    enabled: state.enabled,
  }));

  ipcMain.on('mascot:renderer-layout', (event, layout) => {
    const normalized = normalizeLayout(layout);
    if (!normalized) return;
    state.lastLayout = normalized;
    saveStateSoon();
    const client = activeClientId ? clients.get(activeClientId) : null;
    if (client) sendToClient(client, { type: 'layout', layout: normalized });
  });

  ipcMain.on('mascot:interactive', (event, interactive) => {
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!interactive, { forward: true });
    log('interactive: ' + Boolean(interactive));
  });

  ipcMain.on('mascot:quit', () => app.quit());
}

// ---------------------------------------------------------------------------
// bandeja
// ---------------------------------------------------------------------------

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const connected = clients.size;
  const menu = Menu.buildFromTemplate([
    { label: connected ? 'Conectado a pi (' + connected + ')' : 'Sin sesión de pi', enabled: false },
    { type: 'separator' },
    { label: 'Mostrar mascota', click: () => { state.enabled = true; saveStateSoon(); if (win && !win.isDestroyed()) showWindow(); notifyActiveClient({ type: 'command', action: 'show' }); } },
    { label: 'Ocultar mascota', click: () => { state.enabled = false; saveStateSoon(); if (win && !win.isDestroyed()) win.hide(); notifyActiveClient({ type: 'command', action: 'hide' }); } },
    { label: 'Restablecer posición', click: () => sendToRenderer({ type: 'command', action: 'reset' }) },
    { type: 'separator' },
    { label: 'Salir', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(connected ? 'Mascota pi — ' + connected + ' sesión(es)' : 'Mascota pi — sin sesión');
}

function createTray() {
  try {
    const image = nativeImage.createFromPath(ICON_PATH);
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
    tray.on('click', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isVisible()) win.hide(); else win.showInactive();
    });
    updateTray();
  } catch (error) {
    log('tray: ' + error.message);
  }
}

// ---------------------------------------------------------------------------
// arranque
// ---------------------------------------------------------------------------

function bootstrap() {
  app.whenReady().then(() => {
    app.setAppUserModelId('pi-mascot-shell');
    loadState();
    registerIpc();
    createWindow();
    startServer();
    createTray();
    const smokeMs = Number(process.env.MASCOT_SMOKE_MS || 0);
    if (Number.isFinite(smokeMs) && smokeMs > 0) {
      setTimeout(() => app.quit(), smokeMs);
    }
  });

  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) showWindow();
  });

  app.on('before-quit', () => {
    try { if (server) server.close(); } catch (error) { /* ignorar */ }
    for (const client of clients.values()) {
      try { client.socket.destroy(); } catch (error) { /* ignorar */ }
    }
    clients.clear();
    try {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
    } catch (error) { /* ignorar */ }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

if (E2E || app.requestSingleInstanceLock()) {
  bootstrap();
} else {
  // ya hay una mascota corriendo: esta instancia se va sin tocar el pipe
  app.quit();
}