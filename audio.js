/*
 * Corrida Benlit — áudio 100% sintetizado com Web Audio API (sem arquivos de som).
 * No iPhone o áudio só é liberado após um toque do usuário: chamamos unlock()
 * nos botões "Criar sala"/"Entrar" e no primeiro toque na tela.
 * Obs.: com a chave de silencioso do iPhone ligada, o Safari pode silenciar o jogo.
 */
(function () {
  'use strict';
  var AC = window.AudioContext || window.webkitAudioContext;

  function load(key, def) {
    try { var v = localStorage.getItem(key); return v === null ? def : v === '1'; } catch (e) { return def; }
  }
  function save(key, v) { try { localStorage.setItem(key, v ? '1' : '0'); } catch (e) {} }

  var A = {
    ctx: null,
    sfxOn: load('cb_sfx', true),
    musicOn: load('cb_music', false),
    engine: null,
    skid: null
  };

  A.unlock = function () {
    if (!AC) return;
    if (!this.ctx) {
      try { this.ctx = new AC(); } catch (e) { return; }
      var ctx = this.ctx;
      this.master = ctx.createGain(); this.master.gain.value = 0.8; this.master.connect(ctx.destination);
      this.sfx = ctx.createGain(); this.sfx.gain.value = this.sfxOn ? 1 : 0; this.sfx.connect(this.master);
      this.music = ctx.createGain(); this.music.gain.value = this.musicOn ? 0.22 : 0; this.music.connect(this.master);
      // ruído branco reutilizável
      var len = ctx.sampleRate * 1.5;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = this.noise.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.buildEngine();
      this.buildSkid();
      if (this.musicOn) this.startMusic();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  };

  A.buildEngine = function () {
    var ctx = this.ctx;
    var o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o1.type = 'sawtooth'; o2.type = 'square';
    o1.frequency.value = 55; o2.frequency.value = 27.5;
    f.type = 'lowpass'; f.frequency.value = 600; f.Q.value = 3;
    var g2 = ctx.createGain(); g2.gain.value = 0.35;
    o1.connect(f); o2.connect(g2); g2.connect(f); f.connect(g); g.connect(this.sfx);
    g.gain.value = 0;
    o1.start(); o2.start();
    this.engine = { o1: o1, o2: o2, f: f, g: g };
  };

  A.buildSkid = function () {
    var ctx = this.ctx;
    var src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    var f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 2.5;
    var g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(this.sfx);
    src.start();
    this.skid = { src: src, f: f, g: g };
  };

  /** ratio: 0..1 (velocidade), throttle: 0/1, nitro: bool */
  A.setEngine = function (ratio, throttle, nitro) {
    if (!this.engine) return;
    var t = this.ctx.currentTime, e = this.engine;
    // simula marchas: a rotação sobe e "cai" a cada troca
    var gears = 5, gr = Math.min(0.999, ratio) * gears, gearPos = gr - Math.floor(gr);
    var rpm = 0.25 + 0.75 * (ratio < 0.02 ? 0 : gearPos * 0.7 + 0.3 * ratio);
    var freq = 48 + rpm * 120 + (nitro ? 25 : 0);
    e.o1.frequency.setTargetAtTime(freq, t, 0.05);
    e.o2.frequency.setTargetAtTime(freq / 2, t, 0.05);
    e.f.frequency.setTargetAtTime(400 + rpm * 1400 + throttle * 500, t, 0.08);
    var vol = ratio === 0 && throttle === 0 ? 0.05 : 0.07 + throttle * 0.07 + ratio * 0.05;
    e.g.gain.setTargetAtTime(vol, t, 0.08);
  };
  A.setSkid = function (amount) {
    if (!this.skid) return;
    this.skid.g.gain.setTargetAtTime(amount * 0.22, this.ctx.currentTime, 0.05);
  };
  A.silenceCar = function () { this.setEngine(0, 0, false); if (this.engine) this.engine.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1); this.setSkid(0); };

  A.crash = function (strength) {
    if (!this.ctx || !this.sfxOn) return;
    var ctx = this.ctx, t = ctx.currentTime;
    var src = ctx.createBufferSource(); src.buffer = this.noise;
    var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900 + strength * 1500;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * strength + 0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25 + strength * 0.2);
    src.connect(f); f.connect(g); g.connect(this.sfx);
    src.start(t, Math.random()); src.stop(t + 0.5);
    var o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    og.gain.setValueAtTime(0.4 * strength, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(og); og.connect(this.sfx); o.start(t); o.stop(t + 0.25);
  };

  A.beep = function (high) {
    if (!this.ctx) return;
    var ctx = this.ctx, t = ctx.currentTime;
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = high ? 1046 : 523;
    g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + (high ? 0.6 : 0.25));
    o.connect(g); g.connect(this.sfx); o.start(t); o.stop(t + 0.65);
  };

  A.fanfare = function () {
    if (!this.ctx) return;
    var ctx = this.ctx, t = ctx.currentTime, notes = [523, 659, 784, 1046];
    notes.forEach(function (n, i) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = n;
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.2, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + (i === 3 ? 0.8 : 0.2));
      o.connect(g); g.connect(A.sfx); o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.9);
    });
  };

  // ---------- música (loop sintetizado simples) ----------
  var BPM = 128, STEP = 60 / BPM / 2;
  var CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  A.startMusic = function () {
    if (!this.ctx || this._musicTimer) return;
    var self = this;
    this._nextNote = this.ctx.currentTime + 0.1;
    this._step = 0;
    this._musicTimer = setInterval(function () {
      var ctx = self.ctx;
      while (self._nextNote < ctx.currentTime + 0.25) {
        var s = self._step, bar = Math.floor(s / 8) % 4, chord = CHORDS[bar], t = self._nextNote;
        // baixo
        if (s % 2 === 0) self.note(mtof(chord[0] - 24), t, STEP * 1.6, 'sawtooth', 0.22, 500);
        // arpejo
        var arp = chord[[0, 1, 2, 1, 0, 2, 1, 2][s % 8]] + 12;
        self.note(mtof(arp), t, STEP * 0.8, 'square', 0.06, 2400);
        // bumbo
        if (s % 4 === 0) self.kick(t);
        // chimbal
        if (s % 2 === 1) self.hat(t);
        self._nextNote += STEP; self._step++;
      }
    }, 60);
  };
  A.stopMusic = function () { clearInterval(this._musicTimer); this._musicTimer = null; };

  A.note = function (freq, t, dur, type, vol, cutoff) {
    var ctx = this.ctx, o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq; f.type = 'lowpass'; f.frequency.value = cutoff;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f); f.connect(g); g.connect(this.music); o.start(t); o.stop(t + dur + 0.02);
  };
  A.kick = function (t) {
    var ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(g); g.connect(this.music); o.start(t); o.stop(t + 0.16);
  };
  A.hat = function (t) {
    var ctx = this.ctx, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = this.noise; f.type = 'highpass'; f.frequency.value = 7000;
    g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    s.connect(f); f.connect(g); g.connect(this.music); s.start(t, Math.random()); s.stop(t + 0.06);
  };

  A.toggleSfx = function () {
    this.sfxOn = !this.sfxOn; save('cb_sfx', this.sfxOn);
    if (this.sfx) this.sfx.gain.setTargetAtTime(this.sfxOn ? 1 : 0, this.ctx.currentTime, 0.05);
    return this.sfxOn;
  };
  A.toggleMusic = function () {
    this.musicOn = !this.musicOn; save('cb_music', this.musicOn);
    this.unlock();
    if (this.music) this.music.gain.setTargetAtTime(this.musicOn ? 0.22 : 0, this.ctx.currentTime, 0.05);
    if (this.musicOn) this.startMusic(); else this.stopMusic();
    return this.musicOn;
  };

  // pausa o áudio quando a aba fica em segundo plano (economiza bateria)
  document.addEventListener('visibilitychange', function () {
    if (!A.ctx) return;
    if (document.hidden) A.ctx.suspend(); else A.ctx.resume();
  });

  window.AudioSys = A;
})();
