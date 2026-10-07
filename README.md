# World Radio

Search and play live radio stations from around the world. Stations appear in a list on the left and on a map on the right (desktop); phones get the list and a player. Self-hosted with Docker, nginx and Let's Encrypt HTTPS.

**Features:** search by name, country or genre - map with station location - "Surprise me" random station - favourites - shareable station links - now-playing track titles - automatic dead-station detection - installable as an app.

## How it fits together

```
Browser --HTTPS--> host nginx (:443, certbot)
                        |
                        v
        web container (nginx, 127.0.0.1:8080) ... serves the page
                        |  /api/
                        v
        api container (Node, internal only) ... track titles, dead-station list
```

Station data comes from the community [Radio Browser](https://www.radio-browser.info) directory and the map from [OpenStreetMap](https://www.openstreetmap.org). The `api` container reads track titles from streams and keeps a server-verified list of dead stations.

## Requirements

- Ubuntu VPS with nginx, certbot (`python3-certbot-nginx`), Docker with Compose v2, and `unzip`
- A DNS **A** record (plus **AAAA** if you use IPv6) for your domain pointing at the VPS
- Ports 80 and 443 open

## Install

Examples use `worldradio.zawaung.site`; replace it with your domain in steps 4 and 6 (and in the `server_name` line of the `.conf` file).

**1. Check DNS** - this must return your VPS IP before certbot will work:

```bash
dig +short worldradio.zawaung.site
```

**2. Copy the files to the server**

```bash
scp worldradio.zip user@YOUR_VPS_IP:~
ssh user@YOUR_VPS_IP
sudo mkdir -p /opt/worldradio && sudo chown $USER /opt/worldradio
unzip ~/worldradio.zip -d /opt/worldradio
```

**3. Start the containers**

```bash
cd /opt/worldradio
docker compose up -d --build
docker compose ps                  # worldradio and worldradio-api should be "running"
curl -I http://127.0.0.1:8080      # expect HTTP 200
```

**4. Add the host nginx site**

```bash
sudo cp worldradio.zawaung.site.conf /etc/nginx/sites-available/worldradio.zawaung.site
sudo ln -s /etc/nginx/sites-available/worldradio.zawaung.site /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**5. Open the firewall** (if you use ufw)

```bash
sudo ufw allow 'Nginx Full'
```

**6. Get the HTTPS certificate** (certbot adds the 443 block and the HTTP redirect)

```bash
sudo certbot --nginx -d worldradio.zawaung.site --redirect
sudo certbot renew --dry-run       # confirms automatic renewal works
```

**7. Verify**

```bash
curl -s https://worldradio.zawaung.site/api/dead     # expect {"uuids":[]}
```

Then open <https://worldradio.zawaung.site>.

## Update

```bash
cd /opt/worldradio
unzip -o ~/worldradio.zip
docker compose up -d --build
```

Then hard-refresh the browser (Ctrl+Shift+R). If installed as a phone app, close and reopen it once or twice, or clear the site data.

## Configuration

Set in `docker-compose.yml` under the `api` service, then run `docker compose up -d`.

| Variable | Default | Meaning |
|---|---|---|
| `DEAD_DAYS` | `3` | Days a confirmed-dead station stays hidden before it is re-checked |
| `DEAD_MIN_REPORTS` | `1` | Distinct visitors who must report a station (the server also tests the stream itself) |

Favourites and personally removed stations are stored in each visitor's browser only.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `container name "/worldradio" is already in use` | Leftover container from an earlier install | `docker rm -f worldradio worldradio-api`, then `docker compose up -d --build` |
| 502 Bad Gateway | Container not running, or wrong port | `docker compose ps`, `docker compose logs web`, `curl -I http://127.0.0.1:8080` |
| Certbot fails | DNS not propagated, or port 80 blocked | Re-check `dig`, open 80/443 in ufw **and** the provider's firewall |
| Map grey, tiles return 403 | OpenStreetMap requires a Referer header | Keep `Referrer-Policy "strict-origin-when-cross-origin"` in `nginx.conf`, rebuild, hard-refresh |
| Map or page partly broken | Content-Security-Policy blocking a resource | Read the browser console; adjust the CSP in `nginx.conf` and rebuild (a new tile provider needs `img-src`) |
| Station will not play | Stream is offline, or HTTP-only | Only HTTPS streams are listed. Use the **x** button to remove it; failures are also detected automatically |
| No track titles | Station sends none, or the API is down | `docker compose logs api`; many stations simply do not publish titles |
| Old version after update | Service worker / browser cache | Hard-refresh; on phones close and reopen the app or clear site data |
| A good station is hidden for everyone | Wrongly marked dead | `docker compose exec api rm -f /data/dead.json && docker compose restart api` |
| Personally removed stations | Stored in your browser | Click **Restore N removed** under the search results |

Useful commands: `docker compose logs -f --tail=50` (live logs), `docker compose restart`, `sudo nginx -t`, `sudo certbot certificates`.

## Uninstall

```bash
cd /opt/worldradio && docker compose down -v
sudo rm /etc/nginx/sites-enabled/worldradio.zawaung.site
sudo rm /etc/nginx/sites-available/worldradio.zawaung.site
sudo systemctl reload nginx
sudo certbot delete --cert-name worldradio.zawaung.site
```

## Design

### Principles

- **No build step, no framework.** The whole front end is one self-contained `index.html` (HTML, CSS and JavaScript) plus the Leaflet map library from a CDN. It is easy to read, edit and deploy.
- **No accounts, almost no server state.** Personal data lives in the visitor's browser. The server stores a single small JSON file (the shared dead-station list).
- **The browser talks to the station directory directly.** The server only does what a browser cannot: read track titles from streams and re-test streams that visitors report as dead.
- **Safe by default.** Strict Content-Security-Policy, escaped output, and a backend that can only be asked about known station IDs.

### Request flow

```
Station search      browser ---------------------------> Radio Browser API (mirrors)
Audio               browser ---------------------------> the station's own HTTPS stream
Map tiles           browser ---------------------------> tile.openstreetmap.org
Page and app files  browser --> host nginx --> web container (nginx)
Titles, dead list   browser --> host nginx --> web container --/api/--> api container
```

The api container in turn calls the Radio Browser directory (to find a station's stream address) and the streams themselves.

### Front end (`index.html`)

The script is one function with a single `state` object as the source of truth. User input changes `state`, then `render()` rebuilds the list, map pins and channel card from it. A full re-render is simple and fast enough for 40-200 rows, so no virtual DOM is needed. List clicks use one delegated event handler.

| Section | What it does |
|---|---|
| State | `stations` (current list), `current` station, `tag`, paging `offset`, `favs`, `hidden`, session `dead` flags, `sharedDead`, `recent` surprise picks, `np` (track title), `pending` (shared-link station) |
| Directory API | `getServers()` discovers Radio Browser mirrors from `all.api.radio-browser.info/json/servers` (random order, built-in fallback list). `api()` tries each mirror until one answers |
| Search | Debounced 350 ms. Fixed filters: `hidebroken=true`, `is_https=true`, `hls=0`, ordered by popularity; name, country and genre are optional. Browsing (no search text) loads 100 popular stations at a time and shuffles them, so the list differs on every visit; a typed search keeps best-match-first order, 40 per page. "Show more" loads the next batch. A request counter discards out-of-date responses |
| Location | `locate()` uses the station's exact coordinates if present; otherwise the country centre from a built-in table, nudged by a small offset derived from the station ID so pins do not stack. Approximate pins are drawn as dashed rings |
| Map | `ensureMap()` and `drawPins()`: Leaflet with OpenStreetMap tiles, markers in one layer group redrawn on each render. Clicking a pin selects the station and the map flies to it |
| Playback | `select()` plus the audio element events (see below) |
| Now playing | Polls `/api/nowplaying` every 20 s while playing; stops after 3 failures so a missing API costs nothing |
| Surprise me | Fetches 60 random stations with `cache: no-store`, drops hidden, dead and the last 30 picks, prefers stations with 5+ votes, then picks at random |
| Shared links | `#s=<station id>` in the URL. On load the station is fetched by ID, placed first in the list and selected without autoplay (browsers require a tap to start audio). `history.replaceState` keeps the URL in sync |

**Playback and dead-station handling**

```
select(station) -> set audio.src, play()      'play' event starts a 15 second connect timer
      |
      +-- 'playing' event --> live: stop timer, count a listen with the directory, poll titles
      |
      +-- 'error' event, or no audio within 15 s --> markDead(): row shows "Not responding",
                                                      card offers Remove, report sent to server
```

Three layers of "removed", from narrowest to widest:

| Layer | Trigger | Scope | Stored in |
|---|---|---|---|
| Session flag | Stream error or 15 s timeout | This page view | Memory |
| Personal removal | The x button or the card's Remove button | This browser | `localStorage` key `wr_hidden` |
| Shared removal | Server re-tests the stream and it fails | All visitors | `dead.json` on the server |

Other browser storage: `wr_favs` holds full station objects, so favourites show without a search; `wr_vol` holds the volume.

**Responsive layout.** CSS grid, 40% list and 60% map on desktop. At 760 px and below it becomes one column: the map is hidden, the genre chips collapse into a **Genre** button that opens a popup sheet (a native `<dialog>`), the channel card becomes a bar under the list, and the script never creates the map, so phones download no map tiles. Colours are CSS custom properties with a dark variant (`prefers-color-scheme`), and map tiles are inverted by a CSS filter in dark mode. Controls are real buttons with labels, the status line is `aria-live`, and animations respect `prefers-reduced-motion`.

**Installable app.** `manifest.webmanifest` and icons make it installable. `sw.js` is network-first: pages are always fresh after a deploy and fall back to the cached shell offline. Streams, tiles and `/api/` are never cached.

### Back end (`api/server.js`)

A dependency-free Node service (built-in `http`, `https`, `dns`, `net`, `fs` only), reachable only from the web container.

| Endpoint | Returns | Limit |
|---|---|---|
| `GET /api/nowplaying?uuid=` | `{ title }` | 40 per minute per IP |
| `GET /api/dead` | `{ uuids: [...] }` | none |
| `POST /api/dead/report` | `{ dead: true or false }` | 10 per minute per IP |
| `GET /api/health` | `{ ok: true }` | none |

**Track titles** use the ICY metadata protocol. The server requests the stream with the header `Icy-MetaData: 1`; the station replies with `icy-metaint`, a number N. After every N bytes of audio the stream carries one length byte (times 16) and a block such as `StreamTitle='Artist - Song';`. The server reads just the first block, closes the connection and returns the cleaned title. Results are cached 15 s per station, and simultaneous requests share one fetch.

**Dead-station verification.** A report triggers a probe: the server opens the stream itself and counts it alive only if it answers 2xx, is not an HTML page, and sends audio bytes within 8 s. Alive means the report is ignored, so visitors cannot hide working stations. If the probe fails and `DEAD_MIN_REPORTS` distinct visitors (hashed IPs) have reported it, the station goes into `dead.json` (written atomically via a temp file and rename) and expires after `DEAD_DAYS`. If the server is too busy to probe, it assumes the station is alive.

| Cache | Lifetime | Purpose |
|---|---|---|
| Station ID to stream URL | 1 hour | Avoids repeated directory lookups |
| Now-playing title | 15 seconds | Many listeners of one station cost one connection |
| Probe result | 60 seconds | Repeated reports trigger one test |

### Security design

- **Browser.** Every piece of directory text is escaped before it enters the page. Station logos load only over HTTPS with `referrerpolicy="no-referrer"`; external links use `rel="noopener noreferrer"`. The Content-Security-Policy limits scripts, styles, connections and media to known sources. `Referrer-Policy` sends only the site origin, which OpenStreetMap's tile policy requires.
- **Server-side request forgery.** Clients send a station ID, never a URL; the server looks the URL up itself. Only HTTPS is allowed. A custom DNS lookup refuses private, loopback, link-local and other internal address ranges at connection time, which also defeats DNS rebinding. IP literals are checked, redirects are re-validated (maximum 3), connections time out after 8 s, and at most 12 run at once. Stream data is never relayed to the visitor, only a parsed, sanitised title (control characters removed, 200 characters maximum).
- **Abuse.** Per-IP rate limits (the real IP comes from `X-Real-IP`, set by the host nginx), UUID format validation, a 2 KB request body limit, and server-verified dead reports.
- **Containers.** The API runs as the unprivileged `node` user and publishes no port; the web container is bound to `127.0.0.1` and only the host nginx faces the internet.

### Trade-offs and limitations

- Only HTTPS, non-HLS streams are listed. Browsers block plain HTTP audio on an HTTPS page, and HLS needs an extra player library, so some stations are excluded.
- Stations without coordinates get an approximate pin at the country centre rather than being hidden.
- Favourites and personal removals do not sync between devices (no accounts).
- Track titles appear only for streams that send ICY metadata.
- Dead-station tests run from the VPS's network location, so a station that blocks that region may be hidden for everyone until its entry expires.
- OpenStreetMap's public tiles suit light use only; see Notes and credits.

### Extending

- **Genre chips and the popup:** edit the `GENRES` array; both use it.
- **Missing country centre:** add a code to the `CENTRES` table.
- **Different map tiles:** change the tile URL and attribution in `ensureMap()`, and add the provider's domain to `img-src` in `nginx.conf`.
- **New API route:** add a handler in `api/server.js`; the web container already forwards everything under `/api/`.

## Project layout

| Path | Purpose |
|---|---|
| `index.html` | The whole web app (list, map, player) |
| `sw.js`, `manifest.webmanifest`, `icon*` | Installable-app files |
| `Dockerfile`, `nginx.conf` | `web` container: serves the page, proxies `/api/`, sets security headers |
| `api/server.js`, `api/Dockerfile` | `api` container: track titles and the dead-station list |
| `docker-compose.yml` | Runs both containers; only `127.0.0.1:8080` is exposed |
| `worldradio.zawaung.site.conf` | Host nginx site (certbot adds HTTPS) |

## Notes and credits

- OpenStreetMap's public tile servers are for light use. For heavy traffic switch to a tile provider that permits it (and add its domain to `img-src` in the CSP). Keep the attribution.
- The page loads the Bricolage Grotesque font from Google Fonts and Leaflet from cdnjs. Remove the font `<link>` lines to avoid contacting Google.
- Data: [Radio Browser](https://www.radio-browser.info) and [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Map library: [Leaflet](https://leafletjs.com). Streams belong to their broadcasters.
