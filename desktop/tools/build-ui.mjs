#!/usr/bin/env node
/**
 * Genera renderer/mascot-ui.js a partir del núcleo visual de ui/mascot-client.js
 * reemplazando solo las tres costuras de host:
 *
 *   1. envoltorio __ModuleLoader__  -> IIFE con React global
 *   2. useSessionFacts (servicios DSH) -> useMascotFacts (puente pi)
 *   3. registro en ctx.slots -> window.__mascotMount()
 *
 * El resto (sprites, CSS, fases, drag, resize, persistencia) se conserva.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SOURCE = path.resolve(ROOT, 'ui', 'mascot-client.js');
const OUTPUT = path.resolve(ROOT, 'renderer', 'mascot-ui.js');

let code = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
const originalLength = code.length;

function replaceOnce(label, from, to) {
  const index = code.indexOf(from);
  if (index < 0) throw new Error('No se encontró el ancla: ' + label);
  if (code.indexOf(from, index + 1) >= 0) throw new Error('Ancla ambigua (más de una vez): ' + label);
  code = code.slice(0, index) + to + code.slice(index + from.length);
}

function replaceTail(label, startAnchor, replacement) {
  const start = code.indexOf(startAnchor);
  if (start < 0) throw new Error('No se encontró el inicio: ' + label);
  code = code.slice(0, start) + replacement;
}

function replaceBetween(label, startAnchor, endAnchor, replacement) {
  const start = code.indexOf(startAnchor);
  if (start < 0) throw new Error('No se encontró el inicio: ' + label);
  const end = code.indexOf(endAnchor, start + startAnchor.length);
  if (end < 0) throw new Error('No se encontró el fin: ' + label);
  code = code.slice(0, start) + replacement + code.slice(end);
}

// 1) envoltorio del module loader -> IIFE
replaceOnce(
  'module-loader',
  [
    "window.__ModuleLoader__.load({",
    "  id: '@local/dsh-mascot',",
    "  factory(require) {",
    "    const React = require('react');",
    "    const h = React.createElement;",
  ].join('\n'),
  [
    '(function () {',
    '  const React = window.React;',
    '  const h = React.createElement;',
  ].join('\n'),
);

// 2) hechos desde DSH -> hechos desde el puente
replaceBetween(
  'useSessionFacts',
  '    function useSessionFacts(uiSession, uiWorkspace, sessions) {',
  '\n    function basePhase(facts) {',
  [
    '    function useMascotFacts() {',
    '      const stateHook = React.useState(function () {',
    '        if (typeof window.__mascotGetFacts === \'function\') return window.__mascotGetFacts();',
    '        return { id: null, running: false, pending: false, error: null, tool: null, streaming: false };',
    '      });',
    '      const facts = stateHook[0];',
    '      const setFacts = stateHook[1];',
    '',
    '      React.useEffect(function () {',
    '        if (typeof window.__mascotOnFacts !== \'function\') return undefined;',
    '        return window.__mascotOnFacts(function (next) {',
    '          setFacts(function (previous) {',
    '            if (previous.id === next.id && previous.running === next.running && previous.pending === next.pending',
    '              && previous.error === next.error && previous.tool === next.tool && previous.streaming === next.streaming) return previous;',
    '            return {',
    '              id: next.id === undefined ? null : next.id,',
    '              running: Boolean(next.running),',
    '              pending: Boolean(next.pending),',
    '              error: next.error ? String(next.error) : null,',
    '              tool: next.tool ? String(next.tool) : null,',
    '              streaming: Boolean(next.streaming),',
    '            };',
    '          });',
    '        });',
    '      }, []);',
    '',
    '      return facts;',
    '    }',
    '',
  ].join('\n'),
);

replaceOnce(
  'initial-layout-persist',
  '      return defaultLayout();\n    }',
  '      const fallback = defaultLayout();\n      persistLayout(fallback);\n      return fallback;\n    }',
);

replaceOnce(
  'facts-usage',
  '      const facts = useSessionFacts(props.uiSession, props.uiWorkspace, props.sessions);',
  '      const facts = useMascotFacts();',
);

// 3b) aplicador de layout en caliente (sin remontar: conserva fase y animación)
replaceOnce(
  'layout-apply-hook',
  '      const saveTimer = React.useRef(0);',
  [
    '      const saveTimer = React.useRef(0);',
    '',
    '      React.useEffect(function () {',
    '        function apply(next) {',
    '          if (!next) return;',
    '          var x = Number(next.x);',
    '          var y = Number(next.y);',
    '          var scale = Number(next.scale);',
    '          if (!isFinite(x) || !isFinite(y) || !isFinite(scale)) return;',
    '          commitLayout(clampLayout({ x: x, y: y, scale: scale }));',
    '        }',
    '        window.__mascotApplyLayout = apply;',
    '        var handler = function (event) { apply(event.detail); };',
    '        window.addEventListener(\'mascot:layout\', handler);',
    '        return function () {',
    '          window.removeEventListener(\'mascot:layout\', handler);',
    '          if (window.__mascotApplyLayout === apply) delete window.__mascotApplyLayout;',
    '        };',
    '      }, []);',
  ].join('\n'),
);

// 3) persistir layout también hacia el plugin
replaceOnce(
  'persist-layout',
  "      try { window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (error) { /* ignore */ }",
  [
    "      try { window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (error) { /* ignore */ }",
    "      try {",
    "        if (window.mascotAPI && typeof window.mascotAPI.reportLayout === 'function') window.mascotAPI.reportLayout(layout);",
    "      } catch (error) { /* ignore */ }",
  ].join('\n'),
);

// 4) cola: registro en slots -> montaje autónomo
replaceTail(
  'mount-tail',
  "\n    return {\n      inject: ['slots', 'sessions', 'uiSession', 'uiWorkspace'],",
  [
    '',
    '    window.__mascotMount = function () {',
    '      for (const stale of Array.from(document.querySelectorAll(\'style[data-plugin="session-mascot"]\'))) {',
    '        stale.remove();',
    '      }',
    '      const tag = document.createElement(\'style\');',
    '      tag.dataset.plugin = \'session-mascot\';',
    '      tag.textContent = CSS_TEXT;',
    '      document.head.appendChild(tag);',
    '      const root = document.getElementById(\'mascot-root\') || document.body;',
    '      window.__mascotReactRoot = ReactDOM.createRoot(root);',
    '      window.__mascotReactRoot.render(h(Mascot, {}));',
    '    };',
    '  })();',
    '',
  ].join('\n'),
);

const banner = [
  '/**',
  ' * GENERADO por desktop/tools/build-ui.mjs — no editar a mano.',
  ' * Fuente: ui/mascot-client.js (' + fs.statSync(SOURCE).size + ' bytes).',
  ' * Generado: ' + new Date().toISOString(),
  ' */',
  '',
].join('\n');

code = banner + code;

const forbidden = ['__ModuleLoader__', 'useSessionFacts(', 'ctx.slots', 'require(\'react\')'];
for (const needle of forbidden) {
  if (code.includes(needle)) throw new Error('El resultado todavía contiene: ' + needle);
}

fs.writeFileSync(OUTPUT, code);
console.log('[build-ui] ' + path.relative(ROOT, SOURCE) + ' -> ' + path.relative(ROOT, OUTPUT));
console.log('[build-ui] ' + originalLength + ' -> ' + code.length + ' bytes');
