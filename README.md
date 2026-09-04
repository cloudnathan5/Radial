# Radial

An internet-radio browser built on the [radio-browser.info](https://api.radio-browser.info)
directory. Browse and filter ~50k stations, see them on a world map, keep favorites,
record what you're listening to, and play arbitrary stream URLs.

Implemented from the `Radial.dc.html` Claude Design canvas.

## Run

No build step, no dependencies to install — it's static files. Any static server works:

```bash
python3 -m http.server 8137
```

Then open <http://localhost:8137>. Opening `index.html` via `file://` will not work:
the radio-browser API requires an `http(s)` origin for CORS.

## Files

| File | Role |
| --- | --- |
| `index.html` | Markup for all four pages and the player bar |
| `styles.css` | Design tokens (light/dark) and every component style |
| `app.js` | State, radio-browser API access, audio, persistence, map bridge |
| `map.html` | Standalone Leaflet map, driven entirely over `postMessage` |
| `manifest.json` | Web app manifest — makes it installable as a desktop/mobile app |
| `sw.js` | Service worker; caches the app shell, ignores everything cross-origin |
| — | Recordings live in IndexedDB (`opendial` / `recordings`), not in a file |
| `config.js` | Runtime config — set `proxy` to enable now-playing, empty for pure static |
| `themes.js` | Preset palettes and the share-code encoder/decoder |
| `icons/` | App icons (192/512 plus maskable variants, Apple touch, favicon) |
| `worker/` | **Optional** Cloudflare Worker that reads now-playing metadata |

`map.html` is sandboxed in an iframe and shares no globals with the app. The two talk
over four messages: `stations`, `theme`, and `current` go down; `play` comes back up.

## Install as an app

Radial is a PWA, so Chrome and Edge offer to install it as a standalone desktop
app — the same thing SoundCloud and YouTube Music do with their "install" button.
Nothing is downloaded as a file: the browser registers the site as an app, adds a
desktop/Start-menu entry, and runs it in its own window with no browser chrome.
The app still loads from the network; the service worker just makes the shell
instant and resilient.

Chrome's install criteria, all met here: served over HTTPS, a manifest with
`name`, `start_url`, `display: standalone` and 192px + 512px icons, and a service
worker with a `fetch` handler. When the browser fires `beforeinstallprompt` the
sidebar grows an **Install app** button; otherwise the browser's own install icon
in the address bar does the same job. Safari has no install prompt — it uses
"Add to Dock" (macOS) or "Add to Home Screen" (iOS), both of which read the same
manifest. Firefox dropped desktop PWA install entirely.

### How updates reach installed users

Push to GitHub Pages and installed apps pick the change up on their own — there is
no app store and nothing for anyone to reinstall. Two mechanisms, deliberately kept
separate:

- **Content** (`index.html`, `app.js`, `styles.css`, `map.html`) is served
  **network-first** by the service worker, so a deploy lands on the user's *next
  load*. This matters: a cache-first shell — the more common recipe — serves the
  previous version's JS for one more load and leaves everyone permanently one
  version behind. The cache here is strictly an offline fallback.
- **The service worker itself** updates when `sw.js` changes by even one byte. The
  browser re-checks it on navigation (bypassing the HTTP cache, so GitHub Pages'
  10-minute `Cache-Control` doesn't hold it back) and at least daily.

A new worker deliberately does **not** take over a running page — it would be
swapping code under a tab that is very possibly playing audio. It waits, and the
sidebar shows **Update ready**; clicking it activates the new worker and reloads.
Closing every tab activates it too, so a relaunch is always current.

Bump `VERSION` in `sw.js` whenever the precache list changes; `activate` deletes
every cache that doesn't match, so old assets are cleaned up automatically.

### Deploying to GitHub Pages

Push these files to a repo and enable Pages; nothing needs building. GitHub Pages
serves HTTPS, which is the only hard requirement PWAs add.

The one thing to watch is the sub-path — a project site lives at
`https://<user>.github.io/<repo>/`, not at the domain root. Every path here is
relative for that reason: `manifest.json` uses `"start_url": "."` and
`"scope": "./"`, the service worker is registered as `sw.js` (so its scope is the
repo directory), and no asset is referenced from `/`. Moving the app to a custom
domain or a user site needs no changes.

## Optional: now-playing track titles

Radial ships fully static with this off. Deploying one small Cloudflare Worker turns
on the current track in the player bar.

It has to be server-side for exactly one reason: `Icy-MetaData: 1` is not a
CORS-safelisted request header, so asking a stream for its metadata makes the request
preflighted, and stream servers do not answer `OPTIONS`. There is no preflight
server-side, so the identical read simply works. This is the same mechanism native
players use — GStreamer hands Shortwave the title as a `Tag` message on the pipeline.

```bash
cd worker && npx wrangler deploy
```

Then put the deployed URL in `config.js`:

```js
window.RADIAL = { proxy: "https://radial-nowplaying.<you>.workers.dev" };
```

Leave it empty and nothing changes — no requests are made and the player shows
country/codec as before.

**What it does.** `GET /nowplaying?url=<stream>` connects, reads the `icy-metaint`
offset, skips one audio block and parses `StreamTitle`. `GET /health` is the
capability probe the app runs at startup. Responses are cached 15 seconds, so several
listeners on one station hit the origin once.

**Coverage** is about 46% of stations — 60% broadcast a title and roughly 77% of those
parse into artist and track. Stations that send nothing keep showing country/codec,
and the app stops polling one that reports no metadata support.

**The parser earns its keep**, because real values are a mess:

| Received | Parsed as |
| --- | --- |
| `Olivia Dean - text="Man I Need" song_spot="M" MediaBaseId=…` | Olivia Dean — Man I Need |
| `title="Locked Out Of Heaven",artist="BRUNO MARS"` | BRUNO MARS — Locked Out Of Heaven |
| `Kfi Cross Promo - text="…" song_spot="T"` | rejected — `song_spot` ≠ M is an advert |
| `9999999 - 9999999` | rejected as a placeholder |
| `*** Werbung in SWR3 ***` | rejected as an ad marker |
| `Traffic - Traffic` | rejected — a repeated value is not a song |

Only a parsed artist/title pair reaches the UI. A slogan or ad marker shows nothing,
which beats showing garbage.

**Cost:** the free plan allows 100k requests/day; this makes one subrequest per call,
and reading ~16 KB off a stream is I/O rather than CPU time.

### Auditing it

The worker is one file, [`worker/index.js`](worker/index.js), with **no dependencies**
— there is no `package.json`, so there is no transitive tree to audit either. The
claims below are all checkable with `grep` in a few seconds:

```bash
grep -n 'fetch('   worker/index.js   # one outbound call, to the ?url= stream
grep -n 'console\.' worker/index.js   # no logging (the only hit is the comment saying so)
grep -nE 'KV|D1|R2|Durable|analytics' worker/index.js   # no storage, no telemetry
```

It contacts **only the stream URL passed to it** — the same host the listener's
browser is already pulling audio from. No analytics, no third-party API, no API key,
no storage, no logging. `GET /health` returns those claims as JSON (`contacts`,
`stores`, `logs`, `thirdParties`, `apiKeys`) alongside a version and a link to the
source, so a deployment can be compared against this repository without reading code.

**What the operator can see, stated plainly:** Cloudflare receives the caller's IP and
the `?url=` parameter, so whoever runs a deployment could learn which station an IP is
listening to. That is inherent to making an HTTP request and cannot be engineered
away. Two things reduce it to a choice rather than a condition:

- **It is off by default.** A stock build sets `proxy: ""`, makes no such request at
  all, and simply shows country/codec instead.
- **Anyone can run their own.** `npx wrangler deploy` and one line in `config.js`
  points the app at your own worker, so no third party is involved.

**The honest limitation:** nobody can cryptographically prove that a *deployed* worker
is running the published source. If that matters to someone, self-hosting is the only
real answer — which is why the app is built to make that a one-line change rather than
a fork.

In the app itself, hovering the track line shows the raw metadata plus the host it was
read through, so the provenance is visible rather than implied.

## Behavior notes

- **Persistence.** Favorites, recently played, saved custom streams, theme, and volume
  are kept in `localStorage` under the `rad.*` keys. Nothing leaves the browser.
- **API mirrors.** radio-browser has no single canonical host. Requests start at `de1`
  and fall through `de2` → `at1` → `nl1` on failure; the mirrors rate-limit and
  intermittently answer without CORS headers, so this failover is load-bearing, not
  belt-and-braces.
- **Default sort is most votes** (`order=votes`, reversed), which the API returns
  strictly descending.
- **Filters are server-side.** Every filter change re-queries the API (search input
  debounced 380ms, dropdowns 40ms). The map shows the same filtered set, capped at
  2500 geolocated stations.
- **Two views of Browse**, chosen with the List / Map control in the filter bar and
  remembered in `rad.view`. The map is not a separate section — it is a view of the
  same filtered set, so the nav is Browse / Library / Custom stream.
  - **List** is the full-width table: every column, paged 400 at a time.
  - **Map** puts the map beside a narrow list that follows it. Panning or zooming
    re-filters the list to whatever is on screen; the map reports its bounds to the
    app on every `moveend`/`zoomend` and the app filters locally, so panning costs no
    requests.
  - **A real difference worth knowing:** the map view's list is drawn from the
    *geolocated* set (up to 2500 stations with coordinates), not the top-400 the
    table normally shows — a station without coordinates cannot appear on a map. It
    renders at most 300 rows and says so plainly, e.g. `300 of 623 in view`.
  - Below 860px the two panes stack rather than sitting side by side.
  - `rad.view` accepts the older `"split"` and map-only `"map"` values and collapses
    both onto this view.
- **The table pages.** The directory holds ~58,700 stations (~53,300 working), and
  real queries are far larger than one page — `jazz` matches ~1,400 and `radio`
  ~24,800. Rows load 400 at a time on scroll, up to 2,000, after which the label asks
  for narrower filters rather than pretending there is nothing more.
  - The count is worded to match what is actually known. radio-browser returns no
    total for a search, so a full page back means "there is probably more" and the
    label reads `400+ shown`; once a short page comes back the list is exhausted and
    the number becomes a real total, `8 stations`. It never claims a total it hasn't
    established.
- **Category vs. genre.** radio-browser has no category concept — only free-form
  tags. Each category in the dropdown is a curated tag set OR-ed together, defined
  in `CATEGORIES` in `app.js`. The API's `tagList` is AND-only, so an OR costs one
  query per tag, merged and re-sorted client-side. Category and genre combine with
  AND. Tag matching is a substring match, so `news` also catches "news talk" and
  "local news" — which is why most categories need only one tag.
- **Volume is not linear.** Perceived loudness tracks roughly the square of the
  fader position, so the slider is squared before it reaches the audio element
  (50% → −12 dB, 5% → −52 dB). A linear slider makes everything below ~20% sound
  much louder than its number suggests. The curve is `gainFor()` in `app.js`.
- **Resuming a live stream reconnects rather than continuing.** Pausing an `<audio>`
  element stops the download outright, so a plain resume replays the buffered tail
  and leaves you behind live by the length of the pause — measured at ~12 s behind
  after a 12.5 s pause, and it accumulates across every pause with nothing on screen
  to say so. Resuming therefore reopens the stream: one second of rebuffering in
  exchange for actually being live. Recordings are finite files, so pause/resume
  there continues where it left off.
  - This path deliberately avoids `play()`, which pings `/url/{uuid}` — that is how
    radio-browser counts listens, and a resume is not a new listen.
  - **Pausing playback does not interrupt a recording.** Recording runs on its own
    `fetch` connection, so the two are independent: measured at 31.2 s captured over
    23 s of wall clock containing two pause/resume cycles. A recording is one
    continuous take regardless of what playback does, and will contain audio that was
    never heard live.
- **Play counts.** Playing a directory station pings `/url/{uuid}`, which is how
  radio-browser tallies listens. Custom streams are excluded.
- **Station artwork.** radio-browser carries a `favicon` URL per station, shown in
  the browse list, the library and the player. Measured over the 80 most-played
  stations: **72%** resolve to a real image, 16% have no URL and 10% are dead links —
  so every use sits over a lettered tile that shows through when the image fails
  (caught via a capture-phase `error` listener, since `error` does not bubble).
  - Images are `loading="lazy"`, so a 400-row list fetches only what is on screen —
    about 50 requests rather than 400.
  - **Worth knowing:** these load from the stations' own hosts, so browsing reveals
    your IP to those hosts. `referrerpolicy="no-referrer"` keeps the app's URL out of
    their logs, but the request itself is unavoidable if the artwork is shown at all.
  - **Artwork is off by default**, because it is the only thing in the app that
    contacts hosts other than the directory and the stream you chose to play.
  - **The default is toggled** by the small image icon in the table header, above the
    artwork column (icon-only; 30px leaves no room for a label, so the meaning lives
    in `title` and `aria-label`). Off omits the `<img>` elements entirely rather than
    hiding them, so **no request reaches any station host**. Persists in `rad.images`.
  - **Per-station override**, on the player tile: a badge that cycles
    **auto → always on → always off → auto**, stored in `rad.imgPins`.

    The design point worth keeping: `auto` is the *absence* of an entry, and the
    other two store an **explicit** `true`/`false` — not "differs from the default".
    Inferring intent from a difference silently inverts every pinned station the
    moment the default is flipped. With explicit values, a station pinned on while
    the default is off stays on when the default is turned on, and vice versa.

    Consequences of that choice, all deliberate: a station following the default
    costs nothing to store and keeps following it when it changes; `auto` is revealed
    on hover while `on`/`off` stay visible, so a pinned station is identifiable at a
    glance; overrides apply everywhere, not only in the player, so pinning one
    station while the default is off shows exactly one artwork in the list; and the
    map is capped at 300 entries. The badge hides for the ~16% of stations that
    publish no artwork at all, and for recordings.
- **The live indicator is a real analyser.** The trefoil next to LIVE is driven by
  Web Audio: the three bands (bass 0–1.5 kHz, mids 1.5–3.75 kHz, highs 3.75–9 kHz)
  are averaged into one level, and the two arcs of every blade light together like a
  signal-strength meter, so the whole mark pulses as a unit. `UNIFIED_PULSE` in
  `app.js` switches to per-blade metering instead.
  - **Arcs are binary — lit or resting, never in between.** At 15px a partly-faded
    arc reads as flicker rather than as brightness. Each ring has separate on and off
    thresholds: a single threshold chatters whenever the level sits on it, which
    would look exactly like the flicker this avoids. The CSS fallback animation is
    square-stepped for the same reason.
  - This needs **two audio elements**. `createMediaElementSource()` silences a
    cross-origin element that fails the CORS check and cannot be undone once
    attached, so a single blocked station would kill playback permanently. One
    element carries `crossOrigin` and is wired to the analyser; the other is never
    touched by Web Audio and takes over when a stream refuses. Stations without CORS
    fall back to a CSS keyframe sweep and play normally.
  - Levels get a static tilt (music falls off ~3 dB/octave, so raw magnitudes leave
    bass permanently winning) plus a slow per-band envelope. The expanded value is
    blended with the raw one rather than replacing it — dividing purely by a decaying
    peak pegs every band at full on steady material.
  - **Volume lives in a `GainNode`, not on the element.** A media element's `volume`
    is applied *before* the audio reaches `createMediaElementSource`, so setting it
    there made the meter dim as the listener turned down. The graph is
    `source → analyser → gain → destination`: the element stays at full scale, the
    analyser reads the music, and the gain node sets listening level. The plain
    element still uses element volume since it is not in the graph — both go through
    one `applyVolume()` so they cannot drift apart.
- **Themes.** The whole UI is built from twelve CSS custom properties, so a theme is
  just those twelve colours plus a `dark` flag. The sidebar button opens a picker with
  13 presets; changing any individual colour forks the current theme into a custom one.
  - **Share codes.** The palette packs into `[version][dark][12 × RGB][name]`,
    base64url-encoded — about 60 characters. Copy it from the picker, or paste one in
    to load it. `#theme=<code>` in the URL also works, so a theme can be shared as a
    link; it wins over stored settings, and is applied before first paint.
  - **Alt+T** still flips light/dark, returning to whichever theme of that mode was
    last used rather than dropping you on the default.
  - The map iframe receives the palette too, so pins and clusters match custom themes.
  - **The tab icon follows the theme.** It is generated at runtime as an SVG data
    URI from the current palette (accent tile, `accent-fg` mark) and swapped on every
    theme change, with `icons/favicon-32.png` kept as `rel="alternate icon"` for
    browsers without SVG favicon support. A data URI also sidesteps the browser's
    favicon cache, which is unusually sticky and largely independent of normal HTTP
    caching — the reason a replaced `.png` can keep showing the old icon for a long
    time. The two-arc variant of the mark is used, since three arcs turn to mush at
    16px.
- **Offline.** The service worker precaches the shell, so the app opens with the
  server unreachable — verified by stopping the server and reloading. It cannot do
  anything useful offline beyond that, since stations and the directory are both
  remote. Cross-origin requests are passed straight through and never cached: an
  audio stream is endless, so caching one would grow without bound.
- **Recording.** The ● button in the player captures the live stream. It works for
  roughly 77% of stations — see below for which ones and why. Recording opens its
  *own* connection to the stream rather than tapping the playing `<audio>` element,
  because Web Audio cannot read a cross-origin media element without CORS headers
  that most stations don't send. The cost is a second connection while recording.
  - **Recordings are kept in the browser, not downloaded.** They land in the
    **Recordings** section of Library, where they can be played back in place,
    downloaded to the device, or deleted. Nothing touches the filesystem unless you
    press ⤓, and deleting asks first.
  - Stored in **IndexedDB** as Blobs — `localStorage` is string-only and capped
    around 5 MB, so it is not an option here. The app calls
    `navigator.storage.persist()` after the first save to ask the browser not to
    evict them under storage pressure; without persistence granted, a browser
    clearing site data will take them.
  - A stored recording plays through the normal player as a pseudo-station backed by
    an object URL. Favourite, share and record are disabled while one is playing —
    an object URL is meaningless outside the session, so persisting it would break.
  - Held in memory during capture, capped at 300 MB (~5 hours at 128 kbps), with a
    beforeunload prompt so a tab close doesn't silently discard one in progress.
  - Recordings run *longer* than the elapsed timer: Icecast's burst-on-connect sends
    a few seconds of backfill the moment you connect, so you capture a little before
    you pressed record. The list shows the real length, read off the blob rather than
    from the timer — a 7-second capture is typically ~21 seconds of audio.
  - A recording belongs to the station it started on — changing station or stopping
    playback finalises and saves it.
  - Personal time-shifting of broadcasts is broadly accepted; redistribution is not,
    and some streams' terms prohibit recording outright.

## Known constraints

These are properties of internet radio, not bugs:

- A station streaming over plain `http://` cannot be played from a page served over
  `https://` — browsers block the mixed content. Served over `http://localhost` they
  play fine.
- Some stations advertise CORS-less endpoints or are simply offline; the player
  surfaces these as **Stream unavailable**.
- `.m3u` / `.pls` playlist URLs are handed to the browser as-is. Most browsers follow
  them; a few do not.
- About a quarter of stations cannot be recorded, and the app says which and why
  rather than failing silently. Measured over the 80 most-played stations:

  | | share | recordable |
  | --- | --- | --- |
  | Progressive MP3/AAC with CORS headers | ~66% | yes |
  | HLS (`.m3u8`) | ~11% | no — would need segment fetching via hls.js |
  | No CORS headers | ~17% | no — `fetch()` is blocked before a byte arrives |
  | Unreachable | ~6% | no |

  Unlike the metadata case below, recording needs no custom request header, so it
  triggers no CORS preflight — which is why its success rate is so much higher.

## Deviations from the design canvas

The design is followed as drawn, plus a **Category** filter added after the first
review. Four changes were needed to make it work as a real page:

1. **Leaflet size invalidation.** The map iframe starts hidden, so Leaflet's first
   measurement is of a zero-size container and the map renders into a small square.
   `map.html` now re-measures via `ResizeObserver` and on an explicit `resize` message.
2. **Stop no longer reports an error.** Clearing `audio.src` fires an `error` event,
   which flipped the just-idled player to "Stream unavailable". Transport events are
   now suppressed while the source is being swapped.
3. **A Retry control.** The API-failure message tells the user to retry but the design
   gave them no way to; the empty state now carries a Retry link.
4. **Ranked metadata queries.** `/tags`, `/countries` and `/languages` cap their
   response at 1000 rows returned *alphabetically*. Ranking that slice by station
   count therefore ranked only the first 1000 names, and the genre dropdown ran out
   somewhere around "af…". All three now pass `order=stationcount&reverse=true`.

Two smaller additions: a loading line in the table while a query is in flight, and
`aria-label`/`aria-pressed` on the icon-only buttons.

## Design note: now-playing / song identification

Investigated, deliberately not built — it cannot be done from a static page. Notes
here so the next person doesn't have to re-derive it.

### Most stations already announce the track

Shoutcast/Icecast streams carry in-band ICY metadata: request the stream with
`Icy-MetaData: 1`, read the `icy-metaint` byte offset from the response headers,
then every `metaint` bytes there is a length byte followed by
`StreamTitle='Artist - Track';`. No fingerprinting needed.

Measured against the 80 most-played stations in the directory:

| | share |
| --- | --- |
| Live `StreamTitle` present | 60% |
| — of those, parseable as "Artist – Track" | 77% |
| Empty title (mostly talk/news — no song to name) | 20% |
| HLS streams, no ICY metadata at all | 11% |
| No metadata support | 9% |

So roughly 46% of stations hand you an exact track for free, instantly, with no API
key and no per-query cost.

### The browser cannot read it

This is the blocker, and it fails two independent ways — both verified, not assumed:

- `Icy-MetaData: 1` is not a CORS-safelisted request header, so it forces a preflight.
  Icecast and the audio CDNs don't answer `OPTIONS`, so the request never happens.
  BBC World Service, Deutschlandfunk and WALM all fail this way.
- Where a server *does* allow the request (Radio Paradise), `icy-metaint` is not in
  its `Access-Control-Expose-Headers`, so JS cannot read the offset and has no way to
  locate the metadata blocks.

Measured over 40 stations: 12 survived the preflight, 6 of those also exposed
`icy-metaint` and could be parsed in-browser — but only **1 of the 40** yielded a real
song title (Capital: "Walk The Moon - Shut Up & Dance"). The rest returned station
slogans, empty strings, or internal database IDs like `285876 - 401548`. Checking the
HLS route separately, 2 of 5 HLS streams carried in-band ID3 and one had a usable
`TIT2` ("RTL Soir"), which adds a couple more percent.

So it is not literally impossible from a static page — roughly **5%** of stations
would show something. It is just not shippable: a now-playing line that is blank or
reads `285876 - 401548` for nineteen stations in twenty is worse than no line at all.
The same requests succeed from outside the browser, which is how the 60% table above
was measured.

The contrast with recording is the whole story, and it comes down to one header.
`Icy-MetaData: 1` makes the request non-simple and forces a preflight; recording
reads *the same bytes from the same URL* without any custom header, never preflights,
and therefore works for 77% of stations instead of 5%.

Station status endpoints are not a way around it: `/status-json.xsl` and
`/stats?json=1` returned 404/403/502 for all 14 top stations, which sit behind CDNs
(iHeart, Quortex, Radio France, cdnstream) that don't expose Icecast status pages.

**What it would take:** a ~40-line proxy (Cloudflare Worker, Vercel, Netlify) that
performs the ICY read server-side and returns JSON. Free, no API key. The cost is
that the app stops being deployable to any static host.

### True fingerprinting is the harder path

- **Getting PCM.** `createMediaElementSource()` taints the graph unless the stream
  sends CORS headers, which most don't — the same constraint that made
  `crossOrigin="anonymous"` break playback (see Deviations). You cannot tap the
  stream you are already playing. The workarounds are `getDisplayMedia({audio:true})`
  tab capture (Chrome/Edge only, user must opt into sharing tab audio) or the
  microphone.
- **Recognition.** Shazam has no public API. Real options are AudD (~$5/1000 queries)
  or ACRCloud, both paid and key-based — and a key can't ship in static JS, so this
  needs a proxy too. AcoustID/Chromaprint is free but matches exact recordings via a
  native `fpcalc` binary and is built for files, not radio with crossfades and DJ talk.

Given both routes need a proxy, metadata-first is strictly better: it is exact rather
than probabilistic, free, and instant. Fingerprinting is only worth adding for the
~30% that announce nothing — much of which is talk radio with no song in it.

### If this is ever built, budget for parsing

Real `StreamTitle` values are messy and need normalising:

```
Olivia Dean - text="Man I Need" song_spot="M" MediaBaseId=...   (iHeart)
title="Locked Out Of Heaven",artist="BRUNO MARS",url="..."      (Z100)
9999999 - 9999999                                               (placeholder)
*** Werbung in SWR3 ***                                         (ad break)
```

Once a clean artist/title exists, the iTunes Search API is free, key-less and
CORS-enabled — usable directly from the page for cover art and links.
