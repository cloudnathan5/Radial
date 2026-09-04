/* Radial now-playing worker.
 *
 * Reads ICY (Shoutcast/Icecast) metadata from a stream and returns the current
 * track as JSON. This exists because a browser cannot do it: `Icy-MetaData: 1`
 * is not a CORS-safelisted request header, so asking for metadata turns the
 * request into a preflighted one, and stream servers do not answer OPTIONS.
 * Server-side there is no preflight, so the same read just works.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SERVICE DOES AND DOES NOT DO
 *
 * Makes exactly one outbound request: to the stream URL passed in `?url=`, which
 * is the same host the listener's browser is already streaming audio from. It
 * contacts no other service. Grep it yourself — there is one `fetch()` to an
 * external host in this file, on the line marked below.
 *
 *   does NOT  call any analytics, telemetry or third-party API
 *   does NOT  use KV, D1, R2, Durable Objects or any storage
 *   does NOT  log — there is no console.* call anywhere in this file
 *   does NOT  require or hold any API key
 *   does NOT  read cookies, headers or credentials from the caller
 *   has NO    dependencies (no package.json, nothing to audit transitively)
 *
 * What the operator CAN see, stated plainly: Cloudflare receives the caller's IP
 * address and the `?url=` parameter, so whoever runs this deployment could learn
 * which station an IP is listening to. That is inherent to any HTTP request and
 * is not removable. If you would rather not trust someone else's deployment,
 * deploy your own — `npx wrangler deploy` — and point config.js at it.
 *
 * Honest limitation: nobody can cryptographically prove that a deployed Worker
 * is running this published source. Self-hosting is the only way to be certain.
 * ---------------------------------------------------------------------------
 *
 * Deploy:  cd worker && npx wrangler deploy
 */

// Shown by /health so anyone can compare a deployment against the source.
const VERSION = "1.0.0";
const SOURCE = "https://github.com/nsudhaka/radial/blob/main/worker/index.js";

const UA = "Radial/1.0 (+https://github.com/)";
const CACHE_SECONDS = 15;     // also protects stations from repeated polling
const CONNECT_TIMEOUT = 8000;
const MAX_METAINT = 64 * 1024;

/* ------------------------------------------------------------------ parsing */

// Real StreamTitle values are messy. Observed in the wild:
//   Olivia Dean - text="Man I Need" song_spot="M" MediaBaseId=...   (iHeart)
//   title="Locked Out Of Heaven",artist="BRUNO MARS",url="..."      (Z100)
//   9999999 - 9999999                                              (placeholder)
//   *** Werbung in SWR3 ***                                        (ad break)
// A repeated value ("Promo - Promo") is a station filling the field, not a song.
function finish(raw, artist, title) {
  if (!title) return { raw, artist: null, title: null, kind: "none" };
  if (artist && artist.toLowerCase() === title.toLowerCase()) {
    return { raw, artist: null, title, kind: "text" };
  }
  return { raw, artist: artist || null, title, kind: "track" };
}

export function parseTitle(raw) {
  const out = { raw, artist: null, title: null, kind: "none" };
  if (!raw) return out;

  const s = raw.trim();
  if (!s) return out;

  // Obvious non-tracks: ad markers and numeric placeholders.
  if (/^\*{2,}.*\*{2,}$/.test(s)) return { ...out, kind: "marker" };
  if (/^[\d\s\-–—:._]+$/.test(s)) return { ...out, kind: "junk" };

  // key="value" pairs. Z100 sends title="..",artist=".."; iHeart sends the artist
  // bare, then `- text="TITLE"` followed by its own tracking fields.
  const kv = {};
  for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) kv[m[1].toLowerCase()] = m[2].trim();
  const kvTitle = kv.title || kv.text;
  if (kvTitle) {
    let artist = kv.artist || null;
    if (!artist) {
      const lead = s.split(/\s+[-–—]\s+\w+="/)[0];
      if (lead && lead !== s) artist = lead.trim();
    }
    // iHeart tags the content type: song_spot="M" is music, anything else is a
    // promo, advert or talk break — not something to show as a track.
    if (kv.song_spot && kv.song_spot.toUpperCase() !== "M") {
      return { raw, artist: null, title: kvTitle, kind: "marker" };
    }
    return finish(raw, artist, kvTitle);
  }

  // Plain "Artist - Title", after dropping any trailing key=value tracking fields.
  // (Station-specific forms such as "TITLE by ARTIST" are left as-is.)
  const clean = s.replace(/\s+\w+=["'][^"']*["'].*$/, "").replace(/\s+\w+=\S+\s*$/, "").trim() || s;
  const dash = clean.match(/^(.{1,120}?)\s+[-–—]\s+(.{1,160})$/);
  if (dash) {
    const r = finish(raw, dash[1].trim(), dash[2].trim());
    if (r.kind === "track") return r;
  }

  // Something human-readable, but not resolvable into artist/title — a programme
  // name or station slogan. Surfaced as text so the caller can decide.
  return { raw, artist: null, title: s, kind: "text" };
}

/* --------------------------------------------------------------- icy reader */

export async function readIcy(streamUrl) {
  // >>> the one and only outbound request this service makes <<<
  const res = await fetch(streamUrl, {
    headers: { "Icy-MetaData": "1", "User-Agent": UA, "Accept": "*/*" },
    signal: AbortSignal.timeout(CONNECT_TIMEOUT),
    redirect: "follow"
  });

  if (!res.ok || !res.body) {
    if (res.body) await res.body.cancel();
    return { supported: false, reason: "http-" + res.status };
  }

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const metaint = parseInt(res.headers.get("icy-metaint") || "0", 10);

  if (!metaint || metaint > MAX_METAINT) {
    await res.body.cancel();
    return {
      supported: false,
      reason: ct.includes("mpegurl") || ct.includes("dash") ? "hls" : "no-metadata",
      station: res.headers.get("icy-name") || null
    };
  }

  const reader = res.body.getReader();
  let buf = new Uint8Array(0);

  async function take(n) {
    while (buf.length < n) {
      const { value, done } = await reader.read();
      if (done) throw new Error("eof");
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf); merged.set(value, buf.length);
      buf = merged;
    }
    const head = buf.slice(0, n);
    buf = buf.slice(n);
    return head;
  }

  try {
    await take(metaint);                       // one block of audio
    const len = (await take(1))[0] * 16;       // metadata length byte
    let raw = "";
    if (len) raw = new TextDecoder("utf-8").decode(await take(len)).replace(/\0+$/, "");
    const m = /StreamTitle='([^']*)'/.exec(raw);
    return {
      supported: true,
      station: res.headers.get("icy-name") || null,
      ...parseTitle(m ? m[1] : "")
    };
  } finally {
    reader.cancel().catch(() => {});           // don't hold the stream open
  }
}

/* -------------------------------------------------------------------- http */

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400"
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors, ...extra }
  });
}

function allowed(target) {
  let u;
  try { u = new URL(target); } catch { return "not a URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http(s) URLs";
  // Refuse anything pointed at a private or loopback address.
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1)/.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return "private address";
  return null;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "radial-nowplaying",
        version: VERSION,
        source: SOURCE,
        features: ["nowplaying"],
        // Declared so a caller can check the claims without reading the source.
        contacts: ["only the stream URL supplied in ?url="],
        stores: [],
        logs: false,
        thirdParties: [],
        apiKeys: []
      });
    }
    if (url.pathname !== "/nowplaying") return json({ error: "not found" }, 404);

    const target = url.searchParams.get("url");
    if (!target) return json({ error: "missing ?url=" }, 400);
    const bad = allowed(target);
    if (bad) return json({ error: bad }, 400);

    // Short shared cache: several listeners on one station hit the origin once.
    const cache = caches.default;
    const key = new Request(url.toString(), { method: "GET" });
    const hit = await cache.match(key);
    if (hit) return hit;

    let payload;
    try {
      payload = await readIcy(target);
    } catch (e) {
      payload = { supported: false, reason: e && e.name === "TimeoutError" ? "timeout" : "unreachable" };
    }

    const res = json(payload, 200, { "Cache-Control": "public, max-age=" + CACHE_SECONDS });
    await cache.put(key, res.clone());
    return res;
  }
};
