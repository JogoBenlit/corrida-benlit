/*
 * Corrida Benlit — servidor multiplayer
 * - Serve o front-end (pasta public)
 * - Gerencia salas, lobby, largada, voltas e resultados
 * - Valida movimentos (velocidade máxima, limites da pista, ordem dos setores)
 *   para que ninguém consiga "teleportar" ou declarar vitória sozinho.
 */
'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const TrackLib = require('./public/shared/track.js');

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const TRACK = TrackLib.build();
const C = TrackLib.CONFIG;

// ---- Regras do jogo ----
const COUNTDOWN_MS = 3000;
const SNAPSHOT_MS = 50;              // 20 atualizações por segundo
const RECONNECT_GRACE_MS = 60000;    // tempo para voltar após queda de conexão (ex.: trocar de app)
const FINISH_TIMEOUT_MS = 30000;     // após o 1º terminar, demais têm 30s
const EMPTY_ROOM_TTL_MS = 120000;    // sala sem ninguém conectado é apagada
const MAX_ROOMS = 500;
const ALLOWED_LAPS = [1, 2, 3, 5];
const POINTS = [10, 8, 6, 5, 4, 3, 2, 1];
const COLORS = ['#E8B04B', '#E2412F', '#2F7DE2', '#2FB35A', '#9B4BE2', '#F07AC0', '#21C7C7', '#F2F2F2'];
const SPEED_ALLOWANCE = C.NITRO_SPEED * 1.25; // unidades/s toleradas pelo servidor
const ALLOWANCE_CAP = SPEED_ALLOWANCE * 1.0;  // até 1s de "crédito" para lag/rajadas
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const app = express();
app.disable('x-powered-by');
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: ALLOWED_ORIGINS.length ? { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] } : undefined,
  pingInterval: 5000,
  pingTimeout: 6000,
  maxHttpBufferSize: 1e5
});

/** @type {Map<string, any>} */
const rooms = new Map();

// ---------- utilidades ----------
function now() { return Date.now(); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function round1(v) { return Math.round(v * 10) / 10; }

function cleanName(name) {
  let s = String(name || '').replace(/[\u0000-\u001f<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > 14) s = s.slice(0, 14).trim();
  return s || 'Piloto';
}
function cleanId(id) {
  const s = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return s.length >= 8 ? s : null;
}
function cleanCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}
function newCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function pickColor(room, wanted, exceptId) {
  const used = new Set();
  for (const p of room.players.values()) if (p.id !== exceptId) used.add(p.color);
  if (Number.isInteger(wanted) && wanted >= 0 && wanted < COLORS.length && !used.has(wanted)) return wanted;
  for (let i = 0; i < COLORS.length; i++) if (!used.has(i)) return i;
  return 0;
}

function connectedPlayers(room) {
  return [...room.players.values()].filter(p => p.connected);
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    laps: room.laps,
    raceNumber: room.raceNumber,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, connected: p.connected, inRace: p.inRace
    })),
    standings: [...room.standings.values()]
      .sort((a, b) => b.points - a.points || b.wins - a.wins)
      .map(s => ({ id: s.id, name: s.name, color: s.color, points: s.points, wins: s.wins, races: s.races }))
  };
}

function broadcastRoom(room) { io.to(room.code).emit('room', publicRoom(room)); }
function notice(room, text, type) { io.to(room.code).emit('notice', { text, type: type || 'info' }); }

// ---------- progresso / ranking ----------
function progressOf(p) {
  // count = setores avançados (validados); fração = posição dentro do setor
  const frac = TrackLib.sectorFraction(TRACK, p.idx);
  return p.count + frac;
}

function liveOrder(room) {
  const racers = [...room.players.values()].filter(p => p.inRace);
  racers.sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return progressOf(b) - progressOf(a);
  });
  return racers;
}

function lapsDone(count) {
  return count >= 1 ? Math.floor((count - 1) / C.SECTORS) : 0;
}

// ---------- ciclo de corrida ----------
function clearRoomTimers(room) {
  clearTimeout(room.countdownTimer); room.countdownTimer = null;
  clearTimeout(room.finishTimer); room.finishTimer = null;
  clearTimeout(room.maxRaceTimer); room.maxRaceTimer = null;
}

function startRace(room) {
  clearRoomTimers(room);
  const racers = connectedPlayers(room);
  if (racers.length === 0) return;
  room.raceNumber += 1;
  room.state = 'countdown';
  room.finishCount = 0;
  room.goAt = 0;
  const grid = {};
  // ordem do grid: pior colocado no campeonato larga na frente (mais justo)
  racers.sort((a, b) => (room.standings.get(a.id)?.points || 0) - (room.standings.get(b.id)?.points || 0));
  for (const p of room.players.values()) p.inRace = false;
  racers.forEach((p, slot) => {
    const g = TrackLib.gridSlot(TRACK, slot);
    Object.assign(p, {
      inRace: true, x: g.x, y: g.y, angle: g.angle, speed: 0, flags: 0,
      idx: g.index, sector: TrackLib.sectorOf(TRACK, g.index), count: 0,
      finished: false, finishTime: 0, place: 0, bestLap: 0, lapStart: 0, lapsDone: 0,
      lastMoveAt: 0, allowance: 0, rejects: 0, left: false
    });
    grid[p.id] = { x: g.x, y: g.y, angle: g.angle };
  });
  io.to(room.code).emit('countdown', { laps: room.laps, grid, ms: COUNTDOWN_MS, raceNumber: room.raceNumber });
  broadcastRoom(room);
  room.countdownTimer = setTimeout(() => {
    room.state = 'racing';
    room.goAt = now();
    for (const p of room.players.values()) {
      if (!p.inRace) continue;
      p.lastMoveAt = room.goAt; p.allowance = 0; p.lapStart = room.goAt;
    }
    io.to(room.code).emit('go', { raceNumber: room.raceNumber });
    broadcastRoom(room);
    room.maxRaceTimer = setTimeout(() => endRace(room, 'tempo'), room.laps * 150000 + 60000);
  }, COUNTDOWN_MS);
}

function finishPlayer(room, p, t) {
  p.finished = true;
  p.finishTime = t - room.goAt;
  p.place = ++room.finishCount;
  io.to(room.code).emit('playerFinished', { id: p.id, name: p.name, place: p.place, time: p.finishTime });
  if (p.place === 1) {
    room.finishTimer = setTimeout(() => endRace(room, 'tempo'), FINISH_TIMEOUT_MS);
    io.to(room.code).emit('notice', { text: `${p.name} venceu! Os demais têm 30s para terminar.`, type: 'gold' });
  }
  checkRaceOver(room);
}

function checkRaceOver(room) {
  if (room.state !== 'racing' && room.state !== 'countdown') return;
  const stillRacing = [...room.players.values()].some(p => p.inRace && p.connected && !p.finished);
  if (!stillRacing) endRace(room, 'todos');
}

function endRace(room, reason) {
  if (room.state !== 'racing' && room.state !== 'countdown') return;
  clearRoomTimers(room);
  const order = liveOrder(room);
  const results = order.map((p, i) => {
    const pts = p.finished ? (POINTS[i] || 0) : 0;
    let st = room.standings.get(p.id);
    if (!st) { st = { id: p.id, name: p.name, color: p.color, points: 0, wins: 0, races: 0 }; room.standings.set(p.id, st); }
    st.name = p.name; st.color = p.color; st.points += pts; st.races += 1;
    if (p.finished && i === 0) st.wins += 1;
    return {
      id: p.id, name: p.name, color: p.color, place: i + 1, finished: p.finished,
      time: p.finished ? p.finishTime : null, bestLap: p.bestLap || null,
      laps: Math.min(p.lapsDone, room.laps), points: pts, left: !p.connected
    };
  });
  room.state = 'results';
  room.lastResults = results;
  for (const p of room.players.values()) p.inRace = false;
  io.to(room.code).emit('results', { results, laps: room.laps, reason, raceNumber: room.raceNumber });
  broadcastRoom(room);
}

// ---------- validação de movimento ----------
function handleState(room, p, data) {
  const t = now();
  if (room.state !== 'racing' || !p.inRace) return;
  if (!data || !isNum(data.x) || !isNum(data.y) || !isNum(data.a)) return;

  // limitador de taxa (máx ~40 msgs/s)
  if (t - (p.lastMsgAt || 0) < 20) return;
  p.lastMsgAt = t;

  const elapsed = Math.max(0, t - p.lastMoveAt) / 1000;
  p.lastMoveAt = t;
  p.allowance = Math.min(ALLOWANCE_CAP, p.allowance + elapsed * SPEED_ALLOWANCE);

  const dist = Math.hypot(data.x - p.x, data.y - p.y);
  const near = TrackLib.nearest(TRACK, data.x, data.y, p.idx);
  const outside = near.dist > C.WALL_DIST + 20;
  // distância medida AO LONGO da pista: impede "atalhos" cortando o gramado entre trechos
  let di = Math.abs(near.index - p.idx);
  di = Math.min(di, TRACK.count - di);
  const alongTrack = di * TRACK.spacing;

  if (dist > p.allowance + 30 || alongTrack > p.allowance + 150 || outside) {
    p.rejects += 1;
    p.sock && p.sock.emit('correction', { x: p.x, y: p.y, a: p.angle });
    return;
  }
  p.allowance = Math.max(0, p.allowance - dist);
  p.x = data.x; p.y = data.y; p.angle = data.a;
  p.speed = isNum(data.s) ? Math.max(-300, Math.min(C.NITRO_SPEED * 1.1, data.s)) : 0;
  p.flags = Number.isInteger(data.f) ? data.f & 7 : 0;
  p.idx = near.index;

  // progresso por setores — só avança/recua um setor por vez
  const sector = TrackLib.sectorOf(TRACK, near.index);
  if (sector === (p.sector + 1) % C.SECTORS) { p.count += 1; p.sector = sector; }
  else if (sector === (p.sector - 1 + C.SECTORS) % C.SECTORS) { p.count -= 1; p.sector = sector; }

  if (!p.finished) {
    const done = lapsDone(p.count);
    if (done > p.lapsDone) {
      const lapTime = t - p.lapStart;
      p.lapStart = t;
      p.lapsDone = done;
      if (!p.bestLap || lapTime < p.bestLap) p.bestLap = lapTime;
      p.sock && p.sock.emit('lap', { lapsDone: done, lapTime, bestLap: p.bestLap });
      if (done >= room.laps) finishPlayer(room, p, t);
    }
  }
}

// ---------- snapshots (20/s) ----------
setInterval(() => {
  const t = now();
  for (const room of rooms.values()) {
    if (room.state !== 'racing' && room.state !== 'countdown') continue;
    const order = liveOrder(room);
    const list = order.map((p, i) => [
      p.id, round1(p.x), round1(p.y), Math.round(p.angle * 1000) / 1000, Math.round(p.speed),
      p.flags | (p.connected ? 0 : 8), i + 1, p.lapsDone, p.finished ? 1 : 0
    ]);
    io.to(room.code).volatile.emit('snap', {
      t, p: list, el: room.goAt ? t - room.goAt : 0
    });
  }
}, SNAPSHOT_MS);

// ---------- entrada/saída de jogadores ----------
function removePlayer(room, p, reason) {
  clearTimeout(p.graceTimer);
  room.players.delete(p.id);
  if (p.sock) p.sock.leave(room.code);
  notice(room, reason === 'saiu' ? `${p.name} saiu da sala` : `${p.name} não voltou e foi removido`, 'warn');
  if (room.hostId === p.id) {
    const next = connectedPlayers(room)[0] || [...room.players.values()][0];
    room.hostId = next ? next.id : null;
    if (next) notice(room, `${next.name} agora é o anfitrião`, 'info');
  }
  if (room.players.size === 0) { deleteRoom(room); return; }
  checkRaceOver(room);
  broadcastRoom(room);
}

function deleteRoom(room) {
  clearRoomTimers(room);
  clearTimeout(room.emptyTimer);
  rooms.delete(room.code);
}

function scheduleEmptyCheck(room) {
  clearTimeout(room.emptyTimer);
  if (connectedPlayers(room).length === 0) {
    room.emptyTimer = setTimeout(() => {
      if (rooms.get(room.code) === room && connectedPlayers(room).length === 0) deleteRoom(room);
    }, EMPTY_ROOM_TTL_MS);
  }
}

function attach(socket, room, p) {
  p.sock = socket;
  p.connected = true;
  clearTimeout(p.graceTimer);
  clearTimeout(room.emptyTimer);
  socket.data.roomCode = room.code;
  socket.data.playerId = p.id;
  socket.join(room.code);
}

function raceSync(room, p) {
  // dados para quem entra/reconecta durante uma corrida
  if (room.state !== 'racing' && room.state !== 'countdown') return null;
  return {
    laps: room.laps, raceNumber: room.raceNumber, state: room.state,
    elapsed: room.goAt ? now() - room.goAt : 0,
    me: p.inRace ? { x: p.x, y: p.y, angle: p.angle, lapsDone: p.lapsDone, finished: p.finished } : null
  };
}

io.on('connection', (socket) => {
  function currentRoom() {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    if (!room) return {};
    const p = room.players.get(socket.data.playerId);
    if (!p || p.sock !== socket) return {};
    return { room, p };
  }

  function leaveCurrent() {
    const { room, p } = currentRoom();
    if (room && p) removePlayer(room, p, 'saiu');
    socket.data.roomCode = null;
  }

  socket.on('createRoom', (data, ack) => {
    if (typeof ack !== 'function') return;
    const id = cleanId(data && data.playerId);
    if (!id) return ack({ ok: false, error: 'Identificação inválida. Recarregue a página.' });
    if (rooms.size >= MAX_ROOMS) return ack({ ok: false, error: 'Servidor cheio. Tente de novo em alguns minutos.' });
    leaveCurrent();
    const code = newCode();
    if (!code) return ack({ ok: false, error: 'Não foi possível criar a sala.' });
    const room = {
      code, hostId: id, state: 'lobby', laps: 3, raceNumber: 0,
      players: new Map(), standings: new Map(), createdAt: now(), finishCount: 0, goAt: 0
    };
    rooms.set(code, room);
    const p = { id, name: cleanName(data.name), color: 0, connected: true, inRace: false, idx: 0, count: 0 };
    p.color = pickColor(room, data.color, id);
    room.players.set(id, p);
    attach(socket, room, p);
    ack({ ok: true, room: publicRoom(room), you: id, colors: COLORS });
    broadcastRoom(room);
  });

  socket.on('joinRoom', (data, ack) => {
    if (typeof ack !== 'function') return;
    const id = cleanId(data && data.playerId);
    const code = cleanCode(data && data.code);
    if (!id) return ack({ ok: false, error: 'Identificação inválida. Recarregue a página.' });
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: `Sala ${code || ''} não encontrada. Confira o código ou peça um novo link.` });

    let p = room.players.get(id);
    if (p) {
      // reconexão do mesmo jogador
      if (p.sock && p.sock !== socket && p.sock.connected) p.sock.disconnect(true);
      const wasDisconnected = !p.connected;
      if (data.name) p.name = cleanName(data.name);
      attach(socket, room, p);
      ack({ ok: true, room: publicRoom(room), you: id, colors: COLORS, race: raceSync(room, p), reconnected: true });
      if (wasDisconnected) notice(room, `${p.name} reconectou`, 'ok');
      broadcastRoom(room);
      return;
    }
    if (socket.data.roomCode && socket.data.roomCode !== code) leaveCurrent();
    if (room.players.size >= C.MAX_PLAYERS) return ack({ ok: false, error: 'Sala cheia (máximo de 8 pilotos).' });
    p = { id, name: cleanName(data.name), color: 0, connected: true, inRace: false, idx: 0, count: 0 };
    p.color = pickColor(room, data.color, id);
    room.players.set(id, p);
    if (!room.hostId) room.hostId = id;
    attach(socket, room, p);
    ack({ ok: true, room: publicRoom(room), you: id, colors: COLORS, race: raceSync(room, p) });
    notice(room, `${p.name} entrou na sala`, 'ok');
    broadcastRoom(room);
  });

  socket.on('leaveRoom', () => leaveCurrent());

  socket.on('setColor', (color) => {
    const { room, p } = currentRoom();
    if (!room || room.state === 'racing' || room.state === 'countdown') return;
    p.color = pickColor(room, color, p.id);
    broadcastRoom(room);
  });

  socket.on('setName', (name) => {
    const { room, p } = currentRoom();
    if (!room || room.state === 'racing' || room.state === 'countdown') return;
    p.name = cleanName(name);
    broadcastRoom(room);
  });

  socket.on('setLaps', (laps) => {
    const { room, p } = currentRoom();
    if (!room || room.hostId !== p.id || room.state === 'racing' || room.state === 'countdown') return;
    if (ALLOWED_LAPS.includes(laps)) { room.laps = laps; broadcastRoom(room); }
  });

  socket.on('startRace', (ack) => {
    const { room, p } = currentRoom();
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!room) return reply({ ok: false, error: 'Você não está em uma sala.' });
    if (room.hostId !== p.id) return reply({ ok: false, error: 'Só o anfitrião pode iniciar a corrida.' });
    if (room.state === 'racing' || room.state === 'countdown') return reply({ ok: false, error: 'A corrida já está em andamento.' });
    startRace(room);
    reply({ ok: true });
  });

  socket.on('resetStandings', () => {
    const { room, p } = currentRoom();
    if (!room || room.hostId !== p.id || room.state === 'racing' || room.state === 'countdown') return;
    room.standings.clear();
    notice(room, 'Campeonato zerado pelo anfitrião', 'info');
    broadcastRoom(room);
  });

  socket.on('state', (data) => {
    const { room, p } = currentRoom();
    if (room) handleState(room, p, data);
  });

  socket.on('pingCheck', (ack) => { if (typeof ack === 'function') ack(now()); });

  socket.on('disconnect', () => {
    const { room, p } = currentRoom();
    if (!room) return;
    p.connected = false;
    p.sock = null;
    notice(room, `${p.name} perdeu a conexão…`, 'warn');
    p.graceTimer = setTimeout(() => {
      if (rooms.get(room.code) === room && room.players.get(p.id) === p && !p.connected) removePlayer(room, p, 'caiu');
    }, RECONNECT_GRACE_MS);
    checkRaceOver(room);
    broadcastRoom(room);
    scheduleEmptyCheck(room);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`🏁 Corrida Benlit rodando em http://localhost:${PORT}`);
  });
}

module.exports = { server, io, rooms, TRACK };
