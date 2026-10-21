# World Radio

World Radio is a self-hosted web app for discovering and listening to live radio stations around the world. It combines a searchable station directory, an interactive map on desktop, and a built-in audio player. The goal is to make global radio easy to explore without accounts or a complex application stack.

## Project goals

- Find stations by name, country, and genre, or discover one with **Surprise me**.
- Show station locations on a map, with approximate country-centre pins when exact coordinates are unavailable.
- Play live streams, save favourites, remove stations locally, and share a station link.
- Show track titles when a station provides ICY metadata, and identify streams that stop responding.
- Keep deployment and maintenance straightforward: no frontend build system, no third-party application dependencies in the API, and only minimal shared server state.

## How it works

```text
Browser ── HTTPS ──> host nginx ──> web container (nginx)
  │                                      │
  ├── station search ──> Radio Browser  └── /api/ ──> API container (Node.js)
  ├── audio ───────────> station stream                    ├── Radio Browser
  └── map tiles ───────> OpenStreetMap                     └── station stream
```

The browser queries the community [Radio Browser](https://www.radio-browser.info) directory and plays station streams directly. The API is used for tasks that cannot be performed reliably in the browser: reading stream track metadata and verifying user reports of offline stations. [Leaflet](https://leafletjs.com) displays [OpenStreetMap](https://www.openstreetmap.org) tiles on desktop.

The web container serves the static app and proxies `/api/` to the API container. The web container is published only on `127.0.0.1:8080`; the API has no published host port. Host nginx provides the public HTTPS endpoint.

## Features and operation

- Search and filter stations by name, country, and genre. Browsing loads popular stations in a shuffled order; searches are ranked by the directory.
- Browse station locations on desktop. Phones use a single-column list and player without loading the map.
- Play HTTPS, non-HLS streams, adjust volume, save favourites, and copy links to stations.
- Check for now-playing titles while a station is playing. Titles are available only for stations that publish ICY metadata.
- Detect playback errors and connection timeouts. User reports are checked by the API before a station is marked offline for everyone.
- Install the site as a Progressive Web App. The service worker caches the app shell for offline access, but never caches API responses, map tiles, or audio streams.

Favourites, volume, and personally removed stations are stored in the visitor's browser. Shared offline-station status is stored by the API in `/data/dead.json`, persisted in the `worldradio-data` Docker volume, and expires after the configured number of days.

## How the code is constructed

The frontend is a single `index.html` containing HTML, CSS, and JavaScript. It has no bundler or frontend framework. A single state object drives the station list, map markers, and station card; updates re-render the UI. Leaflet and the Bricolage Grotesque font are loaded from CDNs.

The API in `api/server.js` is a small Node.js HTTP service built with Node's standard libraries and global `fetch`; it has no package dependencies. It resolves station IDs through Radio Browser, reads ICY metadata from HTTPS streams, and probes streams to verify offline reports. The browser supplies a station UUID, not a URL.

Docker Compose builds and runs two services:

| Service | Image definition | Responsibility |
|---|---|---|
| `web` | `Dockerfile` | Serve static files, set response security headers, and proxy `/api/` |
| `api` | `api/Dockerfile` | Serve API routes and persist verified offline stations |

`nginx.conf` configures nginx inside the web container. `worldradio.zawaung.site.conf` is an example host-nginx virtual host; replace its sample domain with your own. The manifest, icons, and `sw.js` provide installable-app support.

## Requirements

For the documented VPS deployment:

- A Linux VPS with Docker Engine and Docker Compose v2.
- Host nginx and Certbot with the nginx plugin (Ubuntu package: `python3-certbot-nginx`).
- A domain whose DNS A record (and AAAA record, if using IPv6) points to the VPS.
- Public inbound ports 80 and 443.

No local Node.js installation is required; the API runs in its container.

## Install

The following example targets Ubuntu and uses `worldradio.example.com` as a placeholder. Replace it with your domain wherever it appears.

1. Install Docker Engine with the Compose v2 plugin, nginx, Certbot, and the Certbot nginx plugin. Ensure DNS points to the VPS and ports 80 and 443 are open.

2. Get the project on the server and start the containers:

   ```bash
   git clone https://github.com/zawaung7791/worldradio.git /opt/worldradio
   cd /opt/worldradio
   docker compose up -d --build
   docker compose ps
   curl -I http://127.0.0.1:8080
   ```

   Both `worldradio` and `worldradio-api` should be running; the local HTTP check should return `200`.

3. Configure host nginx. Edit `worldradio.zawaung.site.conf` and replace its `server_name` with your domain, then install it:

   ```bash
   sudo cp worldradio.zawaung.site.conf /etc/nginx/sites-available/worldradio
   sudo ln -s /etc/nginx/sites-available/worldradio /etc/nginx/sites-enabled/worldradio
   sudo nginx -t
   sudo systemctl reload nginx
   ```

4. If using UFW, allow web traffic, then request the TLS certificate:

   ```bash
   sudo ufw allow 'Nginx Full'
   sudo certbot --nginx -d worldradio.example.com --redirect
   sudo certbot renew --dry-run
   ```

5. Verify the public endpoint:

   ```bash
   curl -s https://worldradio.example.com/api/health
   ```

   The response should be `{"ok":true}`. Then open `https://worldradio.example.com` in a browser.

## Configuration

Set API options under the `api` service's `environment` section in `docker-compose.yml`, then apply them with `docker compose up -d`.

| Variable | Default | Description |
|---|---:|---|
| `DEAD_DAYS` | `3` | Days a confirmed-offline station remains hidden before it can be rechecked. |
| `DEAD_MIN_REPORTS` | `1` | Number of distinct visitors who must report a station, in addition to a failed server-side stream probe. |

The API listens on port `3000` inside the Compose network. Its data directory defaults to `/data`; Compose mounts the persistent `worldradio-data` volume there.

## Operations and maintenance

Run commands from the project directory (`/opt/worldradio` in the install example):

```bash
docker compose ps                         # Service status
docker compose logs -f --tail=50          # Follow recent logs
docker compose logs -f api                 # API logs only
docker compose restart                    # Restart services
docker compose up -d --build              # Rebuild and apply source/config changes
```

To update a Git checkout:

```bash
cd /opt/worldradio
git pull
docker compose up -d --build
```

After deploying, hard-refresh the browser. If the app is installed on a phone, close and reopen it; if the old shell persists, clear the site's data.

The named `worldradio-data` volume retains the shared offline-station list across container rebuilds and restarts. Preserve this volume when updating. For a backup, stop the API before copying its data, then restart it:

```bash
docker compose stop api
docker compose cp api:/data ./worldradio-data-backup
docker compose start api
```

Host nginx and certificate maintenance remain separate from Docker. Check nginx configuration with `sudo nginx -t`, inspect certificates with `sudo certbot certificates`, and verify renewal with `sudo certbot renew --dry-run`.

To clear the shared offline-station list and have it rebuilt as reports arrive:

```bash
docker compose exec api rm -f /data/dead.json
docker compose restart api
```

To remove the deployment, remove the host-nginx site and optionally its certificate. `docker compose down -v` also deletes the persistent data volume:

```bash
cd /opt/worldradio
docker compose down -v
sudo rm /etc/nginx/sites-enabled/worldradio
sudo rm /etc/nginx/sites-available/worldradio
sudo nginx -t && sudo systemctl reload nginx
sudo certbot delete --cert-name worldradio.example.com
```

## API

All routes are served under `/api/` by the API container:

| Method and path | Purpose |
|---|---|
| `GET /api/health` | Health check; returns `{"ok":true}`. |
| `GET /api/dead` | List UUIDs currently confirmed offline. |
| `GET /api/nowplaying?uuid=<uuid>` | Read the current ICY stream title, if provided. Limited to 40 requests per minute per IP. |
| `POST /api/dead/report` | Verify a report for a station UUID. Limited to 10 requests per minute per IP. |

The report body is JSON: `{"uuid":"<station-uuid>"}`. The API validates UUIDs, limits request size and concurrent stream probes, caches directory lookups and probe results, and rejects non-HTTPS streams. Its stream URL lookup and outbound-connection checks prevent clients from using the API to request arbitrary URLs or private network addresses.

## Security and limitations

- Host nginx is the public entry point. Keep the API port private and the web container bound to localhost.
- The web nginx config sets a Content Security Policy and other security headers. If adding a new external resource provider, review the relevant CSP directive in `nginx.conf`.
- Only HTTPS, non-HLS streams are supported. Some stations may therefore be unavailable.
- Track titles depend on stream-provided ICY metadata. Map pins may be approximate when the directory has no exact coordinates.
- Browser-stored favourites and removals do not synchronize across devices; there are no user accounts.
- Offline checks originate from the VPS, so regional stream restrictions can cause a false offline result. Such entries expire after `DEAD_DAYS`.
- OpenStreetMap's public tile service is intended for light use. Use a provider whose terms support your traffic if the site grows, and retain proper attribution.

## Troubleshooting

| Symptom | Check |
|---|---|
| Site returns 502 | Run `docker compose ps`, inspect `docker compose logs web`, and check `curl -I http://127.0.0.1:8080`. |
| Certbot cannot issue a certificate | Confirm DNS resolves to the VPS and that ports 80 and 443 are open in both host and provider firewalls. |
| Map tiles fail or return 403 | Confirm the referrer policy in `nginx.conf`; OpenStreetMap tiles require a valid referrer. |
| Search fails | Check the browser connection and try again; the app uses the Radio Browser directory directly. |
| A station will not play | The stream may be offline or unsupported. Only HTTPS, non-HLS streams are listed. |
| No track title appears | The station may not send ICY metadata; otherwise inspect `docker compose logs api`. |
| Old app version remains | Hard-refresh, then close and reopen the installed app or clear site data. |

## Project files

| Path | Purpose |
|---|---|
| `index.html` | Frontend application and styling |
| `api/server.js` | API and stream metadata/offline verification logic |
| `Dockerfile`, `nginx.conf` | Static web container |
| `api/Dockerfile` | API container |
| `docker-compose.yml` | Services, private port mapping, and persistent volume |
| `worldradio.zawaung.site.conf` | Example host-nginx virtual host |
| `sw.js`, `manifest.webmanifest`, `icon*` | Service worker and installable-app assets |

## Credits and license

Station data is provided by [Radio Browser](https://www.radio-browser.info). Map data and tiles are from [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). The app uses [Leaflet](https://leafletjs.com); the Bricolage Grotesque font is served by Google Fonts. Radio streams remain the property of their broadcasters.

This project is distributed under the [MIT License](LICENSE).
