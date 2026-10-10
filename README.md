# Shubha Yatra

A small website for delivering wedding cards without roaming the city. Add every home you need to visit; it works out the shortest order, draws the route on Google Maps, and walks you through the deliveries one by one.

Plain HTML, CSS and JavaScript. No server, no build step, no login. Everything is saved in the browser of the device you use.

## Use it

1. Open the site and paste your Google Maps key (see below), then tap **Connect**.
2. Set the start point (usually home) and whether the route ends back there.
3. Add stops: search a name or address, drop a pin on the map, or paste a list (one per line, optionally `Name | address`).
4. Tap **Plan best route**. Reorder or lock a stop as **First** or **Last** and re-plan if needed.
5. Tap **Start delivering**. **Navigate** opens Google Maps to the next home; tick **Delivered** as you go. **Skip for now** moves a home to the end. **Undo last** reverses a tick.

Use **Save backup** to download your stops as a file and **Restore backup** to load them on another phone.

## Google Maps key

Create a project at console.cloud.google.com, turn on billing (Google's monthly free credit covers a few hundred stops), and enable:

- Maps JavaScript API
- Places API (New): address search
- Geocoding API: pin drop, pasted lists, "use my location"
- Routes API: real road distance and driving time. Without it the site still works and shows a straight-line estimate.

Create an API key and, under restrictions, limit it to websites and add this site's address. The key you paste is stored only in your browser.

## How the route is chosen

`js/solver.js` builds a distance table between all stops (straight line, scaled by 1.3 to approximate roads), starts from a nearest-neighbour tour, then improves it with 2-opt and or-opt moves and several seeded random restarts. It handles 150 stops in a few seconds and matches the true optimum on small sets (checked against brute force in the tests). Google then draws the real roads, in runs of 25 points.

## Tests

```bash
node --test tests/solver.test.js
```

## Files

- `index.html`, `css/style.css`: the page
- `js/solver.js`: route ordering (no browser needed)
- `js/maps.js`: Google Maps wrapper
- `js/app.js`: screens and saved state
