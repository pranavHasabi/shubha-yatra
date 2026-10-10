/* Electric car battery maths. Pure functions, no browser needed. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ev = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = { enabled: false, pct: 80, rangeKm: 200, reservePct: 10, marginPct: 15, endAtCharger: true, chargeTo: 80 };

  function withDefaults(ev) {
    var out = Object.assign({}, DEFAULTS, ev || {});
    ['pct', 'rangeKm', 'reservePct', 'marginPct', 'chargeTo'].forEach(function (k) { out[k] = Number(out[k]); });
    return out;
  }

  /** Why these settings cannot be used, or null if they are fine. */
  function problem(ev) {
    ev = withDefaults(ev);
    if (!(ev.pct >= 1 && ev.pct <= 100)) return 'Battery must be between 1% and 100%.';
    if (!(ev.rangeKm > 0)) return 'Enter the range your car shows, in km.';
    if (!(ev.reservePct >= 0 && ev.reservePct < ev.pct)) return 'The reserve must be lower than your current battery.';
    if (!(ev.marginPct >= 0 && ev.marginPct <= 60)) return 'Safety margin must be between 0% and 60%.';
    return null;
  }

  /**
   * Kilometres you can really drive per 1% of battery: the range the dashboard shows now, divided by the
   * battery now, reduced by the safety margin (dashboard range is optimistic in city traffic and with the AC on).
   */
  function kmPerPct(ev) {
    ev = withDefaults(ev);
    return (ev.rangeKm * (1 - ev.marginPct / 100)) / ev.pct;
  }

  function pctForKm(ev, km) { return km / kmPerPct(ev); }

  /**
   * legsKm: distance of each leg, in order from home. kinds[i] says what the leg ends at: 'stop', 'charger' or 'home'.
   * Returns {points:[{arrivePct, afterPct, kind, low, empty}], firstLow, firstEmpty, totalPct}.
   * low: arrives below the reserve. empty: would run out. At a charger the battery is topped up to chargeTo.
   */
  function profile(ev, legsKm, kinds, startPct) {
    ev = withDefaults(ev);
    // startPct lets the caller resume part-way through a run; the km-per-% rate still comes from the departure figures.
    var per = kmPerPct(ev), pct = startPct != null ? startPct : ev.pct, used = 0;
    var points = [], firstLow = -1, firstEmpty = -1;
    for (var i = 0; i < legsKm.length; i++) {
      var d = legsKm[i] / per;
      pct -= d; used += d;
      var p = { arrivePct: pct, kind: kinds[i] || 'stop', low: pct < ev.reservePct, empty: pct <= 0 };
      if (p.low && firstLow < 0) firstLow = i;
      if (p.empty && firstEmpty < 0) firstEmpty = i;
      if (p.kind === 'charger') {
        pct = Math.max(pct, ev.chargeTo);
        p.afterPct = pct;
      }
      points.push(p);
    }
    return { points: points, firstLow: firstLow, firstEmpty: firstEmpty, totalPct: used };
  }

  return { DEFAULTS: DEFAULTS, withDefaults: withDefaults, problem: problem, kmPerPct: kmPerPct, pctForKm: pctForKm, profile: profile };
});
