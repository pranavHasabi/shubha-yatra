const test = require('node:test');
const assert = require('node:assert');
const G = require('../js/geo.js');

test('plain coordinates', () => {
  assert.deepStrictEqual(G.parseLatLng('15.3647, 75.1160'), { lat: 15.3647, lng: 75.116 });
  assert.deepStrictEqual(G.parseLatLng('15.3647 75.1160'), { lat: 15.3647, lng: 75.116 });
  assert.deepStrictEqual(G.parseLatLng('(15.3647,75.1160)'), { lat: 15.3647, lng: 75.116 });
});

test('google link with a pin: the pin wins over the map centre', () => {
  const u = 'https://www.google.com/maps/place/Home/@15.40,75.20,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d15.3647!4d75.1160';
  assert.deepStrictEqual(G.parseLatLng(u), { lat: 15.3647, lng: 75.116 });
});

test('google link with only a map centre', () => {
  assert.deepStrictEqual(G.parseLatLng('https://www.google.com/maps/@15.3647,75.1160,17z'), { lat: 15.3647, lng: 75.116 });
});

test('whatsapp / share style links', () => {
  assert.deepStrictEqual(G.parseLatLng('https://maps.google.com/?q=15.3647,75.1160'), { lat: 15.3647, lng: 75.116 });
  assert.deepStrictEqual(G.parseLatLng('https://www.google.com/maps/search/?api=1&query=15.3647%2C75.1160'), { lat: 15.3647, lng: 75.116 });
  assert.deepStrictEqual(G.parseLatLng('https://maps.google.com/maps?ll=15.3647,75.1160&z=16'), { lat: 15.3647, lng: 75.116 });
});

test('openstreetmap links', () => {
  assert.deepStrictEqual(G.parseLatLng('https://www.openstreetmap.org/?mlat=15.3647&mlon=75.1160#map=17/15.3647/75.1160'), { lat: 15.3647, lng: 75.116 });
  assert.deepStrictEqual(G.parseLatLng('https://www.openstreetmap.org/#map=17/15.3647/75.1160'), { lat: 15.3647, lng: 75.116 });
});

test('things that are not positions return null', () => {
  assert.strictEqual(G.parseLatLng('4th Cross, Vidyanagar'), null);
  assert.strictEqual(G.parseLatLng('Ramesh uncle'), null);
  assert.strictEqual(G.parseLatLng('12, 34'), null);
  assert.strictEqual(G.parseLatLng('15.3647, 275.1160'), null);
  assert.strictEqual(G.parseLatLng(''), null);
  assert.strictEqual(G.parseLatLng(null), null);
});

test('short links are recognised so the app can explain them', () => {
  assert.ok(G.isShortLink('https://maps.app.goo.gl/AbC123'));
  assert.ok(!G.isShortLink('https://www.google.com/maps/@15.36,75.11,17z'));
  assert.strictEqual(G.parseLatLng('https://maps.app.goo.gl/AbC123'), null);
});

test('tidyAddress drops country, state and pincode but keeps the street', () => {
  assert.strictEqual(G.tidyAddress('4th Cross, Vidyanagar, Hubballi, Dharwad, Karnataka, 580021, India'), '4th Cross, Vidyanagar, Hubballi, Dharwad');
  assert.strictEqual(G.tidyAddress('Hubballi'), 'Hubballi');
});
