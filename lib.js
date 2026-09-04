/* Radial — pure helpers.
 *
 * Everything here is a plain function of its arguments: no DOM, no state, no I/O.
 * That is the point — this is the layer that can be tested without a browser, and
 * it holds the values that were arrived at empirically and are easy to "simplify"
 * back into bugs later. See lib.test.js for what each one is guarding.
 */

/** 1234 -> "1.2k". Counts in the table are too wide otherwise. */
export function num(n) {
  if (n == null) return "—";
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(n);
}

export function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/**
 * About 4% of the directory reports bitrate in bits per second, which renders as
 * "MP3 128000k". Values at that magnitude are unambiguous; oddities in the low
 * thousands are left alone, since a bad number and an unusual one look the same.
 */
export function kbps(b) {
  b = +b || 0;
  return b >= 10000 ? Math.round(b / 1000) : b;
}

/**
 * Perceived loudness tracks roughly the square of the fader position. A linear
 * slider puts 5% at about -26 dB, which is plainly audible; squaring puts it at -52.
 */
export function gainFor(v) {
  const x = Math.max(0, Math.min(100, +v || 0)) / 100;
  return x * x;
}

export function safeName(s) {
  return String(s || "recording").replace(/[^\w\-. ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 60);
}

export function stamp(ms) {
  const d = ms ? new Date(ms) : new Date(), p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + "-" + p(d.getMinutes());
}

export function fmtDuration(ms) {
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600),
        m = Math.floor((t % 3600) / 60), sec = t % 60;
  const mm = (h ? String(m).padStart(2, "0") : String(m)) + ":" + String(sec).padStart(2, "0");
  return h ? h + ":" + mm : mm;
}

export function fmtSize(b) {
  return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
}

export function fmtClock(sec) {
  if (sec == null) return "—";
  let m = Math.floor(sec / 60), r = Math.round(sec % 60);
  if (r === 60) { m += 1; r = 0; }
  return m + ":" + String(r).padStart(2, "0");
}

/**
 * A viewport that crosses the antimeridian reports west > east, so the longitude
 * test has to flip rather than assume an ordered range.
 */
export function inBounds(lat, lon, b) {
  if (!b) return true;
  if (!lat && !lon) return false;
  if (lat > b.n || lat < b.s) return false;
  return b.w <= b.e ? (lon >= b.w && lon <= b.e) : (lon >= b.w || lon <= b.e);
}

/** Only #rrggbb is accepted; a partial value must not reach the CSS variables. */
export function isHex(v) { return /^#[0-9a-f]{6}$/i.test(String(v || "").trim()); }

export function normaliseHex(v) {
  let s = String(v || "").trim();
  if (s && s[0] !== "#") s = "#" + s;
  return isHex(s) ? s.toLowerCase() : null;
}
