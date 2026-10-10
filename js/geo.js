/* Pure text helpers: read a position out of a pasted map link or "lat, lng". No browser needed. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Geo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function valid(lat, lng) {
    return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  }
  function pair(a, b) {
    var lat = parseFloat(a), lng = parseFloat(b);
    return valid(lat, lng) ? { lat: lat, lng: lng } : null;
  }

  function isShortLink(text) {
    return /^\s*https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\//i.test(text);
  }

  /** Returns {lat,lng} from a coordinates string or a Google Maps / OpenStreetMap link, else null. */
  function parseLatLng(text) {
    if (!text) return null;
    var t = String(text).trim();
    try { t = decodeURIComponent(t); } catch (e) { /* keep as typed */ }
    var m;

    // The exact pin of a Google place link beats the map centre that follows "@".
    m = t.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (m && pair(m[1], m[2])) return pair(m[1], m[2]);

    m = t.match(/[?&](?:q|query|ll|destination|daddr|mlat)=(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
    if (m && pair(m[1], m[2])) return pair(m[1], m[2]);

    m = t.match(/[?&]mlat=(-?\d+(?:\.\d+)?)&mlon=(-?\d+(?:\.\d+)?)/);
    if (m && pair(m[1], m[2])) return pair(m[1], m[2]);

    m = t.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (m && pair(m[1], m[2])) return pair(m[1], m[2]);

    m = t.match(/#map=\d+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    if (m && pair(m[1], m[2])) return pair(m[1], m[2]);

    // Bare pairs need decimals, so a house number like "12, 34" is never mistaken for a position.
    m = t.match(/^\(?\s*(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)\s*\)?$/);
    if (m && pair(m[1], m[2])) return pair(m[1], m[2]);

    return null;
  }

  /** Shorten a long OpenStreetMap display name: drop the country, state and pincode tail. */
  function tidyAddress(display) {
    var parts = String(display || '').split(',').map(function (p) { return p.trim(); }).filter(Boolean);
    while (parts.length > 2 && /^(india|\d{6}|karnataka|maharashtra|goa|telangana|andhra pradesh|tamil nadu|kerala)$/i.test(parts[parts.length - 1])) parts.pop();
    return parts.join(', ');
  }

  return { parseLatLng: parseLatLng, isShortLink: isShortLink, tidyAddress: tidyAddress };
});
