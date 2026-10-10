/* Public EV charging stations from OpenStreetMap (Overpass API). Free, no key. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Chargers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

  function maxKw(tags) {
    var best = 0;
    Object.keys(tags).forEach(function (k) {
      if (/^socket:.*:output$/.test(k)) {
        var m = String(tags[k]).match(/(\d+(?:[.,]\d+)?)\s*(kw|w)?/i);
        if (m) {
          var v = parseFloat(m[1].replace(',', '.'));
          if (m[2] && m[2].toLowerCase() === 'w') v /= 1000;
          if (v > best) best = v;
        }
      }
    });
    return best || null;
  }

  /** Turn an Overpass response into [{id,name,operator,lat,lng,kw,sockets}], skipping private chargers. */
  function parseOverpass(json) {
    var seen = {}, out = [];
    ((json && json.elements) || []).forEach(function (el) {
      var tags = el.tags || {};
      if (tags.amenity !== 'charging_station') return;
      if (tags.access === 'private' || tags.access === 'no') return;
      var lat = el.lat != null ? el.lat : el.center && el.center.lat;
      var lng = el.lon != null ? el.lon : el.center && el.center.lon;
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      var id = 'c' + el.type[0] + el.id;
      if (seen[id]) return;
      seen[id] = true;
      var operator = tags.operator || tags.brand || tags.network || '';
      out.push({
        id: id, name: tags.name || operator || 'EV charging station', operator: operator,
        lat: lat, lng: lng, kw: maxKw(tags), sockets: parseInt(tags.capacity, 10) || null, manual: false
      });
    });
    return out;
  }

  /** bbox: {south, west, north, east}. Tries each Overpass server in turn. */
  async function fetchChargers(bbox) {
    var b = [bbox.south, bbox.west, bbox.north, bbox.east].map(function (v) { return v.toFixed(5); }).join(',');
    var q = '[out:json][timeout:25];(node["amenity"="charging_station"](' + b + ');way["amenity"="charging_station"](' + b + '););out center tags;';
    var lastErr = null;
    for (var i = 0; i < ENDPOINTS.length; i++) {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 30000);
      try {
        var res = await fetch(ENDPOINTS[i] + '?data=' + encodeURIComponent(q), { signal: ctl.signal });
        if (!res.ok) throw new Error('status ' + res.status);
        return parseOverpass(await res.json());
      } catch (e) { lastErr = e; }
      finally { clearTimeout(timer); }
    }
    throw new Error('Could not look up charging stations right now (' + (lastErr && lastErr.message || 'no answer') + ').');
  }

  /** A box around the start and every stop, padded by padKm so nearby chargers are included. */
  function bboxAround(points, padKm) {
    var s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
    points.forEach(function (p) {
      if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat;
      if (p.lng < w) w = p.lng; if (p.lng > e) e = p.lng;
    });
    var dLat = padKm / 111, dLng = padKm / (111 * Math.cos(((s + n) / 2) * Math.PI / 180));
    return { south: s - dLat, north: n + dLat, west: w - dLng, east: e + dLng };
  }

  return { parseOverpass: parseOverpass, fetchChargers: fetchChargers, bboxAround: bboxAround };
});
