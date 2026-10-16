/*
 * Corrida Benlit — módulo compartilhado da pista.
 * O MESMO arquivo é usado pelo servidor (Node, via require) e pelo navegador
 * (window.TrackLib). Assim, servidor e jogadores usam exatamente a mesma pista
 * para validar posições, voltas e setores.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.TrackLib = lib;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CONFIG = {
    HALF_WIDTH: 100,     // metade da largura do asfalto
    WALL_DIST: 158,      // distância do centro da pista até a barreira
    SAMPLE_SPACING: 10,  // espaçamento entre pontos amostrados da linha central
    SECTORS: 16,         // setores usados pelo servidor para validar as voltas
    MAX_SPEED: 560,      // velocidade máxima normal (unidades/s)
    NITRO_SPEED: 760,    // velocidade máxima com nitro
    CAR_RADIUS: 20,
    CAR_LENGTH: 46,
    CAR_WIDTH: 24,
    MAX_PLAYERS: 8,
    MARGIN: 340          // borda de cenário em volta da pista
  };

  // Pontos de controle do circuito "Autódromo Benlit" (sentido horário na tela)
  var CONTROL_POINTS = [
    [1100, 1690], [1650, 1700], [2400, 1620], [2750, 1350], [2700, 1000],
    [2350, 890], [2000, 1110], [1700, 1300], [1350, 1270], [1170, 950],
    [1450, 590], [1950, 530], [2450, 510], [2400, 150], [1500, 130],
    [800, 190], [450, 550], [500, 900], [760, 1110], [500, 1420], [650, 1660]
  ];

  // Obstáculos (pilhas de pneus): fração da volta + deslocamento lateral (-1..1 da meia largura)
  var OBSTACLES = [
    { f: 0.17, off: 0.55 }, { f: 0.30, off: -0.5 }, { f: 0.46, off: 0.5 },
    { f: 0.585, off: -0.55 }, { f: 0.72, off: 0.5 }, { f: 0.86, off: -0.5 }
  ];
  var OBSTACLE_RADIUS = 15;

  function catmull(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t;
    return [
      0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
      0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
    ];
  }

  function buildTrack() {
    var cp = CONTROL_POINTS, n = cp.length, dense = [], i, j;
    for (i = 0; i < n; i++) {
      var p0 = cp[(i - 1 + n) % n], p1 = cp[i], p2 = cp[(i + 1) % n], p3 = cp[(i + 2) % n];
      for (j = 0; j < 60; j++) dense.push(catmull(p0, p1, p2, p3, j / 60));
    }
    // Reamostra com espaçamento uniforme (índice proporcional à distância percorrida)
    var cum = [0], total = 0;
    for (i = 1; i <= dense.length; i++) {
      var a = dense[i - 1], b = dense[i % dense.length];
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
      cum.push(total);
    }
    var count = Math.round(total / CONFIG.SAMPLE_SPACING);
    var spacing = total / count;
    var xs = new Float64Array(count), ys = new Float64Array(count);
    var k = 0;
    for (i = 0; i < count; i++) {
      var d = i * spacing;
      while (cum[k + 1] < d) k++;
      var segA = dense[k], segB = dense[(k + 1) % dense.length];
      var t = (d - cum[k]) / ((cum[k + 1] - cum[k]) || 1);
      xs[i] = segA[0] + (segB[0] - segA[0]) * t;
      ys[i] = segA[1] + (segB[1] - segA[1]) * t;
    }
    // Normaliza coordenadas para começarem em MARGIN
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (i = 0; i < count; i++) {
      if (xs[i] < minX) minX = xs[i]; if (ys[i] < minY) minY = ys[i];
      if (xs[i] > maxX) maxX = xs[i]; if (ys[i] > maxY) maxY = ys[i];
    }
    for (i = 0; i < count; i++) { xs[i] += CONFIG.MARGIN - minX; ys[i] += CONFIG.MARGIN - minY; }
    var width = Math.ceil(maxX - minX + CONFIG.MARGIN * 2);
    var height = Math.ceil(maxY - minY + CONFIG.MARGIN * 2);

    // Tangentes e normais
    var tx = new Float64Array(count), ty = new Float64Array(count);
    for (i = 0; i < count; i++) {
      var nx = xs[(i + 1) % count] - xs[(i - 1 + count) % count];
      var ny = ys[(i + 1) % count] - ys[(i - 1 + count) % count];
      var len = Math.hypot(nx, ny) || 1;
      tx[i] = nx / len; ty[i] = ny / len;
    }

    var track = {
      config: CONFIG, count: count, spacing: spacing, length: total,
      xs: xs, ys: ys, tx: tx, ty: ty, width: width, height: height,
      sectorSize: count / CONFIG.SECTORS, obstacles: []
    };
    for (i = 0; i < OBSTACLES.length; i++) {
      var o = OBSTACLES[i], idx = Math.floor(o.f * count) % count;
      // normal "direita" = (-ty, tx)
      track.obstacles.push({
        x: xs[idx] - ty[idx] * o.off * CONFIG.HALF_WIDTH,
        y: ys[idx] + tx[idx] * o.off * CONFIG.HALF_WIDTH,
        r: OBSTACLE_RADIUS
      });
    }
    return track;
  }

  /**
   * Ponto mais próximo da linha central.
   * hint (opcional): índice anterior, para busca local rápida.
   */
  function nearest(track, x, y, hint) {
    var best = -1, bestD = Infinity, i, idx, dx, dy, d, n = track.count;
    if (hint !== undefined && hint !== null && hint >= 0) {
      for (i = -45; i <= 45; i++) {
        idx = (hint + i + n) % n;
        dx = x - track.xs[idx]; dy = y - track.ys[idx]; d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = idx; }
      }
      // se o resultado estiver estranho, faz busca completa
      if (Math.sqrt(bestD) > track.config.WALL_DIST + 60) best = -1;
    }
    if (best < 0) {
      bestD = Infinity;
      for (i = 0; i < n; i++) {
        dx = x - track.xs[i]; dy = y - track.ys[i]; d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    // refina projetando no segmento vizinho
    var cx = track.xs[best], cy = track.ys[best];
    var tX = track.tx[best], tY = track.ty[best];
    var along = (x - cx) * tX + (y - cy) * tY;
    along = Math.max(-track.spacing, Math.min(track.spacing, along));
    var px = cx + tX * along, py = cy + tY * along;
    var lat = (x - px) * -tY + (y - py) * tX; // positivo = lado "direito"
    return {
      index: best, x: px, y: py, dist: Math.abs(lat), lateral: lat,
      tx: tX, ty: tY, along: along
    };
  }

  function sectorOf(track, index) {
    return Math.floor(index / track.sectorSize) % track.config.SECTORS;
  }

  /** Fração (0..1) do caminho já percorrido dentro do setor atual */
  function sectorFraction(track, index) {
    var s = track.sectorSize;
    return (index % s) / s;
  }

  /** Posição de largada para o "slot" (0..7). Grid atrás da linha de largada. */
  function gridSlot(track, slot) {
    var row = Math.floor(slot / 2), col = slot % 2;
    var back = 5 + row * 7 + col * 3; // em amostras (≈10 unidades cada)
    var idx = (track.count - back) % track.count;
    var side = col === 0 ? -1 : 1;
    var off = side * track.config.HALF_WIDTH * 0.45;
    return {
      x: track.xs[idx] - track.ty[idx] * off,
      y: track.ys[idx] + track.tx[idx] * off,
      angle: Math.atan2(track.ty[idx], track.tx[idx]),
      index: idx
    };
  }

  return {
    CONFIG: CONFIG,
    build: buildTrack,
    nearest: nearest,
    sectorOf: sectorOf,
    sectorFraction: sectorFraction,
    gridSlot: gridSlot
  };
});
