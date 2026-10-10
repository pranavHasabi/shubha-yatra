/* Thin wrapper around Google Maps. Every call that can fail for key/billing reasons degrades instead of crashing. */
(function (root) {
  'use strict';

  var libs = {};
  var map = null;
  var overlays = [];

  function loadScript(key) {
    return new Promise(function (resolve, reject) {
      if (root.google && root.google.maps && root.google.maps.importLibrary) return resolve();
      var done = false;
      root.gm_authFailure = function () {
        if (done) return;
        done = true;
        reject(new Error('Google rejected this key. Check the key, and that billing and the services are turned on.'));
      };
      var s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&v=weekly&loading=async';
      s.async = true;
      s.onload = function () { if (!done) { done = true; resolve(); } };
      s.onerror = function () { if (!done) { done = true; reject(new Error('Could not reach Google Maps. Check your internet.')); } };
      document.head.appendChild(s);
    });
  }

  async function init(key) {
    await loadScript(key);
    libs.maps = await google.maps.importLibrary('maps');
    libs.places = await google.maps.importLibrary('places');
    try { libs.geocoding = await google.maps.importLibrary('geocoding'); } catch (e) { libs.geocoding = null; }
    try { libs.routes = await google.maps.importLibrary('routes'); } catch (e) { libs.routes = null; }
  }

  function showMap(el, center) {
    if (map) return map;
    map = new libs.maps.Map(el, {
      center: center || { lat: 15.36, lng: 75.12 }, zoom: 12,
      disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', clickableIcons: false
    });
    return map;
  }

  function clearOverlays() {
    overlays.forEach(function (o) { o.setMap(null); });
    overlays = [];
  }

  function circleIcon(fill, scale, stroke) {
    return { path: google.maps.SymbolPath.CIRCLE, scale: scale, fillColor: fill, fillOpacity: 1, strokeColor: stroke || '#ffffff', strokeWeight: 2 };
  }

  function addMarker(pos, opts) {
    var m = new google.maps.Marker({
      map: map, position: pos, title: opts.title || '',
      icon: circleIcon(opts.fill, opts.scale || 11, opts.stroke),
      label: opts.label ? { text: String(opts.label), color: opts.textColor || '#ffffff', fontWeight: '700', fontSize: '12px' } : undefined,
      zIndex: opts.z || 1
    });
    overlays.push(m);
    return m;
  }

  function addLine(path, style) {
    var l = new google.maps.Polyline(Object.assign({ map: map, path: path, strokeColor: '#8E1F3A', strokeWeight: 4, strokeOpacity: 0.95 }, style || {}));
    overlays.push(l);
    return l;
  }

  function fit(points) {
    if (!map || !points.length) return;
    var b = new google.maps.LatLngBounds();
    points.forEach(function (p) { b.extend(p); });
    map.fitBounds(b, 48);
    google.maps.event.addListenerOnce(map, 'idle', function () { if (map.getZoom() > 17) map.setZoom(17); });
  }

  function onMapClick(handler) {
    if (!map) return function () {};
    var l = map.addListener('click', function (e) { handler({ lat: e.latLng.lat(), lng: e.latLng.lng() }); });
    return function () { l.remove(); };
  }

  function resize() {
    if (map) google.maps.event.trigger(map, 'resize');
  }

  /** Search box (new Places element). onPick receives {name,address,lat,lng}. */
  async function createSearchBox(onPick, bias) {
    var opts = {};
    if (bias) opts.locationBias = { center: bias, radius: 40000 };
    var el;
    try { el = new libs.places.PlaceAutocompleteElement(opts); }
    catch (e) { el = new libs.places.PlaceAutocompleteElement({}); }
    el.style.colorScheme = 'light';
    var handle = async function (ev) {
      try {
        var place = ev.placePrediction ? ev.placePrediction.toPlace() : ev.place;
        await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
        onPick({
          name: place.displayName || '', address: place.formattedAddress || '',
          lat: place.location.lat(), lng: place.location.lng()
        });
      } catch (err) {
        onPick(null, err);
      }
    };
    el.addEventListener('gmp-select', handle);
    el.addEventListener('gmp-placeselect', handle);
    return el;
  }

  async function geocode(request) {
    if (!libs.geocoding) throw new Error('Geocoding is not available. Turn on the Geocoding API for this key.');
    var g = new libs.geocoding.Geocoder();
    var res = await g.geocode(request);
    if (!res.results || !res.results.length) throw new Error('No match found');
    var r = res.results[0];
    return { address: r.formatted_address, lat: r.geometry.location.lat(), lng: r.geometry.location.lng() };
  }

  function geocodeAddress(text, bias) {
    var req = { address: text };
    if (bias) {
      var d = 0.35;
      req.bounds = { south: bias.lat - d, north: bias.lat + d, west: bias.lng - d, east: bias.lng + d };
    }
    return geocode(req);
  }

  function reverseGeocode(pos) { return geocode({ location: pos }); }

  function num(v) { return typeof v === 'function' ? v.call(null) : v; }

  /**
   * Real road route through points [{lat,lng}...] (origin first, destination last, up to 25 per request).
   * Returns {path:[{lat,lng}], meters, seconds, legs:[{meters,seconds}]} or throws.
   */
  async function roadRoute(points) {
    var origin = points[0], dest = points[points.length - 1], mids = points.slice(1, -1);
    if (libs.routes && libs.routes.Route && libs.routes.Route.computeRoutes) {
      try {
        var out = await libs.routes.Route.computeRoutes({
          origin: origin, destination: dest,
          intermediates: mids.map(function (p) { return { location: p }; }),
          travelMode: 'DRIVING',
          fields: ['path', 'distanceMeters', 'durationMillis', 'legs']
        });
        var r = out.routes && out.routes[0];
        if (r) {
          return {
            path: r.path.map(function (p) { return { lat: num(p.lat), lng: num(p.lng) }; }),
            meters: r.distanceMeters, seconds: Math.round(r.durationMillis / 1000),
            legs: (r.legs || []).map(function (l) { return { meters: l.distanceMeters, seconds: Math.round((l.durationMillis || 0) / 1000) }; })
          };
        }
      } catch (e) { /* fall through to the older service */ }
    }
    if (libs.routes && libs.routes.DirectionsService) {
      var svc = new libs.routes.DirectionsService();
      var res = await svc.route({
        origin: origin, destination: dest,
        waypoints: mids.map(function (p) { return { location: p, stopover: true }; }),
        travelMode: 'DRIVING'
      });
      var rt = res.routes[0];
      var path = [], meters = 0, seconds = 0, legs = [];
      rt.legs.forEach(function (l) {
        meters += l.distance.value; seconds += l.duration.value;
        legs.push({ meters: l.distance.value, seconds: l.duration.value });
      });
      rt.overview_path.forEach(function (p) { path.push({ lat: p.lat(), lng: p.lng() }); });
      return { path: path, meters: meters, seconds: seconds, legs: legs };
    }
    throw new Error('Road routing is not available');
  }

  root.Gmaps = {
    init: init, showMap: showMap, clearOverlays: clearOverlays, addMarker: addMarker, addLine: addLine,
    fit: fit, onMapClick: onMapClick, resize: resize, createSearchBox: createSearchBox,
    geocodeAddress: geocodeAddress, reverseGeocode: reverseGeocode, roadRoute: roadRoute
  };
})(window);
