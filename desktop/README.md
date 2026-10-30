# pi-session-mascot-shell

Ventana transparente y always-on-top que pinta la mascota web y obedece a la
extensión de pi/gentle-shell por un named pipe local. El protocolo está en
[PROTOCOL.md](PROTOCOL.md).

```
pi / gentle-shell
  └─ extension (repo ../extension)      cerebro
        │  NDJSON por named pipe
        ▼
este shell (Electron)                   cara: React + CSS + sprites
```

## Requisitos

- Node.js 20+ y npm.
- Windows 10/11 (probado). En macOS/Linux el pipe usa socket Unix.
- Electron (se instala con `npm install` desde la raíz del repo).

## Descarga

Instalador y portable en
[Releases](https://github.com/deimerjr/Mascota_Gentle_AI/releases).

## Arranque (dev)

Desde la **raíz del repo**:

```powershell
npm install
npm start
```

`npm start` regenera `renderer/mascot-ui.js` desde
[`ui/mascot-client.js`](ui/mascot-client.js) y lanza Electron limpiando
`ELECTRON_RUN_AS_NODE` (algunos entornos como DSH la dejan puesta y Electron
arrancaría como Node).

También puedes ejecutarlo desde la extensión: si el pipe no existe y
`autoLaunch` está activo, la extensión busca Electron en
`desktop/node_modules` o en el `node_modules` raíz del workspace y lo lanza.

## Uso

- **Arrastrar** para mover; **rueda** para redimensionar (55 %–190 %); **doble clic** para restablecer.
- **🎭** (arriba a la derecha, al pasar el cursor) cambia entre Gatita Kimono,
  Gato original, Majin Buu y Neko. La elección se guarda en `localStorage`.
- La ventana es click-through fuera de la mascota.
- **Bandeja**: mostrar/ocultar, restablecer, salir.
- Posición/tamaño los persiste la extensión en `<home>/session-mascot.json`;
  el shell guarda una caché en `%APPDATA%/pi-mascot-shell/shell-state.json`.

## Cómo se genera el renderer

`tools/build-ui.mjs` toma `ui/mascot-client.js` (la UI original con sprites y
CSS embebidos) y sustituye sólo las costuras de host:

1. `window.__ModuleLoader__` → IIFE con React global.
2. `useSessionFacts` (servicios de DSH) → `useMascotFacts` alimentado por el puente.
3. Registro en `ctx.slots` → `window.__mascotMount()`.

Además añade un aplicador de layout en caliente para que el reset y
`/mascota tamaño` no remonten React. El resultado (`renderer/mascot-ui.js`) está
en `.gitignore`; se reconstruye al arrancar o con `npm run build:ui`.

## Tests

```powershell
npm run test:ui    # renderer en Chromium (Playwright) + capturas en test/artifacts
npm run test:e2e   # Electron real: ventana, fases, layout, reset, hide/show
```

## Integración con gentle-shell

El shell es el mismo; la extensión vive en el home de gentle-shell. Desde la raíz:

```powershell
powershell -ExecutionPolicy Bypass -File extension\install.ps1
```

Reinicia gentle-shell. Como la ventana es externa, convive con su TUI sin
interferir; sólo la sesión principal mueve la mascota.

## Troubleshooting

- **No aparece la ventana**: comprueba `/mascota estado`; revisa
  `%APPDATA%/pi-mascot-shell/shell.log`; arranca `npm start` a mano.
- **`ELECTRON_RUN_AS_NODE`**: usa `npm start` (ya lo limpia), no `electron .`
  directamente en entornos que la definan.
- **Pipe ocupado**: otra instancia del shell ya está corriendo (single instance);
  esta se cierra sola.
- **Sin Electron**: ejecuta `npm install` en la raíz del repo.

## Limitaciones

- Sólo monitor primario.
- Aún sin instalador empaquetado (`electron-builder`) ni firma de código.
- Windows probado; macOS/Linux sin verificar.