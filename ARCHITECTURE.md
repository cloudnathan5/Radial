# Radial — edition strategy

Status: **plan, not yet built.** The static edition exists and works; everything
below describes how the other editions should be added without wrecking it.

Every number here was measured against the live radio-browser directory and real
streams during development, not estimated. Sample sizes are given so they can be
re-checked when they drift.

---

## The principle

**Three releases, but not three codebases.**

The obvious way to do this — fork the app per platform — fails predictably: the
static edition rots because every fix has to land three times, and the editions
silently diverge until only one is really maintained.

Instead:

- **one frontend** that asks what it can do at runtime, rather than what edition it is
- **one backend core** shared by the server and desktop editions, which need the same
  capabilities for different reasons
- **three packagings** of those two things

The app already does a miniature version of this: recording attempts a `fetch` and
reports per-station when CORS blocks it, rather than assuming. Generalise that.

---

## Why the editions exist: capability tiers

The features do not split by platform. They split by **three constraints**, and the
platforms are just where those constraints land.

1. **The CORS preflight.** A request carrying `Icy-MetaData: 1` is not "simple", so
   the browser preflights it, and Icecast servers do not answer `OPTIONS`. This one
   header is the entire reason now-playing fails while recording succeeds — both read
   the same bytes from the same URL.
2. **The origin check.** Roughly a fifth of streams send no `Access-Control-Allow-Origin`
   at all, so the browser refuses before a byte arrives. A server has no such rule.
3. **Native code and the filesystem.** Fingerprinting needs a native binary; a real
   music library needs durable filesystem access.

Anything a server does removes constraints 1 and 2. Anything native additionally
removes 3.

### Capability matrix

| | Static (Pages) | + Proxy (server) | Desktop (native) |
| --- | --- | --- | --- |
| Browse, search, map, favourites, sleep timer | yes | yes | yes |
| Recording | 77% of stations | ~94% | ~94% |
| Now playing / track titles | ~5% — unshippable | **~46%** | ~60% |
| Song fingerprinting | possible, bring-your-own key | server-held key | **free** (bundled `fpcalc`) |
| Local music folder | Chromium only, no persistence | same | full, with watching |
| Recording storage | IndexedDB, evictable | + server-side | real files on disk |
| Install / distribution | PWA | PWA + Docker | signed binaries |

---

## Where those numbers come from

### Recording — 77% static, ~94% with a server

Verified in-browser over 26 top stations, and by header probe over 80:

| | share | note |
| --- | --- | --- |
| Progressive MP3/AAC, readable by `fetch()` | ~69% | records today |
| HLS (`.m3u8`) | ~11% | playlist is readable; needs segment fetching |
| No CORS headers | ~17% | browser refuses; **a server does not care** |
| Unreachable / dead | ~6% | nothing fixes this |

A server ignores CORS entirely, so the ceiling becomes the ~6% that are simply dead,
plus whatever HLS handling is implemented. Hence ~94%.

### Now playing — 5% static, ~46% with a server

Stream metadata is carried in-band: request with `Icy-MetaData: 1`, read the
`icy-metaint` offset from the headers, then every `metaint` bytes there is a length
byte followed by `StreamTitle='Artist - Track';`.

Server-side, over 80 stations:

| | share |
| --- | --- |
| Live `StreamTitle` present | 60% |
| — of those, parseable as "Artist – Track" | 77% |
| Empty title (talk/news — no song exists) | 20% |
| HLS, no ICY metadata | 11% |
| No metadata support | 9% |

60% × 77% ≈ **46%** of stations yield a real track. From the browser, over 40
stations: 12 survived the preflight, 6 also exposed `icy-metaint`, and exactly
**1** produced a real song title. The others returned station slogans, empty
strings, or internal IDs like `285876 - 401548`. Adding HLS in-band ID3 (2 of 5 HLS
streams carried it) gets static to roughly 5% — which is worse than shipping
nothing, because the line is blank or garbage nineteen times in twenty.

### Fingerprinting — the blocker is key custody, not capability

Fingerprinting reduces a few seconds of audio to a hash of its acoustic peaks —
robust to compression, noise and volume — and looks that hash up in a catalogue.

Two things about doing this in a browser turned out to be **less** blocked than first
assumed, both verified:

- **Getting PCM works.** `createMediaElementSource()` is genuinely tainted by
  cross-origin media, but that route is unnecessary: fetching the stream bytes and
  running `decodeAudioData()` yields real PCM, and that path already works for the
  ~77% of stations the recorder can read.
- **The recognition APIs are browser-reachable.** AcoustID, AudD and ACRCloud all
  answer with `Access-Control-Allow-Origin: *`. CORS is not the obstacle.

What actually blocks it is the **key**:

| | key | cost | usable from a static page? |
| --- | --- | --- | --- |
| Shazam | — | — | no public API exists |
| AudD | token | ~$5/1000 | only bring-your-own-key |
| ACRCloud | key + HMAC-signed secret | paid | no — the secret cannot be client-side |
| AcoustID | one free *application* key, not per-user | free, non-commercial only | yes, but see below |

So the static edition *can* offer fingerprinting if the user supplies their own AudD
token (held in `localStorage`) — no server, no cost to the project. What it cannot do
is ship a shared key, since an embedded token is drainable by anyone who views source.

Fingerprinting costs money for the **catalogue**, not the algorithm: the expense is a
licensed, continuously-updated index of tens of millions of recordings. AcoustID
avoids that by being community-run against MusicBrainz — which is also why it is
weaker here, matching *exact recordings* rather than tolerating the crossfades and DJ
talk of live radio.

On desktop the problem disappears: bundle Chromaprint's `fpcalc`, query AcoustID, no
key custody and no WASM build.

#### AcoustID in detail

AcoustID is the open-source counterpart: Chromaprint computes the fingerprint,
AcoustID's database maps it to MusicBrainz recordings. Its key model is unlike the
commercial services — from its own web-service documentation:

- There are **two kinds of key**. An **application key** (the `client` parameter) is
  registered once per application; a **user key** is needed only to *submit* new
  fingerprints. Lookups need only the application key, so **users never supply one**.
- **Rate limit: 3 requests per second** — for the application key, i.e. shared across
  every user of a deployed build, not per user.
- **Non-commercial use only.** Commercial use requires a separate paid arrangement.

Two things still make it a poor fit for *live radio in a browser*:

1. **Chromaprint has to run client-side.** The npm ecosystem is thin — WASM wrappers
   (`rusty-chromaprint-wasm`, `chromaprint-wasm`) and pure-JS ports
   (`chromaprint.js`, `chromaprint-fixed`) all sit at 0.1.x. The fingerprint must be
   bit-exact: an almost-correct implementation does not degrade, it simply never
   matches. Realistically this means compiling Chromaprint to WASM yourself.
2. **It is built around whole recordings, not excerpts.** `fpcalc` fingerprints a
   complete file and reports its duration, and the lookup scores on fingerprint *and*
   duration. A fifteen-second slice of a live stream is not the shape it expects.
   Shazam, AudD and ACRCloud are purpose-built for short noisy excerpts; radio piles
   on crossfades, DJ talk over intros and heavy broadcast compression.

The conclusion that follows: **AcoustID belongs in the desktop edition, tagging local
files** — precisely its intended use, and what MusicBrainz Picard does with it. For
identifying live radio, AudD with a bring-your-own key is the more honest option.

#### ShazamIO and the unofficial route

[ShazamIO](https://github.com/shazamio/ShazamIO) sidesteps the key problem entirely:
it reimplements Shazam's signature algorithm locally and posts the result to Shazam's
own internal endpoint — no key, no cost, and Shazam-grade accuracy on short excerpts,
which is exactly what live radio needs. Node equivalents exist (`node-shazam`,
`unofficial-shazam`, `st-shazam`).

**It cannot be used from a static page.** Verified: `amp.shazam.com` returns no
`Access-Control-Allow-Origin` on a plain request, and a preflight comes back 204 with
no CORS headers at all. The endpoint is built for native apps, so a browser is
refused before anything is sent. This is the same wall as ICY metadata, for the same
reason.

It therefore only works where CORS is not enforced — the server and desktop editions.
Two caveats to weigh before depending on it:

- It is an **unofficial, reverse-engineered private API**. There is no terms-of-use
  grant, it can change or break without notice, and heavy traffic from one host may
  simply be blocked.
- The exposure differs sharply by edition. In the **desktop** app each user queries
  Shazam from their own machine at their own volume, which is much the same as using
  the app. A **hosted** instance funnels every user's lookups through one server, and
  that is the shape most likely to break or attract attention.

Reasonable position: acceptable in the desktop edition, risky as the backbone of a
public hosted service.

## Can a static site host its own API?

Partly — and the distinction matters, because it decides which features genuinely
need a server.

**A static host can serve precomputed JSON.** `GET /api/foo.json` is just a file, and
GitHub Actions can act as a build-time backend: a scheduled workflow runs real
server-side code (Python included, so ShazamIO or an ICY reader both work), writes
JSON into the repo, and Pages serves it. No server, no runtime cost.

That covers anything **slow-moving and precomputable**:

| Static API file | Refresh | Worth it? |
| --- | --- | --- |
| Station capability table — which stations send CORS, carry ICY metadata, are HLS | daily | **yes** — the UI could say recording works *before* the user tries |
| Cached `countries` / `tags` / `languages` | daily | yes — removes three API calls from every cold load |
| Curated station picks, genre landing pages | on commit | yes |
| Now playing | ≥5 min | **no** — see below |

What it **cannot** do is anything **per-request and live**, because there is no code
running when the user clicks:

- reading *this* station's metadata *right now*
- proxying a stream for the CORS-blocked stations
- fingerprinting a clip the user just heard

Now-playing is the instructive failure. A cron job could read ICY metadata and commit
`nowplaying.json`, but GitHub Actions schedules no faster than five minutes and in
practice run late, while songs last three to four. The file would routinely name the
*previous* track — worse than showing nothing. It would work for programme and talk
information, which changes hourly.

Caveat if this route is taken: GitHub disables scheduled workflows in public
repositories after a period of inactivity, so an unattended repo silently stops
refreshing.

Caveat worth keeping: AcoustID matches *exact recordings*, so it is weaker on radio
with crossfades and DJ talk than a commercial service. Metadata should always be
tried first regardless of edition; fingerprinting is the fallback for the ~30% of
stations that announce nothing, much of which is talk radio with no song playing.

### Local music — Chromium-only on the web

`showDirectoryPicker()` gives a persistable directory handle (storable in IndexedDB,
re-authorised with one click via `requestPermission()`). Chrome/Edge/Brave desktop
only. Firefox and Safari fall back to `<input type="file" webkitdirectory>`, which
discovers files fine but cannot persist — a re-pick every session. Tag reading is
manual either way: no browser API parses ID3, so read the first ~64 KB and parse
`TIT2`/`TPE1`/`TALB`/`APIC` directly.

Native has none of these limits.

---

## Repo structure

```
/web         the current app — capability-gated, runs standalone with no backend
/worker      BUILT — Cloudflare Worker doing now-playing; first slice of /core
/core        ICY parsing, stream proxying, fingerprinting  (Rust or Node)
/server      /core exposed over HTTP + Docker image; also serves /web
/desktop     Tauri shell wrapping /core natively
/.github/workflows
  pages.yml    deploy /web to GitHub Pages
  release.yml  build desktop binaries + publish the container image
```

`/core` is the load-bearing decision: the server and desktop editions need the same
logic for different reasons, so writing it once is what keeps three releases from
costing three times the work.

## Capability detection

The frontend must never branch on "which edition am I". It asks what it can do:

```js
const caps = {
  proxy:      await probe('/api/health'),        // server edition present?
  native:     '__TAURI__' in window,             // desktop shell present?
  localFiles: 'showDirectoryPicker' in window,   // Chromium file access
  persistent: await navigator.storage?.persisted?.()
};
```

Every feature gates on a capability, and the UI degrades with a *reason* — the way
recording already says "this station blocks recording (no CORS headers)" rather than
failing silently. In the static edition `caps.proxy` is false and now-playing simply
does not render; nothing else changes.

## Core service surface

Small on purpose. Everything takes a stream URL and needs no state.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | capability probe; returns which features this core supports |
| `GET /api/nowplaying?url=` | connect, read ICY metadata, return parsed artist/title |
| `GET /api/stream?url=` | CORS-free passthrough so the blocked ~17% can be recorded |
| `POST /api/identify` | fingerprint a short audio clip (optional; key or `fpcalc`) |

`/api/nowplaying` needs the title parser regardless of edition, because real
`StreamTitle` values are messy:

```
Olivia Dean - text="Man I Need" song_spot="M" MediaBaseId=...   iHeart
title="Locked Out Of Heaven",artist="BRUNO MARS",url="..."      Z100
9999999 - 9999999                                               placeholder
*** Werbung in SWR3 ***                                         ad break
```

That parser belongs in `/core`, not in the frontend, so all editions share it.

---

## Progress

- **Static edition — done.** Deployable to Pages today.
- **Now-playing worker — done.** `worker/` implements the ICY read and the
  `StreamTitle` parser as a Cloudflare Worker; the frontend consumes it via
  `config.js` and degrades to pure-static when no proxy is configured. This is the
  first slice of `/core`, and it validated the serverless route: 95% of streams answer
  with a standard HTTP status line and none with the non-compliant `ICY 200 OK`, so
  the raw-socket fallback (`cloudflare:sockets`) turned out to be unnecessary.
- **Still to do:** stream proxying for the CORS-blocked ~17%, fingerprinting, and the
  desktop shell. The title parser should move into `/core` once `/server` and
  `/desktop` need it, rather than being duplicated.

## Sequencing

1. **Ship the static edition.** It works today and becomes the reference
   implementation everything else is measured against.
2. **Split the repo and add the capability layer.** No new features; purely the
   structure that lets the rest land without forking.
3. **Build `/core` + `/server`.** Highest payoff per line in the whole project: ~40
   lines of ICY reading unlocks now-playing at 46%, recording at ~94%, and is the
   precondition for fingerprinting.
4. **Wrap it in Tauri for desktop.** Tauri over Electron — ~5–10 MB against ~100 MB,
   and since the UI is plain HTML/CSS/JS with no build step it drops in unchanged.
   Adds real files, local music, free fingerprinting.
5. **Mobile, if ever.** The PWA already installs on phones. Tauri 2 covers iOS and
   Android, but background audio and background recording are genuinely hard there —
   treat as a separate project, not a fifth checkbox.

## Note on directory size

The directory is ~58,700 stations (~53,300 working) and the search API returns **no
total count** — only a page of results. Any edition therefore has to phrase counts
carefully: a full page means "at least this many", never "this many". The web UI
pages 400 at a time up to 2,000 rows.

A server edition could do better here by counting server-side and caching it, which
is worth considering as a fourth `/core` endpoint if search UX matters.

## Open questions

- **Does local music belong in Radial at all?** It turns a radio browser into
  partly a local player. Possibly a fifth nav item that stays clearly separate;
  possibly its own app.
- **Public server instance, or self-host only?** A hosted proxy means someone pays
  for bandwidth and takes on abuse handling — it is an open relay for arbitrary URLs
  unless it is restricted to hosts the directory actually lists.
- **Fingerprinting keys:** bring-your-own-key, or a bundled quota? BYO avoids the
  cost question entirely.
- **Streaming-service accounts (Spotify / SoundCloud / YouTube Music).** Not planned;
  captured because the useful shape is not the obvious one.

  Reading a user's library is feasible — Spotify has a proper OAuth PKCE Web API
  (`user-library-read`, `playlist-read-private`); SoundCloud has an API but has kept
  app registration effectively closed for years; YouTube Music has **no** official API
  at all (the YouTube Data API covers YouTube playlists, not the YT Music library, and
  `ytmusicapi` is unofficial cookie-scraping).

  **Playback is the wall**, and it is licensing rather than difficulty. None of them
  permit a third-party app to stream the catalogue: Spotify's Web Playback SDK is
  browser-only, Premium-only and needs Widevine, leaving Spotify Connect remote
  control as the sanctioned path; YouTube requires the official IFrame embed with ads;
  SoundCloud does allow API streaming for permitted tracks, if access can be obtained.

  **The version worth building runs the other way.** Radial already derives
  "Artist – Title" from stream metadata, so the natural feature is a one-click *save
  to Spotify* on the now-playing bar (`user-library-modify` /
  `playlist-modify-private`) — a radio-discoveries playlist that fills itself. Fully
  sanctioned, no DRM involved, and it lands on the actual moment of value.

  Notes: this is **not** desktop-gated — all three APIs send CORS headers, so OAuth
  PKCE works from GitHub Pages; desktop only adds the RFC 8252 loopback redirect and
  refresh tokens in the OS keychain. It does depend on the now-playing metadata, so it
  is gated behind the proxy. Confirm Spotify's current app-quota policy first: since
  late 2024 several endpoints were deprecated for new apps and development-mode apps
  are capped at ~25 users pending extended-quota approval.

## Deliberately not doing

- **Forking the frontend per edition.** Stated once more because it is the specific
  way this plan fails.
- **Timeshift / seekable rewind.** Proven workable (MSE builds a seekable buffer from
  a live MP3 stream), but it forces two playback paths since the CORS-blocked
  stations cannot use it. Not worth it until the proxy makes that set small.
- **Shipping now-playing in the static edition.** 5% coverage with garbage strings is
  worse than an absent feature.
