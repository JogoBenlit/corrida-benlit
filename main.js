/*
 * Corrida Benlit — interface, salas e comunicação com o servidor (Socket.IO).
 */
(function () {
  'use strict';

  var SERVER = (window.CORRIDA_SERVER_URL || '').replace(/\/+$/, '');
  var COLORS = Game.colors;
  var COLOR_NAMES = ['Dourado', 'Vermelho', 'Azul', 'Verde', 'Roxo', 'Rosa', 'Turquesa', 'Branco'];

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function store(type) { try { var s = window[type]; s.setItem('__t', '1'); s.removeItem('__t'); return s; } catch (e) { return null; } }
  var LS = store('localStorage'), SS = store('sessionStorage');
  var mem = {};
  function get(s, k) { return s ? s.getItem(k) : (mem[k] !== undefined ? mem[k] : null); }
  function set(s, k, v) { if (s) s.setItem(k, v); else mem[k] = v; }
  function del(s, k) { if (s) s.removeItem(k); else delete mem[k]; }

  // ID do jogador: por aba (sessionStorage) — permite testar 2 jogadores no mesmo navegador
  var myId = get(SS, 'cb_pid');
  if (!myId) {
    myId = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    set(SS, 'cb_pid', myId);
  }

  var prefs = {
    name: get(LS, 'cb_name') || '',
    color: parseInt(get(LS, 'cb_color') || '0', 10) || 0
  };

  var room = null;
  var screen = 'home';
  var raceNumber = 0;
  var inviteCode = null;
  var wakeLock = null;
  var hadConnection = false;

  var isTouch = /[?&]touch=1/.test(location.search) ||
    (window.matchMedia && matchMedia('(pointer: coarse)').matches) ||
    (navigator.maxTouchPoints > 0 && !(window.matchMedia && matchMedia('(hover: hover)').matches));
  document.body.classList.toggle('touch', isTouch);

  // ---------------- conexão ----------------
  var socket = io(SERVER || undefined, {
    reconnection: true,
    reconnectionDelay: 700,
    reconnectionDelayMax: 4000,
    timeout: 12000
  });

  function setConn(text, cls) {
    var b = $('conn-banner');
    if (!text) { b.hidden = true; return; }
    b.hidden = false; b.textContent = text; b.className = 'conn-banner ' + (cls || '');
  }

  socket.on('connect', function () {
    var first = !hadConnection;
    hadConnection = true;
    setConn(null);
    var code = get(SS, 'cb_room');
    if (code && prefs.name) {
      socket.emit('joinRoom', { playerId: myId, code: code, name: prefs.name, color: prefs.color }, function (res) {
        if (res.ok) {
          if (!first) toast('Conexão restabelecida', 'ok');
          onJoined(res);
        } else {
          del(SS, 'cb_room');
          if (screen !== 'home') { toast(res.error, 'warn'); goHome(); }
        }
      });
    }
  });
  socket.on('disconnect', function (reason) {
    if (reason === 'io client disconnect') return;
    setConn('Conexão perdida. Reconectando…', 'warn');
  });
  socket.io.on('reconnect_attempt', function (n) {
    setConn('Reconectando… (tentativa ' + n + ')', 'warn');
  });
  socket.on('connect_error', function () {
    if (!hadConnection) setConn('Não foi possível conectar ao servidor. Tentando de novo…', 'warn');
  });

  socket.on('room', function (r) {
    room = r;
    Game.setRoomPlayers(r.players, COLORS);
    renderLobby();
  });

  socket.on('notice', function (n) { toast(n.text, n.type); });

  socket.on('countdown', function (d) {
    raceNumber = d.raceNumber;
    hideResults();
    showScreen('game');
    var inRace = !!d.grid[myId];
    Game.prepareRace({ myId: myId, laps: d.laps, grid: d.grid, countdownMs: d.ms, spectate: !inRace });
    Input.enabled = inRace;
    $('spectate-banner').hidden = inRace;
    requestWakeLock();
  });
  socket.on('go', function (d) { if (d.raceNumber === raceNumber) Game.go(0); });
  socket.on('snap', function (s) { Game.onSnapshot(s); });
  socket.on('correction', function (c) { Game.onCorrection(c); });
  socket.on('lap', function (d) { Game.onLap(d); });
  socket.on('playerFinished', function (f) {
    if (f.id === myId) {
      Game.setFinished(f.place, f.time);
      AudioSys.fanfare();
    } else {
      toast(f.name + ' cruzou a chegada em ' + f.place + 'º', f.place === 1 ? 'gold' : 'info');
    }
  });
  socket.on('results', function (d) {
    Game.mode = 'results';
    Input.releaseAll();
    Input.enabled = false;
    AudioSys.silenceCar();
    releaseWakeLock();
    if (screen === 'game') showResults(d);
    else renderLobby();
  });

  function onJoined(res) {
    room = res.room;
    if (res.colors) COLORS = res.colors;
    set(SS, 'cb_room', room.code);
    var url = location.pathname + '?sala=' + room.code;
    try { history.replaceState(null, '', url); } catch (e) {}
    Game.setRoomPlayers(room.players, COLORS);
    var race = res.race;
    if (race) {
      if (screen === 'game' && race.raceNumber === raceNumber && Game.me && race.me) {
        // reconexão rápida: segue a corrida normalmente
        Input.enabled = true;
        return;
      }
      raceNumber = race.raceNumber;
      hideResults();
      showScreen('game');
      if (race.me) {
        Game.prepareRace({
          myId: myId, laps: race.laps, grid: {}, me: race.me,
          countdownMs: race.state === 'countdown' ? 1500 : 0
        });
        if (race.state === 'racing') Game.go(race.elapsed);
        if (race.me.finished) Game.finished = true;
        Input.enabled = true;
        $('spectate-banner').hidden = true;
      } else {
        Game.prepareRace({ myId: myId, laps: race.laps, grid: {}, spectate: true });
        if (race.state === 'racing') Game.go(race.elapsed);
        Input.enabled = false;
        $('spectate-banner').hidden = false;
      }
      return;
    }
    if (screen === 'game' && room.state === 'results' && !$('results').hidden) { renderLobby(); return; }
    showScreen('lobby');
    renderLobby();
  }

  // ---------------- telas ----------------
  function showScreen(name) {
    screen = name;
    ['home', 'lobby', 'game'].forEach(function (s) { $('screen-' + s).classList.toggle('active', s === name); });
    document.body.classList.toggle('in-game', name === 'game');
    if (name === 'game') {
      Game.resize();
      $('touch-controls').hidden = !isTouch;
      updateRotateHint();
    } else {
      Game.stop();
      Input.enabled = false;
      Input.releaseAll();
    }
    window.scrollTo(0, 0);
  }

  function goHome() {
    room = null;
    del(SS, 'cb_room');
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    hideResults();
    showScreen('home');
    renderHome();
  }

  // ---------------- início ----------------
  function renderSwatches(el, selected, taken, onPick) {
    el.innerHTML = '';
    COLORS.forEach(function (c, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (i === selected ? ' selected' : '');
      b.style.setProperty('--c', c);
      b.setAttribute('aria-label', COLOR_NAMES[i] + (taken && taken[i] ? ' (em uso)' : ''));
      b.setAttribute('aria-pressed', i === selected ? 'true' : 'false');
      if (taken && taken[i]) { b.disabled = true; b.classList.add('taken'); }
      b.addEventListener('click', function () { onPick(i); });
      el.appendChild(b);
    });
  }

  function renderHome() {
    $('nick').value = prefs.name;
    renderSwatches($('color-picker'), prefs.color, null, function (i) {
      prefs.color = i; set(LS, 'cb_color', String(i)); renderHome();
    });
    var m = /[?&]sala=([A-Za-z]{4})/.exec(location.search);
    inviteCode = m ? m[1].toUpperCase() : null;
    $('invite-box').hidden = !inviteCode;
    $('invite-code').textContent = inviteCode || '';
    $('btn-create').classList.toggle('primary', !inviteCode);
    $('btn-create').classList.toggle('secondary', !!inviteCode);
    if (inviteCode && !$('code-input').value) $('code-input').value = inviteCode;
  }

  function readName() {
    var n = $('nick').value.replace(/\s+/g, ' ').trim().slice(0, 14);
    if (!n) {
      homeError('Digite seu apelido para entrar na corrida.');
      $('nick').focus();
      return null;
    }
    prefs.name = n; set(LS, 'cb_name', n);
    return n;
  }
  function homeError(t) { $('home-error').textContent = t || ''; }

  function busy(btn, on) { btn.disabled = on; btn.classList.toggle('loading', on); }

  function createRoom() {
    homeError('');
    var name = readName(); if (!name) return;
    AudioSys.unlock();
    if (!socket.connected) { homeError('Sem conexão com o servidor. Aguarde alguns segundos e tente de novo.'); return; }
    var btn = $('btn-create'); busy(btn, true);
    socket.emit('createRoom', { playerId: myId, name: name, color: prefs.color }, function (res) {
      busy(btn, false);
      if (!res.ok) return homeError(res.error);
      onJoined(res);
    });
  }

  function joinRoom(code, btn) {
    homeError('');
    var name = readName(); if (!name) return;
    code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) { homeError('O código da sala tem 4 letras.'); $('code-input').focus(); return; }
    AudioSys.unlock();
    if (!socket.connected) { homeError('Sem conexão com o servidor. Aguarde alguns segundos e tente de novo.'); return; }
    busy(btn, true);
    socket.emit('joinRoom', { playerId: myId, code: code, name: name, color: prefs.color }, function (res) {
      busy(btn, false);
      if (!res.ok) return homeError(res.error);
      onJoined(res);
    });
  }

  // ---------------- lobby ----------------
  function shareUrl() {
    var base = window.CORRIDA_PUBLIC_URL || (location.origin + location.pathname);
    return base.replace(/\?.*$/, '') + '?sala=' + (room ? room.code : '');
  }
  function shareText() {
    return 'Bora correr na Corrida Benlit! 🏁 Entre na minha sala ' + room.code + ':';
  }

  function renderLobby() {
    if (!room) return;
    var me = room.players.find(function (p) { return p.id === myId; });
    var isHost = room.hostId === myId;
    $('lobby-code').textContent = room.code;
    $('share-link').textContent = shareUrl();
    $('btn-whatsapp').href = 'https://wa.me/?text=' + encodeURIComponent(shareText() + ' ' + shareUrl());
    $('player-count').textContent = room.players.length + '/8';

    var ul = $('player-list');
    ul.innerHTML = room.players.map(function (p) {
      var tags = [];
      if (p.id === room.hostId) tags.push('<span class="tag host">anfitrião</span>');
      if (p.id === myId) tags.push('<span class="tag me">você</span>');
      if (!p.connected) tags.push('<span class="tag off">reconectando</span>');
      else if (p.inRace && (room.state === 'racing' || room.state === 'countdown')) tags.push('<span class="tag race">correndo</span>');
      return '<li><span class="car-chip" style="--c:' + COLORS[p.color] + '"></span><span class="pname">' + esc(p.name) + '</span>' + tags.join('') + '</li>';
    }).join('');

    var taken = {};
    room.players.forEach(function (p) { if (p.id !== myId) taken[p.color] = true; });
    var racing = room.state === 'racing' || room.state === 'countdown';
    renderSwatches($('lobby-colors'), me ? me.color : prefs.color, taken, function (i) {
      if (racing) return;
      prefs.color = i; set(LS, 'cb_color', String(i));
      socket.emit('setColor', i);
    });

    var lp = $('laps-picker');
    lp.innerHTML = '';
    [1, 2, 3, 5].forEach(function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg' + (room.laps === n ? ' selected' : '');
      b.textContent = n + (n === 1 ? ' volta' : ' voltas');
      b.disabled = !isHost || racing;
      b.addEventListener('click', function () { socket.emit('setLaps', n); });
      lp.appendChild(b);
    });

    var start = $('btn-start'), status = $('lobby-status');
    start.hidden = false;
    if (racing) {
      start.textContent = 'Assistir corrida em andamento';
      start.disabled = false;
      start.dataset.action = 'watch';
      status.textContent = 'Você entra na próxima corrida.';
    } else if (isHost) {
      start.textContent = room.state === 'results' ? 'Iniciar nova corrida' : 'Iniciar corrida';
      start.disabled = false;
      start.dataset.action = 'start';
      var n = room.players.filter(function (p) { return p.connected; }).length;
      status.textContent = n < 2 ? 'Convide pelo menos 1 amigo — ou largue sozinho para treinar.' : n + ' pilotos prontos. A largada é sua.';
    } else {
      start.textContent = 'Aguardando o anfitrião iniciar';
      start.disabled = true;
      start.dataset.action = '';
      var host = room.players.find(function (p) { return p.id === room.hostId; });
      status.textContent = host ? host.name + ' é o anfitrião e dá a largada.' : '';
    }

    var st = $('standings');
    if (!room.standings.length) {
      st.innerHTML = '<li class="empty">Os pontos aparecem aqui depois da primeira corrida (10, 8, 6, 5, 4, 3, 2, 1).</li>';
    } else {
      st.innerHTML = room.standings.map(function (s, i) {
        return '<li><span class="rank">' + (i + 1) + 'º</span><span class="car-chip" style="--c:' + COLORS[s.color] + '"></span><span class="pname">' + esc(s.name) + '</span><span class="pts">' + s.points + ' pts</span><span class="wins">' + s.wins + ' 🏆</span></li>';
      }).join('');
    }
    $('btn-reset-standings').hidden = !isHost || !room.standings.length;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, 99999);
    var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  function invite() {
    var url = shareUrl();
    if (navigator.share) {
      navigator.share({ title: 'Corrida Benlit', text: shareText(), url: url }).catch(function () {});
    } else {
      copyText(url).then(function (ok) { toast(ok ? 'Link copiado. Cole no WhatsApp da galera.' : 'Copie o link exibido abaixo.', ok ? 'ok' : 'warn'); });
    }
  }

  // ---------------- resultados ----------------
  function showResults(d) {
    var res = d.results;
    var podium = [res[1], res[0], res[2]];
    var heights = ['p2', 'p1', 'p3'];
    $('podium').innerHTML = podium.map(function (r, i) {
      if (!r) return '<div class="step empty ' + heights[i] + '"></div>';
      return '<div class="step ' + heights[i] + (r.id === myId ? ' mine' : '') + '">' +
        '<span class="car-chip big" style="--c:' + COLORS[r.color] + '"></span>' +
        '<span class="pname">' + esc(r.name) + '</span>' +
        '<span class="ptime">' + (r.finished ? Game.fmtTime(r.time) : 'não terminou') + '</span>' +
        '<div class="block"><b>' + r.place + 'º</b></div></div>';
    }).join('');
    $('results-table').innerHTML = '<tr><th>Pos.</th><th>Piloto</th><th>Tempo</th><th>Melhor volta</th><th>Pontos</th></tr>' +
      res.map(function (r) {
        return '<tr class="' + (r.id === myId ? 'mine' : '') + '"><td>' + r.place + 'º</td><td><span class="car-chip" style="--c:' + COLORS[r.color] + '"></span>' + esc(r.name) + (r.left ? ' <small>(caiu)</small>' : '') + '</td><td>' +
          (r.finished ? Game.fmtTime(r.time) : r.laps + '/' + d.laps + ' voltas') + '</td><td>' + (r.bestLap ? Game.fmtTime(r.bestLap) : '—') + '</td><td>+' + r.points + '</td></tr>';
      }).join('');
    var mine = res.find(function (r) { return r.id === myId; });
    $('results-title').textContent = mine ? (mine.place === 1 && mine.finished ? 'Vitória! Você venceu a corrida' : 'Você terminou em ' + mine.place + 'º') : 'Resultado da corrida';
    var isHost = room && room.hostId === myId;
    $('btn-again').hidden = !isHost;
    $('results-wait').hidden = isHost;
    $('results').hidden = false;
  }
  function hideResults() { $('results').hidden = true; }

  // ---------------- utilidades de UI ----------------
  function toast(text, type) {
    var box = $('toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(function () { el.classList.add('out'); }, 2800);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3300);
  }

  function updateRotateHint() {
    var portrait = window.innerHeight > window.innerWidth;
    $('rotate-hint').hidden = !(isTouch && portrait && screen === 'game' && get(SS, 'cb_rot') !== '1');
  }

  function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    navigator.wakeLock.request('screen').then(function (w) {
      wakeLock = w; w.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; } }

  function toggleFullscreen() {
    var el = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    var req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    Promise.resolve(req.call(el)).then(function () {
      if (window.screen.orientation && window.screen.orientation.lock) window.screen.orientation.lock('landscape').catch(function () {});
    }).catch(function () {});
  }

  function refreshAudioButtons() {
    $('btn-sound').textContent = AudioSys.sfxOn ? '🔊' : '🔇';
    $('btn-sound').setAttribute('aria-label', AudioSys.sfxOn ? 'Desativar efeitos sonoros' : 'Ativar efeitos sonoros');
    $('btn-music').classList.toggle('off', !AudioSys.musicOn);
    $('btn-music').setAttribute('aria-label', AudioSys.musicOn ? 'Desativar música' : 'Ativar música');
  }

  // ---------------- eventos da interface ----------------
  function bind() {
    $('btn-create').addEventListener('click', createRoom);
    $('btn-join').addEventListener('click', function () { joinRoom($('code-input').value, $('btn-join')); });
    $('btn-join-invite').addEventListener('click', function () { joinRoom(inviteCode, $('btn-join-invite')); });
    $('code-input').addEventListener('input', function () { this.value = this.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
    $('code-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') joinRoom(this.value, $('btn-join')); });
    $('nick').addEventListener('keydown', function (e) { if (e.key === 'Enter') { if (inviteCode) joinRoom(inviteCode, $('btn-join-invite')); else createRoom(); } });

    $('btn-invite').addEventListener('click', invite);
    $('btn-copy').addEventListener('click', function () {
      copyText(shareUrl()).then(function (ok) { toast(ok ? 'Link copiado' : 'Copie o link exibido abaixo', ok ? 'ok' : 'warn'); });
    });
    $('btn-leave').addEventListener('click', function () { socket.emit('leaveRoom'); goHome(); });
    $('btn-start').addEventListener('click', function () {
      var action = this.dataset.action;
      AudioSys.unlock();
      if (action === 'watch') {
        showScreen('game');
        Game.prepareRace({ myId: myId, laps: room.laps, grid: {}, spectate: true });
        Game.go(1);
        $('spectate-banner').hidden = false;
        return;
      }
      if (action !== 'start') return;
      socket.emit('startRace', function (res) { if (!res.ok) toast(res.error, 'warn'); });
    });
    $('btn-reset-standings').addEventListener('click', function () {
      if (confirm('Zerar os pontos do campeonato desta sala?')) socket.emit('resetStandings');
    });

    $('btn-again').addEventListener('click', function () {
      socket.emit('startRace', function (res) { if (!res.ok) toast(res.error, 'warn'); });
    });
    $('btn-to-lobby').addEventListener('click', function () { hideResults(); showScreen('lobby'); renderLobby(); });
    $('btn-exit').addEventListener('click', function () {
      if (room && (room.state === 'racing' || room.state === 'countdown') && Game.me && !Game.finished) {
        if (!confirm('Sair da corrida agora? Você abandona esta corrida e volta ao lobby.')) return;
        socket.emit('leaveRoom');
        var code = room.code;
        // volta para a mesma sala como espectador da próxima corrida
        socket.emit('joinRoom', { playerId: myId, code: code, name: prefs.name, color: prefs.color }, function (res) {
          if (res.ok) { room = res.room; showScreen('lobby'); renderLobby(); } else goHome();
        });
        return;
      }
      hideResults(); showScreen('lobby'); renderLobby();
    });
    $('btn-sound').addEventListener('click', function () { AudioSys.unlock(); AudioSys.toggleSfx(); refreshAudioButtons(); });
    $('btn-music').addEventListener('click', function () { AudioSys.toggleMusic(); refreshAudioButtons(); });
    var canFs = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
    $('btn-fullscreen').hidden = !canFs || !isTouch;
    $('btn-fullscreen').addEventListener('click', toggleFullscreen);
    $('rotate-ok').addEventListener('click', function () { set(SS, 'cb_rot', '1'); updateRotateHint(); });
    window.addEventListener('resize', updateRotateHint);

    // bloqueia zoom por gesto e rolagem durante a corrida
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    document.addEventListener('touchmove', function (e) {
      if (screen === 'game' || e.touches.length > 1) e.preventDefault();
    }, { passive: false });
    var lastTouchEnd = 0;
    document.addEventListener('touchend', function (e) {
      var now = Date.now();
      if (screen === 'game' && now - lastTouchEnd < 350) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && screen === 'game' && Game.mode !== 'results' && Game.mode !== 'idle') requestWakeLock();
    });
  }

  // aviso de conexão instável: sem atualizações do servidor durante a corrida
  var unstable = false;
  setInterval(function () {
    var racing = screen === 'game' && (Game.mode === 'racing' || Game.mode === 'finished');
    var stalled = racing && socket.connected && Game.lastSnapAt && performance.now() - Game.lastSnapAt > 2500;
    if (stalled && !unstable) { unstable = true; setConn('Conexão instável… aguardando o servidor', 'warn'); }
    else if (!stalled && unstable) { unstable = false; if (socket.connected) setConn(null); }
  }, 500);

  // ping (latência)
  setInterval(function () {
    if (!socket.connected) return;
    var t = performance.now();
    socket.emit('pingCheck', function () {
      var ms = Math.round(performance.now() - t);
      $('hud-ping').textContent = ms + ' ms';
      $('hud-ping').className = 'ping ' + (ms < 120 ? 'good' : ms < 250 ? 'mid' : 'bad');
    });
  }, 3000);

  // ---------------- início ----------------
  Game.init({ canvas: $('game'), minimap: $('minimap') });
  Game.sendFn = function (s) { if (socket.connected) socket.volatile.emit('state', s); };
  Input.bindTouch($('touch-controls'));
  bind();
  refreshAudioButtons();
  renderHome();
  showScreen('home');

  // facilita testes automatizados
  window.__corrida = { socket: socket, get room() { return room; }, myId: myId };
})();
