'use strict';

/**
 * Puente renderer ↔ shell.
 *
 * - Recibe "facts" del plugin (vía main) y los publica para la UI.
 * - Siembra el layout del plugin antes de montar (localStorage es solo caché).
 * - Aplica layouts en caliente con window.__mascotApplyLayout (sin remontar).
 * - Avisa al main cuando el cursor entra/sale de la mascota para alternar el
 *   click-through de la ventana transparente.
 */
(function () {
  var LAYOUT_KEY = 'dsh.mascot.layout.v1';
  var DEFAULT_FACTS = { id: null, running: false, pending: false, error: null, tool: null, streaming: false };

  var api = window.mascotAPI || null;
  var facts = Object.assign({}, DEFAULT_FACTS);
  var subscribers = new Set();
  var mounted = false;
  var interactive = false;
  var lastLayoutKey = null;

  function normalizeFacts(input) {
    var source = input && typeof input === 'object' ? input : {};
    return {
      id: source.id === undefined || source.id === null ? null : String(source.id),
      running: Boolean(source.running),
      pending: Boolean(source.pending),
      error: source.error ? String(source.error) : null,
      tool: source.tool ? String(source.tool) : null,
      streaming: Boolean(source.streaming),
    };
  }

  function publishFacts(next) {
    facts = normalizeFacts(next);
    window.__mascotFacts = facts;
    subscribers.forEach(function (callback) {
      try { callback(facts); } catch (error) { /* la UI no debe romper el puente */ }
    });
  }

  window.__mascotGetFacts = function () { return facts; };
  window.__mascotOnFacts = function (callback) {
    subscribers.add(callback);
    if (window.__mascotFacts) {
      try { callback(window.__mascotFacts); } catch (error) { /* ignorar */ }
    }
    return function () { subscribers.delete(callback); };
  };

  function writeCachedLayout(layout) {
    if (!layout) return;
    try { window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (error) { /* ignorar */ }
  }

  function clearCachedLayout() {
    try { window.localStorage.removeItem(LAYOUT_KEY); } catch (error) { /* ignorar */ }
  }

  function layoutKey(layout) {
    if (!layout) return 'null';
    return layout.x + ':' + layout.y + ':' + layout.scale;
  }

  function applyLayout(layout, reset) {
    if (reset) {
      clearCachedLayout();
      lastLayoutKey = 'null';
      var node = document.querySelector('.dsh-mascot');
      if (node) {
        node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      }
      return;
    }
    if (!layout) return;
    writeCachedLayout(layout);
    lastLayoutKey = layoutKey(layout);
    if (window.__mascotApplyLayout) {
      window.dispatchEvent(new CustomEvent('mascot:layout', { detail: layout }));
    }
  }

  function overMascot(x, y) {
    var node = document.querySelector('.dsh-mascot');
    if (!node) return false;
    var rect = node.getBoundingClientRect();
    var pad = 8;
    return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
  }

  function isDragging() {
    return Boolean(document.querySelector('.dsh-mascot[data-dragging="true"]'));
  }

  function installHoverTracking() {
    window.addEventListener('mousemove', function (event) {
      var over = isDragging() || overMascot(event.clientX, event.clientY);
      if (over === interactive) return;
      interactive = over;
      if (api && typeof api.setInteractive === 'function') api.setInteractive(interactive);
    }, { passive: true });

    window.addEventListener('mouseleave', function () {
      if (!interactive) return;
      interactive = false;
      if (api && typeof api.setInteractive === 'function') api.setInteractive(false);
    });
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'facts') { publishFacts(message.facts); return; }
    if (message.type === 'layout') { applyLayout(message.layout, Boolean(message.reset)); return; }
    if (message.type === 'command' && message.action === 'reset') { applyLayout(null, true); }
  }

  async function init() {
    if (api && typeof api.onMessage === 'function') api.onMessage(handleMessage);
    installHoverTracking();

    var state = null;
    try { state = await api.getState(); } catch (error) { state = null; }

    if (state && state.layout) {
      writeCachedLayout(state.layout);
      lastLayoutKey = layoutKey(state.layout);
    }
    if (state && state.facts) publishFacts(state.facts);

    window.__mascotMount();
    mounted = true;
    window.__mascotMounted = true;
    document.dispatchEvent(new CustomEvent('mascot:mounted'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
