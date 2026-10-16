/*
 * Corrida Benlit — motor do jogo (Canvas 2D, visão de cima estilo arcade).
 * - Física arcade do carro local (aceleração, freio/ré, direção, derrapagem, nitro)
 * - Colisão com barreiras, pneus e outros carros
 * - Interpolação suave dos carros dos outros jogadores (snapshots do servidor)
 * - Partículas, marcas de pneu, minimapa e HUD
 */
(function () {
  'use strict';
  var TL = window.TrackLib;
  var C = TL.CONFIG;
  var TRACK = TL.build();
  var DEFAULT_COLORS = ['#E8B04B', '#E2412F', '#2F7DE2', '#2FB35A', '#9B4BE2', '#F07AC0', '#21C7C7', '#F2F2F2'];
  var SEND_MS = 50;
  var INTERP_DELAY = 110;
  var PHYS_DT = 1 / 120;

  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpAngle(a, b, t) {
    var d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function fmtTime(ms) {
    if (ms == null || ms < 0) ms = 0;
    var m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, cs = Math.floor(ms / 10) % 100;
    return m + ':' + (s < 10 ? '0' : '') + s + '.' + (cs < 10 ? '0' : '') + cs;
  }

  var lionImg = new Image();
  lionImg.src = 'assets/lion.png';

  var Game = {
    TRACK: TRACK,
    colors: DEFAULT_COLORS.slice(),
    mode: 'idle',
    players: new Map(),
    me: null,
    myId: null,
    laps: 3,
    sendFn: null,
    onEvent: null,
    quality: 1,
    fmtTime: fmtTime
  };

  // ---------------- inicialização ----------------
  Game.init = function (opts) {
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.mini = opts.minimap;
    this.miniCtx = this.mini.getContext('2d');
    this.hud = {
      pos: $('hud-pos'), lap: $('hud-lap'), time: $('hud-time'), best: $('hud-best'),
      speed: $('hud-speed'), nitro: $('hud-nitro'), msg: $('hud-msg'), countdown: $('countdown')
    };
    this.particles = [];
    this.spriteCache = {};
    this.cam = { x: TRACK.xs[0], y: TRACK.ys[0], zoom: 1, shake: 0 };
    this.dpr = 1;
    this.resize();
    var self = this;
    window.addEventListener('resize', function () { self.resize(); });
    window.addEventListener('orientationchange', function () { setTimeout(function () { self.resize(); }, 250); });
    this.renderBackground();
    if (!lionImg.complete) lionImg.onload = function () { self.renderBackground(); };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { self.renderBackground(); });
    this.buildMinimapBase();
    this.loop = this.loop.bind(this);
  };

  Game.resize = function () {
    var r = this.canvas.getBoundingClientRect();
    var w = Math.max(1, r.width || window.innerWidth), h = Math.max(1, r.height || window.innerHeight);
    var dpr = Math.min(window.devicePixelRatio || 1, 2) * (this.quality < 1 ? 0.75 : 1);
    if (w * h * dpr * dpr > 3200000) dpr = Math.sqrt(3200000 / (w * h));
    this.dpr = Math.max(0.75, dpr);
    this.cssW = w; this.cssH = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    var portrait = h > w;
    this.baseZoom = clamp(portrait ? w / 560 : Math.min(w, h * 1.6) / 800, 0.5, 1.25);
  };

  // ---------------- pista pré-renderizada ----------------
  function tracePath(g, offset) {
    g.beginPath();
    for (var i = 0; i <= TRACK.count; i++) {
      var k = i % TRACK.count;
      var x = TRACK.xs[k] - TRACK.ty[k] * offset, y = TRACK.ys[k] + TRACK.tx[k] * offset;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  }

  Game.renderBackground = function () {
    var W = TRACK.width, H = TRACK.height;
    if (!this.bg) {
      this.bg = document.createElement('canvas');
      this.bg.width = W; this.bg.height = H;
    }
    var g = this.bg.getContext('2d');
    var rnd = mulberry32(2026);
    var i, k;

    // gramado com faixas de corte
    g.fillStyle = '#3d8549';
    g.fillRect(0, 0, W, H);
    g.save();
    g.translate(W / 2, H / 2); g.rotate(-0.42);
    for (i = -2200; i < 2200; i += 90) {
      g.fillStyle = (i / 90) % 2 === 0 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.035)';
      g.fillRect(i, -2200, 90, 4400);
    }
    g.restore();
    for (i = 0; i < 2600; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(20,60,25,0.25)' : 'rgba(140,200,110,0.18)';
      g.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 3, 2 + rnd() * 3);
    }

    g.lineJoin = 'round'; g.lineCap = 'round';
    // área de escape (dentro das barreiras)
    tracePath(g, 0); g.lineWidth = C.WALL_DIST * 2; g.strokeStyle = '#4a9555'; g.stroke();
    // zebras
    tracePath(g, 0); g.lineWidth = (C.HALF_WIDTH + 12) * 2; g.strokeStyle = '#f4f0e6'; g.setLineDash([]); g.stroke();
    tracePath(g, 0); g.strokeStyle = '#e2412f'; g.setLineDash([22, 22]); g.stroke(); g.setLineDash([]);
    // asfalto
    tracePath(g, 0); g.lineWidth = C.HALF_WIDTH * 2; g.strokeStyle = '#3a3f46'; g.stroke();
    // textura do asfalto
    for (k = 0; k < TRACK.count; k++) {
      for (i = 0; i < 7; i++) {
        var off = (rnd() * 2 - 1) * (C.HALF_WIDTH - 4), along = (rnd() - 0.5) * 10;
        var x = TRACK.xs[k] - TRACK.ty[k] * off + TRACK.tx[k] * along;
        var y = TRACK.ys[k] + TRACK.tx[k] * off + TRACK.ty[k] * along;
        g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.12)';
        g.fillRect(x, y, 2, 2);
      }
    }
    // linhas de borda e central
    g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.8)';
    tracePath(g, C.HALF_WIDTH - 9); g.stroke();
    tracePath(g, -(C.HALF_WIDTH - 9)); g.stroke();
    g.setLineDash([34, 40]); g.strokeStyle = 'rgba(255,255,255,0.28)';
    tracePath(g, 0); g.stroke(); g.setLineDash([]);

    // barreiras de pneus
    [C.WALL_DIST, -C.WALL_DIST].forEach(function (o) {
      tracePath(g, o); g.lineWidth = 16; g.strokeStyle = '#1d2228'; g.stroke();
      tracePath(g, o); g.lineWidth = 11; g.strokeStyle = '#f4f0e6'; g.stroke();
      tracePath(g, o); g.strokeStyle = '#e2412f'; g.setLineDash([16, 16]); g.stroke(); g.setLineDash([]);
    });

    // linha de largada quadriculada
    var a0 = Math.atan2(TRACK.ty[0], TRACK.tx[0]);
    g.save(); g.translate(TRACK.xs[0], TRACK.ys[0]); g.rotate(a0);
    var sq = 12.5, rows = Math.ceil((C.HALF_WIDTH * 2) / sq);
    for (var c = 0; c < 2; c++) for (var r = 0; r < rows; r++) {
      g.fillStyle = (r + c) % 2 ? '#111' : '#fff';
      g.fillRect(-sq + c * sq, -C.HALF_WIDTH + r * sq, sq, sq);
    }
    g.restore();
    // grid de largada
    for (i = 0; i < C.MAX_PLAYERS; i++) {
      var gs = TL.gridSlot(TRACK, i);
      g.save(); g.translate(gs.x, gs.y); g.rotate(gs.angle);
      g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(30, -18); g.lineTo(34, -18); g.lineTo(34, 18); g.lineTo(30, 18); g.stroke();
      g.restore();
    }

    // nome pintado e leão no gramado da reta principal
    var inner = innerSide(10);
    var bx = TRACK.xs[22] - TRACK.ty[22] * inner * (C.WALL_DIST + 115);
    var by = TRACK.ys[22] + TRACK.tx[22] * inner * (C.WALL_DIST + 115);
    if (clearOfTrack(bx, by, 200)) {
      g.save(); g.translate(bx, by); g.rotate(Math.atan2(TRACK.ty[22], TRACK.tx[22]));
      g.globalAlpha = 0.85;
      g.font = '84px "Russo One", Impact, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = 'rgba(244,240,230,0.9)';
      g.fillText('BENLIT', 40, 0);
      if (lionImg.complete && lionImg.naturalWidth) g.drawImage(lionImg, -260, -60, 120, 120);
      g.restore();
    }

    // arquibancadas
    this.stands = [];
    var self = this;
    [{ idx: 40, len: 460 }, { idx: Math.floor(TRACK.count * 0.64), len: 380 }].forEach(function (s) {
      var side = -innerSide(s.idx);
      var dist = C.WALL_DIST + 85;
      var cx = TRACK.xs[s.idx] - TRACK.ty[s.idx] * side * dist;
      var cy = TRACK.ys[s.idx] + TRACK.tx[s.idx] * side * dist;
      var ang = Math.atan2(TRACK.ty[s.idx], TRACK.tx[s.idx]);
      if (!clearOfTrack(cx, cy, 60) || cx < 60 || cy < 60 || cx > W - 60 || cy > H - 60) return;
      self.stands.push({ x: cx, y: cy, r: s.len / 2 });
      g.save(); g.translate(cx, cy); g.rotate(ang);
      if (side < 0) g.scale(1, -1);
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(-s.len / 2 + 8, -26, s.len, 90);
      g.fillStyle = '#5b6470'; g.fillRect(-s.len / 2, -35, s.len, 84);
      for (var row = 0; row < 5; row++) {
        g.fillStyle = row % 2 ? '#6c7682' : '#4f5863';
        g.fillRect(-s.len / 2, -30 + row * 14, s.len, 14);
        for (var px = -s.len / 2 + 6; px < s.len / 2 - 4; px += 9) {
          if (rnd() < 0.82) {
            g.fillStyle = ['#e2412f', '#f4f0e6', '#bc9d66', '#2f7de2', '#f2c14e', '#12263a'][Math.floor(rnd() * 6)];
            g.beginPath(); g.arc(px + rnd() * 3, -23 + row * 14, 3.3, 0, Math.PI * 2); g.fill();
          }
        }
      }
      g.fillStyle = '#12263a'; g.fillRect(-s.len / 2 - 6, 40, s.len + 12, 16);
      g.fillStyle = '#bc9d66'; g.fillRect(-s.len / 2 - 6, 40, s.len + 12, 5);
      g.restore();
    });

    // árvores
    var trees = 0;
    for (i = 0; i < 1400 && trees < 170; i++) {
      var tx = 30 + rnd() * (W - 60), ty = 30 + rnd() * (H - 60), tr = 22 + rnd() * 22;
      if (!clearOfTrack(tx, ty, tr + 28)) continue;
      var nearStand = this.stands.some(function (st) { return Math.hypot(st.x - tx, st.y - ty) < st.r + tr + 50; });
      if (nearStand) continue;
      if (Math.hypot(tx - bx, ty - by) < 260) continue;
      trees++;
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath(); g.arc(tx + 9, ty + 11, tr, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#245c30'; g.beginPath(); g.arc(tx, ty, tr, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#2f7a3d'; g.beginPath(); g.arc(tx - tr * 0.18, ty - tr * 0.18, tr * 0.72, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(160,220,120,0.35)'; g.beginPath(); g.arc(tx - tr * 0.35, ty - tr * 0.35, tr * 0.32, 0, Math.PI * 2); g.fill();
    }

    // pilhas de pneus (obstáculos)
    TRACK.obstacles.forEach(function (o) {
      g.fillStyle = 'rgba(0,0,0,0.3)'; g.beginPath(); g.arc(o.x + 4, o.y + 5, o.r + 2, 0, Math.PI * 2); g.fill();
      [[-6, -5], [6, -5], [0, 6]].forEach(function (p) {
        g.fillStyle = '#16191d'; g.beginPath(); g.arc(o.x + p[0], o.y + p[1], 9, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#e2412f'; g.lineWidth = 2.5; g.beginPath(); g.arc(o.x + p[0], o.y + p[1], 5.5, 0, Math.PI * 2); g.stroke();
      });
    });
  };

  // lado "de dentro" da pista (em relação ao centro geométrico), retorna +1/-1 na normal direita
  function innerSide(idx) {
    var cx = 0, cy = 0;
    for (var i = 0; i < TRACK.count; i += 10) { cx += TRACK.xs[i]; cy += TRACK.ys[i]; }
    cx /= Math.ceil(TRACK.count / 10); cy /= Math.ceil(TRACK.count / 10);
    var nx = -TRACK.ty[idx], ny = TRACK.tx[idx];
    return ((cx - TRACK.xs[idx]) * nx + (cy - TRACK.ys[idx]) * ny) > 0 ? 1 : -1;
  }
  function clearOfTrack(x, y, r) {
    return TL.nearest(TRACK, x, y).dist > C.WALL_DIST + r;
  }

  Game.buildMinimapBase = function () {
    var w = 150, h = Math.round(150 * TRACK.height / TRACK.width);
    this.miniW = w; this.miniH = h;
    var d = 2;
    this.mini.width = w * d; this.mini.height = h * d;
    var base = document.createElement('canvas');
    base.width = w * d; base.height = h * d;
    var g = base.getContext('2d');
    var s = (w * d) / TRACK.width;
    g.scale(s, s);
    g.lineJoin = 'round';
    tracePath(g, 0); g.lineWidth = C.HALF_WIDTH * 2.6; g.strokeStyle = 'rgba(244,240,230,0.9)'; g.stroke();
    tracePath(g, 0); g.lineWidth = C.HALF_WIDTH * 1.5; g.strokeStyle = 'rgba(18,38,58,0.9)'; g.stroke();
    var a = Math.atan2(TRACK.ty[0], TRACK.tx[0]);
    g.save(); g.translate(TRACK.xs[0], TRACK.ys[0]); g.rotate(a);
    g.fillStyle = '#bc9d66'; g.fillRect(-12, -C.HALF_WIDTH * 1.4, 24, C.HALF_WIDTH * 2.8);
    g.restore();
    this.miniBase = base; this.miniScale = s;
  };

  // ---------------- sprites dos carros ----------------
  Game.carSprite = function (color) {
    if (this.spriteCache[color]) return this.spriteCache[color];
    var L = C.CAR_LENGTH, Wd = C.CAR_WIDTH, sc = 3, pad = 10;
    var cv = document.createElement('canvas');
    cv.width = (L + pad * 2) * sc; cv.height = (Wd + pad * 2) * sc;
    var g = cv.getContext('2d');
    g.scale(sc, sc); g.translate(L / 2 + pad, Wd / 2 + pad);
    function rr(x, y, w, h, r) {
      g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
      g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h);
      g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
    }
    // pneus
    g.fillStyle = '#0d0f12';
    [[-L * 0.32, -Wd / 2 - 2.5], [L * 0.27, -Wd / 2 - 2.5], [-L * 0.32, Wd / 2 - 3.5], [L * 0.27, Wd / 2 - 3.5]].forEach(function (p) {
      rr(p[0] - 6, p[1], 12, 6, 2); g.fill();
    });
    // aerofólio traseiro
    g.fillStyle = '#1b232c'; rr(-L / 2 - 3, -Wd / 2 - 1, 6, Wd + 2, 2); g.fill();
    // carroceria
    g.fillStyle = color; rr(-L / 2 + 1, -Wd / 2 + 1, L - 2, Wd - 2, 8); g.fill();
    // luz/brilho
    g.fillStyle = 'rgba(255,255,255,0.22)'; rr(-L / 2 + 4, -Wd / 2 + 2.5, L - 10, Wd / 2 - 3, 5); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.18)'; rr(-L / 2 + 4, 1, L - 10, Wd / 2 - 3, 5); g.fill();
    // faixa dourada Benlit
    g.fillStyle = '#bc9d66'; g.fillRect(-L / 2 + 2, -2, L - 4, 4);
    // cockpit
    g.fillStyle = '#122030'; rr(-7, -Wd / 2 + 4.5, 16, Wd - 9, 5); g.fill();
    g.fillStyle = 'rgba(150,200,235,0.7)'; rr(5, -Wd / 2 + 5.5, 4, Wd - 11, 2); g.fill();
    // faróis
    g.fillStyle = '#fff6c8'; g.fillRect(L / 2 - 4, -Wd / 2 + 3, 3, 4); g.fillRect(L / 2 - 4, Wd / 2 - 7, 3, 4);
    cv._ox = (L / 2 + pad); cv._oy = (Wd / 2 + pad); cv._sc = sc;
    this.spriteCache[color] = cv;
    return cv;
  };

  Game.drawCar = function (g, x, y, a, color) {
    var sp = this.carSprite(color);
    g.save(); g.translate(x, y);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.ellipse(4, 6, C.CAR_LENGTH * 0.55, C.CAR_WIDTH * 0.62, a, 0, Math.PI * 2); g.fill();
    g.rotate(a);
    g.drawImage(sp, -sp._ox, -sp._oy, sp.width / sp._sc, sp.height / sp._sc);
    g.restore();
  };

  // ---------------- ciclo de corrida ----------------
  Game.setRoomPlayers = function (list, colors) {
    if (colors) this.colors = colors;
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var p = list[i]; seen[p.id] = 1;
      var cur = this.players.get(p.id);
      if (!cur) { cur = { id: p.id, buf: [], x: 0, y: 0, a: 0, visible: false }; this.players.set(p.id, cur); }
      cur.name = p.name; cur.color = this.colors[p.color] || '#ccc'; cur.connected = p.connected;
    }
    var self = this;
    this.players.forEach(function (v, k) { if (!seen[k]) self.players.delete(k); });
  };

  /**
   * opts: { myId, laps, grid, spectate, countdownMs, me (posição p/ reconexão) }
   */
  Game.prepareRace = function (opts) {
    this.myId = opts.myId;
    this.laps = opts.laps;
    this.spectate = !!opts.spectate;
    this.renderBackground(); // apaga marcas de pneu da corrida anterior
    this.particles.length = 0;
    this.finished = false;
    this.lapsDone = 0;
    this.position = 1;
    this.racerCount = Object.keys(opts.grid || {}).length || 1;
    this.bestLap = 0;
    this.raceStart = 0;
    this.lastSend = 0;
    this.wrongWayTime = 0;
    this.lastSnapAt = 0;
    this.finishedTime = 0;
    var self = this;
    this.players.forEach(function (p) {
      p.buf.length = 0; p.visible = false; p.pos = 0; p.finished = false;
      var g = opts.grid && opts.grid[p.id];
      if (g) { p.x = g.x; p.y = g.y; p.a = g.angle; p.visible = true; p.buf.push({ t: performance.now(), x: g.x, y: g.y, a: g.angle, s: 0, f: 0 }); }
    });
    var start = opts.me || (opts.grid && opts.grid[this.myId]);
    if (start && !this.spectate) {
      this.me = {
        x: start.x, y: start.y, a: start.angle !== undefined ? start.angle : start.a, vx: 0, vy: 0, speed: 0,
        steer: 0, nitro: 0.35, idx: TL.nearest(TRACK, start.x, start.y).index, drift: 0, onGrass: false, nitroOn: false
      };
      this.cam.x = this.me.x; this.cam.y = this.me.y;
    } else {
      this.me = null;
      this.spectate = true;
    }
    this.mode = opts.countdownMs ? 'countdown' : 'racing';
    this.countdownEnd = performance.now() + (opts.countdownMs || 0);
    this.lastCount = null;
    this.hud.best.textContent = '';
    this.updateHud(true);
    this.start();
  };

  Game.go = function (elapsedMs) {
    this.mode = this.finished ? 'finished' : 'racing';
    this.raceStart = performance.now() - (elapsedMs || 0);
    if (!elapsedMs) {
      this.showCountdown('VAI!', 'go');
      window.AudioSys && AudioSys.beep(true);
    }
  };

  Game.showCountdown = function (txt, cls) {
    var el = this.hud.countdown;
    el.textContent = txt;
    el.className = 'countdown show ' + (cls || '');
    clearTimeout(this._cdTimer);
    var self = this;
    this._cdTimer = setTimeout(function () { el.className = 'countdown'; }, cls === 'go' ? 800 : 900);
  };

  Game.message = function (txt, ms, cls) {
    var el = this.hud.msg;
    el.textContent = txt;
    el.className = 'hud-msg show ' + (cls || '');
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(function () { el.className = 'hud-msg'; }, ms || 1800);
  };

  Game.start = function () {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.acc = 0;
    this.frameTimes = [];
    requestAnimationFrame(this.loop);
  };
  Game.stop = function () {
    this.running = false;
    this.mode = 'idle';
    window.AudioSys && AudioSys.silenceCar();
  };

  Game.onSnapshot = function (snap) {
    var t = performance.now();
    this.lastSnapAt = t;
    this.racerCount = snap.p.length;
    for (var i = 0; i < snap.p.length; i++) {
      var e = snap.p[i];
      var p = this.players.get(e[0]);
      if (!p) continue;
      p.pos = e[6]; p.lapsDone = e[7]; p.finished = !!e[8]; p.flags = e[5]; p.visible = true;
      if (e[0] === this.myId) {
        this.position = e[6]; this.lapsDone = e[7];
        if (e[8] && !this.finished) {
          this.finished = true;
          if (this.mode === 'racing') this.mode = 'finished';
        }
        continue;
      }
      p.buf.push({ t: t, x: e[1], y: e[2], a: e[3], s: e[4], f: e[5] });
      if (p.buf.length > 12) p.buf.shift();
    }
  };

  Game.setFinished = function (place, time) {
    this.finished = true;
    this.finishedTime = time;
    if (this.mode === 'racing') this.mode = 'finished';
    this.message('Você terminou em ' + place + 'º!', 3000, 'gold');
  };

  Game.onCorrection = function (c) {
    if (!this.me) return;
    this.me.x = c.x; this.me.y = c.y; this.me.a = c.a; this.me.vx = 0; this.me.vy = 0;
    this.me.idx = TL.nearest(TRACK, c.x, c.y).index;
  };

  Game.onLap = function (d) {
    this.lapsDone = d.lapsDone;
    this.bestLap = d.bestLap;
    this.hud.best.textContent = 'Melhor volta ' + fmtTime(d.bestLap);
    if (d.lapsDone < this.laps) {
      this.message(d.lapsDone === this.laps - 1 ? 'Última volta!' : 'Volta ' + fmtTime(d.lapTime), 1800, d.lapsDone === this.laps - 1 ? 'gold' : '');
    }
  };

  // ---------------- física ----------------
  Game.stepCar = function (car, inp, dt) {
    var fx = Math.cos(car.a), fy = Math.sin(car.a), rx = -fy, ry = fx;
    var vf = car.vx * fx + car.vy * fy;
    var vl = car.vx * rx + car.vy * ry;
    var near = TL.nearest(TRACK, car.x, car.y, car.idx);
    car.idx = near.index;
    car.onGrass = near.dist > C.HALF_WIDTH + 6;

    var nitroOn = inp.nitro && inp.up && car.nitro > 0.01 && !car.onGrass && vf > 0;
    car.nitroOn = nitroOn;
    if (nitroOn) car.nitro = Math.max(0, car.nitro - 0.42 * dt);
    var top = car.onGrass ? 230 : (nitroOn ? C.NITRO_SPEED : C.MAX_SPEED);

    if (inp.up) {
      if (vf < 0) vf += 1100 * dt;
      else if (vf < top) vf = Math.min(top, vf + (nitroOn ? 900 : 560 * (1 - 0.6 * vf / top)) * dt);
    }
    if (inp.down) {
      if (vf > 15) vf -= 1050 * dt;
      else vf = Math.max(-210, vf - 420 * dt);
    }
    if (!inp.up && !inp.down) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 120 * dt);
    if (vf > top) vf -= Math.min(vf - top, (car.onGrass ? 650 : 260) * dt);
    if (inp.handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 230 * dt);

    var steerIn = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    car.steer += (steerIn - car.steer) * Math.min(1, dt * 11);
    var sp = Math.abs(vf);
    var turn = Math.min(1, sp / 110) * (1 - 0.36 * Math.min(1, sp / C.NITRO_SPEED));
    var rate = 3.15 * (inp.handbrake ? 1.4 : 1);
    car.a += car.steer * rate * turn * (vf >= 0 ? 1 : -1) * dt;
    if (car.a > Math.PI) car.a -= Math.PI * 2; else if (car.a < -Math.PI) car.a += Math.PI * 2;

    var grip = car.onGrass ? 4.5 : 10;
    if (inp.handbrake) grip = 1.5;
    else if (Math.abs(car.steer) > 0.6 && sp > 430) grip *= 0.42;
    vl -= vl * Math.min(1, grip * dt);

    car.vx = fx * vf + rx * vl; car.vy = fy * vf + ry * vl;
    car.speed = vf;
    car.drift = Math.abs(vl);
    if (car.drift > 70 && !car.onGrass && sp > 200) car.nitro = Math.min(1, car.nitro + 0.2 * dt);
    car.nitro = Math.min(1, car.nitro + 0.03 * dt);

    car.x += car.vx * dt; car.y += car.vy * dt;
    this.collide(car);
  };

  Game.bounce = function (car, nx, ny, restitution, minDist, ox, oy) {
    car.x = ox + nx * minDist; car.y = oy + ny * minDist;
    var vn = car.vx * nx + car.vy * ny;
    if (vn < 0) {
      car.vx -= nx * vn * (1 + restitution); car.vy -= ny * vn * (1 + restitution);
      car.vx *= 0.88; car.vy *= 0.88;
      return -vn;
    }
    return 0;
  };

  Game.collide = function (car) {
    var impact = 0, ix = car.x, iy = car.y;
    // barreiras
    var n = TL.nearest(TRACK, car.x, car.y, car.idx);
    var limit = C.WALL_DIST - C.CAR_RADIUS + 2;
    if (n.dist > limit) {
      var nx = (n.x - car.x) / n.dist, ny = (n.y - car.y) / n.dist; // aponta para dentro
      var v = this.bounce(car, nx, ny, 0.35, -limit, n.x, n.y);
      // bounce posiciona em n + nx*(-limit): de volta para dentro do limite
      if (v > impact) { impact = v; ix = car.x - nx * 18; iy = car.y - ny * 18; }
    }
    // pneus
    for (var i = 0; i < TRACK.obstacles.length; i++) {
      var o = TRACK.obstacles[i], dx = car.x - o.x, dy = car.y - o.y, d = Math.hypot(dx, dy), md = o.r + C.CAR_RADIUS * 0.85;
      if (d < md && d > 0.01) {
        var vv = this.bounce(car, dx / d, dy / d, 0.45, md, o.x, o.y);
        if (vv > impact) { impact = vv; ix = o.x + dx / d * o.r; iy = o.y + dy / d * o.r; }
      }
    }
    // outros carros
    var self = this;
    this.players.forEach(function (p) {
      if (p.id === self.myId || !p.visible || !p.rendered) return;
      var dx2 = car.x - p.rx, dy2 = car.y - p.ry, d2 = Math.hypot(dx2, dy2), md2 = C.CAR_RADIUS * 1.8;
      if (d2 < md2 && d2 > 0.01) {
        var v2 = self.bounce(car, dx2 / d2, dy2 / d2, 0.5, md2, p.rx, p.ry);
        if (v2 > impact) { impact = v2; ix = (car.x + p.rx) / 2; iy = (car.y + p.ry) / 2; }
      }
    });
    if (impact > 60) this.impact(impact, ix, iy);
  };

  Game.impact = function (v, x, y) {
    var now = performance.now();
    if (now - (this._lastImpact || 0) < 120) return;
    this._lastImpact = now;
    var strength = clamp(v / 500, 0.1, 1);
    this.cam.shake = Math.max(this.cam.shake, strength * 9);
    for (var i = 0; i < 6 + strength * 14; i++) {
      this.spawn(x, y, (Math.random() - 0.5) * 420, (Math.random() - 0.5) * 420, 0.25 + Math.random() * 0.3, 2 + Math.random() * 2, i % 3 ? '#ffd27a' : '#fff', 'spark');
    }
    window.AudioSys && AudioSys.crash(strength);
    if (navigator.vibrate && strength > 0.4) { try { navigator.vibrate(30); } catch (e) {} }
  };

  // ---------------- partículas ----------------
  Game.spawn = function (x, y, vx, vy, life, size, color, type) {
    var max = this.quality < 1 ? 140 : 320;
    if (this.particles.length >= max) this.particles.shift();
    this.particles.push({ x: x, y: y, vx: vx, vy: vy, life: life, max: life, size: size, color: color, type: type });
  };

  Game.carEffects = function (x, y, a, speed, flags, isMe, dt, key) {
    var drifting = flags & 1, nitro = flags & 2, grass = flags & 4;
    var bx = x - Math.cos(a) * 20, by = y - Math.sin(a) * 20;
    var px = -Math.sin(a) * 10, py = Math.cos(a) * 10;
    var chance = this.quality < 1 ? 0.4 : 1;
    if (drifting && Math.abs(speed) > 120) {
      if (Math.random() < 0.7 * chance) this.spawn(bx + px * (Math.random() > 0.5 ? 1 : -1), by + py, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, 0.7 + Math.random() * 0.5, 7 + Math.random() * 6, 'rgba(225,225,225,', 'smoke');
      this.skid(key, bx + px, by + py, bx - px, by - py);
    } else this.skidLast && (this.skidLast[key] = null);
    if (grass && Math.abs(speed) > 70 && Math.random() < 0.6 * chance) {
      this.spawn(bx, by, (Math.random() - 0.5) * 60 - Math.cos(a) * 40, (Math.random() - 0.5) * 60 - Math.sin(a) * 40, 0.6, 6 + Math.random() * 5, 'rgba(150,115,70,', 'smoke');
    }
    if (nitro) {
      for (var i = 0; i < 2; i++) this.spawn(bx - Math.cos(a) * 6, by - Math.sin(a) * 6, -Math.cos(a) * 180 + (Math.random() - 0.5) * 60, -Math.sin(a) * 180 + (Math.random() - 0.5) * 60, 0.18 + Math.random() * 0.1, 5 + Math.random() * 3, i ? '#ffb347' : '#7fd3ff', 'flame');
    }
    if (!drifting && !grass && Math.abs(speed) > 480 && Math.random() < 0.15 * chance) {
      this.spawn(bx, by, -Math.cos(a) * 60, -Math.sin(a) * 60, 0.4, 4, 'rgba(200,200,200,', 'smoke');
    }
  };

  Game.skid = function (key, x1, y1, x2, y2) {
    this.skidLast = this.skidLast || {};
    var last = this.skidLast[key];
    if (last) {
      var g = this.bg.getContext('2d');
      g.strokeStyle = 'rgba(15,15,18,0.28)'; g.lineWidth = 4; g.lineCap = 'round';
      g.beginPath(); g.moveTo(last[0], last[1]); g.lineTo(x1, y1); g.moveTo(last[2], last[3]); g.lineTo(x2, y2); g.stroke();
    }
    this.skidLast[key] = [x1, y1, x2, y2];
  };

  Game.updateParticles = function (dt) {
    var ps = this.particles;
    for (var i = ps.length - 1; i >= 0; i--) {
      var p = ps[i];
      p.life -= dt;
      if (p.life <= 0) { ps.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      var damp = p.type === 'spark' ? 3 : 1.6;
      p.vx -= p.vx * Math.min(1, damp * dt); p.vy -= p.vy * Math.min(1, damp * dt);
      if (p.type === 'smoke') p.size += 14 * dt;
    }
  };

  Game.drawParticles = function (g) {
    var ps = this.particles;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i], k = p.life / p.max;
      if (p.type === 'smoke') {
        g.fillStyle = p.color + (0.35 * k).toFixed(3) + ')';
      } else { g.globalAlpha = k; g.fillStyle = p.color; }
      g.beginPath(); g.arc(p.x, p.y, p.size * (p.type === 'smoke' ? 1 : k + 0.3), 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    }
  };

  // ---------------- loop principal ----------------
  Game.loop = function (ts) {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    var now = performance.now();
    var frame = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.trackPerformance(frame);

    var inp = window.Input ? Input.state : {};
    var frozen = this.mode === 'countdown' || this.mode === 'results' || this.mode === 'idle';
    var none = { up: false, down: false, left: false, right: false, handbrake: false, nitro: false };

    // contagem regressiva visual
    if (this.mode === 'countdown') {
      var left = Math.ceil((this.countdownEnd - now) / 1000);
      if (left > 0 && left <= 3 && left !== this.lastCount) {
        this.lastCount = left;
        this.showCountdown(String(left), '');
        window.AudioSys && AudioSys.beep(false);
      }
    }

    // física do meu carro
    if (this.me) {
      this.acc += frame;
      var steps = 0;
      while (this.acc >= PHYS_DT && steps < 12) {
        this.stepCar(this.me, frozen ? none : inp, PHYS_DT);
        this.acc -= PHYS_DT; steps++;
      }
      if (steps >= 12) this.acc = 0;
      var me = this.me;
      var flags = (me.drift > 85 && Math.abs(me.speed) > 140 ? 1 : 0) | (me.nitroOn ? 2 : 0) | (me.onGrass ? 4 : 0);
      me.flags = flags;
      if (!frozen) this.carEffects(me.x, me.y, me.a, me.speed, flags, true, frame, 'me');

      // contramão
      var tIdx = me.idx;
      var dot = me.vx * TRACK.tx[tIdx] + me.vy * TRACK.ty[tIdx];
      if (dot < -120 && this.mode === 'racing') { this.wrongWayTime += frame; } else this.wrongWayTime = 0;
      if (this.wrongWayTime > 1.2) { this.message('Contramão!', 900, 'warn'); this.wrongWayTime = 0.4; }

      // envia estado ao servidor
      if ((this.mode === 'racing' || this.mode === 'finished') && now - this.lastSend >= SEND_MS && this.sendFn) {
        this.lastSend = now;
        this.sendFn({ x: Math.round(me.x * 10) / 10, y: Math.round(me.y * 10) / 10, a: Math.round(me.a * 1000) / 1000, s: Math.round(me.speed), f: flags });
      }
      if (window.AudioSys) {
        AudioSys.setEngine(Math.abs(me.speed) / C.NITRO_SPEED, frozen ? 0 : (inp.up ? 1 : 0), me.nitroOn);
        AudioSys.setSkid(!frozen && (flags & 1) ? clamp((me.drift - 60) / 200, 0, 1) : 0);
      }
    }

    // interpolação dos outros carros
    var renderT = now - INTERP_DELAY;
    var self = this;
    this.players.forEach(function (p) {
      if (p.id === self.myId) return;
      var b = p.buf;
      if (!b.length) { p.rendered = false; return; }
      var s0 = b[0], s1 = b[b.length - 1];
      for (var i = 0; i < b.length - 1; i++) {
        if (b[i].t <= renderT && b[i + 1].t >= renderT) { s0 = b[i]; s1 = b[i + 1]; break; }
      }
      if (renderT >= s1.t) { s0 = s1; }
      var u = s1.t > s0.t ? clamp((renderT - s0.t) / (s1.t - s0.t), 0, 1) : 1;
      p.rx = lerp(s0.x, s1.x, u); p.ry = lerp(s0.y, s1.y, u); p.ra = lerpAngle(s0.a, s1.a, u);
      p.rs = lerp(s0.s, s1.s, u); p.rf = s1.f;
      p.rendered = true;
      if (!frozen) self.carEffects(p.rx, p.ry, p.ra, p.rs, p.rf || 0, false, frame, p.id);
    });

    this.updateParticles(frame);
    this.updateCamera(frame);
    this.render(now);
    if (!this._hudT || now - this._hudT > 80) { this._hudT = now; this.updateHud(false); }
  };

  Game.trackPerformance = function (frame) {
    this.frameTimes.push(frame);
    if (this.frameTimes.length >= 120) {
      var avg = this.frameTimes.reduce(function (a, b) { return a + b; }, 0) / this.frameTimes.length;
      this.frameTimes.length = 0;
      if (avg > 0.026 && this.quality === 1) { this.quality = 0.5; this.resize(); }
    }
  };

  Game.updateCamera = function (dt) {
    var tx, ty, speed = 0;
    if (this.me) {
      speed = Math.abs(this.me.speed);
      tx = this.me.x + this.me.vx * 0.28; ty = this.me.y + this.me.vy * 0.28;
    } else {
      // espectador: segue o líder
      var leader = null;
      this.players.forEach(function (p) { if (p.rendered && (!leader || (p.pos && p.pos < leader.pos))) leader = p; });
      if (leader) { tx = leader.rx; ty = leader.ry; speed = Math.abs(leader.rs || 0); }
      else { tx = this.cam.x; ty = this.cam.y; }
    }
    var k = 1 - Math.pow(0.0015, dt);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    var targetZoom = this.baseZoom * (1 - 0.18 * Math.min(1, speed / C.NITRO_SPEED));
    this.cam.zoom += (targetZoom - this.cam.zoom) * Math.min(1, dt * 2.5);
    this.cam.shake = Math.max(0, this.cam.shake - dt * 30);
  };

  Game.render = function (now) {
    var g = this.ctx, dpr = this.dpr, z = this.cam.zoom * dpr;
    var W = this.canvas.width, H = this.canvas.height;
    var sx = (Math.random() - 0.5) * this.cam.shake, sy = (Math.random() - 0.5) * this.cam.shake;
    var camX = this.cam.x + sx, camY = this.cam.y + sy;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#3d8549';
    g.fillRect(0, 0, W, H);

    // recorte visível da pista pré-renderizada
    var vw = W / z, vh = H / z;
    var x0 = camX - vw / 2, y0 = camY - vh / 2;
    var sx0 = Math.max(0, x0), sy0 = Math.max(0, y0);
    var sx1 = Math.min(TRACK.width, x0 + vw), sy1 = Math.min(TRACK.height, y0 + vh);
    if (sx1 > sx0 && sy1 > sy0) {
      g.imageSmoothingEnabled = true;
      g.drawImage(this.bg, sx0, sy0, sx1 - sx0, sy1 - sy0, (sx0 - x0) * z, (sy0 - y0) * z, (sx1 - sx0) * z, (sy1 - sy0) * z);
    }

    g.setTransform(z, 0, 0, z, -x0 * z, -y0 * z);
    this.drawParticles(g);

    var self = this, labels = [];
    this.players.forEach(function (p) {
      if (p.id === self.myId || !p.rendered) return;
      g.globalAlpha = p.connected === false || (p.rf & 8) ? 0.45 : 1;
      self.drawCar(g, p.rx, p.ry, p.ra, p.color);
      g.globalAlpha = 1;
      labels.push({ x: p.rx, y: p.ry, name: p.name, color: p.color, me: false, pos: p.pos });
    });
    if (this.me) {
      var mp = this.players.get(this.myId);
      var color = mp ? mp.color : '#E8B04B';
      this.drawCar(g, this.me.x, this.me.y, this.me.a, color);
      labels.push({ x: this.me.x, y: this.me.y, name: mp ? mp.name : 'Você', color: color, me: true });
    }

    // nomes em coordenadas de tela (tamanho fixo)
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.font = '600 13px "Barlow Condensed", "Arial Narrow", sans-serif';
    for (var i = 0; i < labels.length; i++) {
      var l = labels[i];
      var px = (l.x - x0) * this.cam.zoom, py = (l.y - y0) * this.cam.zoom - 26 * this.cam.zoom - 8;
      var txt = l.me ? '▼ ' + l.name : l.name;
      var w = g.measureText(txt).width + 12;
      g.fillStyle = l.me ? 'rgba(188,157,102,0.95)' : 'rgba(18,38,58,0.78)';
      roundRect(g, px - w / 2, py - 17, w, 18, 5); g.fill();
      g.fillStyle = l.me ? '#12263a' : '#f4f0e6';
      g.fillText(txt, px, py);
    }

    this.renderMinimap();
  };

  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  Game.renderMinimap = function () {
    this._miniFrame = (this._miniFrame || 0) + 1;
    if (this._miniFrame % 3) return;
    var g = this.miniCtx, s = this.miniScale;
    g.clearRect(0, 0, this.mini.width, this.mini.height);
    g.drawImage(this.miniBase, 0, 0);
    var self = this;
    this.players.forEach(function (p) {
      if (p.id === self.myId || !p.rendered) return;
      g.fillStyle = p.color; g.beginPath(); g.arc(p.rx * s, p.ry * s, 4.5, 0, Math.PI * 2); g.fill();
    });
    if (this.me) {
      var mp = this.players.get(this.myId);
      g.fillStyle = '#fff'; g.beginPath(); g.arc(this.me.x * s, this.me.y * s, 7, 0, Math.PI * 2); g.fill();
      g.fillStyle = mp ? mp.color : '#E8B04B'; g.beginPath(); g.arc(this.me.x * s, this.me.y * s, 5, 0, Math.PI * 2); g.fill();
    }
  };

  Game.updateHud = function () {
    var h = this.hud;
    var total = Math.max(1, this.racerCount || 1);
    h.pos.innerHTML = (this.position || 1) + 'º<small>/' + total + '</small>';
    h.lap.textContent = Math.min(this.laps, (this.lapsDone || 0) + 1) + '/' + this.laps;
    var elapsed = this.raceStart ? performance.now() - this.raceStart : 0;
    if (this.finishedTime) elapsed = this.finishedTime;
    h.time.textContent = fmtTime(this.mode === 'countdown' ? 0 : elapsed);
    if (this.me) {
      h.speed.textContent = Math.round(Math.abs(this.me.speed) * 0.36);
      h.nitro.style.transform = 'scaleX(' + this.me.nitro.toFixed(3) + ')';
      h.nitro.parentNode.classList.toggle('active', !!this.me.nitroOn);
    } else {
      h.speed.textContent = '—';
    }
  };

  window.Game = Game;
})();
