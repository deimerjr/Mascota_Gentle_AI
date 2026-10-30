/**
 * Session Mascot para pi — extensión.
 *
 * Mantiene la máquina de estados de la mascota (los mismos "facts" que usaba el
 * plugin de DSH), los envía por un named pipe local al shell de escritorio
 * (mascot-desktop) y persiste el layout. El shell solo pinta; el cerebro es
 * este archivo.
 *
 * Instalación:
 *   pi --extension ./pi-mascot/index.ts
 * o copiarlo a ~/.pi/agent/extensions/session-mascot/ y reiniciar pi.
 *
 * Variables:
 *   PI_MASCOT_PIPE        ruta del pipe (debe coincidir con el shell)
 *   PI_MASCOT_SHELL_DIR   carpeta de mascot-desktop (si no está al lado)
 *   PI_MASCOT_DEBUG=1     log detallado en ~/.pi/agent/session-mascot.log
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

const PROTOCOL_VERSION = 1;
// gentle-shell lanza sus agentes como procesos pi hijos; sólo la sesión
// principal debe mover la mascota (el hijo no abre ventana ni pisa el estado).
const IS_SUBAGENT = process.env.GENTLE_PI_AGENTS_CHILD === "1";
// gentle-shell y pi permiten cambiar el home del agente; la config debe vivir
// en el home que pi está usando (vanilla: ~/.pi/agent, gentle-shell: ~/.gentle-shell/agent).
const AGENT_HOME = process.env.PI_CODING_AGENT_DIR
  || process.env.GENTLE_PI_AGENT_HOME
  || path.join(os.homedir(), ".pi", "agent");
const CONFIG_PATH = process.env.PI_MASCOT_CONFIG || path.join(AGENT_HOME, "session-mascot.json");
const LOG_PATH = process.env.PI_MASCOT_LOG_PATH || path.join(AGENT_HOME, "session-mascot.log");
const STREAM_QUIET_MS = 1600;

const DEFAULT_FACTS = {
  id: null as string | null,
  running: false,
  pending: false,
  error: null as string | null,
  tool: null as string | null,
  streaming: false,
};

interface Layout {
  x: number;
  y: number;
  scale: number;
}

interface Facts {
  id: string | null;
  running: boolean;
  pending: boolean;
  error: string | null;
  tool: string | null;
  streaming: boolean;
}

interface Config {
  enabled: boolean;
  autoLaunch: boolean;
  shellDir: string;
  /** Ruta al ejecutable empaquetado (instalador/portable). Si es null se usa Electron de desarrollo. */
  shellExe: string | null;
  shellArgs: string[];
  layout: Layout | null;
  debug: boolean;
}

interface SessionInfo {
  id: string | null;
  name?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
}

function looksLikeShell(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return pkg && (pkg.name === "pi-session-mascot-shell" || pkg.name === "pi-mascot-shell");
  } catch (error) {
    return false;
  }
}

function defaultShellDir(): string {
  if (process.env.PI_MASCOT_SHELL_DIR) return process.env.PI_MASCOT_SHELL_DIR;
  const candidates: string[] = [];
  try {
    // jiti carga la extensión como CJS; __dirname existe en ese contexto.
    const dir = eval("typeof __dirname !== 'undefined' ? __dirname : null");
    if (typeof dir === "string" && dir.length > 0) {
      for (const name of ["desktop", "mascot-desktop"]) {
        candidates.push(path.resolve(dir, "..", name));
        candidates.push(path.resolve(dir, "..", "..", name));
        candidates.push(path.resolve(dir, "..", "..", "..", name));
      }
    }
  } catch (error) { /* contexto ESM */ }
  for (const name of ["desktop", "mascot-desktop"]) {
    candidates.push(path.resolve(process.cwd(), name));
    candidates.push(path.resolve(process.cwd(), "..", name));
  }
  for (const candidate of candidates) {
    if (looksLikeShell(candidate)) return candidate;
  }
  return candidates[0];
}

function defaultConfig(): Config {
  return {
    enabled: true,
    autoLaunch: true,
    shellDir: defaultShellDir(),
    shellExe: null,
    shellArgs: [],
    layout: null,
    debug: process.env.PI_MASCOT_DEBUG === "1",
  };
}

function normalizeLayout(raw: unknown): Layout | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const x = Number(source.x);
  const y = Number(source.y);
  const scale = Number(source.scale);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    scale: Math.min(1.9, Math.max(0.55, scale)),
  };
}

function loadConfig(): Config {
  const config = defaultConfig();
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
      if (typeof parsed.autoLaunch === "boolean") config.autoLaunch = parsed.autoLaunch;
      if (typeof parsed.shellDir === "string" && parsed.shellDir.trim()) config.shellDir = parsed.shellDir;
      if (typeof parsed.shellExe === "string" && parsed.shellExe.trim()) config.shellExe = parsed.shellExe;
      if (Array.isArray(parsed.shellArgs)) config.shellArgs = parsed.shellArgs.map(String);
      if (typeof parsed.debug === "boolean") config.debug = parsed.debug;
      config.layout = normalizeLayout(parsed.layout);
    }
  } catch (error) {
    writeConfig(config);
  }
  return config;
}

function writeConfig(config: Config): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  } catch (error) { /* sin permisos: seguimos en memoria */ }
}

function log(config: Config | undefined, message: string): void {
  const text = "[" + new Date().toISOString() + "] " + message;
  if (config?.debug) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, text + "\n");
    } catch (error) { /* ignorar */ }
  }
  if (process.env.PI_MASCOT_LOG === "1") console.error(text);
}

function pipeName(): string {
  if (process.env.PI_MASCOT_PIPE) return process.env.PI_MASCOT_PIPE;
  const user = os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (process.platform === "win32") return "\\\\.\\pipe\\pi-mascot-" + user;
  return path.join(os.tmpdir(), "pi-mascot-" + user + ".sock");
}

function electronBinary(shellDir: string): string | null {
  const relative = process.platform === "win32"
    ? ["node_modules", "electron", "dist", "electron.exe"]
    : ["node_modules", ".bin", "electron"];
  const candidates = [
    path.join(shellDir, ...relative),
    path.join(shellDir, "..", ...relative),
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (error) { /* ignorar */ }
  }
  return null;
}

function installedShellCandidates(): string[] {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    for (const root of [local ? path.join(local, "Programs") : null, programFiles]) {
      if (!root) continue;
      candidates.push(path.join(root, "Session Mascot", "Session Mascot.exe"));
      candidates.push(path.join(root, "session-mascot", "Session Mascot.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Session Mascot.app/Contents/MacOS/Session Mascot");
  } else {
    candidates.push("/opt/Session Mascot/session-mascot");
    candidates.push("/usr/local/bin/session-mascot");
  }
  return candidates;
}

interface ShellLaunch {
  file: string;
  args: string[];
  cwd?: string;
}

function resolveShellLaunch(config: Config): ShellLaunch | null {
  if (config.shellExe) {
    try {
      if (fs.existsSync(config.shellExe)) {
        return {
          file: config.shellExe,
          args: config.shellArgs || [],
          cwd: path.dirname(config.shellExe),
        };
      }
    } catch (error) { /* ignorar */ }
  }
  const binary = electronBinary(config.shellDir);
  if (binary) return { file: binary, args: [config.shellDir], cwd: config.shellDir };
  for (const candidate of installedShellCandidates()) {
    try {
      if (fs.existsSync(candidate)) return { file: candidate, args: [], cwd: path.dirname(candidate) };
    } catch (error) { /* ignorar */ }
  }
  return null;
}

function errorText(value: unknown): string {
  if (value === null || value === undefined) return "error";
  if (typeof value === "string") return value.slice(0, 300);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const message = source.message ?? source.error ?? source.reason;
    if (typeof message === "string") return message.slice(0, 300);
    try { return JSON.stringify(value).slice(0, 300); } catch (error) { return "error"; }
  }
  return String(value).slice(0, 300);
}

// ---------------------------------------------------------------------------
// máquina de estados: replica la semántica de useSessionFacts del plugin DSH
// ---------------------------------------------------------------------------

class MascotState {
  session: SessionInfo = { id: null };
  private running = false;
  private pendingCount = 0;
  private tools = new Map<string, string>();
  private streaming = false;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private error: string | null = null;
  private send: (facts: Facts) => void;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(send: (facts: Facts) => void) {
    this.send = send;
  }

  facts(): Facts {
    let tool: string | null = null;
    for (const name of this.tools.values()) tool = name;
    return {
      id: this.session.id,
      running: this.running,
      pending: this.pendingCount > 0,
      error: this.error,
      tool,
      streaming: this.streaming && this.running,
    };
  }

  private schedule(): void {
    if (this.sendTimer) return;
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.send(this.facts());
    }, 40);
  }

  reset(session: SessionInfo): void {
    this.session = session;
    this.running = false;
    this.pendingCount = 0;
    this.tools.clear();
    this.streaming = false;
    this.error = null;
    if (this.streamTimer) { clearTimeout(this.streamTimer); this.streamTimer = null; }
    this.schedule();
  }

  sessionStart(session: SessionInfo): void {
    this.session = session;
    this.pendingCount = 0;
    this.tools.clear();
    this.streaming = false;
    if (this.streamTimer) { clearTimeout(this.streamTimer); this.streamTimer = null; }
    this.schedule();
  }

  agentStart(): void {
    this.running = true;
    this.error = null;
    this.streaming = false;
    if (this.streamTimer) { clearTimeout(this.streamTimer); this.streamTimer = null; }
    this.schedule();
  }

  agentSettled(): void {
    this.running = false;
    this.streaming = false;
    this.tools.clear();
    if (this.streamTimer) { clearTimeout(this.streamTimer); this.streamTimer = null; }
    this.schedule();
  }

  turnStart(): void {
    this.running = true;
    this.schedule();
  }

  turnEnd(): void {
    this.streaming = false;
    this.tools.clear();
    if (this.streamTimer) { clearTimeout(this.streamTimer); this.streamTimer = null; }
    this.schedule();
  }

  toolStart(callId: string, name: string): void {
    this.tools.set(callId, name);
    this.schedule();
  }

  toolEnd(callId: string, isError: boolean, result: unknown): void {
    this.tools.delete(callId);
    if (isError) this.error = errorText(result);
    this.schedule();
  }

  streamChunk(): void {
    this.streaming = true;
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      this.streaming = false;
      this.schedule();
    }, STREAM_QUIET_MS);
    this.schedule();
  }

  promptStart(): void {
    this.pendingCount += 1;
    this.schedule();
  }

  promptEnd(): void {
    this.pendingCount = Math.max(0, this.pendingCount - 1);
    this.schedule();
  }

  setError(message: string): void {
    this.error = message;
    this.schedule();
  }

  dispose(): void {
    if (this.streamTimer) clearTimeout(this.streamTimer);
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.streamTimer = null;
    this.sendTimer = null;
  }
}

// ---------------------------------------------------------------------------
// puente con el shell
// ---------------------------------------------------------------------------

class MascotBridge {
  config: Config;
  state: MascotState;
  private socket: net.Socket | null = null;
  private connecting = false;
  private closed = false;
  private buffer = "";
  private spawnTried = false;
  private allowSpawn = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private lastLayout: Layout | null;
  interactive = true;
  private facts: Facts = { ...DEFAULT_FACTS };
  private clientId = os.hostname() + "-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
  private retries = 0;
  private lastError: string | null = null;
  onLayout: (layout: Layout) => void = () => {};
  onCommand: (action: string) => void = () => {};

  constructor(config: Config, state: MascotState) {
    this.config = config;
    this.state = state;
    this.lastLayout = config.layout;
  }

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  get layout(): Layout | null {
    return this.lastLayout;
  }

  syncSession(): void {
    if (!this.connected) return;
    this.sendHello();
    this.write({ type: "facts", facts: this.state.facts() });
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.facts = this.state.facts();
    try { this.write({ type: "bye" }); } catch (error) { /* ignorar */ }
    if (this.socket) {
      try { this.socket.end(); } catch (error) { /* ignorar */ }
      try { this.socket.destroy(); } catch (error) { /* ignorar */ }
    }
    this.socket = null;
    this.connecting = false;
  }

  private connect(): void {
    if (this.closed || this.connecting || this.connected) return;
    if (!this.config.enabled) return;
    this.connecting = true;
    const socket = net.connect(pipeName());
    socket.setEncoding("utf8");

    socket.on("connect", () => {
      this.connecting = false;
      this.socket = socket;
      this.retries = 0;
      this.reconnectDelay = 1000;
      log(this.config, "bridge connected: " + pipeName());
      this.sendHello();
      if (this.lastLayout) this.write({ type: "layout", layout: this.lastLayout });
      this.facts = this.state.facts();
      this.write({ type: "facts", facts: this.facts });
      this.write({ type: "command", action: this.config.enabled ? "show" : "hide" });
    });

    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf("\n");
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) this.receive(line);
        index = this.buffer.indexOf("\n");
      }
    });

    socket.on("error", (error: NodeJS.ErrnoException) => {
      this.lastError = error.message;
      this.connecting = false;
    });

    socket.on("close", () => {
      this.connecting = false;
      if (this.socket === socket) this.socket = null;
      if (this.closed) return;
      if (!this.spawnTried) { this.spawnTried = true; this.spawn(); }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.config.enabled) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(5000, Math.round(this.reconnectDelay * 1.6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.retries += 1;
      this.connect();
    }, delay);
  }

  spawn(): void {
    if (!this.config.autoLaunch || !this.allowSpawn) return;
    const launch = resolveShellLaunch(this.config);
    if (!launch) {
      this.lastError = "no se encontró el shell (configura shellExe o PI_MASCOT_SHELL_DIR)";
      log(this.config, this.lastError);
      return;
    }
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, PI_MASCOT_PIPE: pipeName() };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(launch.file, launch.args, {
        cwd: launch.cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env,
      });
      child.unref();
      log(this.config, "shell lanzado: " + launch.file);
    } catch (error) {
      this.lastError = errorText(error);
      log(this.config, "spawn: " + this.lastError);
    }
  }

  private sendHello(): void {
    this.write({
      type: "hello",
      clientId: this.clientId,
      pid: process.pid,
      cwd: this.state.session.cwd,
      interactive: this.interactive,
      session: this.state.session,
    });
  }

  private receive(raw: string): void {
    let message: Record<string, any>;
    try { message = JSON.parse(raw); } catch (error) { return; }
    if (!message || typeof message !== "object") return;

    if (message.type === "welcome") {
      const layout = normalizeLayout(message.layout);
      if (layout && !this.lastLayout) {
        this.lastLayout = layout;
        this.config.layout = layout;
        this.onLayout(layout);
      }
      return;
    }

    if (message.type === "layout") {
      const layout = normalizeLayout(message.layout);
      if (!layout) return;
      this.lastLayout = layout;
      this.config.layout = layout;
      this.onLayout(layout);
      return;
    }

    if (message.type === "command") {
      const action = String(message.action || "");
      if (!action) return;
      if (action === "show") {
        this.config.enabled = true;
        this.onCommand("show");
      } else if (action === "hide") {
        this.config.enabled = false;
        this.onCommand("hide");
      } else {
        this.onCommand(action);
      }
      return;
    }

    if (message.type === "error") {
      this.lastError = String(message.message || "error");
    }
  }

  sendFacts(facts: Facts): void {
    this.facts = facts;
    this.write({ type: "facts", facts });
  }

  setLayout(layout: Layout): void {
    this.lastLayout = layout;
    this.config.layout = layout;
    this.write({ type: "layout", layout });
  }

  command(action: string): boolean {
    return this.write({ type: "command", action });
  }

  private write(message: Record<string, any>): boolean {
    if (!this.connected || !this.socket) return false;
    try {
      this.socket.write(JSON.stringify({ v: PROTOCOL_VERSION, ...message }) + "\n");
      return true;
    } catch (error) {
      this.lastError = errorText(error);
      return false;
    }
  }

  status(): string {
    const connected = this.connected ? "conectada" : "sin conexión";
    const error = this.lastError ? " · último error: " + this.lastError : "";
    return connected + " · " + pipeName() + error;
  }
}

// ---------------------------------------------------------------------------
// extensión
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let config: Config | null = null;
  try {
    const initial = loadConfig();
    log(initial, "extension loaded: home=" + AGENT_HOME + " subagent=" + IS_SUBAGENT + " debug=" + initial.debug);
  } catch (error) { /* diagnóstico best-effort */ }
  let state: MascotState | null = null;
  let bridge: MascotBridge | null = null;
  let lastLayoutSave: ReturnType<typeof setTimeout> | null = null;
  let shellDir: string | null = null;

  function ensureConfig(): Config {
    if (!config) config = loadConfig();
    return config;
  }

  function saveLayoutSoon(): void {
    if (lastLayoutSave) clearTimeout(lastLayoutSave);
    lastLayoutSave = setTimeout(() => {
      lastLayoutSave = null;
      if (config) writeConfig(config);
    }, 400);
  }

  function notify(ctx: any, text: string): void {
    if (ctx && ctx.hasUI && ctx.ui && typeof ctx.ui.notify === "function") {
      ctx.ui.notify(text, "info");
    } else {
      console.log("[mascota] " + text);
    }
  }

  function connectBridge(ctx: any): void {
    const interactive = Boolean(ctx && ctx.hasUI);
    const current = ensureConfig();
    if (!current.enabled) return;
    if (!state) return;
    if (bridge) {
      bridge.config = current;
      bridge.allowSpawn = interactive;
      bridge.interactive = interactive;
      if (!bridge.connected) bridge.start();
      bridge.syncSession();
      return;
    }
    state = state || new MascotState((facts) => {
      if (bridge) bridge.sendFacts(facts);
    });
    bridge = new MascotBridge(current, state);
    bridge.allowSpawn = interactive;
    bridge.interactive = interactive;
    bridge.onLayout = (layout) => {
      if (!config) return;
      if (config.layout && config.layout.x === layout.x && config.layout.y === layout.y && config.layout.scale === layout.scale) return;
      config.layout = layout;
      writeConfig(config);
    };
    bridge.onCommand = (action) => {
      if (!config) return;
      if (action === "show") { config.enabled = true; writeConfig(config); }
      if (action === "hide") { config.enabled = false; writeConfig(config); }
    };
    bridge.start();
    log(current, "session_start: " + bridge.status());
  }

  function sessionInfo(ctx: any): SessionInfo {
    let id: string | null = null;
    let name: string | undefined;
    try {
      id = ctx.sessionManager.getSessionId();
      name = ctx.sessionManager.getSessionName();
    } catch (error) { /* contexto mínimo */ }
    return {
      id,
      name,
      model: ctx.model && (ctx.model.id || ctx.model.name),
      thinking: ctx.thinkingLevel,
      cwd: ctx.cwd,
    };
  }

  pi.on("session_start", async (event, ctx) => {
    try { log(ensureConfig(), "session_start: mode=" + ctx.mode + " hasUI=" + Boolean(ctx.hasUI) + " subagent=" + IS_SUBAGENT + " reason=" + event.reason); } catch (error) { /* ignorar */ }
    if (IS_SUBAGENT) return;
    ensureConfig();
    const info = sessionInfo(ctx);
    if (!state) {
      state = new MascotState((facts) => { if (bridge) bridge.sendFacts(facts); });
    }
    state.sessionStart(info);
    connectBridge(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (bridge) bridge.stop();
    bridge = null;
    if (config) writeConfig(config);
  });

  pi.on("agent_start", async () => { state?.agentStart(); });
  pi.on("agent_settled", async () => { state?.agentSettled(); });
  pi.on("turn_start", async () => { state?.turnStart(); });
  pi.on("turn_end", async () => { state?.turnEnd(); });

  pi.on("tool_execution_start", async (event) => {
    state?.toolStart(String(event.toolCallId), String(event.toolName));
  });

  pi.on("tool_execution_end", async (event) => {
    state?.toolEnd(String(event.toolCallId), Boolean(event.isError), event.result);
  });

  pi.on("message_update", async (event) => {
    if (event.message && event.message.role === "assistant") state?.streamChunk();
  });

  pi.on("ui_prompt_start", async () => { state?.promptStart(); });
  pi.on("ui_prompt_end", async () => { state?.promptEnd(); });

  pi.on("session_info_changed", async (event) => {
    if (state) state.session.name = event.name;
  });

  pi.registerCommand("mascota", {
    description: "Controla la mascota de escritorio: estado, on, off, reset, tamaño <55-190>, auto, debug, salir",
    handler: async (args: string, ctx: any) => {
      const current = ensureConfig();
      const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
      const action = (parts[0] || "estado").toLowerCase();

      if (action === "on") {
        current.enabled = true;
        writeConfig(current);
        if (!bridge) connectBridge(ctx);
        if (bridge) { bridge.start(); bridge.command("show"); }
        notify(ctx, "Mascota activada.");
        return;
      }

      if (action === "off") {
        current.enabled = false;
        writeConfig(current);
        if (bridge) bridge.command("hide");
        notify(ctx, "Mascota oculta.");
        return;
      }

      if (action === "reset") {
        if (bridge) bridge.command("reset");
        notify(ctx, bridge ? "Posición restablecida." : "La mascota no está conectada. Inicia pi con el shell disponible.");
        return;
      }

      if (action === "tamano" || action === "tamaño" || action === "size") {
        const percent = Number(parts[1]);
        if (!Number.isFinite(percent)) {
          notify(ctx, "Uso: /mascota tamaño 55-190");
          return;
        }
        const scale = Math.min(1.9, Math.max(0.55, percent / 100));
        const layout = current.layout || (bridge ? bridge.layout : null);
        if (!layout) {
          notify(ctx, "Todavía no hay layout conocido; mueve la mascota una vez o usa /mascota reset.");
          return;
        }
        const next = { x: layout.x, y: layout.y, scale };
        current.layout = next;
        writeConfig(current);
        if (bridge) bridge.setLayout(next);
        notify(ctx, "Tamaño: " + Math.round(percent) + "%.");
        return;
      }

      if (action === "auto") {
        const value = (parts[1] || "").toLowerCase();
        if (value === "on" || value === "off") {
          current.autoLaunch = value === "on";
          writeConfig(current);
          notify(ctx, "Auto-lanzar shell: " + value + ".");
        } else {
          notify(ctx, "Auto-lanzar shell: " + (current.autoLaunch ? "on" : "off") + " (usa /mascota auto on|off).");
        }
        return;
      }

      if (action === "debug") {
        current.debug = !current.debug;
        writeConfig(current);
        notify(ctx, "Debug: " + (current.debug ? "on" : "off") + " (" + LOG_PATH + ").");
        return;
      }

      if (action === "config") {
        notify(ctx, CONFIG_PATH + "\n" + JSON.stringify(current, null, 2));
        return;
      }

      if (action === "salir" || action === "quit") {
        if (bridge) bridge.command("quit");
        notify(ctx, "Cerrando el shell de la mascota.");
        return;
      }

      if (action === "ayuda" || action === "help") {
        notify(ctx, "Comandos: /mascota estado | on | off | reset | tamaño <55-190> | auto on|off | debug | config | salir");
        return;
      }

      // estado
      const facts = state ? state.facts() : { ...DEFAULT_FACTS };
      const lines = [
        "Mascota: " + (bridge ? bridge.status() : "sin sesión activa"),
        "Fase: " + phaseForFacts(facts),
        "Sesión: " + (facts.id || "-"),
        "Layout: " + (current.layout ? JSON.stringify(current.layout) : "por defecto"),
        "Config: " + CONFIG_PATH,
        "Shell: " + current.shellDir,
      ];
      notify(ctx, lines.join("\n"));
      return;
    },
  });
}

function phaseForFacts(facts: Facts): string {
  if (facts.pending) return "te necesita";
  if (!facts.running) return "reposo";
  if (facts.tool) return "herramienta: " + facts.tool;
  if (facts.streaming) return "cantando (streaming)";
  return "pensando";
}