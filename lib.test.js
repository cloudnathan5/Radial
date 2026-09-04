/* Run with: node --test
 *
 * These cover the values that were arrived at by measuring live data, and that a
 * later "cleanup" would plausibly undo. Each case notes what it is protecting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "./lib.js";
import { parseTitle } from "./worker/index.js";

test("num: compact counts, no trailing .0", () => {
  assert.equal(lib.num(0), "0");
  assert.equal(lib.num(999), "999");
  assert.equal(lib.num(1000), "1k");        // not "1.0k"
  assert.equal(lib.num(1234), "1.2k");
  assert.equal(lib.num(299854), "300k");    // >=10000 drops the decimal
  assert.equal(lib.num(null), "—");
});

test("kbps: rescales bits-per-second, leaves ambiguous values alone", () => {
  assert.equal(lib.kbps(128), 128);
  assert.equal(lib.kbps(128000), 128);      // ~4% of the directory reports bps
  assert.equal(lib.kbps(96000), 96);
  assert.equal(lib.kbps(1536), 1536);       // plausible as kbps (FLAC), untouched
  assert.equal(lib.kbps(7499), 7499);       // implausible either way — not guessed at
  assert.equal(lib.kbps(undefined), 0);
});

test("gainFor: squared curve, clamped", () => {
  assert.equal(lib.gainFor(100), 1);
  assert.equal(lib.gainFor(0), 0);
  assert.equal(lib.gainFor(50), 0.25);      // -12 dB, not -6
  assert.ok(Math.abs(lib.gainFor(5) - 0.0025) < 1e-9);
  assert.equal(lib.gainFor(150), 1);        // clamped
  assert.equal(lib.gainFor(-10), 0);
});

test("esc: escapes every character that can break out of markup", () => {
  assert.equal(lib.esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  assert.equal(lib.esc(null), "");
});

test("inBounds: handles a viewport crossing the antimeridian", () => {
  const normal = { n: 60, s: 30, e: 20, w: -10 };
  assert.equal(lib.inBounds(45, 5, normal), true);
  assert.equal(lib.inBounds(45, 25, normal), false);
  assert.equal(lib.inBounds(70, 5, normal), false);

  const wrapped = { n: 60, s: 30, e: -160, w: 160 };   // w > e
  assert.equal(lib.inBounds(45, 170, wrapped), true);
  assert.equal(lib.inBounds(45, -170, wrapped), true);
  assert.equal(lib.inBounds(45, 0, wrapped), false);
});

test("hex validation rejects partial input", () => {
  assert.equal(lib.isHex("#3ba55d"), true);
  assert.equal(lib.isHex("#3ba"), false);      // mid-typing must not be applied
  assert.equal(lib.isHex("#3ba55"), false);
  assert.equal(lib.normaliseHex("3BA55D"), "#3ba55d");
  assert.equal(lib.normaliseHex("#zzz"), null);
});

test("fmtDuration / fmtSize / fmtClock", () => {
  assert.equal(lib.fmtDuration(65000), "1:05");
  assert.equal(lib.fmtDuration(3725000), "1:02:05");
  assert.equal(lib.fmtSize(1024), "1 KB");
  assert.equal(lib.fmtSize(2 * 1048576), "2.0 MB");
  assert.equal(lib.fmtClock(21), "0:21");
  assert.equal(lib.fmtClock(null), "—");
});

test("safeName: filesystem-safe, bounded", () => {
  assert.equal(lib.safeName("BBC / World: Service"), "BBC _ World_ Service");
  assert.equal(lib.safeName(""), "recording");
  assert.ok(lib.safeName("x".repeat(200)).length <= 60);
});

/* ---- the StreamTitle parser, against values actually observed on air ---- */

test("parseTitle: plain Artist - Title", () => {
  const r = parseTitle("Walk The Moon - Shut Up & Dance");
  assert.equal(r.kind, "track");
  assert.equal(r.artist, "Walk The Moon");
  assert.equal(r.title, "Shut Up & Dance");
});

test("parseTitle: iHeart's text= form, and its advert marker", () => {
  const music = parseTitle('Olivia Dean - text="Man I Need" song_spot="M" MediaBaseId=2172074');
  assert.equal(music.kind, "track");
  assert.equal(music.artist, "Olivia Dean");
  assert.equal(music.title, "Man I Need");   // not the raw tracking blob

  // song_spot other than M is a promo/advert, not a song
  const spot = parseTitle('Kfi Cross Promo - text="Kfi Cross Promo" song_spot="T" MediaBaseId="0"');
  assert.equal(spot.kind, "marker");
});

test("parseTitle: key=\"value\" form", () => {
  const r = parseTitle('title="Locked Out Of Heaven",artist="BRUNO MARS",url="x"');
  assert.equal(r.kind, "track");
  assert.equal(r.artist, "BRUNO MARS");
  assert.equal(r.title, "Locked Out Of Heaven");
});

test("parseTitle: rejects placeholders, ad markers and repeated values", () => {
  assert.equal(parseTitle("9999999 - 9999999").kind, "junk");
  assert.equal(parseTitle("*** Werbung in SWR3 ***").kind, "marker");
  assert.equal(parseTitle("Traffic - Traffic").kind, "text");   // artist === title
  assert.equal(parseTitle("").kind, "none");
});

test("parseTitle: a slogan is text, never a track", () => {
  const r = parseTitle("Leading Britain");
  assert.equal(r.kind, "text");
  assert.equal(r.artist, null);
});
