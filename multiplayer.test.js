/*
 * Teste de integração do multiplayer.
 * Sobe o servidor de verdade, conecta "pilotos-robô" via Socket.IO e verifica:
 * salas, lobby, permissões do anfitrião, largada, validação anti-trapaça,
 * reconexão no meio da corrida, voltas, chegada e resultados.
 *
 * Uso: npm test
 */
'use strict';
const assert = require('assert');
const { io: Client } = require('socket.io-client');
const { server, TRACK } = require('../server.js');
const TrackLib = require('../public/shared/track.js');

let URL;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function ok(name) { results.push(name); console.log('  ✔', name); }

function connect() {
  return new Promise((resolve, reject) => {
    const s = Client(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}
function waitFor(s, ev, pred, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { s.off(ev, h); reject(new Error('timeout esperando ' + ev)); }, timeout);
    function h(d) { if (pred(d)) { clearTimeout(t); s.off(ev, h); resolve(d); } }
    s.on(ev, h);
  });
}
function emitAck(s, ev, data) {
  return new Promise(r => (data === undefined ? s.emit(ev, r) : s.emit(ev, data, r)));
}
function once(s, ev, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout esperando ' + ev)), timeout);
    s.once(ev, (d) => { clearTimeout(t); resolve(d); });
  });
}

/** Robô que dirige pela linha central da pista a uma velocidade fixa */
function driver(sock, startPos, speed, opts = {}) {
  const state = { d: 0, sock, stopped: false, corrections: 0 };
  // distância ao longo da pista a partir do índice de largada
  const startIdx = TrackLib.nearest(TRACK, startPos.x, startPos.y).index;
  state.d = startIdx * TRACK.spacing - TRACK.length; // negativo: atrás da linha
  sock.on('correction', () => { state.corrections++; });
  let last = Date.now();
  state.timer = setInterval(() => {
    if (state.stopped) return;
    const t = Date.now();
    const dt = (t - last) / 1000; last = t;
    state.d += speed * dt;
    const pos = posAt(state.d);
    state.sock.emit('state', { x: pos.x, y: pos.y, a: pos.a, s: speed, f: 0 });
  }, 50);
  state.stop = () => { state.stopped = true; clearInterval(state.timer); };
  return state;
}
function posAt(d) {
  const L = TRACK.length;
  const dd = ((d % L) + L) % L;
  const f = dd / TRACK.spacing;
  const i = Math.floor(f) % TRACK.count, j = (i + 1) % TRACK.count, u = f - Math.floor(f);
  return {
    x: TRACK.xs[i] + (TRACK.xs[j] - TRACK.xs[i]) * u,
    y: TRACK.ys[i] + (TRACK.ys[j] - TRACK.ys[i]) * u,
    a: Math.atan2(TRACK.ty[i], TRACK.tx[i])
  };
}

async function main() {
  await new Promise(r => server.listen(0, r));
  URL = 'http://localhost:' + server.address().port;
  console.log('Servidor de teste em', URL, '| volta =', Math.round(TRACK.length), 'unidades');

  // ---------- lobby ----------
  const A = await connect(), B = await connect(), C = await connect();
  const created = await emitAck(A, 'createRoom', { playerId: 'botA-000001', name: 'Ana <script>', color: 1 });
  assert(created.ok, 'criar sala');
  const code = created.room.code;
  assert.match(code, /^[A-Z]{4}$/);
  assert.strictEqual(created.room.players[0].name, 'Ana script', 'nome sanitizado');
  ok('anfitrião cria sala com código ' + code + ' (nome sanitizado)');

  const bad = await emitAck(B, 'joinRoom', { playerId: 'botB-000001', code: 'ZZZZ', name: 'Bia' });
  assert(!bad.ok && /não encontrada/.test(bad.error));
  ok('código inválido é recusado com mensagem clara');

  const jb = await emitAck(B, 'joinRoom', { playerId: 'botB-000001', code: code.toLowerCase(), name: 'Bia', color: 1 });
  assert(jb.ok);
  assert.notStrictEqual(jb.room.players.find(p => p.id === 'botB-000001').color, 1, 'cor repetida é trocada');
  const roomUpdate = new Promise(res => { const h = (rm) => { if (rm.players.length === 3) { A.off('room', h); res(rm); } }; A.on('room', h); });
  const jc = await emitAck(C, 'joinRoom', { playerId: 'botC-000001', code, name: 'Caio', color: 3 });
  assert(jc.ok);
  const r = await roomUpdate;
  assert.strictEqual(r.players.length, 3);
  ok('dois amigos entram pelo código e aparecem no lobby (cores sem repetição)');

  const notHost = await emitAck(B, 'startRace');
  assert(!notHost.ok && /anfitrião/.test(notHost.error));
  ok('só o anfitrião consegue iniciar a corrida');

  A.emit('setLaps', 1);
  await sleep(100);

  // ---------- largada ----------
  const cdA = once(A, 'countdown'), cdB = once(B, 'countdown'), cdC = once(C, 'countdown');
  const goB = once(B, 'go', 6000);
  const st = await emitAck(A, 'startRace');
  assert(st.ok);
  const [cA, cB, cC] = await Promise.all([cdA, cdB, cdC]);
  assert.strictEqual(cA.laps, 1);
  assert.deepStrictEqual(Object.keys(cB.grid).sort(), ['botA-000001', 'botB-000001', 'botC-000001']);
  ok('contagem regressiva chega para todos com o mesmo grid');

  // movimento durante a contagem é ignorado
  B.emit('state', { x: cB.grid['botB-000001'].x + 500, y: cB.grid['botB-000001'].y, a: 0, s: 0 });
  await goB;
  ok('largada (VAI!) sincronizada');

  const snaps = [];
  A.on('snap', (s) => snaps.push(s));

  const dA = driver(A, cA.grid['botA-000001'], 540);
  let dB = driver(B, cB.grid['botB-000001'], 500);
  const dC = driver(C, cC.grid['botC-000001'], 450);

  // ---------- trapaça: teleporte ----------
  await sleep(1500);
  const corr = once(C, 'correction', 3000);
  const far = posAt(4000);
  dC.stop();
  C.emit('state', { x: far.x, y: far.y, a: far.a, s: 500 });
  await corr;
  // tenta também ir para fora da pista
  C.emit('state', { x: 5, y: 5, a: 0, s: 100 });
  await sleep(100);
  ok('teleporte e posição fora da pista são rejeitados pelo servidor (correction)');
  // C volta a dirigir honestamente a partir de onde o servidor aceitou
  const lastC = snaps[snaps.length - 1].p.find(p => p[0] === 'botC-000001');
  const dC2 = driver(C, { x: lastC[1], y: lastC[2] }, 450);
  dC2.d = TrackLib.nearest(TRACK, lastC[1], lastC[2]).index * TRACK.spacing - TRACK.length;

  // ---------- queda e reconexão no meio da corrida ----------
  await sleep(2500);
  const lastB = snaps[snaps.length - 1].p.find(p => p[0] === 'botB-000001');
  const progressB = dB.d;
  dB.stop();
  const lostNotice = once(A, 'notice');
  B.disconnect();
  const n1 = await lostNotice;
  assert(/perdeu a conexão/.test(n1.text));
  await sleep(1500);
  const B2 = await connect();
  const back = await emitAck(B2, 'joinRoom', { playerId: 'botB-000001', code, name: 'Bia' });
  assert(back.ok && back.reconnected && back.race && back.race.me, 'reconexão devolve estado da corrida');
  assert(Math.hypot(back.race.me.x - lastB[1], back.race.me.y - lastB[2]) < 80);
  ok('jogador cai, reconecta com o mesmo ID e volta para a corrida na mesma posição');
  dB = driver(B2, back.race.me, 500);
  dB.d = progressB;

  // ---------- chegada ----------
  const resP = once(A, 'results', 60000);
  const finishes = [];
  A.on('playerFinished', (f) => finishes.push(f));
  const res = await resP;
  [dA, dB, dC2].forEach(d => d.stop());
  assert.strictEqual(res.results.length, 3);
  assert.deepStrictEqual(res.results.map(x => x.name), ['Ana script', 'Bia', 'Caio']);
  assert(res.results.every(x => x.finished));
  assert(res.results[0].time > 15000, 'tempo de corrida plausível: ' + res.results[0].time);
  assert.deepStrictEqual(res.results.map(x => x.points), [10, 8, 6]);
  assert(finishes.length === 3 && finishes[0].place === 1);
  ok(`resultado calculado pelo servidor: ${res.results.map(x => x.place + 'º ' + x.name + ' ' + (x.time / 1000).toFixed(2) + 's').join(' | ')}`);

  // snapshots
  assert(snaps.length > 100, 'recebeu snapshots: ' + snaps.length);
  assert(snaps.some(s => s.p.length === 3));
  ok(`snapshots em tempo real recebidos (${snaps.length} durante a corrida)`);

  // ---------- campeonato e nova corrida ----------
  const roomAfter = await new Promise(r => { A.once('room', r); A.emit('setLaps', 2); });
  assert.strictEqual(roomAfter.state, 'results');
  assert.strictEqual(roomAfter.standings[0].name, 'Ana script');
  assert.strictEqual(roomAfter.standings[0].wins, 1);
  ok('ranking do campeonato acumula pontos e vitórias');

  // anfitrião sai -> outro vira anfitrião
  const hostChange = waitFor(B2, 'room', (rm) => rm.players.length === 2);
  A.emit('leaveRoom');
  const afterLeave = await hostChange;
  assert.notStrictEqual(afterLeave.hostId, 'botA-000001');
  assert.strictEqual(afterLeave.players.length, 2);
  ok('se o anfitrião sair, outro jogador assume e a sala continua');

  const again = await emitAck(B2, 'startRace');
  assert(again.ok);
  await once(C, 'go', 6000);
  ok('nova corrida ("jogar novamente") inicia com quem ficou');

  // ---------- sala cheia ----------
  const H = await connect();
  const big = await emitAck(H, 'createRoom', { playerId: 'host-big-01', name: 'Host' });
  const extra = [];
  for (let i = 0; i < 8; i++) {
    const s = await connect(); extra.push(s);
    const j = await emitAck(s, 'joinRoom', { playerId: 'extra-player-' + i, code: big.room.code, name: 'P' + i });
    if (i < 7) assert(j.ok); else assert(!j.ok && /cheia/.test(j.error));
  }
  ok('limite de 8 pilotos por sala');

  [A, B2, C, H, ...extra].forEach(s => s.close());
  console.log(`\n${results.length} verificações passaram ✅`);
  server.close();
  process.exit(0);
}

main().catch((e) => { console.error('\n❌ FALHOU:', e); process.exit(1); });
