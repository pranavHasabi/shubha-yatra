const test = require('node:test');
const assert = require('node:assert');
const S = require('../js/solver.js');

function rng(seed) {
  let t = seed;
  return () => { t = (t * 1664525 + 1013904223) % 4294967296; return t / 4294967296; };
}
function randomStops(n, seed) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({ id: 's' + i, lat: 15.30 + r() * 0.12, lng: 75.05 + r() * 0.12 }));
}
const HOME = { lat: 15.36, lng: 75.11 };

function permutations(a) {
  if (a.length <= 1) return [a];
  return a.flatMap((x, i) => permutations(a.slice(0, i).concat(a.slice(i + 1))).map((p) => [x].concat(p)));
}

test('no stops gives an empty route', () => {
  assert.deepStrictEqual(S.planRoute(HOME, [], {}).order, []);
});

test('stops on a line are visited in line order from one end (open route)', () => {
  const start = { lat: 15.0, lng: 75.0 };
  const stops = [3, 1, 4, 2].map((k) => ({ id: 'p' + k, lat: 15.0 + k * 0.01, lng: 75.0 }));
  const res = S.planRoute(start, stops, { returnHome: false });
  assert.deepStrictEqual(res.order, ['p1', 'p2', 'p3', 'p4']);
});

test('result is never longer than the order the user typed', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const stops = randomStops(25, seed);
    const res = S.planRoute(HOME, stops, { returnHome: true });
    assert.ok(res.km <= res.userKm + 1e-9, 'seed ' + seed);
    assert.strictEqual(new Set(res.order).size, 25, 'every stop visited exactly once');
  }
});

test('matches the true optimum on small sets (brute force)', () => {
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const stops = randomStops(7, seed);
    for (const returnHome of [true, false]) {
      let best = Infinity;
      for (const p of permutations(stops.map((s) => s.id))) best = Math.min(best, S.orderKm(HOME, stops, p, returnHome));
      const res = S.planRoute(HOME, stops, { returnHome });
      assert.ok(Math.abs(res.km - best) < 1e-6, `seed ${seed} return ${returnHome}: ${res.km} vs ${best}`);
    }
  }
});

test('reported km equals the km of the returned order', () => {
  const stops = randomStops(30, 99);
  const res = S.planRoute(HOME, stops, { returnHome: true });
  assert.ok(Math.abs(res.km - S.orderKm(HOME, stops, res.order, true)) < 1e-6);
});

test('a locked first and last stop stay where they are', () => {
  const stops = randomStops(15, 7);
  const res = S.planRoute(HOME, stops, { returnHome: true, firstId: 's9', lastId: 's2' });
  assert.strictEqual(res.order[0], 's9');
  assert.strictEqual(res.order[res.order.length - 1], 's2');
  assert.strictEqual(new Set(res.order).size, 15);
});

test('locks cost at most a little and are optimal among locked orders (small set)', () => {
  const stops = randomStops(6, 21);
  const ids = stops.map((s) => s.id);
  let best = Infinity;
  for (const p of permutations(ids.filter((i) => i !== 's0' && i !== 's5'))) {
    best = Math.min(best, S.orderKm(HOME, stops, ['s0'].concat(p, ['s5']), true));
  }
  const res = S.planRoute(HOME, stops, { returnHome: true, firstId: 's0', lastId: 's5' });
  assert.ok(Math.abs(res.km - best) < 1e-6);
});

test('same input gives the same answer', () => {
  const stops = randomStops(40, 5);
  assert.deepStrictEqual(S.planRoute(HOME, stops, {}).order, S.planRoute(HOME, stops, {}).order);
});

test('history only goes down and ends at the final distance', () => {
  const res = S.planRoute(HOME, randomStops(30, 3), {});
  for (let k = 1; k < res.history.length; k++) assert.ok(res.history[k] <= res.history[k - 1] + 1e-9);
  assert.ok(Math.abs(res.history[res.history.length - 1] - res.km) < 1e-6);
});

test('handles 150 stops quickly', () => {
  const t0 = Date.now();
  const res = S.planRoute(HOME, randomStops(150, 8), {});
  assert.strictEqual(res.order.length, 150);
  assert.ok(Date.now() - t0 < 15000, 'took ' + (Date.now() - t0) + ' ms');
});

test('chunkWithOverlap shares join points and covers everything', () => {
  assert.deepStrictEqual(S.chunkWithOverlap([1, 2, 3], 5), [[1, 2, 3]]);
  assert.deepStrictEqual(S.chunkWithOverlap([1, 2, 3, 4, 5], 3), [[1, 2, 3], [3, 4, 5]]);
  assert.deepStrictEqual(S.chunkWithOverlap([1, 2, 3, 4, 5, 6], 3), [[1, 2, 3], [3, 4, 5], [5, 6]]);
});

test('mapsUrl builds a driving link with at most 9 waypoints', () => {
  const pts = Array.from({ length: 12 }, (_, i) => ({ lat: 15 + i / 100, lng: 75 }));
  const u = new URL(S.mapsUrl(null, { lat: 16, lng: 75.5 }, pts));
  assert.strictEqual(u.searchParams.get('destination'), '16.000000,75.500000');
  assert.strictEqual(u.searchParams.get('waypoints').split('|').length, 9);
  assert.strictEqual(u.searchParams.get('origin'), null);
});
