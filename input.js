/*
 * Corrida Benlit — controles (teclado + toque multitoque).
 * Toque: cada dedo é rastreado pelo pointerId. Ao arrastar o dedo de um botão
 * para outro (ex.: esquerda -> direita), o controle acompanha. Ao soltar,
 * o botão é liberado. Funciona com vários botões ao mesmo tempo.
 */
(function () {
  'use strict';
  var state = { up: false, down: false, left: false, right: false, handbrake: false, nitro: false };
  var keys = {};
  var touches = new Map(); // pointerId -> nome do botão
  var layer = null;

  var KEYMAP = {
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    Space: 'handbrake', ShiftLeft: 'nitro', ShiftRight: 'nitro', KeyN: 'nitro'
  };

  function recompute() {
    var t = { up: false, down: false, left: false, right: false, handbrake: false, nitro: false };
    touches.forEach(function (b) { if (b) t[b] = true; });
    for (var k in t) state[k] = t[k] || !!keys[k];
    if (layer) {
      var btns = layer.querySelectorAll('[data-btn]');
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', !!t[btns[i].getAttribute('data-btn')]);
    }
  }

  function keyName(e) { return KEYMAP[e.code] || KEYMAP[e.key]; }

  window.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    var k = keyName(e);
    if (!k || !Input.enabled) return;
    keys[k] = true; recompute(); e.preventDefault();
  });
  window.addEventListener('keyup', function (e) {
    var k = keyName(e);
    if (!k) return;
    keys[k] = false; recompute();
  });

  function buttonAt(x, y) {
    var el = document.elementFromPoint(x, y);
    var b = el && el.closest ? el.closest('[data-btn]') : null;
    return b && layer && layer.contains(b) ? b.getAttribute('data-btn') : null;
  }

  function releaseAll() { keys = {}; touches.clear(); recompute(); }

  var Input = {
    state: state,
    enabled: false,
    releaseAll: releaseAll,
    bindTouch: function (el) {
      layer = el;
      el.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        touches.set(e.pointerId, buttonAt(e.clientX, e.clientY));
        recompute();
        if (window.AudioSys) AudioSys.unlock();
        e.preventDefault();
      }, { passive: false });
      window.addEventListener('pointermove', function (e) {
        if (!touches.has(e.pointerId)) return;
        var b = buttonAt(e.clientX, e.clientY);
        if (b !== touches.get(e.pointerId)) { touches.set(e.pointerId, b); recompute(); }
      }, { passive: true });
      var end = function (e) { if (touches.delete(e.pointerId)) recompute(); };
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      // impede menu de contexto / lupa / seleção ao segurar os botões
      el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      el.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
      el.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    }
  };

  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', function () { if (document.hidden) releaseAll(); });

  window.Input = Input;
})();
