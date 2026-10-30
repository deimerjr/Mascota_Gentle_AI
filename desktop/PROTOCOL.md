# Protocolo mascota pi ↔ shell

Transporte: **named pipe de Windows** (`\\.\pipe\pi-mascot-<usuario>`) o **socket Unix** en
`$TMPDIR/pi-mascot-<usuario>.sock`. Se puede forzar una ruta concreta con la variable de
entorno `PI_MASCOT_PIPE` (útil para tests).

Mensajes: **JSON por línea** (NDJSON, UTF-8). Versión de protocolo: `1`.

- El **shell** (Electron) es el servidor: crea el pipe y atiende a todos los clientes.
- La **extensión de pi** es el cliente: envía el cerebro (facts), el layout y comandos.
- El plugin es la fuente de verdad del layout; el shell solo lo cachea para arrancar sin
  parpadeo y se lo pasa al renderer.

## Cliente → servidor

| `type` | Campos | Descripción |
| --- | --- | --- |
| `hello` | `clientId`, `pid`, `cwd`, `session: { id, name, model, thinking }` | Identifica la instancia de pi. |
| `facts` | `facts: { id, running, pending, error, tool, streaming }` | Estado que pinta la mascota. Es el mismo objeto que consumía el plugin de DSH. |
| `layout` | `layout: { x, y, scale }` | El plugin impone posición/tamaño (p. ej. tras `/mascota tamaño`). |
| `command` | `action: "show" \| "hide" \| "quit" \| "reset"` | Órdenes al shell. `reset` lo ejecuta el renderer. |
| `bye` | — | Cierre ordenado de la sesión. |

## Servidor → cliente

| `type` | Campos | Descripción |
| --- | --- | --- |
| `welcome` | `layout` (cacheado o `null`), `shell: { version, platform }` | Al conectar. |
| `layout` | `layout` | El renderer arrastró/redimensionó; el plugin lo persiste. |
| `command` | `action: "reset" \| "hide" \| "show"` | Intención desde el menú de la bandeja. El plugin decide y persiste. |
| `error` | `message` | Error de protocolo. |

## Semántica de `facts`

| Campo | Tipo | Significado |
| --- | --- | --- |
| `id` | string \| null | Id de sesión. Un cambio dispara la caminata de transición (900 ms). |
| `running` | boolean | Hay un run de agente activo (`agent_start` … `agent_settled`). |
| `pending` | boolean | Hay un diálogo bloqueante esperando al usuario (`ui_prompt_start/end`). |
| `error` | string \| null | Error nuevo. El renderer lo muestra ~3,6 s. |
| `tool` | string \| null | Herramienta en vuelo (la última si hay varias). |
| `streaming` | boolean | El asistente está emitiendo texto (con 1,6 s de gracia). |

## Layout

`{ x, y, scale }` en píxeles CSS de la pantalla primaria, `scale` entre `0.55` y `1.9`.
El renderer mantiene la copia en `localStorage` (`dsh.mascot.layout.v1`) como caché de
arranque; el plugin guarda la definitiva en `~/.pi/agent/session-mascot.json`.

## Compatibilidad

- Solo loopback/pipe local; no hay puertos TCP ni exposición de red.
- Los mensajes desconocidos se ignoran (forward compatibility).
- El shell tolera clientes múltiples: muestra el último que emitió `facts`.
