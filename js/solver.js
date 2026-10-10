/* Route solver: pure functions, no browser or Google dependency, so it can be tested in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Solver = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EARTH_KM = 6371;
  // Straight-line distance understates road distance; one factor for every figure keeps comparisons fair.
  var ROAD_FACTOR = 1.3;

  function haversine(a, b) {
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function mulberry32(seed) {
    var t = seed >>> 0;
    return function () {
      t += 0x6D2B79F5;
      var r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Node 0 is the start point, nodes 1..n are the stops, node n+1 (optional) is a fixed final waypoint
  // such as a charging station: after the last stop the route goes there, and then home.
  function buildMatrix(start, stops, finish) {
    var nodes = [start].concat(stops, finish ? [finish] : []);
    return nodes.map(function (a) {
      return nodes.map(function (b) { return haversine(a, b) * ROAD_FACTOR; });
    });
  }

  function seqCost(seq, D, returnHome, tail) {
    if (!seq.length) return 0;
    var c = D[0][seq[0]];
    for (var k = 0; k + 1 < seq.length; k++) c += D[seq[k]][seq[k + 1]];
    var last = seq[seq.length - 1];
    if (tail) {
      c += D[last][tail];
      if (returnHome) c += D[tail][0];
    } else if (returnHome) {
      c += D[last][0];
    }
    return c;
  }

  function nearestNeighbour(n, D, firstNode, lastNode) {
    var seq = [];
    var left = {};
    for (var i = 1; i <= n; i++) if (i !== firstNode && i !== lastNode) left[i] = true;
    var cur = 0;
    if (firstNode) { seq.push(firstNode); cur = firstNode; }
    var remaining = Object.keys(left).length;
    while (remaining--) {
      var best = -1, bd = Infinity;
      for (var key in left) {
        var d = D[cur][+key];
        if (d < bd) { bd = d; best = +key; }
      }
      seq.push(best); delete left[best]; cur = best;
    }
    if (lastNode) seq.push(lastNode);
    return seq;
  }

  // 2-opt and or-opt on seq[lo..hi]; positions outside that range are locked.
  function improve(seq, D, returnHome, tail, lo, hi, onBetter) {
    var best = seqCost(seq, D, returnHome, tail);
    var improved = true;
    var i, j, c, len, pos;
    while (improved) {
      improved = false;
      for (i = lo; i < hi; i++) {
        for (j = i + 1; j <= hi; j++) {
          reverse(seq, i, j);
          c = seqCost(seq, D, returnHome, tail);
          if (c < best - 1e-9) { best = c; improved = true; onBetter(c); }
          else reverse(seq, i, j);
        }
      }
      for (len = 1; len <= 3; len++) {
        for (i = lo; i + len - 1 <= hi; i++) {
          var seg = seq.slice(i, i + len);
          var rest = seq.slice(0, i).concat(seq.slice(i + len));
          var hiPos = rest.length - (hi < seq.length - 1 ? seq.length - 1 - hi : 0);
          var moved = false;
          for (pos = lo; pos <= hiPos && !moved; pos++) {
            for (var flip = 0; flip < 2 && !moved; flip++) {
              if (pos === i && flip === 0) continue;
              var piece = flip ? seg.slice().reverse() : seg;
              var cand = rest.slice(0, pos).concat(piece, rest.slice(pos));
              c = seqCost(cand, D, returnHome, tail);
              if (c < best - 1e-9) {
                for (var k = 0; k < cand.length; k++) seq[k] = cand[k];
                best = c; improved = true; moved = true; onBetter(c);
              }
            }
          }
        }
      }
    }
    return best;
  }

  function reverse(a, i, j) {
    while (i < j) { var t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
  }

  /**
   * start: {lat,lng}; stops: [{id,lat,lng}]
   * opts: {returnHome, firstId, lastId, userOrder:[ids], finish:{lat,lng}, restarts}
   *   finish: a fixed last waypoint (a charger) visited after the final stop, before going home.
   *   restarts: number of random restarts (default scales with the number of stops).
   * Returns {order:[ids], km, userKm, history:[km...]}; km includes the leg to the finish point and home.
   */
  function planRoute(start, stops, opts) {
    opts = opts || {};
    var returnHome = opts.returnHome !== false;
    var n = stops.length;
    if (!n) return { order: [], km: 0, userKm: 0, history: [0] };

    var D = buildMatrix(start, stops, opts.finish);
    var tail = opts.finish ? n + 1 : 0;
    var idOf = stops.map(function (s) { return s.id; });
    var nodeOf = {};
    idOf.forEach(function (id, k) { nodeOf[id] = k + 1; });

    var firstNode = opts.firstId != null && nodeOf[opts.firstId] ? nodeOf[opts.firstId] : 0;
    var lastNode = opts.lastId != null && nodeOf[opts.lastId] ? nodeOf[opts.lastId] : 0;
    if (firstNode && firstNode === lastNode) lastNode = 0;

    var userSeq = (opts.userOrder || idOf).filter(function (id) { return nodeOf[id]; }).map(function (id) { return nodeOf[id]; });
    var userKm = seqCost(userSeq, D, returnHome, tail);

    var lo = firstNode ? 1 : 0;
    var hi = lastNode ? n - 2 : n - 1;
    var history = [userKm];
    var globalBest = Infinity;
    var bestSeq = null;
    function note(c) { if (c < globalBest - 1e-9) { globalBest = c; history.push(c); } }

    var seq = nearestNeighbour(n, D, firstNode, lastNode);
    note(seqCost(seq, D, returnHome, tail));
    improve(seq, D, returnHome, tail, lo, hi, note);
    bestSeq = seq.slice();
    globalBest = Math.min(globalBest, seqCost(seq, D, returnHome, tail));

    var free = hi - lo + 1;
    if (free >= 4) {
      var rand = mulberry32(12345);
      var restarts = opts.restarts != null ? opts.restarts : (n <= 40 ? 30 : n <= 100 ? 8 : 3);
      for (var r = 0; r < restarts; r++) {
        var cand = seq.slice();
        for (var k = hi; k > lo; k--) {
          var m = lo + Math.floor(rand() * (k - lo + 1));
          var t = cand[k]; cand[k] = cand[m]; cand[m] = t;
        }
        var c = improve(cand, D, returnHome, tail, lo, hi, function () {});
        if (c < globalBest - 1e-9) { globalBest = c; bestSeq = cand.slice(); history.push(c); }
      }
    }

    return {
      order: bestSeq.map(function (node) { return idOf[node - 1]; }),
      km: globalBest,
      userKm: userKm,
      history: history
    };
  }

  /** Estimated km for an explicit order of ids; optional finish waypoint (charger) before going home. */
  function orderKm(start, stops, order, returnHome, finish) {
    var byId = {};
    stops.forEach(function (s) { byId[s.id] = s; });
    var pts = [start].concat(order.map(function (id) { return byId[id]; }).filter(Boolean));
    if (finish) pts.push(finish);
    var km = 0;
    for (var k = 0; k + 1 < pts.length; k++) km += haversine(pts[k], pts[k + 1]) * ROAD_FACTOR;
    if (returnHome !== false && pts.length > 1) km += haversine(pts[pts.length - 1], pts[0]) * ROAD_FACTOR;
    return km;
  }

  /**
   * Pick the charger to finish at: the one that makes the whole trip (all stops, then the charger, then home)
   * shortest. Candidates are the chargers with the least extra distance for some final stop, then each is solved.
   * opts as planRoute, plus {chargerId} to force one. Returns {charger, result, tried:[{id,km}]} or null.
   */
  function chooseCharger(start, stops, chargers, opts) {
    opts = opts || {};
    if (!chargers || !chargers.length || !stops.length) return null;
    var returnHome = opts.returnHome !== false;
    var pool = chargers;
    if (opts.chargerId) {
      pool = chargers.filter(function (c) { return c.id === opts.chargerId; });
      if (!pool.length) pool = chargers;
    }
    var scored = pool.map(function (c) {
      var best = Infinity;
      stops.forEach(function (s) {
        var extra = haversine(s, c) + (returnHome ? haversine(c, start) - haversine(s, start) : 0);
        if (extra < best) best = extra;
      });
      return { c: c, extra: best };
    }).sort(function (a, b) { return a.extra - b.extra; });
    var cands = (opts.chargerId && pool.length === 1 ? scored : scored.slice(0, 8));

    var fast = Object.assign({}, opts, { restarts: stops.length <= 40 ? 6 : 1 });
    var tried = [], bestC = null, bestKm = Infinity;
    cands.forEach(function (x) {
      var res = planRoute(start, stops, Object.assign({}, fast, { finish: x.c }));
      tried.push({ id: x.c.id, km: res.km });
      if (res.km < bestKm - 1e-9) { bestKm = res.km; bestC = x.c; }
    });
    var full = planRoute(start, stops, Object.assign({}, opts, { finish: bestC }));
    return { charger: bestC, result: full, tried: tried };
  }

  /**
   * Split an ordered list into runs for APIs with a stop cap. Neighbouring runs share their join point
   * so the drawn route has no gap: [a b c d e] with size 3 gives [a b c] [c d e].
   */
  function chunkWithOverlap(items, size) {
    if (size < 2) throw new Error('size must be at least 2');
    if (items.length <= size) return [items.slice()];
    var out = [];
    var i = 0;
    while (i < items.length - 1) {
      out.push(items.slice(i, i + size));
      i += size - 1;
    }
    return out;
  }

  /** Google Maps directions link. Points are {lat,lng}; waypoints are capped at 9 by Google Maps links. */
  function mapsUrl(origin, destination, waypoints) {
    var f = function (p) { return p.lat.toFixed(6) + ',' + p.lng.toFixed(6); };
    var u = 'https://www.google.com/maps/dir/?api=1&travelmode=driving';
    if (origin) u += '&origin=' + encodeURIComponent(f(origin));
    u += '&destination=' + encodeURIComponent(f(destination));
    if (waypoints && waypoints.length) u += '&waypoints=' + encodeURIComponent(waypoints.slice(0, 9).map(f).join('|'));
    return u;
  }

  return {
    haversine: haversine, planRoute: planRoute, orderKm: orderKm, chooseCharger: chooseCharger,
    chunkWithOverlap: chunkWithOverlap, mapsUrl: mapsUrl, ROAD_FACTOR: ROAD_FACTOR
  };
});
