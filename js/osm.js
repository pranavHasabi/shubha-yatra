/* Free provider: Leaflet + OpenStreetMap tiles, Nominatim search, OSRM road routing. No key needed.
   Same interface as Gmaps (js/maps.js), so app.js does not care which one is active. */
(function (root) {
  'use strict';

  var NOMINATIM = 'https://nominatim.openstreetmap.org';
  var OSRM = 'https://router.project-osrm.org';
  // OSRM assumes clear roads; a city with traffic and stops is slower.
  var TIME_FACTOR = 1.25;
  var PRECISE = /^(house|building|shop|amenity|office|tourism|leisure|historic|craft|man_made|healthcare|place_of_worship)$/;

  var map = null, layer = null;

  async function init() {
    if (!root.L) throw new Error('The map could not load. Check your internet and refresh.');
  }

  function showMap(el, center) {
    if (map) return map;
    map = root.L.map(el, { zoomControl: true, attributionControl: true }).setView(center ? [center.lat, center.lng] : [15.36, 75.12], 12);
    root.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    layer = root.L.layerGroup().addTo(map);
    return map;
  }

  function clearOverlays() { if (layer) layer.clearLayers(); }

  function addMarker(pos, o) {
    var size = (o.scale || 11) * 2 + 4;
    var html = '<div class="lpin" style="width:' + size + 'px;height:' + size + 'px;background:' + o.fill + ';border-color:' + (o.stroke || '#fff') +
      ';color:' + (o.textColor || '#fff') + '">' + (o.label ? String(o.label).replace(/[&<>]/g, '') : '') + '</div>';
    var m = root.L.marker([pos.lat, pos.lng], {
      icon: root.L.divIcon({ className: 'lpin-wrap', html: html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
      title: o.title || '', draggable: !!o.draggable, zIndexOffset: (o.z || 1) * 100, keyboard: !!o.draggable
    });
    if (o.draggable && o.onDrag) {
      m.on('dragend', function () { var p = m.getLatLng(); o.onDrag({ lat: p.lat, lng: p.lng }); });
    }
    m.addTo(layer);
    m.__setPos = function (p) { m.setLatLng([p.lat, p.lng]); };
    return m;
  }

  function addLine(path, style) {
    style = style || {};
    var dashed = !!style.icons;
    root.L.polyline(path.map(function (p) { return [p.lat, p.lng]; }), {
      color: style.strokeColor || '#8E1F3A', weight: dashed ? 2 : 4,
      opacity: dashed ? 0.7 : (style.strokeOpacity == null ? 0.95 : style.strokeOpacity),
      dashArray: dashed ? '6 8' : null, lineJoin: 'round'
    }).addTo(layer);
  }

  function fit(points) {
    if (!map || !points.length) return;
    // The map may have been created while its panel was hidden; measure it again before fitting.
    map.invalidateSize({ animate: false });
    map.fitBounds(root.L.latLngBounds(points.map(function (p) { return [p.lat, p.lng]; })), { padding: [48, 48], maxZoom: 17, animate: false });
  }

  function panTo(pos, zoom) { if (map) map.setView([pos.lat, pos.lng], zoom || 17); }

  function onMapClick(handler) {
    if (!map) return function () {};
    var f = function (e) { handler({ lat: e.latlng.lat, lng: e.latlng.lng }); };
    map.on('click', f);
    return function () { map.off('click', f); };
  }

  function resize() { if (map) map.invalidateSize({ animate: false }); }

  /* Nominatim asks for at most one request per second. */
  var chain = Promise.resolve();
  function throttled(url) {
    var run = chain.then(function () { return fetchJson(url, 25000); });
    chain = run.catch(function () {}).then(function () { return new Promise(function (r) { setTimeout(r, 1100); }); });
    return run;
  }

  async function fetchJson(url, ms) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, ms);
    try {
      var res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('The free map service answered with an error (' + res.status + '). Try again in a moment.');
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('The free map service is not answering. Try again in a moment.');
      throw e;
    } finally { clearTimeout(timer); }
  }

  function biasParams(bias) {
    if (!bias) return '';
    var d = 0.4;
    return '&viewbox=' + [bias.lng - d, bias.lat + d, bias.lng + d, bias.lat - d].join(',');
  }

  function shape(r) {
    var addr = r.address || {};
    var precise = !!addr.house_number || PRECISE.test(r.addresstype || '') || PRECISE.test(r.class || '');
    var display = root.Geo.tidyAddress(r.display_name);
    return {
      name: r.name || display.split(',')[0], address: display,
      lat: parseFloat(r.lat), lng: parseFloat(r.lon), approx: !precise
    };
  }

  async function search(text, bias, limit) {
    var rows = await throttled(NOMINATIM + '/search?format=jsonv2&addressdetails=1&limit=' + (limit || 6) + '&q=' + encodeURIComponent(text) + biasParams(bias));
    return rows.map(shape);
  }

  /** A search box: type, press Enter, pick a result. Also accepts a pasted map link or coordinates. */
  async function createSearchBox(onPick, bias) {
    var wrap = document.createElement('div');
    wrap.className = 'osmsearch';
    wrap.innerHTML = '<div class="row"><input type="text" class="osminput" placeholder="Search a name or address" aria-label="Search a name or address" autocomplete="off" spellcheck="false">' +
      '<button type="button" class="btn small osmgo">Search</button></div>' +
      '<div class="osmmsg muted" aria-live="polite"></div><ul class="osmres list" hidden></ul>';
    var input = wrap.querySelector('input'), go = wrap.querySelector('.osmgo');
    var msg = wrap.querySelector('.osmmsg'), ul = wrap.querySelector('.osmres');
    var busy = false;

    async function run() {
      var text = input.value.trim();
      if (!text || busy) return;
      ul.hidden = true; ul.innerHTML = '';
      var pos = root.Geo.parseLatLng(text);
      if (pos) {
        msg.textContent = '';
        var a = { name: 'Pinned spot', address: pos.lat.toFixed(5) + ', ' + pos.lng.toFixed(5), approx: false };
        try { var g = await reverseGeocode(pos); a.address = g.address; a.name = g.address.split(',')[0]; } catch (e) { /* keep coordinates */ }
        onPick({ name: a.name, address: a.address, lat: pos.lat, lng: pos.lng, approx: false });
        input.value = '';
        return;
      }
      if (root.Geo.isShortLink(text)) {
        msg.textContent = 'That is a short link. Open it, then copy the long address from the browser, or search by name instead.';
        return;
      }
      busy = true; go.setAttribute('aria-disabled', 'true'); msg.textContent = 'Searching…';
      try {
        var rows = await search(text, bias, 6);
        if (!rows.length) { msg.textContent = 'Nothing found. Try the colony or landmark name, or drop a pin on the map.'; return; }
        msg.textContent = '';
        ul.innerHTML = '';
        rows.forEach(function (r) {
          var li = document.createElement('li');
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'osmpick';
          b.innerHTML = '<span class="osmname"></span><span class="ad"></span>';
          b.querySelector('.osmname').textContent = r.name + (r.approx ? ' (area only)' : '');
          b.querySelector('.ad').textContent = r.address;
          b.addEventListener('click', function () { ul.hidden = true; ul.innerHTML = ''; input.value = ''; onPick(r); });
          li.appendChild(b); ul.appendChild(li);
        });
        ul.hidden = false;
      } catch (e) { msg.textContent = e.message; }
      finally { busy = false; go.removeAttribute('aria-disabled'); }
    }

    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    go.addEventListener('click', run);
    return wrap;
  }

  async function geocodeAddress(text, bias) {
    var pos = root.Geo.parseLatLng(text);
    if (pos) return { address: pos.lat.toFixed(5) + ', ' + pos.lng.toFixed(5), lat: pos.lat, lng: pos.lng, approx: false };
    var rows = await search(text, bias, 1);
    if (!rows.length) throw new Error('No match found');
    return rows[0];
  }

  async function reverseGeocode(pos) {
    var r = await throttled(NOMINATIM + '/reverse?format=jsonv2&zoom=18&lat=' + pos.lat + '&lon=' + pos.lng);
    if (!r || !r.display_name) throw new Error('No match found');
    return { address: root.Geo.tidyAddress(r.display_name), lat: pos.lat, lng: pos.lng };
  }

  async function roadRoute(points) {
    var coords = points.map(function (p) { return p.lng.toFixed(6) + ',' + p.lat.toFixed(6); }).join(';');
    var d = await fetchJson(OSRM + '/route/v1/driving/' + coords + '?overview=full&geometries=geojson&steps=false', 20000);
    if (d.code !== 'Ok' || !d.routes || !d.routes[0]) throw new Error('No road route found');
    var r = d.routes[0];
    return {
      path: r.geometry.coordinates.map(function (c) { return { lat: c[1], lng: c[0] }; }),
      meters: r.distance, seconds: Math.round(r.duration * TIME_FACTOR),
      legs: r.legs.map(function (l) { return { meters: l.distance, seconds: Math.round(l.duration * TIME_FACTOR) }; })
    };
  }

  root.Osm = {
    id: 'osm', maxRoutePoints: 40,
    init: init, showMap: showMap, clearOverlays: clearOverlays, addMarker: addMarker, addLine: addLine, fit: fit, panTo: panTo,
    onMapClick: onMapClick, resize: resize, createSearchBox: createSearchBox,
    geocodeAddress: geocodeAddress, reverseGeocode: reverseGeocode, roadRoute: roadRoute
  };
})(window);
