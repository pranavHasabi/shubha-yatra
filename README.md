# Shubha Yatra

A small website for delivering wedding cards without roaming the city. Add every home you need to visit; it works out the shortest order, draws the route on Google Maps, and walks you through the deliveries one by one.

Plain HTML, CSS and JavaScript. No server, no build step, no login. Everything is saved in the browser of the device you use.

## Use it

1. Open the site. The **Free map, no key** option works straight away. (Choose **Google Maps** and paste a key if you want better house-level search.)
2. Set the start point (usually home) and whether the route ends back there.
3. Add stops: search a name or address and press Enter, drop a pin on the map, or paste a list (one per line, optionally `Name | address`). A pasted map link or coordinates such as `15.3647, 75.1160` also work. Short `maps.app.goo.gl` links cannot be read; use the long link.
   Stops the free search could only place by area are tagged **Area only**. Tap **Place pin exactly** and drag the pin (or tap the map) onto the house.
4. Tap **Plan best route**. Reorder or lock a stop as **First** or **Last** and re-plan if needed.
5. Tap **Start delivering**. **Navigate** opens Google Maps to the next home; tick **Delivered** as you go. **Skip for now** moves a home to the end. **Undo last** reverses a tick.

### Electric car

Open **Electric car** on the Stops screen and switch it on. Enter the battery % when you leave, the range your car shows (km), the lowest % you want left, and a safety margin (dashboard range is optimistic in city traffic).

- The route shows the battery % you arrive with at every stop, and the % used in total. It warns if the battery would drop below your reserve, or run out, and names the stop.
- **Finish at a charging station** (on by default): the planner tries the nearest known chargers and picks the one that makes the whole trip shortest (every home, then the charger, then home). You can force a specific charger from the list.
- After the last delivery, **On the road** sends you to the charger, then home.
- Chargers come from OpenStreetMap. In smaller cities the data is thin, so use **Add a charger** and drop a pin on one you know. Pinned chargers are kept in your backup.
- It does not add a mid-route charging stop. If the warning says the battery would run out early, charge before you leave or start with more battery.

Use **Save backup** to download your stops as a file and **Restore backup** to load them on another phone.

## Free map or Google

The default is OpenStreetMap: Leaflet map, Nominatim search and the public OSRM road server. No key, no billing. It finds areas and landmarks well and house numbers poorly, and OSRM times assume light traffic (scaled up 25%). The public servers ask for light use, so searches are spaced one second apart.

## Google Maps key (optional)

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
node --test tests/solver.test.js tests/geo.test.js tests/ev.test.js
```

## Files

- `index.html`, `css/style.css`: the page
- `js/solver.js`: route ordering (no browser needed)
- `js/maps.js`: Google Maps provider
- `js/osm.js`: free OpenStreetMap provider (same interface)
- `js/geo.js`: reads positions from pasted map links and coordinates
- `js/ev.js`: battery maths (% per km, battery at each stop)
- `js/chargers.js`: finds public chargers from OpenStreetMap
- `js/app.js`: screens and saved state
