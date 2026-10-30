# pi-session-mascot

Extensión de pi (y gentle-shell) que controla la mascota de escritorio del repo
[`desktop/`](../desktop/README.md). Mantiene los mismos “facts” que el plugin
original (running, tool, pending, error, streaming), los envía por named pipe y
persiste configuración y layout.

## Instalación

Desde el clon del repo:

```powershell
# opción A: instalador en ambos homes (recomendado)
powershell -ExecutionPolicy Bypass -File extension\install.ps1

# opción B: cargarla sólo en una ejecución
pi --extension ./extension/extensions/session-mascot.ts

# opción C: instalarla como paquete pi en el home actual
pi install ./extension
```

La opción C deja la extensión enlazada al repo; necesitas el shell de escritorio
en `desktop/` (o configurar `shellDir`/`PI_MASCOT_SHELL_DIR`).

## Configuración

Archivo: `<home>/session-mascot.json`, donde `<home>` es
`PI_CODING_AGENT_DIR` si está definido, si no `~/.pi/agent` (pi vanilla) o
`~/.gentle-shell/agent` (gentle-shell).

```json
{
  "enabled": true,
  "autoLaunch": true,
  "shellDir": "C:\\ruta\\a\\session-mascot\\desktop",
  "layout": null,
  "debug": false
}
```

Variables:

| Variable | Efecto |
| --- | --- |
| `PI_MASCOT_PIPE` | Ruta del pipe (debe coincidir con el shell). |
| `PI_MASCOT_SHELL_DIR` | Carpeta del shell si no se autodetecta. |
| `PI_MASCOT_CONFIG` | Ruta alternativa del JSON. |
| `PI_MASCOT_LOG_PATH` | Ruta alternativa del log. |
| `PI_MASCOT_DEBUG=1` | Log detallado. |

## Comandos

| Comando | Efecto |
| --- | --- |
| `/mascota estado` | Conexión, fase, sesión, layout y rutas. |
| `/mascota on` / `off` | Muestra u oculta la mascota. |
| `/mascota reset` | Restaura posición y tamaño. |
| `/mascota tamaño 55-190` | Escala. |
| `/mascota auto on|off` | Auto-lanzar el shell. |
| `/mascota debug` | Alterna el log. |
| `/mascota config` | Muestra configuración y rutas. |
| `/mascota salir` | Cierra el shell. |

## Mapeo de eventos

| Evento pi | Efecto en `facts` |
| --- | --- |
| `session_start` | nuevo `id` → caminata de transición. |
| `agent_start`, `turn_start` | `running = true`; limpia error. |
| `agent_settled` | `running = false` → celebración. |
| `tool_execution_start/end` | `tool` en vuelo; `isError` → `error`. |
| `message_update` | `streaming = true` con gracia de 1.6 s. |
| `turn_end` | limpia herramientas y streaming. |
| `ui_prompt_start/end` | “te necesita”. |
| Desconexión | el shell vuelve a reposo. |

## Notas

- La extensión no dibuja nada: lanza/controla el shell Electron del repo.
- Sólo sesiones interactivas (TUI/RPC) auto-lanzan la ventana.
- Procesos headless, subagentes y `pi -p` no compiten por el estado; sólo la sesión principal mueve la mascota.
- El canal es local (named pipe/socket); no hay puertos ni red.
