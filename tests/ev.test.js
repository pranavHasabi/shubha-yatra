const test = require('node:test');
const assert = require('node:assert');
const S = require('../js/solver.js');
const Ev = require('../js/ev.js');
const C = require('../js/chargers.js');

const HOME = { lat: 15.36, lng: 75.11 };
function permutations(a) {
  if (a.length <= 1) return [a];
  return a.flatMap((x, i) => permutations(a.slice(0, i).concat(a.slice(i + 1))).map((p) => [x].concat(p)));
}
function rng(seed) { let t = seed; return () => { t = (t * 1664525 + 1013904223) % 4294967296; return t / 4294967296; }; }
function pts(n, seed, prefix) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({ id: prefix + i, lat: 15.30 + r() * 0.12, lng: 75.05 + r() * 0.12 }));
}

/* ---------- solver with a finish waypoint (charger) ---------- */

test('with a charger finish the route is optimal among all orders (brute force)', () => {
  for (const seed of [31, 32, 33, 34]) {
    const stops = pts(6, seed, 's');
    const charger = { id: 'c', lat: 15.33, lng: 75.15 };
    let best = Infinity;
    for (const p of permutations(stops.map((s) => s.id))) best = Math.min(best, S.orderKm(HOME, stops, p, true, charger));
    const res = S.planRoute(HOME, stops, { returnHome: true, finish: charger });
    assert.ok(Math.abs(res.km - best) < 1e-6, `seed ${seed}: ${res.km} vs ${best}`);
    assert.ok(Math.abs(res.km - S.orderKm(HOME, stops, res.order, true, charger)) < 1e-6);
  }
});

test('finish waypoint is counted: the trip is longer than the same route without it unless it lies on the way', () => {
  const stops = pts(10, 5, 's');
  const far = { id: 'c', lat: 15.45, lng: 75.30 };
  const plain = S.planRoute(HOME, stops, { returnHome: true });
  const withFar = S.planRoute(HOME, stops, { returnHome: true, finish: far });
  assert.ok(withFar.km > plain.km);
});

test('locked last stop is still honoured with a charger after it', () => {
  const stops = pts(8, 9, 's');
  const res = S.planRoute(HOME, stops, { returnHome: true, finish: { lat: 15.33, lng: 75.15 }, lastId: 's3' });
  assert.strictEqual(res.order[res.order.length - 1], 's3');
});

test('chooseCharger picks the charger giving the shortest whole trip', () => {
  const stops = pts(8, 14, 's');
  const chargers = [
    { id: 'near', lat: 15.36, lng: 75.12 },
    { id: 'far', lat: 15.50, lng: 75.40 },
    { id: 'mid', lat: 15.34, lng: 75.17 }
  ];
  const pick = S.chooseCharger(HOME, stops, chargers, { returnHome: true });
  let bestId = null, bestKm = Infinity;
  for (const c of chargers) {
    const km = S.planRoute(HOME, stops, { returnHome: true, finish: c }).km;
    if (km < bestKm) { bestKm = km; bestId = c.id; }
  }
  assert.strictEqual(pick.charger.id, bestId);
  assert.ok(Math.abs(pick.result.km - bestKm) < 0.25, 'full solve is at least as good as the quick comparison');
  assert.strictEqual(pick.result.order.length, 8);
});

test('chooseCharger can be forced to a chosen charger and returns null with none', () => {
  const stops = pts(5, 2, 's');
  const chargers = [{ id: 'a', lat: 15.31, lng: 75.06 }, { id: 'b', lat: 15.40, lng: 75.15 }];
  assert.strictEqual(S.chooseCharger(HOME, stops, chargers, { chargerId: 'a' }).charger.id, 'a');
  assert.strictEqual(S.chooseCharger(HOME, stops, [], {}), null);
});

/* ---------- battery maths ---------- */

test('kmPerPct: range shown now over battery now, less the safety margin', () => {
  assert.ok(Math.abs(Ev.kmPerPct({ pct: 80, rangeKm: 200, marginPct: 0 }) - 2.5) < 1e-9);
  assert.ok(Math.abs(Ev.kmPerPct({ pct: 80, rangeKm: 200, marginPct: 20 }) - 2.0) < 1e-9);
});

test('profile counts the battery down leg by leg and tops up at the charger', () => {
  const ev = { pct: 80, rangeKm: 200, marginPct: 20, reservePct: 10, chargeTo: 80 }; // 2 km per %
  const p = Ev.profile(ev, [20, 20, 10, 6], ['stop', 'stop', 'charger', 'home']);
  assert.ok(Math.abs(p.points[0].arrivePct - 70) < 1e-9);
  assert.ok(Math.abs(p.points[1].arrivePct - 60) < 1e-9);
  assert.ok(Math.abs(p.points[2].arrivePct - 55) < 1e-9);
  assert.ok(Math.abs(p.points[2].afterPct - 80) < 1e-9);
  assert.ok(Math.abs(p.points[3].arrivePct - 77) < 1e-9);
  assert.strictEqual(p.firstLow, -1);
});

test('profile flags the first leg that drops below the reserve, and running out', () => {
  const ev = { pct: 30, rangeKm: 100, marginPct: 0, reservePct: 10 }; // 3.33 km per %
  const p = Ev.profile(ev, [30, 30, 30, 30], ['stop', 'stop', 'stop', 'home']); // each leg costs 9%: 21, 12, 3, -6
  assert.strictEqual(p.firstLow, 2);
  assert.strictEqual(p.firstEmpty, 3);
});

test('settings validation', () => {
  assert.strictEqual(Ev.problem({ pct: 80, rangeKm: 200, reservePct: 10, marginPct: 15 }), null);
  assert.ok(Ev.problem({ pct: 0, rangeKm: 200 }));
  assert.ok(Ev.problem({ pct: 80, rangeKm: 0 }));
  assert.ok(Ev.problem({ pct: 20, rangeKm: 200, reservePct: 30 }));
});

/* ---------- charger lookup parsing ---------- */

test('parseOverpass reads nodes and ways, skips private ones, finds power', () => {
  const json = { elements: [
    { type: 'node', id: 1, lat: 15.36, lon: 75.12, tags: { amenity: 'charging_station', name: 'Tata Power', 'socket:ccs:output': '60 kW', 'socket:type2:output': '22 kW', capacity: '4' } },
    { type: 'way', id: 2, center: { lat: 15.4, lon: 75.1 }, tags: { amenity: 'charging_station', operator: 'Ather Grid' } },
    { type: 'node', id: 3, lat: 15.3, lon: 75.1, tags: { amenity: 'charging_station', access: 'private' } },
    { type: 'node', id: 4, lat: 15.3, lon: 75.1, tags: { amenity: 'cafe' } },
    { type: 'node', id: 1, lat: 15.36, lon: 75.12, tags: { amenity: 'charging_station' } }
  ] };
  const out = C.parseOverpass(json);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].name, 'Tata Power');
  assert.strictEqual(out[0].kw, 60);
  assert.strictEqual(out[0].sockets, 4);
  assert.strictEqual(out[1].name, 'Ather Grid');
  assert.strictEqual(out[1].lat, 15.4);
  assert.strictEqual(out[1].kw, null);
});

test('bboxAround covers every point with padding', () => {
  const b = C.bboxAround([{ lat: 15.3, lng: 75.0 }, { lat: 15.4, lng: 75.2 }], 5);
  assert.ok(b.south < 15.3 && b.north > 15.4 && b.west < 75.0 && b.east > 75.2);
});
