(function () {
  'use strict';

  var STORE = 'shubha-yatra-v1';
  var VIEWS = ['setup', 'stops', 'planning', 'route', 'road'];
  var S = load();
  var mapReady = false;
  var pinMode = false;
  var stopPinListener = null;
  var undoStack = [];
  var refreshToken = 0;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var viewEl = $('#view');

  /* ---------- state ---------- */

  function blank() {
    return { apiKey: '', start: null, returnHome: true, stops: [], order: [], route: null, view: 'setup' };
  }
  function load() {
    var s = blank();
    try {
      var raw = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (raw && typeof raw === 'object') {
        s = Object.assign(s, raw);
        if (!Array.isArray(s.stops)) s.stops = [];
        if (!Array.isArray(s.order)) s.order = [];
      }
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
      Gmaps.showMap($('#map'), S.start);
      Gmaps.resize();
      drawMap();
    }
    if (S.view !== 'stops') setPinMode(false);
  }

  /* ---------- map drawing ---------- */

  function pendingOrdered() {
    return S.order.map(byId).filter(function (s) { return s && !s.done; });
  }

  function drawMap(opts) {
    if (!mapReady) return;
    opts = opts || {};
    Gmaps.clearOverlays();
    var pts = [];
    if (S.start) { Gmaps.addMarker(S.start, { fill: '#8E1F3A', scale: 13, label: 'S', title: 'Start', z: 5 }); pts.push(S.start); }
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
      Gmaps.addMarker(s, o);
      pts.push(s);
    });
    if (opts.messy && opts.messy.length) {
      var path = [S.start].concat(opts.messy);
      if (S.returnHome) path.push(S.start);
      Gmaps.addLine(path, {
        strokeOpacity: 0, strokeColor: '#B3261E',
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.7, scale: 3 }, offset: '0', repeat: '12px' }]
      });
    } else if (S.route && S.route.path && (S.view === 'route' || S.view === 'road')) {
      Gmaps.addLine(S.route.path);
    }
    Gmaps.fit(pts);
  }

  function doneCount() { return S.stops.filter(function (s) { return s.done; }).length; }

  /* ---------- setup ---------- */

  function renderSetup() {
    var connected = mapReady;
    viewEl.innerHTML =
      '<div class="field" style="gap:12px">' +
      '<h1>Plan your card run</h1>' +
      '<p class="muted" style="font-size:16px">Add every home you need to visit. You get the shortest order, so you never drive back and forth.</p></div>' +
      '<div class="field"><label for="key">Google Maps key</label>' +
      '<div class="row"><input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="AIzaSy..." value="' + esc(S.apiKey) + '">' +
      '<button class="btn small" data-act="connect" type="button">' + (connected ? 'Reconnect' : 'Connect') + '</button></div>' +
      '<div id="keystatus" class="status' + (connected ? ' ok' : '') + '"' + (connected ? '' : ' hidden') + '>' + (connected ? 'Connected to Google Maps' : '') + '</div>' +
      '<span class="muted">Saved only on this device. Never sent anywhere except to Google.</span></div>' +
      '<details class="help"><summary>How to get a key</summary><ol>' +
      '<li>Open <strong>console.cloud.google.com</strong> and create a project. Turn on billing (Google gives a monthly free credit that covers a few hundred stops).</li>' +
      '<li>In APIs and services, enable: <strong>Maps JavaScript API</strong>, <strong>Places API (New)</strong>, <strong>Geocoding API</strong> and <strong>Routes API</strong>.</li>' +
      '<li>Create an API key. Under restrictions, limit it to websites and add this page\'s address.</li>' +
      '<li>Paste the key above and tap Connect.</li></ol></details>' +
      '<div class="field"><label for="startbox">Start point</label>' +
      '<div id="startbox">' + (connected ? '' : '<div class="muted">Connect your key first.</div>') + '</div>' +
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
    var el = await Gmaps.createSearchBox(function (p, err) {
      if (!p) { toast('Could not read that place. Try again.'); return; }
      S.start = { lat: p.lat, lng: p.lng, name: p.name, address: p.address || p.name };
      save();
      $('#startchosen').innerHTML = startChosenHtml();
    }, S.start);
    box.innerHTML = '';
    box.appendChild(el);
  }

  async function connect() {
    var key = $('#key').value.trim();
    var st = $('#keystatus');
    if (!key) { st.hidden = false; st.className = 'status bad'; st.textContent = 'Paste your Google Maps key first.'; return; }
    st.hidden = false; st.className = 'status'; st.textContent = 'Connecting…';
    try {
      await Gmaps.init(key);
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
      try { address = (await Gmaps.reverseGeocode(p)).address; } catch (e) { /* keep the label */ }
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
      '<div class="more">' +
      '<button class="link" data-act="setup" type="button">Start point and key</button>' +
      '<button class="link" data-act="backup" type="button">Save backup</button>' +
      '<button class="link" data-act="restore" type="button">Restore backup</button>' +
      '<button class="link" data-act="clear" type="button">Clear all</button>' +
      '<input type="file" id="restorefile" accept="application/json" hidden></div>' +
      '<div class="actions"><button class="btn primary grow" data-act="plan" type="button">Plan best route</button></div>';
    renderStopList();
    mountSearch();
  }

  async function mountSearch() {
    var box = $('#searchbox');
    if (!box || !mapReady) return;
    var el = await Gmaps.createSearchBox(function (p) {
      if (!p) { toast('Could not read that place. Try again.'); return; }
      addStop({ name: p.name, address: p.address, lat: p.lat, lng: p.lng });
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
        '<span class="ad">' + esc(s.address) + '</span></div>' +
        '<input class="note" type="text" value="' + esc(s.note) + '" placeholder="Note" data-field="note" data-id="' + s.id + '" aria-label="Note for ' + esc(s.name) + '">' +
        '<button class="iconbtn sm" data-act="remove" data-id="' + s.id + '" type="button" aria-label="Remove ' + esc(s.name) + '">' + icon('x') + '</button></li>';
    }).join('');
    if (pend !== S.stops.length && cnt) cnt.textContent += ' (' + (S.stops.length - pend) + ' delivered)';
  }

  function addStop(p) {
    var name = (p.name || '').trim() || (p.address || 'Stop').split(',')[0];
    S.stops.push({ id: newId(), name: name, address: p.address || '', note: p.note || '', lat: p.lat, lng: p.lng, done: false, lock: null });
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

  function setPinMode(on) {
    pinMode = on;
    document.body.classList.toggle('pinning', on);
    var hint = $('#pinhint'); if (hint) hint.hidden = !on;
    var btn = $('[data-act="pin"]');
    if (btn) { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on); }
    if (stopPinListener) { stopPinListener(); stopPinListener = null; }
    if (on && mapReady) {
      stopPinListener = Gmaps.onMapClick(async function (pos) {
        var a = { name: 'Pinned spot', address: pos.lat.toFixed(5) + ', ' + pos.lng.toFixed(5) };
        try { var g = await Gmaps.reverseGeocode(pos); a.address = g.address; a.name = g.address.split(',')[0]; } catch (e) { /* keep coordinates */ }
        addStop({ name: a.name, address: a.address, lat: pos.lat, lng: pos.lng });
        setPinMode(false);
      });
    }
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
        var g = await Gmaps.geocodeAddress(addr, S.start);
        addStop({ name: name || addr.split(',')[0], address: g.address, lat: g.lat, lng: g.lng });
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

    S.view = 'planning';
    render();
    drawMap({ messy: pend });
    await sleep(80);

    var res = Solver.planRoute(S.start, pend, {
      returnHome: S.returnHome, firstId: lockedId('first'), lastId: lockedId('last'),
      userOrder: pend.map(function (s) { return s.id; })
    });
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
      '<div class="twocol"><div><div class="muted">Your order</div><div class="kmbig bad">' + fmtKm(userKm) + '</div></div>' +
      '<div><div class="muted">Best so far</div><div class="kmbig best" id="pl-best">' + fmtKm(userKm) + '</div></div></div>' +
      '<div class="bar"><div id="pl-bar" style="width:4%"></div></div></div>' +
      '<p class="muted" style="text-align:center">The red dashed line on the map is the order you entered.</p>';
  }

  /* ---------- road route ---------- */

  async function refreshRoute() {
    var token = ++refreshToken;
    var pend = pendingOrdered();
    if (!pend.length) { S.route = { km: 0, seconds: 0, legs: [], path: null, source: 'estimate' }; return; }
    var pts = [S.start].concat(pend);
    if (S.returnHome) pts.push(S.start);
    var legs = [], km = 0;
    for (var i = 0; i + 1 < pts.length; i++) {
      var d = Solver.haversine(pts[i], pts[i + 1]) * Solver.ROAD_FACTOR;
      legs.push(d); km += d;
    }
    var route = { km: km, seconds: Math.round(km / 25 * 3600), legs: legs, path: pts.map(function (p) { return { lat: p.lat, lng: p.lng }; }), source: 'estimate' };
    try {
      var chunks = Solver.chunkWithOverlap(pts, 25), path = [], meters = 0, seconds = 0, rl = [];
      for (var c = 0; c < chunks.length; c++) {
        var r = await Gmaps.roadRoute(chunks[c]);
        path = path.concat(r.path); meters += r.meters; seconds += r.seconds;
        r.legs.forEach(function (l) { rl.push(l.meters / 1000); });
      }
      if (rl.length === pts.length - 1) route = { km: meters / 1000, seconds: seconds, legs: rl, path: path, source: 'road' };
      else route = { km: meters / 1000, seconds: seconds, legs: legs, path: path, source: 'road' };
    } catch (e) { /* keep the straight-line estimate */ }
    if (token === refreshToken) S.route = route;
  }

  /* ---------- route view ---------- */

  function renderRoute() {
    if (!S.route) {
      viewEl.innerHTML = '<div class="empty">Finding the roads…</div>';
      refreshRoute().then(function () { if (S.view === 'route' && S.route) { save(); renderRoute(); drawMap(); } });
      return;
    }
    var pend = pendingOrdered();
    var userKm = Solver.orderKm(S.start, S.stops.filter(function (s) { return !s.done; }), S.stops.filter(function (s) { return !s.done; }).map(function (s) { return s.id; }), S.returnHome);
    var estNow = Solver.orderKm(S.start, pend, pend.map(function (s) { return s.id; }), S.returnHome);
    var saving = userKm - estNow;
    viewEl.innerHTML =
      '<div class="head"><h1>Best route</h1>' + (saving > 0.5 ? '<span class="badge">Saves about ' + fmtKm(saving) + '</span>' : '') + '</div>' +
      '<div class="tiles"><div class="tile"><div class="k">Distance</div><div class="v">' + fmtKm(S.route.km) + '</div></div>' +
      '<div class="tile"><div class="k">Driving</div><div class="v">' + fmtTime(S.route.seconds) + '</div></div>' +
      '<div class="tile"><div class="k">Stops</div><div class="v">' + pend.length + '</div></div></div>' +
      (S.route.source === 'estimate' ? '<div class="status">Road distances are an estimate. Turn on the Routes API for this key to get exact roads and times.</div>' : '') +
      '<ol class="list" id="routelist">' + S.order.map(function (id, i) {
        var s = byId(id); if (!s) return '';
        var pi = pend.indexOf(s);
        var leg = pi >= 0 && S.route.legs[pi] != null ? fmtKm(S.route.legs[pi]) : '';
        return '<li><span class="num' + (s.done ? ' done' : '') + '">' + (s.done ? '✓' : (i + 1)) + '</span>' +
          '<div class="mid"><span style="font-weight:500">' + esc(s.name) + (s.note ? ' <span class="pill" style="padding:2px 8px">' + esc(s.note) + '</span>' : '') + '</span>' +
          '<span class="leg">' + esc(leg) + '</span></div>' +
          (s.done ? '' :
            '<button class="lockchip' + (s.lock === 'first' ? ' on' : '') + '" data-act="lock" data-kind="first" data-id="' + s.id + '" type="button" aria-pressed="' + (s.lock === 'first') + '">First</button>' +
            '<button class="lockchip' + (s.lock === 'last' ? ' on' : '') + '" data-act="lock" data-kind="last" data-id="' + s.id + '" type="button" aria-pressed="' + (s.lock === 'last') + '">Last</button>' +
            '<button class="iconbtn sm" data-act="move" data-dir="-1" data-id="' + s.id + '" type="button" aria-label="Move ' + esc(s.name) + ' earlier"' + (i === 0 ? ' disabled' : '') + '>' + icon('up') + '</button>' +
            '<button class="iconbtn sm" data-act="move" data-dir="1" data-id="' + s.id + '" type="button" aria-label="Move ' + esc(s.name) + ' later"' + (i === S.order.length - 1 ? ' disabled' : '') + '>' + icon('down') + '</button>') +
          '</li>';
      }).join('') + '</ol>' +
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
    if (!total) { viewEl.innerHTML = head + '<div class="empty">No route yet. Plan one first.</div><div class="actions"><button class="btn primary grow" data-act="tostops" type="button">Back to stops</button></div>'; return; }
    if (!pend.length) {
      viewEl.innerHTML = head + '<div class="sheet next"><h2>All cards delivered</h2><p class="muted">Every home on this run is ticked off.' + (S.returnHome ? ' Drive safe back to the start.' : '') + '</p></div>' +
        '<div class="actions"><button class="btn" data-act="undo" type="button">Undo last</button><button class="btn primary grow" data-act="newrun" type="button">Start a new run</button></div>';
      return;
    }
    var n = pend[0];
    var legKm = S.route && S.route.legs && S.route.legs[0] != null ? fmtKm(S.route.legs[0]) : '';
    var next9 = pend.slice(0, 9);
    var batchUrl = Solver.mapsUrl(null, next9[next9.length - 1], next9.slice(0, -1));
    viewEl.innerHTML = head +
      '<div class="sheet next"><div class="eyebrow">Next stop ' + (done + 1) + '</div>' +
      '<div><h2 style="font-size:28px">' + esc(n.name) + '</h2><p class="muted" style="font-size:16px;margin-top:4px">' + esc(n.address) + '</p></div>' +
      '<div class="row" style="flex-wrap:wrap">' + (n.note ? '<span class="pill">' + esc(n.note) + '</span>' : '') + (legKm ? '<span class="pill plain">' + esc(legKm) + ' from previous</span>' : '') + '</div>' +
      '<a class="btn primary" target="_blank" rel="noopener" href="' + esc(Solver.mapsUrl(null, n)) + '">' + icon('nav').replace('<svg', '<svg width="22" height="22"') + ' Navigate in Google Maps</a>' +
      '<div class="row"><button class="btn good grow" data-act="deliver" type="button">Delivered</button><button class="btn grow" data-act="skip" type="button">Skip for now</button></div></div>' +
      (pend.length > 1 ? '<div class="field"><div class="muted" style="font-weight:700">Coming up</div><ol class="list">' + pend.slice(1, 6).map(function (s, i) {
        return '<li><span class="num pend">' + (done + i + 2) + '</span><div class="mid"><span style="font-weight:500">' + esc(s.name) + '</span><span class="ad">' + esc(s.address) + '</span></div></li>';
      }).join('') + '</ol>' + (pend.length > 6 ? '<p class="muted">+ ' + (pend.length - 6) + ' more</p>' : '') + '</div>' : '') +
      '<div class="more"><a class="link" target="_blank" rel="noopener" href="' + esc(batchUrl) + '">Open the next ' + next9.length + ' stops in Google Maps</a>' +
      '<button class="link" data-act="undo" type="button">Undo last</button><button class="link" data-act="toroute" type="button">Back to route</button></div>';
  }

  function deliver() {
    var n = pendingOrdered()[0]; if (!n) return;
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
    s.done = false;
    S.route = null; save(); refreshRoute().then(function () { save(); if (S.view === 'road') { renderRoad(); drawMap(); } });
    renderRoad(); drawMap();
  }

  /* ---------- backup ---------- */

  function backup() {
    var data = JSON.stringify({ stops: S.stops, start: S.start, returnHome: S.returnHome, order: S.order }, null, 2);
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
          S.stops.forEach(function (s) { s.done = false; });
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
    if (t.id === 'restorefile' && t.files[0]) { restore(t.files[0]); t.value = ''; return; }
    if (t.dataset.field && t.dataset.id) {
      var s = byId(t.dataset.id);
      if (s) { s[t.dataset.field] = t.value.trim() || (t.dataset.field === 'name' ? s.name : ''); save(); }
    }
  });

  $('#pastego').addEventListener('click', runPaste);
  $('#pastecancel').addEventListener('click', function () { $('#pastedlg').close(); });

  /* ---------- boot ---------- */

  async function boot() {
    if (S.apiKey) {
      try { await Gmaps.init(S.apiKey); mapReady = true; }
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
