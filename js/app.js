(function () {
  'use strict';

  var STORE = 'shubha-yatra-v1';
  var VIEWS = ['setup', 'stops', 'planning', 'route', 'road'];
  var S = load();
  var G = S.provider === 'google' ? Gmaps : Osm;
  var mapReady = false;
  var adjustId = null;
  var adjustOff = null;
  var pinMode = false;
  var pinKind = 'stop';
  var chargerBusy = false;
  var stopPinListener = null;
  var undoStack = [];
  var refreshToken = 0;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var viewEl = $('#view');

  /* ---------- state ---------- */

  function blank() {
    return {
      provider: 'osm', apiKey: '', start: null, returnHome: true, stops: [], order: [], route: null, view: 'setup',
      ev: Ev.withDefaults(), chargers: [], charger: null, chargerId: null, chargeDone: false
    };
  }
  function load() {
    var s = blank();
    try {
      var raw = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (raw && typeof raw === 'object') {
        s = Object.assign(s, raw);
        if (!raw.provider) s.provider = raw.apiKey ? 'google' : 'osm';
        if (s.provider !== 'google') s.provider = 'osm';
        if (!Array.isArray(s.stops)) s.stops = [];
        if (!Array.isArray(s.order)) s.order = [];
        if (!Array.isArray(s.chargers)) s.chargers = [];
      }
      s.ev = Ev.withDefaults(s.ev);
    } catch (e) { /* storage blocked or corrupt: start fresh */ }
    if (s.view === 'planning' || VIEWS.indexOf(s.view) < 0) s.view = s.start ? 'stops' : 'setup';
    return s;
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* private mode: keep working in memory */ }
  }

  /* ---------- helpers ---------- */

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function byId(id) { return S.stops.filter(function (s) { return s.id === id; })[0]; }
  function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function fmtKm(km) { return (Math.round(km * 10) / 10).toFixed(1) + ' km'; }
  function fmtTime(sec) {
    var m = Math.round(sec / 60);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60 ? (m % 60) + ' min' : '').trim();
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3600);
  }
  function icon(name) {
    var p = {
      pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
      paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6"/>',
      x: '<path d="M6 6l12 12M18 6L6 18"/>',
      up: '<path d="M6 15l6-6 6 6"/>',
      down: '<path d="M6 9l6 6 6-6"/>',
      nav: '<path d="M3 11l18-8-8 18-2-8-8-2z"/>',
      locate: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'
    }[name];
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }

  /* ---------- view switching ---------- */

  function setView(v) {
    S.view = v;
    if (v !== 'planning') save();
    render();
  }

  function render() {
    document.body.classList.toggle('nomap', S.view === 'setup' || !mapReady);
    ({ setup: renderSetup, stops: renderStops, planning: renderPlanning, route: renderRoute, road: renderRoad })[S.view]();
    viewEl.parentNode.scrollTop = 0;
    if (S.view !== 'setup' && mapReady) {
      G.showMap($('#map'), S.start);
      G.resize();
      drawMap();
    }
    if (S.view !== 'stops') { setPinMode(false); if (adjustId) endAdjust(); }
  }

  /* ---------- map drawing ---------- */

  function pendingOrdered() {
    return S.order.map(byId).filter(function (s) { return s && !s.done; });
  }

  function drawMap(opts) {
    if (!mapReady) return;
    opts = opts || {};
    G.clearOverlays();
    var pts = [];
    if (S.start) { G.addMarker(S.start, { fill: '#8E1F3A', scale: 13, label: 'S', title: 'Start', z: 5 }); pts.push(S.start); }
    var ordered = S.route ? S.order : [];
    var pend = pendingOrdered();
    var nextId = S.view === 'road' && pend[0] ? pend[0].id : null;
    S.stops.forEach(function (s) {
      var idx = ordered.indexOf(s.id);
      var o = { title: s.name, z: 3 };
      if (s.done) { o.fill = '#1F5E2D'; o.label = '✓'; }
      else if (s.id === nextId) { o.fill = '#B7791F'; o.scale = 14; o.z = 4; o.label = String(pend.indexOf(s) + 1 + doneCount()); }
      else if (idx >= 0) { o.fill = '#8E1F3A'; o.label = String(idx + 1); }
      else { o.fill = '#ffffff'; o.stroke = '#8E1F3A'; o.scale = 9; }
      if (s.id === adjustId) { o.fill = '#B7791F'; o.scale = 14; o.z = 6; o.label = '+'; o.draggable = true; o.onDrag = moveAdjusted; }
      G.addMarker(s, o);
      pts.push(s);
    });
    var active = activeCharger();
    if (S.ev.enabled) {
      chargersByDistance().slice(0, 40).forEach(function (c) {
        if (active && c.id === active.id) return;
        G.addMarker(c, { fill: '#0B6E4F', scale: 8, label: 'E', title: c.name, z: 2 });
      });
    }
    if (active) {
      G.addMarker(active, { fill: '#0B6E4F', scale: 13, label: 'E', title: 'Charge here: ' + active.name, z: 5 });
      pts.push(active);
    }
    if (opts.messy && opts.messy.length) {
      var path = [S.start].concat(opts.messy);
      if (S.returnHome) path.push(S.start);
      G.addLine(path, {
        strokeOpacity: 0, strokeColor: '#B3261E',
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.7, scale: 3 }, offset: '0', repeat: '12px' }]
      });
    } else if (S.route && S.route.path && (S.view === 'route' || S.view === 'road')) {
      G.addLine(S.route.path);
    }
    if (!opts.keep) G.fit(pts);
  }

  function doneCount() { return S.stops.filter(function (s) { return s.done; }).length; }

  /* ---------- setup ---------- */

  function renderSetup() {
    var connected = mapReady;
    var google = S.provider === 'google';
    viewEl.innerHTML =
      '<div class="field" style="gap:12px">' +
      '<h1>Plan your card run</h1>' +
      '<p class="muted" style="font-size:16px">Add every home you need to visit. You get the shortest order, so you never drive back and forth.</p></div>' +
      '<div class="field"><span class="lbl">Map</span><div class="seg" role="group" aria-label="Map">' +
      '<button type="button" data-act="provider" data-val="osm" aria-pressed="' + !google + '">Free map, no key</button>' +
      '<button type="button" data-act="provider" data-val="google" aria-pressed="' + google + '">Google Maps</button></div>' +
      '<span class="muted">' + (google ? 'Better at finding exact house addresses. Needs a Google key.' : 'OpenStreetMap. Works at once. Finds areas and landmarks well; for an exact house, drag the pin.') + '</span></div>' +
      (google ?
        '<div class="field"><label for="key">Google Maps key</label>' +
        '<div class="row"><input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="AIzaSy..." value="' + esc(S.apiKey) + '">' +
        '<button class="btn small" data-act="connect" type="button">' + (connected ? 'Reconnect' : 'Connect') + '</button></div>' +
        '<div id="keystatus" class="status' + (connected ? ' ok' : '') + '"' + (connected ? '' : ' hidden') + '>' + (connected ? 'Connected to Google Maps' : '') + '</div>' +
        '<span class="muted">Saved only on this device. Never sent anywhere except to Google.</span></div>' +
        '<details class="help"><summary>How to get a key</summary><ol>' +
        '<li>Open <strong>console.cloud.google.com</strong> and create a project. Turn on billing (Google gives a monthly free credit that covers a few hundred stops).</li>' +
        '<li>In APIs and services, enable: <strong>Maps JavaScript API</strong>, <strong>Places API (New)</strong>, <strong>Geocoding API</strong> and <strong>Routes API</strong>.</li>' +
        '<li>Create an API key. Under restrictions, limit it to websites and add this page\'s address.</li>' +
        '<li>Paste the key above and tap Connect.</li></ol></details>' : '') +
      '<div class="field"><label for="startbox">Start point</label>' +
      '<div id="startbox">' + (connected ? '' : '<div class="muted">' + (google ? 'Connect your key first.' : 'Loading the map…') + '</div>') + '</div>' +
      '<div id="startchosen" class="chosen">' + startChosenHtml() + '</div>' +
      '<div><button class="btn small" data-act="locate" type="button" ' + (connected ? '' : 'aria-disabled="true"') + '>' + icon('locate').replace('<svg', '<svg width="18" height="18"') + ' Use my location</button></div></div>' +
      '<label class="switch"><span><span style="font-weight:500;display:block">Return to start</span><span class="muted">End the route back home</span></span>' +
      '<input type="checkbox" data-act="return" ' + (S.returnHome ? 'checked' : '') + '><span class="t"></span></label>' +
      '<div class="actions"><button class="btn primary grow" data-act="tostops" type="button">' + (S.stops.length ? 'Continue' : 'Save and add stops') + '</button></div>';
    if (connected) mountStartBox();
  }

  function startChosenHtml() {
    return S.start ? 'Starting from <strong>' + esc(S.start.address || S.start.name || 'your chosen spot') + '</strong>' : 'No start point yet.';
  }

  async function mountStartBox() {
    var box = $('#startbox');
    if (!box) return;
    var el = await G.createSearchBox(function (p, err) {
      if (!p) { toast('Could not read that place. Try again.'); return; }
      S.start = { lat: p.lat, lng: p.lng, name: p.name, address: p.address || p.name };
      save();
      $('#startchosen').innerHTML = startChosenHtml();
    }, S.start);
    box.innerHTML = '';
    box.appendChild(el);
  }

  function setProvider(name) {
    name = name === 'google' ? 'google' : 'osm';
    if (S.provider === name) return;
    S.provider = name;
    S.view = 'setup';
    save();
    // Each provider owns its own map object, so start clean rather than mixing two on one element.
    location.reload();
  }

  async function connect() {
    var key = $('#key').value.trim();
    var st = $('#keystatus');
    if (!key) { st.hidden = false; st.className = 'status bad'; st.textContent = 'Paste your Google Maps key first.'; return; }
    st.hidden = false; st.className = 'status'; st.textContent = 'Connecting…';
    try {
      await G.init(key);
      S.apiKey = key; mapReady = true; save();
      st.className = 'status ok'; st.textContent = 'Connected to Google Maps';
      mountStartBox();
    } catch (e) {
      mapReady = false;
      st.className = 'status bad'; st.textContent = e.message || 'Could not connect.';
    }
  }

  function locate() {
    if (!navigator.geolocation) { toast('This device cannot share its location.'); return; }
    toast('Finding you…');
    navigator.geolocation.getCurrentPosition(async function (pos) {
      var p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      var address = 'My location';
      try { address = (await G.reverseGeocode(p)).address; } catch (e) { /* keep the label */ }
      S.start = { lat: p.lat, lng: p.lng, name: 'My location', address: address };
      save();
      var c = $('#startchosen'); if (c) c.innerHTML = startChosenHtml();
    }, function () { toast('Could not get your location. Search for it instead.'); }, { enableHighAccuracy: true, timeout: 10000 });
  }

  /* ---------- stops ---------- */

  function renderStops() {
    viewEl.innerHTML =
      '<div class="head"><h1>Stops</h1><span class="count" id="stopcount"></span></div>' +
      '<div class="tools"><div class="grow" id="searchbox"></div>' +
      '<button class="iconbtn' + (pinMode ? ' on' : '') + '" data-act="pin" type="button" aria-label="Drop a pin on the map" aria-pressed="' + pinMode + '">' + icon('pin') + '</button>' +
      '<button class="iconbtn" data-act="paste" type="button" aria-label="Paste a list of addresses">' + icon('paste') + '</button></div>' +
      '<ul class="list" id="stoplist"></ul>' +
      '<div id="evpanel"></div>' +
      '<div class="more">' +
      '<button class="link" data-act="setup" type="button">Start point and key</button>' +
      '<button class="link" data-act="backup" type="button">Save backup</button>' +
      '<button class="link" data-act="restore" type="button">Restore backup</button>' +
      '<button class="link" data-act="clear" type="button">Clear all</button>' +
      '<input type="file" id="restorefile" accept="application/json" hidden></div>' +
      '<div class="actions"><button class="btn primary grow" data-act="plan" type="button">Plan best route</button></div>';
    renderStopList();
    renderEv();
    mountSearch();
  }

  async function mountSearch() {
    var box = $('#searchbox');
    if (!box || !mapReady) return;
    var el = await G.createSearchBox(function (p) {
      if (!p) { toast('Could not read that place. Try again.'); return; }
      addStop({ name: p.name, address: p.address, lat: p.lat, lng: p.lng, approx: !!p.approx });
    }, S.start);
    box.innerHTML = '';
    box.appendChild(el);
  }

  function renderStopList() {
    var list = $('#stoplist');
    if (!list) return;
    var cnt = $('#stopcount');
    var pend = S.stops.filter(function (s) { return !s.done; }).length;
    if (cnt) cnt.textContent = S.stops.length + (S.stops.length === 1 ? ' home' : ' homes');
    if (!S.stops.length) {
      list.innerHTML = '<li class="empty" style="display:block;width:100%">Search a name or address above, drop a pin, or paste a list. Add at least two homes to plan a route.</li>';
      return;
    }
    list.innerHTML = S.stops.map(function (s, i) {
      return '<li><div class="mid"><input class="nm" type="text" value="' + esc(s.name) + '" data-field="name" data-id="' + s.id + '" aria-label="Name of stop ' + (i + 1) + '">' +
        '<span class="ad">' + esc(s.address) + '</span>' +
        '<span class="fix">' + (s.approx ? '<span class="approx">Area only</span>' : '') +
        '<button type="button" class="link tiny" data-act="adjust" data-id="' + s.id + '">' + (s.approx ? 'Place pin exactly' : 'Adjust pin') + '</button></span></div>' +
        '<input class="note" type="text" value="' + esc(s.note) + '" placeholder="Note" data-field="note" data-id="' + s.id + '" aria-label="Note for ' + esc(s.name) + '">' +
        '<button class="iconbtn sm" data-act="remove" data-id="' + s.id + '" type="button" aria-label="Remove ' + esc(s.name) + '">' + icon('x') + '</button></li>';
    }).join('');
    if (pend !== S.stops.length && cnt) cnt.textContent += ' (' + (S.stops.length - pend) + ' delivered)';
  }

  function addStop(p) {
    var name = (p.name || '').trim() || (p.address || 'Stop').split(',')[0];
    S.stops.push({ id: newId(), name: name, address: p.address || '', note: p.note || '', lat: p.lat, lng: p.lng, approx: !!p.approx, done: false, lock: null });
    invalidatePlan();
    save();
    renderStopList();
    drawMap();
  }

  function invalidatePlan() {
    S.route = null;
    S.order = S.order.filter(function (id) { return byId(id); });
  }

  function removeStop(id) {
    S.stops = S.stops.filter(function (s) { return s.id !== id; });
    invalidatePlan();
    save();
    renderStopList();
    drawMap();
  }

  function setPinMode(on, kind) {
    pinMode = on;
    document.body.classList.toggle('pinning', on);
    pinKind = kind || 'stop';
    if (on) showHint(pinKind === 'charger' ? 'Tap the map where the charging station is' : 'Tap the map to add a stop', false);
    else if (!adjustId) showHint('', false);
    var btn = $('[data-act="pin"]');
    if (btn) { btn.classList.toggle('on', on && pinKind === 'stop'); btn.setAttribute('aria-pressed', on && pinKind === 'stop'); }
    if (stopPinListener) { stopPinListener(); stopPinListener = null; }
    if (on && mapReady) {
      var kindNow = pinKind;
      stopPinListener = G.onMapClick(async function (pos) {
        var a = { name: kindNow === 'charger' ? 'My charger' : 'Pinned spot', address: pos.lat.toFixed(5) + ', ' + pos.lng.toFixed(5) };
        try {
          var g = await G.reverseGeocode(pos);
          a.address = g.address;
          if (kindNow === 'stop') a.name = g.address.split(',')[0];
        } catch (e) { /* keep coordinates */ }
        if (kindNow === 'charger') addManualCharger({ name: a.name, address: a.address, lat: pos.lat, lng: pos.lng });
        else addStop({ name: a.name, address: a.address, lat: pos.lat, lng: pos.lng });
        setPinMode(false);
      });
    }
  }

  /* ---------- electric car ---------- */

  function chargersByDistance() {
    if (!S.start) return S.chargers.slice();
    return S.chargers.map(function (c) { return Object.assign({}, c, { dist: Solver.haversine(S.start, c) }); })
      .sort(function (a, b) { return a.dist - b.dist; });
  }

  function numField(key, label, min, max) {
    return '<div class="field"><label for="ev-' + key + '">' + label + '</label>' +
      '<input id="ev-' + key + '" type="number" inputmode="decimal" min="' + min + '" max="' + max + '" step="1" value="' + esc(S.ev[key]) + '" data-ev="' + key + '"></div>';
  }

  function evSwitch(key, title, sub) {
    return '<label class="switch"><span><span style="font-weight:500;display:block">' + title + '</span><span class="muted">' + sub + '</span></span>' +
      '<input type="checkbox" data-ev="' + key + '"' + (S.ev[key] ? ' checked' : '') + '><span class="t"></span></label>';
  }

  function renderEv() {
    var box = $('#evpanel');
    if (!box) return;
    var ev = S.ev;
    var html = '<details class="help ev"' + (ev.enabled ? ' open' : '') + '><summary>Electric car' + (ev.enabled ? ' <span class="badge">On</span>' : '') + '</summary>' +
      '<div class="evbody">' + evSwitch('enabled', 'Plan for an electric car', 'Battery % at every stop, and finish at a charger');
    if (ev.enabled) {
      var bad = Ev.problem(ev);
      html += '<div class="evgrid">' + numField('pct', 'Battery at start (%)', 1, 100) + numField('rangeKm', 'Range shown (km)', 1, 1500) +
        numField('reservePct', 'Keep at least (%)', 0, 90) + numField('marginPct', 'Safety margin (%)', 0, 60) + '</div>' +
        (bad ? '<div class="status bad">' + esc(bad) + '</div>' : '') +
        evSwitch('endAtCharger', 'Finish at a charging station', 'Deliver everything, charge, then go home');
      if (ev.endAtCharger) {
        var list = chargersByDistance();
        html += numField('chargeTo', 'Charge up to (%)', 10, 100) +
          '<div class="field"><span class="lbl">Charging stations</span>' +
          '<span class="muted">' + (list.length ? list.length + ' known near your route. The best one is picked for you.' : 'None known yet. Search the map, or drop a pin where one is.') + '</span>' +
          '<div class="row"><button class="btn small" data-act="findchargers" type="button"' + (chargerBusy ? ' aria-disabled="true"' : '') + '>' + (chargerBusy ? 'Searching…' : 'Find chargers nearby') + '</button>' +
          '<button class="btn small" data-act="addcharger" type="button">Add a charger</button></div>' +
          (list.length ? '<ul class="list chg"><li><button class="osmpick" type="button" data-act="pickcharger" data-id="" aria-pressed="' + !S.chargerId + '"><span class="osmname">Auto</span><span class="ad">The one that adds the least distance</span></button></li>' +
            list.slice(0, 6).map(function (c) {
              return '<li><button class="osmpick" type="button" data-act="pickcharger" data-id="' + esc(c.id) + '" aria-pressed="' + (S.chargerId === c.id) + '"><span class="osmname">' + esc(c.name) + (c.manual ? ' (your pin)' : '') + '</span>' +
                '<span class="ad">' + (c.kw ? 'Up to ' + c.kw + ' kW · ' : '') + fmtKm(c.dist) + ' from start</span></button></li>';
            }).join('') + '</ul>' : '') + '</div>';
      }
    }
    box.innerHTML = html + '</div></details>';
  }

  async function loadChargers() {
    var found = await Chargers.fetchChargers(Chargers.bboxAround([S.start].concat(S.stops), 10));
    S.chargers = found.concat(S.chargers.filter(function (c) { return c.manual; }));
    save();
    return found.length;
  }

  async function findChargers() {
    if (!S.start) { toast('Set your start point first.'); return; }
    if (chargerBusy) return;
    chargerBusy = true; renderEv();
    try {
      var n = await loadChargers();
      toast(n ? n + ' charging stations found' : 'No charging stations in the map data nearby. Tap "Add a charger" and drop a pin.');
    } catch (e) { toast(e.message); }
    chargerBusy = false;
    renderEv();
    drawMap({ keep: true });
  }

  function addManualCharger(c) {
    S.chargers.push({ id: 'm' + Date.now().toString(36), name: c.name, operator: '', address: c.address, lat: c.lat, lng: c.lng, kw: null, sockets: null, manual: true });
    S.route = null; save(); renderEv(); drawMap({ keep: true });
    toast('Charger added');
  }

  /* ---------- place a pin exactly ---------- */

  function showHint(text, withDone) {
    var hint = $('#pinhint');
    if (!hint) return;
    hint.hidden = !text;
    $('#pinhinttext').textContent = text;
    $('#pinDone').hidden = !withDone;
  }

  function startAdjust(id) {
    var s = byId(id);
    if (!s || !mapReady) return;
    setPinMode(false);
    if (adjustOff) adjustOff();
    adjustId = id;
    showHint('Drag the pin, or tap the map, to the exact house. Then tap Done.', true);
    drawMap({ keep: true });
    G.panTo(s, 17);
    document.getElementById('mapwrap').scrollIntoView({ block: 'nearest' });
    adjustOff = G.onMapClick(moveAdjusted);
  }

  function moveAdjusted(pos) {
    var s = byId(adjustId);
    if (!s) return;
    s.lat = pos.lat; s.lng = pos.lng; s.approx = false;
    S.route = null;
    save();
    drawMap({ keep: true });
  }

  async function endAdjust() {
    var s = byId(adjustId);
    adjustId = null;
    if (adjustOff) { adjustOff(); adjustOff = null; }
    showHint('', false);
    if (!s) return;
    save();
    renderStopList();
    drawMap();
    try { var g = await G.reverseGeocode(s); s.address = g.address; save(); renderStopList(); } catch (e) { /* keep the old address text */ }
  }

  /* ---------- paste a list ---------- */

  function openPaste() {
    if (!mapReady) { toast('Connect your Google Maps key first.'); return; }
    $('#pastestatus').textContent = '';
    $('#pastedlg').showModal();
  }

  async function runPaste() {
    var lines = $('#pastetext').value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var status = $('#pastestatus');
    if (!lines.length) { status.textContent = 'Paste at least one address.'; return; }
    var failed = [], added = 0;
    $('#pastego').setAttribute('aria-disabled', 'true');
    for (var i = 0; i < lines.length; i++) {
      status.textContent = 'Adding ' + (i + 1) + ' of ' + lines.length + '…';
      var parts = lines[i].split('|');
      var name = parts.length > 1 ? parts[0].trim() : '';
      var addr = (parts.length > 1 ? parts.slice(1).join(' ') : parts[0]).trim();
      try {
        var pos = Geo.parseLatLng(addr);
        var g;
        if (pos) {
          g = { address: pos.lat.toFixed(5) + ', ' + pos.lng.toFixed(5), lat: pos.lat, lng: pos.lng, approx: false };
          try { var rg = await G.reverseGeocode(pos); g.address = rg.address; } catch (e2) { /* keep coordinates */ }
        } else if (Geo.isShortLink(addr)) {
          throw new Error('short link');
        } else {
          g = await G.geocodeAddress(addr, S.start);
        }
        addStop({ name: name || g.address.split(',')[0], address: g.address, lat: g.lat, lng: g.lng, approx: !!g.approx });
        added++;
      } catch (e) { failed.push(lines[i]); }
      await sleep(120);
    }
    $('#pastego').removeAttribute('aria-disabled');
    if (failed.length) {
      $('#pastetext').value = failed.join('\n');
      status.textContent = added + ' added. ' + failed.length + ' not found, left in the box. Make them more specific and try again.';
    } else {
      $('#pastetext').value = '';
      $('#pastedlg').close();
      toast(added + ' stops added');
    }
  }

  /* ---------- planning ---------- */

  function lockedId(kind) {
    var s = S.stops.filter(function (x) { return !x.done && x.lock === kind; })[0];
    return s ? s.id : null;
  }

  async function plan() {
    var pend = S.stops.filter(function (s) { return !s.done; });
    if (!S.start) { toast('Set your start point first.'); setView('setup'); return; }
    if (!mapReady) { toast('Connect your Google Maps key first.'); setView('setup'); return; }
    if (pend.length < 2) { toast('Add at least two homes to plan a route.'); return; }
    if (S.ev.enabled) {
      var bad = Ev.problem(S.ev);
      if (bad) { toast(bad); return; }
    }

    S.view = 'planning';
    S.charger = null; S.chargeDone = false;
    render();
    drawMap({ messy: pend });
    await sleep(80);

    var opts = {
      returnHome: S.returnHome, firstId: lockedId('first'), lastId: lockedId('last'),
      userOrder: pend.map(function (s) { return s.id; })
    };
    var res = null;
    if (S.ev.enabled && S.ev.endAtCharger) {
      if (!S.chargers.some(function (c) { return !c.manual; })) {
        try { await loadChargers(); } catch (e) { toast(e.message); }
      }
      if (S.chargers.length) {
        var pick = Solver.chooseCharger(S.start, pend, S.chargers, Object.assign({ chargerId: S.chargerId }, opts));
        if (pick) { S.charger = pick.charger; res = pick.result; }
      } else {
        toast('No charging stations found nearby. In the Electric car box, tap "Add a charger" and drop a pin.');
      }
    }
    if (!res) res = Solver.planRoute(S.start, pend, opts);
    var userEl = $('#pl-user'); if (userEl) userEl.textContent = fmtKm(res.userKm);
    var doneIds = S.order.filter(function (id) { var s = byId(id); return s && s.done; });
    S.stops.forEach(function (s) { if (s.done && doneIds.indexOf(s.id) < 0) doneIds.push(s.id); });
    S.order = doneIds.concat(res.order);
    S.route = null;

    var roads = refreshRoute();
    await playHistory(res);
    await roads;
    S.view = 'route';
    save();
    render();
  }

  async function playHistory(res) {
    var h = res.history, steps = Math.min(h.length, 36);
    var pick = [];
    for (var i = 0; i < steps; i++) pick.push(h[Math.round(i * (h.length - 1) / Math.max(1, steps - 1))]);
    var per = Math.max(60, Math.round(2400 / steps));
    var bestEl = $('#pl-best'), bar = $('#pl-bar'), msg = $('#pl-msg');
    for (var k = 0; k < pick.length; k++) {
      if (bestEl) bestEl.textContent = fmtKm(pick[k]);
      if (bar) bar.style.width = Math.round(((k + 1) / pick.length) * 90) + '%';
      if (msg && k > pick.length * 0.7) msg.textContent = 'Drawing the route…';
      await sleep(per);
    }
    if (bestEl) bestEl.textContent = fmtKm(res.km);
    if (bar) bar.style.width = '100%';
  }

  function renderPlanning() {
    var pend = S.stops.filter(function (s) { return !s.done; });
    var userKm = Solver.orderKm(S.start, pend, pend.map(function (s) { return s.id; }), S.returnHome);
    viewEl.innerHTML =
      '<div class="sheet"><div class="row" style="gap:14px"><div class="spin"></div><div>' +
      '<h2 id="pl-msg">Trying shorter orders…</h2><p class="muted">Checking ' + pend.length + ' homes. This takes a few seconds.</p></div></div>' +
      '<div class="twocol"><div><div class="muted">Your order</div><div class="kmbig bad" id="pl-user">' + fmtKm(userKm) + '</div></div>' +
      '<div><div class="muted">Best so far</div><div class="kmbig best" id="pl-best">' + fmtKm(userKm) + '</div></div></div>' +
      '<div class="bar"><div id="pl-bar" style="width:4%"></div></div></div>' +
      '<p class="muted" style="text-align:center">The red dashed line on the map is the order you entered.</p>';
  }

  /* ---------- road route ---------- */

  async function refreshRoute() {
    var token = ++refreshToken;
    var pend = pendingOrdered();
    if (!pend.length) { S.route = { km: 0, seconds: 0, legs: [], path: null, source: 'estimate' }; return; }
    var pts = [originPoint()].concat(pend);
    if (activeCharger()) pts.push(activeCharger());
    if (S.returnHome) pts.push(S.start);
    var legs = [], km = 0;
    for (var i = 0; i + 1 < pts.length; i++) {
      var d = Solver.haversine(pts[i], pts[i + 1]) * Solver.ROAD_FACTOR;
      legs.push(d); km += d;
    }
    var route = { km: km, seconds: Math.round(km / 25 * 3600), legs: legs, path: pts.map(function (p) { return { lat: p.lat, lng: p.lng }; }), source: 'estimate' };
    try {
      var chunks = Solver.chunkWithOverlap(pts, G.maxRoutePoints || 25), path = [], meters = 0, seconds = 0, rl = [];
      for (var c = 0; c < chunks.length; c++) {
        var r = await G.roadRoute(chunks[c]);
        path = path.concat(r.path); meters += r.meters; seconds += r.seconds;
        r.legs.forEach(function (l) { rl.push(l.meters / 1000); });
      }
      if (rl.length === pts.length - 1) route = { km: meters / 1000, seconds: seconds, legs: rl, path: path, source: 'road' };
      else route = { km: meters / 1000, seconds: seconds, legs: legs, path: path, source: 'road' };
    } catch (e) { /* keep the straight-line estimate */ }
    if (token === refreshToken) S.route = route;
  }

  /* ---------- route view ---------- */

  function activeCharger() {
    return S.ev.enabled && S.ev.endAtCharger && S.charger ? S.charger : null;
  }

  /* Where the car is now: the last home delivered, or the start if none yet. Done stops are always a prefix of the order. */
  function originPoint() {
    var last = null;
    S.order.forEach(function (id) { var s = byId(id); if (s && s.done) last = s; });
    return last || S.start;
  }

  /* Battery already used on legs driven so far (each delivery records the leg that led to it). */
  function usedPct() {
    var km = 0;
    S.stops.forEach(function (s) { if (s.done && s.legKm) km += s.legKm; });
    return S.ev.enabled && !Ev.problem(S.ev) ? Ev.pctForKm(S.ev, km) : 0;
  }

  /* Battery after each leg of the current route, or null when EV planning is off or the numbers are unusable. */
  function evProfile(pend) {
    if (!S.ev.enabled || Ev.problem(S.ev) || !S.route || !S.route.legs || !S.route.legs.length) return null;
    var kinds = pend.map(function () { return 'stop'; });
    if (activeCharger()) kinds.push('charger');
    if (S.returnHome) kinds.push('home');
    if (S.route.legs.length < kinds.length) return null;
    return Ev.profile(S.ev, S.route.legs.slice(0, kinds.length), kinds, S.ev.pct - usedPct());
  }

  function battChip(p) {
    if (!p) return '';
    var v = Math.max(0, Math.round(p.arrivePct));
    return '<span class="batt' + (p.empty ? ' empty' : p.low ? ' low' : '') + '" title="Battery on arrival">' + v + '%</span>';
  }

  function renderRoute() {
    if (!S.route) {
      viewEl.innerHTML = '<div class="empty">Finding the roads…</div>';
      refreshRoute().then(function () { if (S.view === 'route' && S.route) { save(); renderRoute(); drawMap(); } });
      return;
    }
    var pend = pendingOrdered();
    var allPend = S.stops.filter(function (s) { return !s.done; });
    var ch = activeCharger();
    var userKm = Solver.orderKm(originPoint(), allPend, allPend.map(function (s) { return s.id; }), S.returnHome, ch);
    var estNow = Solver.orderKm(originPoint(), pend, pend.map(function (s) { return s.id; }), S.returnHome, ch);
    var saving = userKm - estNow;
    var prof = evProfile(pend);
    var names = pend.map(function (s) { return s.name; }).concat(ch ? [ch.name] : [], S.returnHome ? ['home'] : []);

    var evNote = '';
    if (S.ev.enabled) {
      var bad = Ev.problem(S.ev);
      if (bad) evNote = '<div class="status bad">' + esc(bad) + '</div>';
      else if (prof) {
        if (prof.firstEmpty >= 0) evNote = '<div class="status bad">The battery would run out before ' + esc(names[prof.firstEmpty]) + '. Start with more charge, or charge before you leave.</div>';
        else if (prof.firstLow >= 0) evNote = '<div class="status">The battery would drop below ' + Math.round(S.ev.reservePct) + '% by ' + esc(names[prof.firstLow]) + '.</div>';
        else {
          var lastP = prof.points[prof.points.length - 1];
          var end = lastP.afterPct != null ? lastP.afterPct : lastP.arrivePct;
          evNote = '<div class="status ok">Battery is fine. ' + (S.returnHome ? 'You get home with about ' : 'You finish with about ') + Math.round(end) + '%.</div>';
        }
      }
    }

    function extraRow(cls, mark, title, sub) {
      return '<li><span class="num ' + cls + '">' + mark + '</span><div class="mid"><span style="font-weight:500">' + title + '</span><span class="leg">' + sub + '</span></div></li>';
    }
    var tail = '';
    var legAt = pend.length;
    if (ch) {
      var cp = prof && prof.points[legAt];
      tail += extraRow('ev', 'E', 'Charge: ' + esc(ch.name),
        esc(S.route.legs[legAt] != null ? fmtKm(S.route.legs[legAt]) : '') + (ch.kw ? ' · up to ' + ch.kw + ' kW' : '') +
        (cp ? ' ' + battChip(cp) + ' → ' + Math.round(cp.afterPct) + '%' : ''));
      legAt++;
    }
    if (S.returnHome) {
      var hp = prof && prof.points[legAt];
      tail += extraRow('home', 'S', 'Back home', esc(S.route.legs[legAt] != null ? fmtKm(S.route.legs[legAt]) : '') + (hp ? ' ' + battChip(hp) : ''));
    }

    viewEl.innerHTML =
      '<div class="head"><h1>Best route</h1>' + (saving > 0.5 ? '<span class="badge">Saves about ' + fmtKm(saving) + '</span>' : '') + '</div>' +
      '<div class="tiles' + (prof ? ' four' : '') + '"><div class="tile"><div class="k">Distance</div><div class="v">' + fmtKm(S.route.km) + '</div></div>' +
      '<div class="tile"><div class="k">Driving</div><div class="v">' + fmtTime(S.route.seconds) + '</div></div>' +
      '<div class="tile"><div class="k">Stops</div><div class="v">' + pend.length + '</div></div>' +
      (prof ? '<div class="tile"><div class="k">Battery used</div><div class="v">' + Math.round(prof.totalPct) + '%</div></div>' : '') + '</div>' +
      evNote +
      (S.route.source === 'estimate'
        ? '<div class="status">' + (S.provider === 'google' ? 'Road distances are an estimate. Turn on the Routes API for this key to get exact roads and times.' : 'The free road service did not answer, so distances are straight-line estimates. Tap Re-plan to try again.') + '</div>'
        : (S.provider === 'osm' ? '<div class="status ok">Road distances from OpenStreetMap. Times assume light traffic.</div>' : '')) +
      '<ol class="list" id="routelist">' + S.order.map(function (id, i) {
        var s = byId(id); if (!s) return '';
        var pi = pend.indexOf(s);
        var leg = pi >= 0 && S.route.legs[pi] != null ? fmtKm(S.route.legs[pi]) : '';
        var chip = pi >= 0 && prof ? ' ' + battChip(prof.points[pi]) : '';
        return '<li><span class="num' + (s.done ? ' done' : '') + '">' + (s.done ? '✓' : (i + 1)) + '</span>' +
          '<div class="mid"><span style="font-weight:500">' + esc(s.name) + (s.note ? ' <span class="pill" style="padding:2px 8px">' + esc(s.note) + '</span>' : '') + '</span>' +
          '<span class="leg">' + esc(leg) + chip + '</span></div>' +
          (s.done ? '' :
            '<button class="lockchip' + (s.lock === 'first' ? ' on' : '') + '" data-act="lock" data-kind="first" data-id="' + s.id + '" type="button" aria-pressed="' + (s.lock === 'first') + '">First</button>' +
            '<button class="lockchip' + (s.lock === 'last' ? ' on' : '') + '" data-act="lock" data-kind="last" data-id="' + s.id + '" type="button" aria-pressed="' + (s.lock === 'last') + '">Last</button>' +
            '<button class="iconbtn sm" data-act="move" data-dir="-1" data-id="' + s.id + '" type="button" aria-label="Move ' + esc(s.name) + ' earlier"' + (i === 0 ? ' disabled' : '') + '>' + icon('up') + '</button>' +
            '<button class="iconbtn sm" data-act="move" data-dir="1" data-id="' + s.id + '" type="button" aria-label="Move ' + esc(s.name) + ' later"' + (i === S.order.length - 1 ? ' disabled' : '') + '>' + icon('down') + '</button>') +
          '</li>';
      }).join('') + tail + '</ol>' +
      '<p class="muted" style="text-align:center">Lock a stop as First or Last, then Re-plan to keep it there.</p>' +
      '<div class="actions"><button class="btn" data-act="tostops" type="button">Edit stops</button><button class="btn" data-act="plan" type="button">Re-plan</button>' +
      '<button class="btn primary grow" data-act="toroad" type="button">Start delivering</button></div>';
  }

  async function moveStop(id, dir) {
    var i = S.order.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= S.order.length) return;
    var t = S.order[i]; S.order[i] = S.order[j]; S.order[j] = t;
    S.route = null; save(); renderRoute();
  }

  function toggleLock(id, kind) {
    var s = byId(id); if (!s) return;
    var had = s.lock === kind;
    S.stops.forEach(function (x) { if (x.lock === kind) x.lock = null; });
    if (!had) s.lock = kind;
    save(); renderRoute();
  }

  /* ---------- on the road ---------- */

  function renderRoad() {
    var pend = pendingOrdered();
    var total = S.order.length;
    var done = S.order.filter(function (id) { var s = byId(id); return s && s.done; }).length;
    var head = '<div class="head"><h1>On the road</h1><span class="count">' + done + ' of ' + total + ' done</span></div>' +
      '<div class="bar"><div style="width:' + (total ? Math.round(done / total * 100) : 0) + '%"></div></div>';
    var navIcon = icon('nav').replace('<svg', '<svg width="22" height="22"');
    if (!total) { viewEl.innerHTML = head + '<div class="empty">No route yet. Plan one first.</div><div class="actions"><button class="btn primary grow" data-act="tostops" type="button">Back to stops</button></div>'; return; }
    if (!pend.length) {
      var ch = activeCharger();
      if (ch && !S.chargeDone) {
        viewEl.innerHTML = head +
          '<div class="sheet next"><div class="eyebrow">Last stop: charge the car</div>' +
          '<div><h2 style="font-size:28px">' + esc(ch.name) + '</h2><p class="muted" style="font-size:16px;margin-top:4px">' + esc(ch.address || ch.operator || '') + '</p></div>' +
          '<div class="row" style="flex-wrap:wrap">' + (ch.kw ? '<span class="pill">Up to ' + ch.kw + ' kW</span>' : '') + '<span class="pill plain">Charge to ' + Math.round(S.ev.chargeTo) + '%</span></div>' +
          '<a class="btn primary" target="_blank" rel="noopener" href="' + esc(Solver.mapsUrl(null, ch)) + '">' + navIcon + ' Navigate to the charger</a>' +
          '<button class="btn good" data-act="charged" type="button">Charging done</button></div>' +
          '<div class="actions"><button class="btn" data-act="undo" type="button">Undo last</button></div>';
        return;
      }
      viewEl.innerHTML = head + '<div class="sheet next"><h2>All cards delivered</h2><p class="muted">Every home on this run is ticked off.' + (ch ? ' The car is charged.' : '') + (S.returnHome ? ' Drive safe back to the start.' : '') + '</p>' +
        (S.returnHome ? '<a class="btn primary" target="_blank" rel="noopener" href="' + esc(Solver.mapsUrl(null, S.start)) + '">' + navIcon + ' Navigate home</a>' : '') + '</div>' +
        '<div class="actions"><button class="btn" data-act="undo" type="button">Undo last</button><button class="btn primary grow" data-act="newrun" type="button">Start a new run</button></div>';
      return;
    }
    var n = pend[0];
    var prof = evProfile(pend);
    var legKm = S.route && S.route.legs && S.route.legs[0] != null ? fmtKm(S.route.legs[0]) : '';
    var arrive = prof && prof.points[0] ? battChip(prof.points[0]) : '';
    var next9 = pend.slice(0, 9);
    var batchUrl = Solver.mapsUrl(null, next9[next9.length - 1], next9.slice(0, -1));
    viewEl.innerHTML = head +
      '<div class="sheet next"><div class="eyebrow">Next stop ' + (done + 1) + '</div>' +
      '<div><h2 style="font-size:28px">' + esc(n.name) + '</h2><p class="muted" style="font-size:16px;margin-top:4px">' + esc(n.address) + '</p></div>' +
      '<div class="row" style="flex-wrap:wrap">' + (n.note ? '<span class="pill">' + esc(n.note) + '</span>' : '') + (legKm ? '<span class="pill plain">' + esc(legKm) + ' from previous</span>' : '') + (arrive ? '<span class="pill plain">Battery on arrival ' + arrive + '</span>' : '') + '</div>' +
      '<a class="btn primary" target="_blank" rel="noopener" href="' + esc(Solver.mapsUrl(null, n)) + '">' + navIcon + ' Navigate in Google Maps</a>' +
      '<div class="row"><button class="btn good grow" data-act="deliver" type="button">Delivered</button><button class="btn grow" data-act="skip" type="button">Skip for now</button></div></div>' +
      (pend.length > 1 ? '<div class="field"><div class="muted" style="font-weight:700">Coming up</div><ol class="list">' + pend.slice(1, 6).map(function (s, i) {
        return '<li><span class="num pend">' + (done + i + 2) + '</span><div class="mid"><span style="font-weight:500">' + esc(s.name) + '</span><span class="ad">' + esc(s.address) + '</span></div></li>';
      }).join('') + '</ol>' + (pend.length > 6 ? '<p class="muted">+ ' + (pend.length - 6) + ' more</p>' : '') + '</div>' : '') +
      '<div class="more"><a class="link" target="_blank" rel="noopener" href="' + esc(batchUrl) + '">Open the next ' + next9.length + ' stops in Google Maps</a>' +
      '<button class="link" data-act="undo" type="button">Undo last</button><button class="link" data-act="toroute" type="button">Back to route</button></div>';
  }

  function deliver() {
    var n = pendingOrdered()[0]; if (!n) return;
    n.legKm = S.route && S.route.legs && S.route.legs[0] != null ? S.route.legs[0] : 0;
    n.done = true; undoStack.push(n.id);
    S.route = null; save(); refreshRoute().then(function () { save(); if (S.view === 'road') { renderRoad(); drawMap(); } });
    renderRoad(); drawMap();
  }
  function skip() {
    var pend = pendingOrdered();
    if (pend.length < 2) { toast('This is the last stop.'); return; }
    var id = pend[0].id;
    S.order = S.order.filter(function (x) { return x !== id; }).concat([id]);
    S.route = null; save(); refreshRoute().then(function () { save(); if (S.view === 'road') { renderRoad(); drawMap(); } });
    renderRoad(); drawMap();
  }
  function undo() {
    var id = undoStack.pop();
    if (!id) {
      var doneIds = S.order.filter(function (x) { var s = byId(x); return s && s.done; });
      id = doneIds[doneIds.length - 1];
    }
    var s = id && byId(id);
    if (!s) { toast('Nothing to undo.'); return; }
    s.done = false; s.legKm = 0;
    if (S.chargeDone) S.chargeDone = false;
    S.route = null; save(); refreshRoute().then(function () { save(); if (S.view === 'road') { renderRoad(); drawMap(); } });
    renderRoad(); drawMap();
  }

  /* ---------- backup ---------- */

  function backup() {
    var data = JSON.stringify({
      stops: S.stops, start: S.start, returnHome: S.returnHome, order: S.order,
      ev: S.ev, chargers: S.chargers.filter(function (c) { return c.manual; })
    }, null, 2);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = 'shubha-yatra-backup.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function restore(file) {
    var r = new FileReader();
    r.onload = function () {
      try {
        var d = JSON.parse(r.result);
        if (!d || !Array.isArray(d.stops)) throw new Error('bad');
        S.stops = d.stops.filter(function (s) { return s && typeof s.lat === 'number' && typeof s.lng === 'number'; }).map(function (s) {
          return { id: String(s.id || newId()), name: String(s.name || 'Stop'), address: String(s.address || ''), note: String(s.note || ''), lat: s.lat, lng: s.lng, done: !!s.done, lock: s.lock === 'first' || s.lock === 'last' ? s.lock : null };
        });
        if (d.start && typeof d.start.lat === 'number' && typeof d.start.lng === 'number') S.start = d.start;
        S.returnHome = d.returnHome !== false;
        if (d.ev && typeof d.ev === 'object') S.ev = Ev.withDefaults(d.ev);
        if (Array.isArray(d.chargers)) {
          var keep = S.chargers.filter(function (c) { return !c.manual; });
          S.chargers = keep.concat(d.chargers.filter(function (c) { return c && c.manual && typeof c.lat === 'number' && typeof c.lng === 'number'; }));
        }
        S.order = Array.isArray(d.order) ? d.order.filter(function (id) { return byId(id); }) : [];
        S.route = null; save(); renderStops(); drawMap();
        toast('Backup restored: ' + S.stops.length + ' stops');
      } catch (e) { toast('That file is not a Shubha Yatra backup.'); }
    };
    r.readAsText(file);
  }

  /* ---------- events ---------- */

  viewEl.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.getAttribute('aria-disabled') === 'true') return;
    var act = t.dataset.act, id = t.dataset.id;
    switch (act) {
      case 'connect': connect(); break;
      case 'provider': setProvider(t.dataset.val); break;
      case 'adjust': startAdjust(id); break;
      case 'findchargers': findChargers(); break;
      case 'addcharger': setPinMode(true, 'charger'); break;
      case 'pickcharger': S.chargerId = id || null; S.route = null; save(); renderEv(); toast(id ? 'That charger will be used when you plan.' : 'The best charger will be chosen when you plan.'); break;
      case 'charged': S.chargeDone = true; save(); renderRoad(); drawMap(); break;
      case 'locate': locate(); break;
      case 'tostops':
        if (!S.start) { toast('Set your start point first.'); return; }
        setView('stops'); break;
      case 'setup': setView('setup'); break;
      case 'pin': setPinMode(!pinMode); break;
      case 'paste': openPaste(); break;
      case 'remove': removeStop(id); break;
      case 'plan': plan(); break;
      case 'toroad': undoStack = []; setView('road'); break;
      case 'toroute': setView('route'); break;
      case 'move': moveStop(id, +t.dataset.dir); break;
      case 'lock': toggleLock(id, t.dataset.kind); break;
      case 'deliver': deliver(); break;
      case 'skip': skip(); break;
      case 'undo': undo(); break;
      case 'newrun':
        if (confirm('Start a new run? This keeps your stops and marks them all as not delivered.')) {
          S.stops.forEach(function (s) { s.done = false; s.legKm = 0; });
          S.chargeDone = false; S.charger = null;
          S.route = null; S.order = []; undoStack = []; setView('stops');
        }
        break;
      case 'backup': backup(); break;
      case 'restore': $('#restorefile').click(); break;
      case 'clear':
        if (confirm('Remove all ' + S.stops.length + ' stops? This cannot be undone.')) {
          S.stops = []; S.order = []; S.route = null; save(); renderStopList(); drawMap();
        }
        break;
    }
  });

  viewEl.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset.act === 'return') { S.returnHome = t.checked; S.route = null; save(); return; }
    if (t.dataset.ev) {
      var k = t.dataset.ev;
      S.ev[k] = t.type === 'checkbox' ? t.checked : Number(t.value);
      S.ev = Ev.withDefaults(S.ev);
      S.route = null; save(); renderEv(); drawMap({ keep: true });
      if ((k === 'enabled' || k === 'endAtCharger') && t.checked && S.ev.enabled && S.ev.endAtCharger && S.start && !S.chargers.some(function (c) { return !c.manual; })) findChargers();
      return;
    }
    if (t.id === 'restorefile' && t.files[0]) { restore(t.files[0]); t.value = ''; return; }
    if (t.dataset.field && t.dataset.id) {
      var s = byId(t.dataset.id);
      if (s) { s[t.dataset.field] = t.value.trim() || (t.dataset.field === 'name' ? s.name : ''); save(); }
    }
  });

  $('#pinDone').addEventListener('click', endAdjust);
  $('#pastego').addEventListener('click', runPaste);
  $('#pastecancel').addEventListener('click', function () { $('#pastedlg').close(); });

  /* ---------- boot ---------- */

  async function boot() {
    if (S.provider === 'osm') {
      try { await G.init(); mapReady = true; }
      catch (e) { mapReady = false; S.view = 'setup'; toast(e.message || 'Could not load the map.'); }
    } else if (S.apiKey) {
      try { await G.init(S.apiKey); mapReady = true; }
      catch (e) { mapReady = false; S.view = 'setup'; toast(e.message || 'Could not connect to Google Maps.'); }
    } else {
      S.view = 'setup';
    }
    if (S.view !== 'setup' && !S.start) S.view = 'setup';
    if (S.view === 'route' && S.order.length === 0) S.view = 'stops';
    render();
  }
  boot();
})();
