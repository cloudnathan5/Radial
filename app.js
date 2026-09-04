import {
  num, cap, esc, kbps, gainFor, safeName, stamp,
  fmtDuration, fmtSize, fmtClock, inBounds, normaliseHex
} from "./lib.js?v=2";

/* Radial — internet radio browser.
   Vanilla ES2020, no build step. Data: https://api.radio-browser.info */
(function () {
  "use strict";

  // radio-browser has no single canonical host; de1 is the design's default and
  // the rest are the published mirrors, tried in order when a request fails.
  var MIRRORS = [
    "https://de1.api.radio-browser.info/json",
    "https://de2.api.radio-browser.info/json",
    "https://at1.api.radio-browser.info/json",
    "https://nl1.api.radio-browser.info/json"
  ];
  var mirror = 0;

  var LS = { favs: "rad.favs", recent: "rad.recent", custom: "rad.custom", theme: "rad.theme", vol: "rad.vol", images: "rad.images", pins: "rad.imgPins",
    view: "rad.view", font: "rad.font", myThemes: "rad.myThemes",
    rail: "rad.rail", split: "rad.split", schema: "rad.v" };

  // Stored shape is versioned, so future changes are a numbered step rather than
  // another special case. Migrations run in order from whatever version is on disk;
  // each is idempotent, so a half-applied run is safe to repeat.
  var SCHEMA = 2;

  var MIGRATIONS = [
    // 0 -> 1: the app was called Opendial, and keys were prefixed od.*
    function () {
      Object.keys(LS).forEach(function (k) {
        if (k === "schema") return;
        var from = "od." + k, to = LS[k];
        if (localStorage.getItem(to) == null) {
          var v = localStorage.getItem(from);
          if (v != null) localStorage.setItem(to, v);
        }
        localStorage.removeItem(from);
      });
    },
    // 1 -> 2: it was called Radium, so the two built-in theme ids were radium-*
    function () {
      var t = load(LS.theme, null);
      if (typeof t === "string" && t.indexOf("radium-") === 0) {
        save(LS.theme, t.replace(/^radium-/, "radial-"));
      }
    }
  ];

  (function migrate() {
    try {
      var at = load(LS.schema, 0);
      if (typeof at !== "number") at = 0;
      for (var i = at; i < MIGRATIONS.length && i < SCHEMA; i++) MIGRATIONS[i]();
      if (at !== SCHEMA) save(LS.schema, SCHEMA);
    } catch (e) { /* storage unavailable — nothing to migrate */ }
  })();

  // radio-browser has no category concept — only free-form tags. Each category is
  // a curated set of tags that are OR-ed together (the API's tagList is AND-only,
  // so an OR needs one query per tag, merged client-side). Tag matching is a
  // substring match, so "news" also picks up "news talk", "local news", etc.
  var CATEGORIES = {
    music:     ["music", "pop", "rock", "dance"],
    news:      ["news"],
    talk:      ["talk"],
    sports:    ["sport"],
    podcasts:  ["podcast"],
    classical: ["classical"],
    oldies:    ["oldies"],
    religious: ["religion", "christian", "gospel"],
    culture:   ["culture"],
    kids:      ["kids", "children"],
    comedy:    ["comedy"]
  };

  // Recording holds the stream in memory until it is saved, so it needs a ceiling.
  // 300 MB is about 5 hours at 128 kbps.
  // Optional now-playing backend (see worker/). Absent by default: with no proxy
  // configured Radial stays a purely static app and simply omits the feature.
  var PROXY = (window.RADIAL && window.RADIAL.proxy || "").replace(/\/+$/, "");
  var NOWPLAYING_EVERY = 25000;

  var PAGE = 400;          // rows fetched per request
  var MAX_ROWS = 2000;     // ceiling on DOM rows; past this, tell the user to filter

  var MAX_REC_BYTES = 300 * 1024 * 1024;
  var REC_EXT = {
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/aac": "aac", "audio/aacp": "aac",
    "audio/x-aac": "aac", "audio/ogg": "ogg", "application/ogg": "ogg",
    "audio/opus": "opus", "audio/flac": "flac", "audio/x-flac": "flac", "audio/wav": "wav"
  };

  // Recordings live in IndexedDB, not localStorage: they are Blobs of many MB and
  // localStorage is string-only and capped around 5 MB.
  // Name kept from the app's previous identity on purpose: renaming the database
  // would mean copying every recording blob into a new one for no visible benefit.
  var DB_NAME = "opendial", DB_VERSION = 1, STORE = "recordings";

  function idb() {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(DB_NAME, DB_VERSION);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" }).createIndex("createdAt", "createdAt");
        }
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }

  function idbDo(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, mode), out;
        tx.oncomplete = function () { db.close(); res(out); };
        tx.onerror = function () { db.close(); rej(tx.error); };
        tx.onabort = function () { db.close(); rej(tx.error); };
        var rq = fn(tx.objectStore(STORE));
        if (rq) rq.onsuccess = function () { out = rq.result; };
      });
    });
  }
  function idbAll() { return idbDo("readonly", function (os) { return os.getAll(); }); }
  function idbPut(v) { return idbDo("readwrite", function (os) { return os.put(v); }); }
  function idbDelete(id) { return idbDo("readwrite", function (os) { return os.delete(id); }); }

  // Perceived loudness tracks roughly the square of the fader position, not the
  // position itself — a linear slider makes everything below ~20% sound loud.

  function load(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  function idOf(s) { return s && (s.stationuuid || s.url); }
  function $(sel) { return document.querySelector(sel); }

  var state = {
    page: "browse",
    theme: null,           // resolved in initTheme()
    stations: [], mapStations: [], loading: true, error: "",
    f: { q: "", category: "", country: "", tag: "", language: "", codec: "", bitrateMin: "0", order: "clickcount", hidebroken: true },
    favs: load(LS.favs, []), recent: load(LS.recent, []), customs: load(LS.custom, []),
    current: null, playing: false, status: "idle",
    volume: load(LS.vol, 80), shared: false,
    recordings: [],
    nowPlaying: null, proxyOk: false,
    // Artwork is off by default: it is the only thing in the app that contacts
    // hosts other than the directory and the stream you chose to play.
    images: load(LS.images, false),
    // Per-station overrides, holding an EXPLICIT true/false rather than "differs
    // from the default". Storing the value means flipping the global default can't
    // silently invert what a pinned station does.
    pins: load(LS.pins, {}),
    offset: 0, hasMore: false, loadingMore: false,
    splitShown: 300,               // render window for the map list
    // Anything that isn't "list" is the map view. Older builds stored "split" for
    // the side-by-side layout and "map" for a map-only page that no longer exists;
    // both collapse onto the same view now.
    view: load(LS.view, "list") === "list" ? "list" : "map",
    font: load(LS.font, "archivo"),
    railed: load(LS.rail, false),
    split: load(LS.split, 420),
    myThemes: load(LS.myThemes, []),
    viewport: null,                // bounds last reported by the map iframe
    sleepMin: 0, sleepLeft: ""
  };

  var el = {};
  // Two elements, deliberately. Web Audio silences a cross-origin media element
  // that fails the CORS check, and createMediaElementSource() cannot be undone —
  // so once an element is wired into the graph, a single CORS-blocked station
  // would play as silence forever. Instead: `audioAn` carries crossOrigin and is
  // the only one connected to the analyser; `audioPlain` is never touched by Web
  // Audio and handles everything that refuses CORS. With crossOrigin set, a
  // refusing stream fails the media load outright, which is the signal to fall back.
  var audioPlain = new Audio();
  var audioAn = new Audio();
  audioAn.crossOrigin = "anonymous";
  var audio = audioPlain;        // the element currently in use
  var analysedUrl = null;        // url being attempted on the analysed element
  var pausedAt = 0;              // when playback was last paused
  var RESUME_LIVE_AFTER = 5000;  // pause longer than this and resuming reconnects

  var actx = null, analyser = null, freq = null, rafId = null, gainNode = null;

  // A media element's `volume` is applied BEFORE the audio reaches
  // createMediaElementSource, so the analyser would see a volume-scaled signal and
  // the meter would dim as the user turned down. Volume therefore moves to a
  // GainNode placed AFTER the analyser, leaving the element at full scale.
  function applyVolume(v) {
    var g = gainFor(v);
    audioPlain.volume = g;
    if (gainNode) {
      audioAn.volume = 1;
      gainNode.gain.value = g;
    } else {
      audioAn.volume = g;
    }
  }

  function reducedMotion() {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function ensureAnalyser() {
    if (analyser) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      actx = new AC();
      var src = actx.createMediaElementSource(audioAn);   // once per element, ever
      analyser = actx.createAnalyser();
      analyser.fftSize = 64;                              // 32 bins is plenty for 3 bars
      // Input smoothing, feeding the peak-hold below. Both stages are needed: the
      // peak-hold alone gets re-triggered by frame noise crossing its decay line,
      // and smoothing alone flattens the range out of the signal.
      analyser.smoothingTimeConstant = 0.62;
      // The default window (-100..-30 dB) clips anything loud to 255, which pins
      // the bass bar solid on compressed broadcast audio. Widening the top gives
      // the loud end somewhere to go.
      analyser.minDecibels = -90;
      analyser.maxDecibels = -5;
      gainNode = actx.createGain();
      // source -> analyser -> gain -> out: the analyser taps the signal at full
      // scale, so the meter reads the music rather than the volume setting.
      src.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(actx.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
      applyVolume(state.volume);
      return true;
    } catch (e) { analyser = null; return false; }
  }

  // Three bands across the lower spectrum, where music actually sits. At 48 kHz
  // with fftSize 64 each bin is ~750 Hz, so these are roughly bass (0-1.5k),
  // mids/vocals (1.5-3.75k) and highs (3.75-9k).
  // Bin 0 is skipped: it carries DC and the near-zero frequencies, which sit high
  // and steady and would flatten the bass bar.
  var BANDS = [[1, 3], [3, 6], [6, 13]];

  /* ---- meter tuning: the only numbers worth touching to change the feel ----
   *
   *  GAIN     per-band tilt. Music falls off ~3 dB/octave, so without this the bass
   *           bar wins permanently and the shape never changes. Raise index 1/2 to
   *           give the mid/high bars more presence.
   *  SMOOTH   how much the level is smoothed each frame, 0-1. Higher = twitchier and
   *           more responsive, lower = calmer and more languid. THE MAIN KNOB.
   *  ATTACK   how fast a bar jumps up to a new peak. Near 1 = instant.
   *  DECAY    how fast it falls back, per frame. Higher = more visible movement,
   *           lower = bars hang near their peaks.
   *  RAW_MIX  how much of the bar height is the plain level vs the expanded one.
   *           Higher = steadier and sits higher; lower = swingier but can look busy.
   *
   *  Measured on compressed pop radio at these values: bars move over about 2-4 px
   *  of their 10 px height, changing ~0.2-0.5 px per frame. Below roughly 0.2 px per
   *  frame it reads as static; above 0.5 it starts to look tacky.
   */
  var GAIN = [1.0, 1.2, 1.5];
  var SMOOTH = 0.18;
  var ATTACK = 0.5;
  var DECAY = 0.016;
  var RAW_MIX = 0.28;

  // The envelope tracks the range each band is actually using, so a band that never
  // gets loud still fills the bar. SPAN_FLOOR stops it amplifying noise when a band
  // is steady — at 0.15 it multiplied small wobbles by ~7x, which was the real
  // source of the jitter, not the analyser.
  var peak = [0, 0, 0], base = [0, 0, 0];
  var ENV = 0.003;           // envelope travel per frame (~5 s full sweep at 60 fps)
  var SPAN_FLOOR = 0.22;
  var SILENT = 0.02;

  // Peak-hold with an unconditional linear decay, the way a VU meter behaves.
  // Flooring the decay at the instantaneous value lets the bar track raw noise
  // again, which measured worse than having no peak-hold at all.
  var level = [0, 0, 0];
  var smooth = [0, 0, 0];

  function resetPeaks() {
    peak = [0, 0, 0]; base = [0, 0, 0]; level = [0, 0, 0]; smooth = [0, 0, 0];
  }

  function startBars() {
    if (!analyser || rafId || !el.bars) return;
    if (actx && actx.state === "suspended") actx.resume().catch(function () {});
    resetPeaks();
    el.bars.classList.add("is-reactive");
    var spans = el.bars.children;
    (function frame() {
      rafId = requestAnimationFrame(frame);
      analyser.getByteFrequencyData(freq);
      for (var i = 0; i < BANDS.length && i < spans.length; i++) {
        var a = BANDS[i][0], b = Math.min(BANDS[i][1], freq.length), sum = 0;
        for (var j = a; j < b; j++) sum += freq[j];
        var v = sum / Math.max(1, b - a) / 255;

        // Deliberately NOT clamped before the envelope: clamping first pins the
        // boosted bands at 1, which collapses peak onto base and freezes the bar.
        v = v * GAIN[i];
        peak[i] = Math.max(v, peak[i] - ENV);
        base[i] = Math.min(v, base[i] + ENV);

        var norm = 0;
        if (peak[i] > SILENT) {
          // A tight span floor turns the expansion into a noise amplifier — at 0.15
          // it multiplies small wobbles by up to ~7x, which is where the jitter was
          // actually coming from, not from the analyser.
          var span = Math.max(SPAN_FLOOR, peak[i] - base[i]);
          var expanded = Math.max(0, Math.min(1, (v - base[i]) / span));
          norm = Math.min(1, RAW_MIX * Math.min(1, v) + (1 - RAW_MIX) * expanded);
        }
        // Smooth the expanded value, then peak-hold it. Both stages matter: the
        // peak-hold alone gets re-triggered by every noise crossing of its decay
        // line, which measured worse than having no peak-hold at all.
        smooth[i] += (norm - smooth[i]) * SMOOTH;

        // The decay is unconditional — flooring it at the instantaneous value lets
        // the bar track noise again.
        if (smooth[i] > level[i]) level[i] += (smooth[i] - level[i]) * ATTACK;
        else level[i] = Math.max(0, level[i] - DECAY);
        spans[i].style.transform = "scaleY(" + (0.16 + level[i] * 0.84).toFixed(3) + ")";
      }
    })();
  }

  function stopBars() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (!el.bars) return;
    el.bars.classList.remove("is-reactive");
    for (var i = 0; i < el.bars.children.length; i++) el.bars.children[i].style.transform = "";
  }
  var reqToken = 0;
  var swapping = false;   // suppresses pause/error events while changing src
  var sleepAt = null;
  var debounceT = null, shareT = null, noteT = null;
  var rec = null;      // active recording, or null
  var recUrls = {};    // recording id -> object URL, created lazily for playback
  var recNote = "";    // transient message shown in the player's meta line

  /* ------------------------------------------------------------------ api */

  // `categoryTag` is one tag from the active category; combined with an explicit
  // genre it becomes a tagList, which the API treats as AND.
  function params(extra, categoryTag) {
    var f = state.f, p = new URLSearchParams();
    if (f.q) p.set("name", f.q);
    if (f.country) p.set("country", f.country);

    var tags = [];
    if (categoryTag) tags.push(categoryTag);
    if (f.tag) tags.push(f.tag);
    if (tags.length > 1) p.set("tagList", tags.join(","));
    else if (tags.length === 1) p.set("tag", tags[0]);

    if (f.language) p.set("language", f.language);
    if (f.codec) p.set("codec", f.codec);
    if (+f.bitrateMin > 0) p.set("bitrateMin", f.bitrateMin);
    if (f.hidebroken) p.set("hidebroken", "true");
    p.set("order", f.order);
    if (f.order !== "name" && f.order !== "random") p.set("reverse", "true");
    Object.keys(extra || {}).forEach(function (k) { p.set(k, extra[k]); });
    return p.toString();
  }

  // Fetch `path` against the current mirror, advancing to the next on failure.
  function api(path, attempt) {
    attempt = attempt || 0;
    return fetch(MIRRORS[mirror] + path, { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .catch(function (err) {
        if (attempt + 1 >= MIRRORS.length) throw err;
        mirror = (mirror + 1) % MIRRORS.length;
        return api(path, attempt + 1);
      });
  }

  function loadMeta() {
    function pick(arr, kind) {
      return arr
        .filter(function (x) { return x.name && x.stationcount > 4; })
        .sort(function (a, b) { return b.stationcount - a.stationcount; })
        .slice(0, kind === "tag" ? 140 : 240)
        .map(function (x) { return { name: x.name, label: cap(x.name) + " (" + num(x.stationcount) + ")" }; })
        .sort(function (a, b) { return a.label.localeCompare(b.label); });
    }
    // These endpoints cap their response at 1000 rows returned ALPHABETICALLY, so
    // without an explicit order the list is the first 1000 names, not the most
    // popular ones — the genre dropdown then stops somewhere around "af...".
    var rank = "&order=stationcount&reverse=true&limit=";
    Promise.all([
      api("/countries?hidebroken=true" + rank + "400"),
      api("/tags?hidebroken=true" + rank + "400"),
      api("/languages?hidebroken=true" + rank + "400")
    ]).then(function (res) {
      fillSelect(el.country, pick(res[0]), state.f.country);
      fillSelect(el.tag, pick(res[1], "tag"), state.f.tag);
      fillSelect(el.language, pick(res[2]), state.f.language);
    }).catch(function () { /* filters degrade to text search */ });
  }

  function fillSelect(sel, items, value) {
    var first = sel.options[0];
    sel.innerHTML = "";
    sel.appendChild(first);
    items.forEach(function (it) {
      var o = document.createElement("option");
      o.value = it.name;
      o.textContent = it.label;
      sel.appendChild(o);
    });
    sel.value = value || "";
  }

  function dedupe(lists) {
    var seen = Object.create(null), out = [];
    lists.forEach(function (l) {
      l.forEach(function (st) {
        var id = st.stationuuid || st.url;
        if (!id || seen[id]) return;
        seen[id] = 1;
        out.push(st);
      });
    });
    return out;
  }

  // Only needed for merged category results — a single query is already ordered
  // by the server.
  function sortStations(list, order) {
    if (order === "random") {
      for (var i = list.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1)), t = list[i];
        list[i] = list[j]; list[j] = t;
      }
      return list;
    }
    var by = {
      votes: function (a, b) { return (b.votes || 0) - (a.votes || 0); },
      bitrate: function (a, b) { return (b.bitrate || 0) - (a.bitrate || 0); },
      name: function (a, b) { return String(a.name || "").localeCompare(String(b.name || "")); },
      clickcount: function (a, b) { return (b.clickcount || 0) - (a.clickcount || 0); }
    };
    return list.sort(by[order] || by.clickcount);
  }

  // One query per category tag, merged; or a single query when no category is set.
  function search(extra, perTagExtra) {
    var tags = CATEGORIES[state.f.category];
    if (!tags) return api("/stations/search?" + params(extra));
    // The reduced per-tag limit only exists to keep a multi-tag fan-out sane.
    var per = tags.length > 1 && perTagExtra ? perTagExtra : extra;
    return Promise.all(tags.map(function (t) {
      return api("/stations/search?" + params(per, t));
    })).then(function (lists) {
      return sortStations(dedupe(lists), state.f.order);
    });
  }

  function playable(s) { return s.url_resolved || s.url; }

  function fetchStations() {
    var token = ++reqToken;
    state.loading = true;
    state.error = "";
    state.offset = 0;
    state.splitShown = SPLIT_PAGE;
    state.hasMore = false;
    state.loadingMore = false;
    renderBrowse();
    renderMapLabel();

    Promise.all([
      search({ limit: PAGE, offset: 0 }),
      search({ limit: 2500, has_geo_info: "true" }, { limit: 900, has_geo_info: "true" })
    ]).then(function (res) {
      if (token !== reqToken) return;
      state.loading = false;
      state.offset = res[0].length;
      // A full page back means the directory probably holds more.
      state.hasMore = res[0].length >= PAGE;
      state.stations = res[0].filter(playable);
      state.mapStations = res[1]
        .filter(function (s) { return +s.geo_lat && +s.geo_long; })
        .slice(0, 2500);
      renderBrowse();
      renderMapLabel();
      pushMap();
    }).catch(function () {
      if (token !== reqToken) return;
      state.loading = false;
      state.stations = [];
      state.mapStations = [];
      state.hasMore = false;
      state.error = "Could not reach the radio-browser API. Check your connection and retry.";
      renderBrowse();
      renderMapLabel();
    });
  }

  // Appends the next page. The directory is far larger than one page — "jazz" alone
  // matches ~1,400 stations and "radio" ~25,000 — so the first 400 are a window,
  // not the answer.
  function loadMore() {
    // In map view the list is governed by the viewport, not by the table's query,
    // so "more" means rendering more of what is already in view.
    if (state.view === "map") { growSplit(); return; }
    if (state.loading || state.loadingMore || !state.hasMore) return;
    if (state.stations.length >= MAX_ROWS) { state.hasMore = false; renderResultLabel(); return; }

    var token = reqToken;
    state.loadingMore = true;
    renderResultLabel();

    search({ limit: PAGE, offset: state.offset }).then(function (list) {
      if (token !== reqToken) return;             // filters changed underneath us
      state.loadingMore = false;
      state.offset += list.length;
      state.hasMore = list.length >= PAGE && state.stations.length < MAX_ROWS;

      var seen = Object.create(null);
      state.stations.forEach(function (s) { seen[idOf(s)] = 1; });
      var fresh = list.filter(function (s) {
        return playable(s) && !seen[idOf(s)];
      });
      if (!fresh.length) { renderResultLabel(); return; }

      var from = state.stations.length;
      state.stations = state.stations.concat(fresh);
      appendRows(from);
      renderResultLabel();
    }).catch(function () {
      if (token !== reqToken) return;
      state.loadingMore = false;
      state.hasMore = false;
      renderResultLabel();
    });
  }

  function setF(patch) {
    Object.assign(state.f, patch);
    clearTimeout(debounceT);
    debounceT = setTimeout(fetchStations, patch.q != null ? 380 : 40);
  }

  /* --------------------------------------------------------------- audio */

  function play(station) {
    var url = station.url_resolved || station.url;
    if (!url) return;
    // A recording belongs to the station it started on.
    if (rec && rec.station !== station) finishRecording("Station changed.");

    state.current = station;
    state.status = "connecting";
    state.playing = true;
    state.shared = false;

    startPlayback(url, !reducedMotion());

    if (station.stationuuid && !station.custom) {
      api("/url/" + station.stationuuid).catch(function () {});
      state.recent = [station]
        .concat(state.recent.filter(function (r) { return r.stationuuid !== station.stationuuid; }))
        .slice(0, 12);
      save(LS.recent, state.recent);
    }

    refresh();
    pushCurrent();
    startNowPlaying();
  }

  // `analysed` asks for the visualiser-capable element; a CORS refusal falls back
  // silently, costing one extra connection attempt only for stations that refuse.
  function startPlayback(url, analysed) {
    var target = analysed ? audioAn : audioPlain;
    var other = target === audioAn ? audioPlain : audioAn;
    analysedUrl = analysed ? url : null;

    swapping = true;
    stopBars();
    try { other.pause(); other.removeAttribute("src"); other.load(); } catch (e) {}
    // Clear the target too: re-assigning the same URL is not a reliable way to force
    // a fresh connection, and a reconnect to the live edge is the whole point here.
    try { target.pause(); target.removeAttribute("src"); target.load(); } catch (e) {}

    audio = target;
    target.src = url;
    applyVolume(state.volume);
    var p = target.play();
    setTimeout(function () { swapping = false; }, 0);
    if (p && p.catch) {
      p.catch(function () {
        if (retryWithoutAnalyser(url)) return;
        state.status = "error";
        state.playing = false;
        renderPlayer();
      });
    }
  }

  function retryWithoutAnalyser(url) {
    if (audio !== audioAn || !analysedUrl || analysedUrl !== url) return false;
    analysedUrl = null;
    startPlayback(url, false);      // this station refuses CORS; no visualiser for it
    return true;
  }

  function stop() {
    if (rec) finishRecording("Playback stopped.");
    swapping = true;
    stopBars();
    analysedUrl = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();                       // cancels the request without an error event
    setTimeout(function () { swapping = false; }, 0);
    state.current = null;
    state.playing = false;
    state.status = "idle";
    stopNowPlaying();
    refresh();
    pushCurrent();
  }

  // Resuming a live stream must reconnect, not continue.
  //
  // Pausing stops the download outright, so resuming replays the buffered tail and
  // leaves you behind live by the length of the pause — and it accumulates across
  // every pause. Reopening the stream costs a second of rebuffering and puts you
  // back at the live edge, which is what "play" means for radio.
  //
  // Deliberately not routed through play(): that pings /url/{uuid}, which is how
  // radio-browser counts listens, and a resume is not a new listen.
  function resumeLive() {
    var st = state.current;
    if (!st) return;
    var url = st.url_resolved || st.url;
    if (!url) return;
    state.status = "connecting";
    state.playing = true;
    pausedAt = 0;
    startPlayback(url, !reducedMotion());
    renderPlayer();
  }

  // Short pause: resume straight from the buffer, which is instant. Long pause:
  // reconnect, because by then the buffered tail is stale and resuming would leave
  // you permanently behind live. The browser stops downloading the moment it is
  // paused, so nothing accumulates while waiting either way.
  //
  // Recordings are finite files, so they always resume where they left off.
  function resumePlayback() {
    var stale = pausedAt && (Date.now() - pausedAt) >= RESUME_LIVE_AFTER;
    if (!isRec(state.current) && stale) { resumeLive(); return; }
    pausedAt = 0;
    var p = audio.play();
    if (audio === audioAn && analyser) startBars();
    if (p && p.catch) {
      p.catch(function () { state.status = "error"; renderPlayer(); });
    }
  }

  function togglePlay() {
    if (!state.current) return;
    if (state.playing) audio.pause();
    else resumePlayback();
  }

  /* ----------------------------------------------------------- recording */

  // Text glyphs (▶ ❙❙ ■ ●) size with the font and carry asymmetric side bearings, so
  // a play triangle renders visibly left of centre in a round button. These are drawn
  // instead: the triangle is positioned on its centroid, which is where the eye reads
  // the centre of a triangle, not on its bounding box.
  function icon(paths, px) {
    return '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px + '" aria-hidden="true">' +
      paths + "</svg>";
  }
  var P_PLAY  = '<path d="M8.6 5.9 L18.4 12 L8.6 18.1 Z" fill="currentColor" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/>';
  var P_PAUSE = '<rect x="7.6" y="6" width="3.4" height="12" rx="1.3" fill="currentColor"/>' +
                '<rect x="13" y="6" width="3.4" height="12" rx="1.3" fill="currentColor"/>';


  function note(msg) {
    recNote = msg;
    renderPlayer();
    clearTimeout(noteT);
    noteT = setTimeout(function () { recNote = ""; renderPlayer(); }, 7000);
  }

  // Recording opens its own connection to the stream rather than tapping the
  // playing <audio> element: Web Audio can't read a cross-origin media element
  // without CORS, which most stations don't send. The cost is a second connection.
  function startRecording() {
    var station = state.current;
    if (!station || rec) return;
    var url = station.url_resolved || station.url;
    if (!url) return;

    var ctrl = new AbortController();
    var r = { station: station, chunks: [], bytes: 0, startedAt: Date.now(), ctrl: ctrl, mime: "" };
    rec = r;
    recNote = "";
    renderPlayer();

    fetch(url, { signal: ctrl.signal }).then(function (res) {
      if (rec !== r) return;
      if (!res.ok || !res.body) throw new Error("http");
      var ct = (res.headers.get("content-type") || "audio/mpeg").split(";")[0].trim().toLowerCase();
      if (ct.indexOf("mpegurl") >= 0 || ct.indexOf("dash") >= 0 || ct.indexOf("text/") === 0) {
        throw new Error("hls");
      }
      r.mime = ct;
      var reader = res.body.getReader();
      function pump() {
        return reader.read().then(function (out) {
          if (rec !== r) { try { reader.cancel(); } catch (e) {} return; }
          if (out.done) { finishRecording("The stream ended."); return; }
          r.chunks.push(out.value);
          r.bytes += out.value.length;
          if (r.bytes >= MAX_REC_BYTES) { finishRecording("Hit the size limit."); return; }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      if (rec !== r) return;                 // already stopped deliberately
      rec = null;
      note(e && e.message === "hls"
        ? "This is an HLS stream — recording isn't supported."
        : "This station blocks recording (it sends no CORS headers).");
    });
  }

  // The elapsed timer undercounts: Icecast's burst-on-connect backfills a few
  // seconds before the user pressed record. Read the real length off the blob.
  function probeDuration(blob) {
    return new Promise(function (res) {
      var u = URL.createObjectURL(blob), a = new Audio();
      var t = setTimeout(function () { done(null); }, 5000);
      function done(v) { clearTimeout(t); URL.revokeObjectURL(u); res(v); }
      a.addEventListener("loadedmetadata", function () {
        done(isFinite(a.duration) && a.duration > 0 ? a.duration : null);
      }, { once: true });
      a.addEventListener("error", function () { done(null); }, { once: true });
      a.preload = "metadata";
      a.src = u;
    });
  }

  function finishRecording(why) {
    var r = rec;
    if (!r) return;
    rec = null;                              // stops the pump on its next tick
    try { r.ctrl.abort(); } catch (e) {}

    if (!r.bytes) { note("Nothing was recorded."); return; }

    var blob = new Blob(r.chunks, { type: r.mime || "audio/mpeg" });
    note("Saving…");

    probeDuration(blob).then(function (dur) {
      var saved = {
        id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
        station: r.station.name || "Untitled station",
        mime: r.mime || "audio/mpeg",
        ext: REC_EXT[r.mime] || "bin",
        size: blob.size,
        duration: dur,
        createdAt: Date.now(),
        blob: blob
      };
      return idbPut(saved).then(function () {
        state.recordings.unshift(saved);
        renderRecordings();
        syncRows();
        // Ask the browser not to evict these under storage pressure.
        if (navigator.storage && navigator.storage.persist) {
          navigator.storage.persist().catch(function () {});
        }
        note("Saved to Library · " + fmtSize(saved.size) + (why ? " — " + why : ""));
      });
    }).catch(function (e) {
      note(e && e.name === "QuotaExceededError"
        ? "Not enough browser storage to save that recording."
        : "Could not save the recording.");
    });
  }

  /* ------------------------------------------------- stored recordings */

  function recUrl(item) {
    if (!recUrls[item.id]) recUrls[item.id] = URL.createObjectURL(item.blob);
    return recUrls[item.id];
  }

  // A stored recording is played through the normal player as a pseudo-station.
  // `custom` keeps it out of the API play-count ping and the recents list.
  function recStation(item) {
    var u = recUrl(item);
    return {
      stationuuid: "rec:" + item.id, recording: true, recordingId: item.id,
      name: item.station, url: u, url_resolved: u,
      custom: true, codec: item.ext, country: "Recording"
    };
  }
  function isRec(st) { return !!(st && st.recording); }

  function downloadRecording(item) {
    var href = URL.createObjectURL(item.blob);
    var a = document.createElement("a");
    a.href = href;
    a.download = safeName(item.station) + " " + stamp(item.createdAt) + "." + item.ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(href); }, 60000);
  }

  function deleteRecording(item) {
    if (!confirm("Delete the \"" + item.station + "\" recording? This can't be undone.")) return;
    if (state.current && state.current.recordingId === item.id) stop();
    idbDelete(item.id).then(function () {
      if (recUrls[item.id]) { URL.revokeObjectURL(recUrls[item.id]); delete recUrls[item.id]; }
      state.recordings = state.recordings.filter(function (x) { return x.id !== item.id; });
      renderRecordings();
    }).catch(function () { note("Could not delete that recording."); });
  }

  function toggleRecording() {
    if (rec) finishRecording();
    else startRecording();
  }

  /* --------------------------------------------------------- now playing */

  var npTimer = null, npToken = 0;

  function probeProxy() {
    if (!PROXY) return;
    fetch(PROXY + "/health", { signal: AbortSignal.timeout(6000) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        state.proxyOk = !!(d && d.ok);
        if (state.proxyOk && state.current) startNowPlaying();
      })
      .catch(function () { state.proxyOk = false; });
  }

  function stopNowPlaying() {
    clearTimeout(npTimer);
    npTimer = null;
    npToken++;
    if (state.nowPlaying) { state.nowPlaying = null; renderPlayer(); }
  }

  function startNowPlaying() {
    stopNowPlaying();
    if (!state.proxyOk || !state.current || isRec(state.current)) return;

    var station = state.current;
    var token = ++npToken;

    (function poll() {
      if (npToken !== token || state.current !== station) return;
      var url = station.url_resolved || station.url;

      fetch(PROXY + "/nowplaying?url=" + encodeURIComponent(url), { signal: AbortSignal.timeout(12000) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (npToken !== token || state.current !== station) return;
          // Only surface an actual track; slogans, ad markers and placeholder junk
          // are worse than showing nothing.
          state.nowPlaying = d && d.supported && d.kind === "track" ? d : null;
          renderPlayer();
          // A station that doesn't support metadata will never start, so stop asking.
          if (d && d.supported === false) return;
          npTimer = setTimeout(poll, NOWPLAYING_EVERY);
        })
        .catch(function () {
          if (npToken !== token) return;
          npTimer = setTimeout(poll, NOWPLAYING_EVERY * 2);
        });
    })();
  }

  function toggleFav(station) {
    var id = idOf(station);
    var has = state.favs.some(function (x) { return idOf(x) === id; });
    state.favs = has
      ? state.favs.filter(function (x) { return idOf(x) !== id; })
      : state.favs.concat([station]);
    save(LS.favs, state.favs);
    refresh();
  }
  function isFav(station) {
    if (!station) return false;
    var id = idOf(station);
    return state.favs.some(function (x) { return idOf(x) === id; });
  }

  /* --------------------------------------------------------------- theme */

  var TH = window.RADIAL_THEMES;
  var lastLight = null, lastDark = null, themeSaveT = null;

  // Trefoil arcs on a 48x48 grid — the two-arc variant, because three turn to
  // mush at 16px. Geometry matches icons/generate.py.
  var FAVICON_ARCS = ["M18.74 13.21 A12.00 12.00 0 0 1 29.26 13.21", "M16.00 7.61 A18.24 18.24 0 0 1 32.00 7.61", "M35.97 24.84 A12.00 12.00 0 0 1 30.71 33.95", "M42.20 25.27 A18.24 18.24 0 0 1 34.20 39.12", "M17.29 33.95 A12.00 12.00 0 0 1 12.03 24.84", "M13.80 39.12 A18.24 18.24 0 0 1 5.80 25.27"];

  // A data: URI sidesteps the browser's favicon cache, which is aggressive and
  // largely independent of normal HTTP caching — the reason a replaced .png file
  // can keep showing the old icon long after it changed.
  function updateFavicon(theme) {
    var link = document.getElementById("favicon");
    if (!link) return;
    var tile = theme.tokens.accent, mark = theme.tokens["accent-fg"];
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
      '<rect width="48" height="48" rx="10.5" fill="' + tile + '"/>' +
      '<circle cx="24" cy="24" r="4.22" fill="' + mark + '"/>' +
      '<g fill="none" stroke="' + mark + '" stroke-width="3.46" stroke-linecap="butt">' +
      FAVICON_ARCS.map(function (d) { return '<path d="' + d + '"/>'; }).join("") +
      "</g></svg>";
    link.setAttribute("type", "image/svg+xml");
    link.setAttribute("href", "data:image/svg+xml," + encodeURIComponent(svg));
  }

  // Google families are fetched only when a font is actually chosen, so the default
  // build still ships one stylesheet link.
  var loadedFonts = {};
  function applyFont(id) {
    var f = TH.fontById(id);
    state.font = f.id;
    save(LS.font, f.id);
    if (f.google && !loadedFonts[f.google]) {
      loadedFonts[f.google] = true;
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=" + f.google + "&display=swap";
      document.head.appendChild(link);
    }
    document.body.style.setProperty("--ui", f.ui);
    document.body.style.setProperty("--mono", f.mono);
    if (el.fontSelect && el.fontSelect.value !== f.id) el.fontSelect.value = f.id;
  }

  /* ------------------------------------------------- saved theme presets */

  function allPresets() { return TH.PRESETS.concat(state.myThemes); }

  function saveCurrentAsPreset(name) {
    var t = state.theme;
    var entry = {
      id: "user-" + Date.now().toString(36),
      name: (name || "").trim().slice(0, 24) || "My theme",
      dark: t.dark, tokens: Object.assign({}, t.tokens), user: true
    };
    state.myThemes = state.myThemes.concat([entry]).slice(-40);
    save(LS.myThemes, state.myThemes);
    setTheme(entry);
    return entry;
  }

  function deletePreset(id) {
    state.myThemes = state.myThemes.filter(function (x) { return x.id !== id; });
    save(LS.myThemes, state.myThemes);
    presetsDirty = true;
    renderThemeModal();
  }

  var presetsDirty = false;

  function initTheme() {
    var stored = load(LS.theme, null);
    var theme = null;
    // Older builds stored the string "light" or "dark".
    if (stored === "light" || stored === "dark") theme = TH.byId("radial-" + stored);
    else if (stored && stored.tokens) theme = stored;
    else if (typeof stored === "string") theme = TH.byId(stored);
    state.theme = theme || TH.byId("radial-dark");

    // A ?theme= / #theme= code in the URL wins, so a shared link just works.
    var fromUrl = (location.hash.match(/theme=([\w\-]+)/) ||
                   location.search.match(/theme=([\w\-]+)/) || [])[1];
    if (fromUrl) {
      var shared = TH.decode(fromUrl);
      if (shared) state.theme = shared;
    }
    // Seed the light/dark memory, so Alt+T twice returns to where you started
    // rather than dropping you on the built-in default.
    if (state.theme.dark) lastDark = state.theme; else lastLight = state.theme;
    applyTheme();
  }

  function applyTheme() {
    var t = state.theme;
    var body = document.body;
    // Every token is set inline so no value can leak from the stylesheet's own
    // light/dark blocks when a custom palette is narrower than the full set.
    TH.TOKENS.forEach(function (k) { body.style.setProperty("--" + k, t.tokens[k]); });
    body.setAttribute("data-theme", t.dark ? "dark" : "light");
    body.style.colorScheme = t.dark ? "dark" : "light";

    if (el.themeLabel) el.themeLabel.textContent = t.name;

    // The on-screen preview is immediate; redrawing the favicon, writing to storage
    // and notifying the map are not — a colour drag emits hundreds of events per
    // second and each of those is comparatively expensive.
    clearTimeout(themeSaveT);
    themeSaveT = setTimeout(function () {
      updateFavicon(t);
      save(LS.theme, t.id === "custom" ? t : t.id);
      pushTheme();
    }, 120);

    if (el.themeModal && !el.themeModal.hidden) renderThemeModal();
  }

  function setTheme(t) {
    if (!t) return;
    state.theme = t;
    if (!t.dark) lastLight = t; else lastDark = t;
    applyTheme();
  }

  // Alt+T keeps its old meaning: flip between light and dark, returning to
  // whichever theme of that mode was last used.
  function toggleTheme() {
    if (state.theme.dark) setTheme(lastLight || TH.byId("radial-light"));
    else setTheme(lastDark || TH.byId("radial-dark"));
  }

  /* ---------------------------------------------------------- sleep timer */

  function setSleep(min) {
    if (min === 0 || state.sleepMin === min) {
      sleepAt = null;
      state.sleepMin = 0;
      state.sleepLeft = "";
    } else {
      sleepAt = Date.now() + min * 60000;
      state.sleepMin = min;
    }
    renderSleep();
  }

  function sleepTick() {
    if (!sleepAt) return;
    var left = Math.max(0, Math.round((sleepAt - Date.now()) / 1000));
    if (left === 0) {
      sleepAt = null;
      state.sleepMin = 0;
      state.sleepLeft = "";
      audio.pause();
      renderSleep();
      return;
    }
    var m = Math.floor(left / 60), sec = left % 60;
    state.sleepLeft = m + ":" + String(sec).padStart(2, "0");
    renderSleep();
  }

  /* ----------------------------------------------------------- map bridge */

  function frameWin() { return el.mapFrame && el.mapFrame.contentWindow; }

  // Single source for the map's theme. This previously existed in two places and
  // they diverged: pushMap still sent `state.theme` after that became an object
  // rather than a "light"/"dark" string, so the iframe got data-theme
  // "[object Object]" and no tokens, and silently fell back to its hardcoded colours.
  function pushTheme() {
    var w = frameWin();
    if (!w) return;
    var t = state.theme;
    w.postMessage({ type: "theme", theme: t.dark ? "dark" : "light", tokens: t.tokens }, "*");
  }

  function pushMap() {
    var w = frameWin();
    if (!w) return;
    pushTheme();
    w.postMessage({
      type: "stations",
      stations: state.mapStations.map(function (s) {
        return {
          uuid: s.stationuuid, name: s.name, lat: +s.geo_lat, lon: +s.geo_long,
          country: s.country, bitrate: s.bitrate
        };
      })
    }, "*");
    pushCurrent();
  }

  function pushCurrent() {
    var w = frameWin();
    if (w) w.postMessage({ type: "current", uuid: state.current ? state.current.stationuuid : null }, "*");
  }

  /* -------------------------------------------------------------- render */

  // In split view the list follows the map: it shows the geolocated stations
  // currently on screen, rather than the top-400 the table normally holds.
  function inViewport(s) {
    return inBounds(+s.geo_lat, +s.geo_long, state.viewport);
  }

  var SPLIT_PAGE = 300;         // rows rendered per step in the map list
  var visibleTotal = 0;         // how many are in view before the render window

  function filteredMapStations() { return state.mapStations.filter(inViewport); }

  function visibleStations() {
    if (state.view !== "map") return state.stations;
    var all = filteredMapStations();
    visibleTotal = all.length;
    return all.slice(0, state.splitShown);
  }

  // Growing the map list needs no network: every station in view is already in
  // memory, so this only widens the render window.
  function growSplit() {
    if (state.view !== "map" || visibleTotal <= state.splitShown) return;
    var from = state.splitShown;
    state.splitShown += SPLIT_PAGE;
    var all = filteredMapStations();
    var html = "";
    for (var i = from; i < Math.min(all.length, state.splitShown); i++) html += rowHtml(all[i], i);
    el.rows.insertAdjacentHTML("beforeend", html);
    renderResultLabel();
  }

  function setView(view) {
    state.view = view;
    state.splitShown = SPLIT_PAGE;
    save(LS.view, view);
    el.browseBody.dataset.view = view;
    document.querySelectorAll(".viewbtn").forEach(function (b) {
      var on = b.dataset.view === view;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    if (view !== "list") {
      // The iframe is display:none in list view, so Leaflet needs re-measuring.
      setTimeout(function () {
        applyTheme();
        pushMap();
        var w = frameWin();
        if (w) w.postMessage({ type: "resize" }, "*");
      }, 60);
    }
    renderBrowse();
  }

  function listFor(name) {
    if (name === "stations") return visibleStations();
    return name === "favs" ? state.favs
      : name === "recent" ? state.recent
      : name === "customs" ? state.customs
      : state.stations;
  }

  // radio-browser carries station artwork in `favicon`. Roughly 16% of stations
  // have no URL and another 10% point at something dead, so every use of it needs
  // the lettered tile behind as a fallback.
  // Effective artwork state for one station: its own override if it has one,
  // otherwise the global default.
  function showArtFor(s) {
    var id = idOf(s);
    return Object.prototype.hasOwnProperty.call(state.pins, id) ? !!state.pins[id] : state.images;
  }

  // Three explicit modes, cycled: auto -> on -> off -> auto.
  //
  // "auto" is the absence of an entry, which is what makes the whole thing behave:
  // a station following the default costs nothing to store and keeps following the
  // default when it changes, while "on" and "off" are deliberate and stay put. The
  // alternative — inferring intent from whether a value differs from the default —
  // silently inverts every pinned station the moment the default is flipped.
  function artModeFor(s) {
    var id = idOf(s);
    if (!Object.prototype.hasOwnProperty.call(state.pins, id)) return "auto";
    return state.pins[id] ? "on" : "off";
  }

  function cycleArtFor(s) {
    var id = idOf(s), mode = artModeFor(s);
    if (mode === "auto") state.pins[id] = true;
    else if (mode === "on") state.pins[id] = false;
    else delete state.pins[id];
    var keys = Object.keys(state.pins);
    if (keys.length > 300) delete state.pins[keys[0]];      // bound the growth
    save(LS.pins, state.pins);
  }

  // About 4% of the directory reports bitrate in bits per second rather than kbps,
  // which renders as "MP3 128000k". Values at that magnitude are unambiguous, so
  // rescale them; oddities in the low thousands are left alone because there is no
  // way to tell a bad number from an unusual one.

  function artUrl(s) {
    var u = (s && s.favicon || "").trim();
    return /^https?:\/\//i.test(u) ? u : "";
  }

  // The image sits over the lettered tile; if it fails to load it is hidden and the
  // letter shows through. `no-referrer` keeps the app's URL out of arbitrary hosts'
  // logs, and lazy loading means only the rows on screen fetch anything.
  function artCell(m, cls) {
    // With artwork off the <img> is omitted entirely rather than hidden — the point
    // of the toggle is that no request reaches the stations' hosts at all.
    var show = m.showArt && m.icon;
    return '<div class="art ' + cls + '"><span class="art-letter">' + esc(m.initial) + "</span>" +
      (show ? '<img class="art-img" src="' + esc(m.icon) + '" alt="" loading="lazy" ' +
              'decoding="async" referrerpolicy="no-referrer">' : "") +
      "</div>";
  }

  function rowModel(s) {
    var cur = state.current && idOf(state.current) === idOf(s);
    return {
      cur: cur,
      playingNow: cur && state.playing,
      fav: isFav(s),
      name: s.name || "Untitled station",
      sub: (s.homepage || s.url_resolved || s.url || "").replace(/^https?:\/\//, "").slice(0, 60),
      tags: (s.tags || "").split(",").filter(Boolean).slice(0, 3).map(cap).join(" · ") || "—",
      country: s.country || s.countrycode || "—",
      language: (s.language || "—").split(",").slice(0, 2).map(cap).join(", "),
      stream: (s.codec || "?").toUpperCase() + (s.bitrate ? " " + kbps(s.bitrate) + "k" : ""),
      votes: num(s.votes),
      listeners: num(s.clickcount),
      url: s.url_resolved || s.url || "",
      icon: artUrl(s),
      showArt: showArtFor(s),
      initial: (s.name || "?").trim().charAt(0).toUpperCase() || "·"
    };
  }

  function playBtn(m, i) {
    return '<button class="play-btn" data-act="play" data-i="' + i + '" ' +
      'aria-label="' + (m.playingNow ? "Pause " : "Play ") + esc(m.name) + '">' +
      icon(m.playingNow ? P_PAUSE : P_PLAY, 11) + "</button>";
  }
  function favBtn(m, i) {
    return '<button class="fav-btn' + (m.fav ? " is-on" : "") + '" data-act="fav" data-i="' + i + '" ' +
      'aria-pressed="' + m.fav + '" aria-label="Favorite ' + esc(m.name) + '">' +
      (m.fav ? "★" : "☆") + "</button>";
  }
  function nameCell(m) {
    return '<div class="name-cell"><div class="name">' + esc(m.name) + "</div>" +
      '<div class="sub">' + esc(m.sub) + "</div></div>";
  }

  // The old label said "400 stations", which read as a match count when it was only
  // the page size. Only claim a total once the list is actually exhausted.
  function renderResultLabel() {
    if (state.view === "map" && !state.loading) {
      var shown = visibleStations().length;
      // Say so when the list is capped, rather than passing the cap off as a total.
      el.resultLabel.textContent = visibleTotal > shown
        ? shown.toLocaleString() + " of " + visibleTotal.toLocaleString() + " geolocated in view · scroll for more"
        : shown.toLocaleString() + " geolocated in view";
      return;
    }
    var n = state.stations.length.toLocaleString();
    el.resultLabel.textContent =
      state.loading ? "loading…" :
      state.loadingMore ? n + " shown · loading…" :
      state.stations.length >= MAX_ROWS ? n + " shown · narrow your filters" :
      state.hasMore ? n + "+ shown · scroll for more" :
      n + (state.stations.length === 1 ? " station" : " stations");
  }

  function rowHtml(s, i) {
    var m = rowModel(s);
    // role=row + aria-label so a screen reader announces a station rather than an
    // anonymous group; tabindex makes the row itself reachable, not just its buttons.
    var label = m.name + ", " + m.country + ", " + m.stream +
      ", " + m.listeners + " listeners, " + m.votes + " votes";
    return '<div class="row' + (m.cur ? " is-current" : "") + '" data-row-id="' + esc(idOf(s)) +
      '" role="row" tabindex="-1" aria-rowindex="' + (i + 2) + '" aria-label="' + esc(label) + '">' +
      playBtn(m, i) +
      artCell(m, "art-row") +
      nameCell(m) +
      '<div class="cell">' + esc(m.tags) + "</div>" +
      '<div class="cell">' + esc(m.country) + "</div>" +
      '<div class="cell">' + esc(m.language) + "</div>" +
      '<div class="cell-mono">' + esc(m.stream) + "</div>" +
      '<div class="cell-votes">' + esc(m.listeners) + "</div>" +
      '<div class="cell-votes">' + esc(m.votes) + "</div>" +
      "<div>" + favBtn(m, i) + "</div>" +
      "</div>";
  }

  // Appends only the new rows, so scroll position and the rest of the DOM survive.
  function appendRows(from) {
    var html = "";
    for (var i = from; i < state.stations.length; i++) html += rowHtml(state.stations[i], i);
    el.rows.insertAdjacentHTML("beforeend", html);
  }

  function renderBrowse() {
    renderResultLabel();

    if (state.loading) {
      el.rows.innerHTML = "";
      el.empty.hidden = false;
      el.empty.textContent = "Loading stations…";
      return;
    }

    var list = visibleStations();
    el.rows.innerHTML = list.map(rowHtml).join("");

    if (el.rows.firstElementChild) el.rows.firstElementChild.tabIndex = 0;
    el.tableScroll.setAttribute("aria-rowcount", String(list.length + 1));

    var isEmpty = list.length === 0;
    el.empty.hidden = !isEmpty;
    if (isEmpty) {
      el.empty.innerHTML = state.error
        ? esc(state.error) + '<button class="linkbtn" id="retry">Retry</button>'
        : state.view === "map"
          ? "No geolocated stations in view — pan or zoom out."
          : "No stations match these filters.";
    }
  }

  function renderLibrary() {
    el.favCount.textContent = state.favs.length + " saved";
    el.noFavs.hidden = state.favs.length > 0;
    el.noRecent.hidden = state.recent.length > 0;

    function libRow(s, i) {
      var m = rowModel(s);
      return '<div class="row-lib' + (m.cur ? " is-current" : "") + '" data-row-id="' + esc(idOf(s)) + '">' +
        playBtn(m, i) +
        artCell(m, "art-row") +
        nameCell(m) +
        '<div class="cell">' + esc(m.country) + "</div>" +
        '<div class="cell-mono">' + esc(m.stream) + "</div>" +
        favBtn(m, i) +
        "</div>";
    }
    el.favRows.innerHTML = state.favs.map(libRow).join("");
    el.recentRows.innerHTML = state.recent.map(libRow).join("");
  }

  function fmtWhen(ms) {
    var d = new Date(ms);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + ", " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function renderRecordings() {
    var list = state.recordings;
    var total = list.reduce(function (n, x) { return n + x.size; }, 0);
    el.recCount.textContent = list.length
      ? list.length + (list.length === 1 ? " recording · " : " recordings · ") + fmtSize(total)
      : "none yet";
    el.noRecordings.hidden = list.length > 0;

    el.recRows.innerHTML = list.map(function (item, i) {
      var cur = state.current && state.current.recordingId === item.id;
      var playing = cur && state.playing;
      return '<div class="row-rec' + (cur ? " is-current" : "") + '" data-row-id="rec:' + esc(item.id) + '">' +
        '<button class="play-btn" data-act="play" data-i="' + i + '" aria-label="' +
          (playing ? "Pause " : "Play ") + esc(item.station) + '">' + icon(playing ? P_PAUSE : P_PLAY, 11) + "</button>" +
        '<div class="name-cell"><div class="name">' + esc(item.station) + "</div>" +
        '<div class="sub">' + fmtClock(item.duration) + " · " + esc(item.ext.toUpperCase()) + "</div></div>" +
        '<div class="cell-mono">' + fmtSize(item.size) + "</div>" +
        '<div class="cell">' + esc(fmtWhen(item.createdAt)) + "</div>" +
        '<button class="icon-btn" data-act="download" data-i="' + i + '" title="Download to device" ' +
          'aria-label="Download ' + esc(item.station) + '">⤓</button>' +
        '<button class="icon-btn" data-act="delete" data-i="' + i + '" title="Delete" ' +
          'aria-label="Delete ' + esc(item.station) + '">×</button>' +
        "</div>";
    }).join("");
  }

  function renderCustom() {
    el.noCustom.hidden = state.customs.length > 0;
    el.customRows.innerHTML = state.customs.map(function (s, i) {
      var m = rowModel(s);
      return '<div class="row-custom' + (m.cur ? " is-current" : "") + '" data-row-id="' + esc(idOf(s)) + '">' +
        playBtn(m, i) +
        '<div class="name-cell"><div class="name">' + esc(m.name) + "</div>" +
        '<div class="sub">' + esc(m.url) + "</div></div>" +
        '<button class="remove-btn" data-act="remove" data-i="' + i + '" title="Remove" ' +
        'aria-label="Remove ' + esc(m.name) + '">×</button>' +
        "</div>";
    }).join("");
  }

  var STATUS = {
    idle: ["No station", "var(--fg3)"],
    connecting: ["Connecting", "var(--fg2)"],
    buffering: ["Buffering", "var(--fg2)"],
    live: ["Live", "var(--ok)"],
    paused: ["Paused", "var(--fg3)"],
    error: ["Stream unavailable", "var(--accent)"]
  };

  function renderPlayer() {
    var cur = state.current;
    var st = STATUS[state.status] || STATUS.idle;
    var animating = state.status === "live" || state.status === "buffering";

    el.nowName.textContent = cur ? (cur.name || "Untitled station") : "Nothing playing";

    var np = state.nowPlaying;
    if (rec) {
      el.nowMeta.textContent = "● REC " + fmtDuration(Date.now() - rec.startedAt) +
        " · " + fmtSize(rec.bytes);
    } else if (recNote) {
      el.nowMeta.textContent = recNote;
    } else if (np && np.title) {
      el.nowMeta.textContent = "♪ " + (np.artist ? np.artist + " — " : "") + np.title;
    } else {
      el.nowMeta.textContent = cur
        ? [cur.country, (cur.codec || "").toUpperCase(), cur.bitrate ? kbps(cur.bitrate) + "kbps" : ""]
            .filter(Boolean).join(" / ")
        : "pick a station to start";
    }
    el.nowMeta.classList.toggle("is-rec", !!rec || !!recNote);
    el.nowMeta.classList.toggle("is-track", !rec && !recNote && !!(state.nowPlaying));
    // Name the source of the track text rather than presenting it as if the app
    // knew it by itself — the listener should be able to see where it came from.
    el.nowMeta.title = state.nowPlaying
      ? state.nowPlaying.raw + "\n\nfrom the station's own stream metadata, read via " +
        (function () { try { return new URL(PROXY).host; } catch (e) { return PROXY; } })()
      : "";

    el.recBtn.disabled = (!cur && !rec) || (isRec(cur) && !rec);
    el.shareBtn.disabled = isRec(cur);
    el.recBtn.classList.toggle("is-on", !!rec);
    el.recBtn.setAttribute("aria-pressed", String(!!rec));
    el.recBtn.title = rec ? "Stop recording and save" : "Record this stream";

    var showCur = cur ? showArtFor(cur) : false;
    // Named artSrc, not icon: a local `icon` here shadows the icon() helper for the
    // whole function (var hoisting) and every transport glyph below stops rendering.
    var artSrc = cur && showCur ? artUrl(cur) : "";
    // Nothing to override when the station publishes no artwork at all (~16%).
    var canPin = !!(cur && artUrl(cur) && !isRec(cur));
    el.artToggle.hidden = !canPin;
    if (canPin) {
      var mode = artModeFor(cur);
      var globalWord = state.images ? "on" : "off";
      el.artToggle.dataset.mode = mode;
      el.artToggle.title =
        mode === "auto" ? "Artwork: following the default (" + globalWord + ") — click to always show" :
        mode === "on"   ? "Artwork: always on for this station — click to always hide" :
                          "Artwork: always off for this station — click to follow the default";
    }
    el.artLetter.textContent = cur && cur.name ? cur.name.trim().charAt(0).toUpperCase() : "·";
    el.art.classList.toggle("is-live", !!cur);
    if (artSrc !== el.artImg.getAttribute("data-src")) {
      el.artImg.setAttribute("data-src", artSrc);
      el.artImg.classList.remove("is-broken");
      if (artSrc) el.artImg.src = artSrc; else el.artImg.removeAttribute("src");
    }
    el.artImg.hidden = !artSrc;

    el.status.textContent = st[0];
    el.status.style.color = st[1];
    el.bars.style.color = st[1];
    el.bars.classList.toggle("is-on", animating);

    el.togglePlay.innerHTML = icon(state.playing ? P_PAUSE : P_PLAY, 18);
    el.shareBtn.textContent = state.shared ? "Copied" : "Copy link";

    el.favCurrent.hidden = !cur || isRec(cur);
    el.favCurrent.classList.toggle("is-on", isFav(cur));
    el.favCurrent.innerHTML = isFav(cur) ? "★" : "☆";
  }

  function renderSleep() {
    Array.prototype.forEach.call(el.sleepOpts.children, function (b) {
      b.classList.toggle("is-on", +b.dataset.min === state.sleepMin);
    });
    var show = !!state.sleepMin && !!state.sleepLeft;
    el.sleepLeft.hidden = !show;
    el.sleepLeft.textContent = show ? "stops in " + state.sleepLeft : "";
  }

  function renderMapLabel() {
    el.mapLabel.textContent = state.loading ? "loading…" : state.mapStations.length.toLocaleString();
  }

  // Updates the current/favorite state of already-rendered rows without
  // rebuilding them — the Browse table can hold 400 rows.
  function syncRows() {
    var curId = state.current ? idOf(state.current) : null;
    document.querySelectorAll("[data-row-id]").forEach(function (row) {
      var id = row.getAttribute("data-row-id");
      var cur = id === curId;
      row.classList.toggle("is-current", cur);

      var pb = row.querySelector('[data-act="play"]');
      if (pb) {
        var pausable = cur && state.playing;
        pb.innerHTML = icon(pausable ? P_PAUSE : P_PLAY, 11);
        pb.setAttribute("aria-label", (pausable ? "Pause " : "Play ") + (row.querySelector(".name") || {}).textContent);
      }

      var fb = row.querySelector('[data-act="fav"]');
      if (fb) {
        var on = state.favs.some(function (x) { return idOf(x) === id; });
        fb.classList.toggle("is-on", on);
        fb.innerHTML = on ? "★" : "☆";
        fb.setAttribute("aria-pressed", String(on));
      }
    });
  }

  // Cheap refresh: small lists rebuilt, big table patched in place.
  function refresh() {
    renderLibrary();
    renderCustom();
    syncRows();
    renderPlayer();
  }

  function renderAll() {
    renderBrowse();
    renderLibrary();
    renderRecordings();
    renderCustom();
    renderPlayer();
  }

  function setPage(page) {
    state.page = page;
    document.querySelectorAll(".nav-item").forEach(function (b) {
      var on = b.dataset.page === page;
      b.classList.toggle("is-active", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    document.querySelectorAll(".page").forEach(function (p) {
      p.hidden = p.dataset.page !== page;
    });
    if (page === "browse" && state.view !== "list") {
      setTimeout(function () {
        applyTheme();
        pushMap();
        var w = frameWin();
        if (w) w.postMessage({ type: "resize" }, "*");
      }, 60);
    }
  }

  /* -------------------------------------------------------------- install */

  // Chrome/Edge fire this instead of showing their own prompt once the app meets
  // the install criteria (HTTPS + manifest + a service worker with a fetch
  // handler). Stashing it lets us offer an in-app button, like SoundCloud's.
  var installPrompt = null;

  function installed() {
    return matchMedia("(display-mode: standalone)").matches ||
      matchMedia("(display-mode: window-controls-overlay)").matches ||
      navigator.standalone === true;
  }

  function syncInstallButton() {
    if (!el.install) return;
    el.install.hidden = !installPrompt || installed();
  }

  addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    installPrompt = e;
    syncInstallButton();
  });

  addEventListener("appinstalled", function () {
    installPrompt = null;
    syncInstallButton();
  });

  // A worker stuck in "waiting" means a newer version is installed but is holding
  // back rather than swapping code under a page that may be playing audio.
  function offerUpdate(reg) {
    if (!el.update || !navigator.serviceWorker.controller) return;
    el.update.hidden = false;
    el.update.onclick = function () {
      el.update.hidden = true;
      if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
    };
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // Secure context only — file:// and plain http (other than localhost) can't.
    if (!self.isSecureContext) return;

    // Reload once the replacement worker actually takes over. Guarded so the very
    // first visit (no previous controller) doesn't reload itself.
    var hadController = !!navigator.serviceWorker.controller;
    var reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });

    addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").then(function (reg) {
        if (reg.waiting) offerUpdate(reg);
        reg.addEventListener("updatefound", function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener("statechange", function () {
            if (sw.state === "installed") offerUpdate(reg);
          });
        });
        // A radio app can sit open for days — re-check rather than waiting for a reload.
        setInterval(function () { reg.update().catch(function () {}); }, 3600000);
      }).catch(function () {});
    });
  }

  /* ------------------------------------------------- sidebar + split pane */

  var NARROW = matchMedia("(max-width: 860px)");

  // Railed either because the user collapsed it, or because there isn't room.
  function syncRail() {
    var rail = state.railed || NARROW.matches;
    document.querySelector(".app").classList.toggle("is-rail", rail);
    if (el.railToggle) {
      el.railToggle.setAttribute("aria-expanded", String(!rail));
      el.railToggle.title = rail ? "Expand sidebar" : "Collapse sidebar";
      el.railToggle.disabled = NARROW.matches;   // no room to expand into
    }
  }

  var SPLIT_MIN = 260;
  var dragRect = null;      // container bounds, measured once per drag

  function applySplit(px) {
    // Measuring here would force a synchronous layout on every pointermove, and the
    // handler needs the same rect — so a drag caches it once at pointerdown.
    var rect = dragRect || el.browseBody.getBoundingClientRect();
    var max = Math.max(SPLIT_MIN, rect.width - 320);
    state.split = Math.round(Math.min(max, Math.max(SPLIT_MIN, px)));
    el.browseBody.style.setProperty("--split-w", state.split + "px");
  }

  function initSplit() {
    applySplit(state.split);
    var handle = el.splitHandle;
    if (!handle) return;

    var pendingX = 0, rafId2 = 0;

    handle.addEventListener("pointerdown", function (e) {
      if (state.view !== "map") return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("is-dragging");
      document.body.classList.add("is-resizing");
      dragRect = el.browseBody.getBoundingClientRect();
    });

    // Coalesced to one update per frame: pointermove can fire several times per
    // frame on a high-rate pointer, and each update relayouts the whole row grid.
    handle.addEventListener("pointermove", function (e) {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      pendingX = e.clientX;
      if (rafId2) return;
      rafId2 = requestAnimationFrame(function () {
        rafId2 = 0;
        // Measured from the right edge, since the list is the right-hand pane.
        applySplit((dragRect ? dragRect.right : el.browseBody.getBoundingClientRect().right) - pendingX);
      });
    });

    function end(e) {
      if (!handle.hasPointerCapture || !handle.hasPointerCapture(e.pointerId)) return;
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing");
      if (rafId2) { cancelAnimationFrame(rafId2); rafId2 = 0; }
      dragRect = null;
      save(LS.split, state.split);
      var w = frameWin();
      if (w) w.postMessage({ type: "resize" }, "*");   // Leaflet must re-measure
    }
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);

    // Keyboard: the handle is focusable, so it should be operable too.
    handle.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? 48 : 16;
      if (e.key === "ArrowLeft") applySplit(state.split + step);
      else if (e.key === "ArrowRight") applySplit(state.split - step);
      else return;
      e.preventDefault();
      save(LS.split, state.split);
      var w = frameWin();
      if (w) w.postMessage({ type: "resize" }, "*");
    });
  }

  /* ---------------------------------------------------------- theme picker */

  function currentCode() { return TH.encode(state.theme); }

  // Updated in place, never rebuilt.
  //
  // <input type="color"> anchors the OS colour picker to that exact element, and it
  // fires `input` continuously while dragging. Re-rendering the grid on each event
  // destroys the element the picker is attached to, closing it mid-drag and losing
  // the edit — the picker has to survive its own change events.
  function renderThemeModal() {
    var cur = state.theme;

    var presets = allPresets();

    if (!el.themeGrid.children.length || presetsDirty) {
      presetsDirty = false;
      el.themeGrid.innerHTML = presets.map(function (t, i) {
        var sw = ["bg", "accent", "fg", "bg3"].map(function (k) {
          return '<span style="background:' + esc(t.tokens[k]) + '"></span>';
        }).join("");
        return '<button class="theme-card" data-preset="' + i + '">' +
          '<span class="theme-swatches">' + sw + "</span>" +
          '<span class="theme-card-name">' + esc(t.name) + "</span>" +
          (t.user ? '<span class="theme-del" role="button" tabindex="0" data-del="' +
                    esc(t.id) + '" title="Delete this theme">×</span>' : "") +
          "</button>";
      }).join("");
    }

    if (!el.swatchGrid.children.length) {
      el.swatchGrid.innerHTML = TH.TOKENS.map(function (k) {
        return '<label class="swatch-row">' +
          '<input type="color" data-token="' + k + '">' +
          '<input type="text" class="hex-input" data-hex="' + k + '" maxlength="7" spellcheck="false">' +
          "<span>" + esc(TH.LABELS[k] || k) + "</span></label>";
      }).join("");
    }

    var cards = el.themeGrid.children;
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle("is-on", !!presets[i] && presets[i].id === cur.id);
    }

    el.swatchGrid.querySelectorAll("input[data-token]").forEach(function (inp) {
      // Leave the one being dragged alone; assigning .value can dismiss the picker.
      if (inp === document.activeElement) return;
      var v = cur.tokens[inp.dataset.token];
      if (v && inp.value !== v) inp.value = v;
    });
    el.swatchGrid.querySelectorAll("input[data-hex]").forEach(function (inp) {
      if (inp === document.activeElement) return;   // never fight someone typing
      var v = cur.tokens[inp.dataset.hex];
      if (v && inp.value.toLowerCase() !== v.toLowerCase()) inp.value = v;
      inp.classList.remove("is-bad");
    });

    if (el.fontSelect && !el.fontSelect.options.length) {
      el.fontSelect.innerHTML = TH.FONTS.map(function (f) {
        return '<option value="' + esc(f.id) + '">' + esc(f.name) + "</option>";
      }).join("");
      el.fontSelect.value = state.font;
    }

    el.themeCode.value = currentCode();
  }

  // Focus is trapped while the dialog is open and returned to whatever opened it —
  // without this, tabbing walks out of the modal into the page behind it.
  var modalReturnFocus = null;

  function focusables() {
    return [].slice.call(el.themeModal.querySelectorAll(
      'button, [href], input, select, [tabindex]:not([tabindex="-1"])'
    )).filter(function (n) { return !n.disabled && n.offsetParent !== null; });
  }

  function openThemeModal() {
    modalReturnFocus = document.activeElement;
    el.themeModal.hidden = false;
    renderThemeModal();
    var f = focusables();
    if (f.length) f[0].focus();
  }

  function closeThemeModal() {
    el.themeModal.hidden = true;
    el.themeError.hidden = true;
    el.themeLoad.value = "";
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
    modalReturnFocus = null;
  }

  function trapTab(e) {
    if (e.key !== "Tab" || el.themeModal.hidden) return;
    var f = focusables();
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* --------------------------------------------------------------- wiring */

  function bindRowList(container) {
    container.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-act]");
      if (!btn || !container.contains(btn)) return;
      var list = listFor(container.dataset.list);
      var s = list[+btn.dataset.i];
      if (!s) return;

      if (btn.dataset.act === "play") {
        var cur = state.current && idOf(state.current) === idOf(s);
        if (cur && state.playing) audio.pause();
        else if (cur) resumePlayback();
        else play(s);
      } else if (btn.dataset.act === "fav") {
        toggleFav(s);
      } else if (btn.dataset.act === "remove") {
        state.customs = state.customs.filter(function (c) { return c.url !== s.url; });
        save(LS.custom, state.customs);
        renderCustom();
      }
    });
  }

  function init() {
    el = {
      category: $("#category"), country: $("#country"), tag: $("#tag"), language: $("#language"),
      q: $("#q"), order: $("#order"), codec: $("#codec"), bitrate: $("#bitrate"),
      hidebroken: $("#hidebroken"), reset: $("#reset"), resultLabel: $("#result-label"),
      rows: $("#rows"), empty: $("#empty"), tableScroll: $(".table-scroll"),
      browseBody: $("#browse-body"), splitHandle: $("#split-handle"),
      railToggle: $("#rail-toggle"),
      imgToggle: $("#img-toggle"), artToggle: $("#art-toggle"),
      mapFrame: $("#map-frame"), mapLabel: $("#map-label"),
      favRows: $("#fav-rows"), recentRows: $("#recent-rows"),
      favCount: $("#fav-count"), noFavs: $("#no-favs"), noRecent: $("#no-recent"),
      recRows: $("#rec-rows"), recCount: $("#rec-count"), noRecordings: $("#no-recordings"),
      customRows: $("#custom-rows"), noCustom: $("#no-custom"),
      customForm: $("#custom-form"), customUrl: $("#custom-url"),
      customName: $("#custom-name"), customError: $("#custom-error"),
      sleepOpts: $("#sleep-opts"), sleepLeft: $("#sleep-left"),
      themeToggle: $("#theme-toggle"), themeLabel: $("#theme-label"),
      themeModal: $("#theme-modal"), themeGrid: $("#theme-grid"),
      swatchGrid: $("#swatch-grid"), themeCode: $("#theme-code"),
      themeCopy: $("#theme-copy"), themeLoad: $("#theme-load"),
      themeApply: $("#theme-apply"), themeError: $("#theme-error"),
      fontSelect: $("#font-select"), presetName: $("#preset-name"), presetSave: $("#preset-save"),
      art: $("#art"), artLetter: $("#art-letter"), artImg: $("#art-img"),
      nowName: $("#now-name"), nowMeta: $("#now-meta"),
      status: $("#status"), bars: $("#bars"),
      togglePlay: $("#toggle-play"), stopPlay: $("#stop-play"), shareBtn: $("#share"),
      recBtn: $("#record"), install: $("#install"), update: $("#update"),
      favCurrent: $("#fav-current"), volume: $("#volume"), volumeLabel: $("#volume-label")
    };

    initTheme();
    applyFont(state.font);

    [audioPlain, audioAn].forEach(function (a) {
      a.preload = "none";

      a.addEventListener("waiting", function () {
        if (a !== audio) return;
        state.status = "buffering"; renderPlayer();
      });
      a.addEventListener("stalled", function () {
        if (a !== audio) return;
        state.status = "buffering"; renderPlayer();
      });
      a.addEventListener("playing", function () {
        if (a !== audio) return;
        analysedUrl = null;                      // the analysed element got through
        state.status = "live"; state.playing = true;
        if (a === audioAn && ensureAnalyser()) startBars();
        refresh();
      });
      a.addEventListener("pause", function () {
        if (a !== audio || swapping) return;
        pausedAt = Date.now();
        stopBars();
        state.playing = false;
        if (state.current) state.status = "paused";
        refresh();
      });
      a.addEventListener("error", function () {
        if (a !== audio || swapping || !state.current) return;
        // A CORS refusal on the analysed element is expected; retry plainly.
        if (retryWithoutAnalyser(a.src)) return;
        stopBars();
        state.status = "error"; state.playing = false; refresh();
      });
    });

    applyVolume(state.volume);
    el.volume.value = state.volume;
    el.volume.style.setProperty("--vol-pct", state.volume + "%");
    el.volumeLabel.textContent = state.volume + "%";

    // nav
    document.querySelectorAll(".nav-item").forEach(function (b) {
      b.addEventListener("click", function () { setPage(b.dataset.page); });
    });

    // filters
    el.q.addEventListener("input", function () { setF({ q: el.q.value }); });
    el.order.addEventListener("change", function () { setF({ order: el.order.value }); });
    el.category.addEventListener("change", function () { setF({ category: el.category.value }); });
    el.country.addEventListener("change", function () { setF({ country: el.country.value }); });
    el.tag.addEventListener("change", function () { setF({ tag: el.tag.value }); });
    el.language.addEventListener("change", function () { setF({ language: el.language.value }); });
    el.codec.addEventListener("change", function () { setF({ codec: el.codec.value }); });
    el.bitrate.addEventListener("change", function () { setF({ bitrateMin: el.bitrate.value }); });
    el.hidebroken.addEventListener("click", function () {
      var on = !state.f.hidebroken;
      el.hidebroken.classList.toggle("is-on", on);
      el.hidebroken.setAttribute("aria-pressed", String(on));
      setF({ hidebroken: on });
    });
    el.reset.addEventListener("click", function () {
      el.q.value = ""; el.category.value = ""; el.country.value = ""; el.tag.value = "";
      el.language.value = ""; el.codec.value = ""; el.bitrate.value = "0";
      setF({ q: "", category: "", country: "", tag: "", language: "", codec: "", bitrateMin: "0" });
    });
    el.imgToggle.classList.toggle("is-on", state.images);
    el.imgToggle.setAttribute("aria-pressed", String(state.images));
    el.imgToggle.addEventListener("click", function () {
      state.images = !state.images;
      save(LS.images, state.images);
      el.imgToggle.classList.toggle("is-on", state.images);
      el.imgToggle.setAttribute("aria-pressed", String(state.images));
      el.imgToggle.title = state.images
        ? "Station artwork — click to turn off (stops all image requests)"
        : "Station artwork off — click to show images";
      renderBrowse();
      renderLibrary();
      renderRecordings();
      renderPlayer();
      syncRows();
    });

    el.artToggle.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!state.current) return;
      cycleArtFor(state.current);
      renderBrowse();
      renderLibrary();
      renderPlayer();
      syncRows();
    });

    el.empty.addEventListener("click", function (e) {
      if (e.target.id === "retry") fetchStations();
    });

    document.querySelectorAll(".viewbtn").forEach(function (b) {
      b.addEventListener("click", function () { setView(b.dataset.view); });
    });

    // Roving tabindex: one row is tabbable at a time, arrows move between them.
    el.rows.addEventListener("keydown", function (e) {
      var row = e.target.closest(".row");
      if (!row) return;
      var rows = [].slice.call(el.rows.children);
      var i = rows.indexOf(row);
      var next = null;
      if (e.key === "ArrowDown") next = rows[i + 1];
      else if (e.key === "ArrowUp") next = rows[i - 1];
      else if (e.key === "Home") next = rows[0];
      else if (e.key === "End") next = rows[rows.length - 1];
      else if (e.key === "Enter" || e.key === " ") {
        var btn = row.querySelector('[data-act="play"]');
        if (btn) { e.preventDefault(); btn.click(); }
        return;
      } else return;
      if (!next) return;
      e.preventDefault();
      rows.forEach(function (r) { r.tabIndex = -1; });
      next.tabIndex = 0;
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    });

    el.rows.addEventListener("focusin", function (e) {
      var row = e.target.closest(".row");
      if (row && row.tabIndex !== 0) {
        [].forEach.call(el.rows.children, function (r) { r.tabIndex = -1; });
        row.tabIndex = 0;
      }
    });

    el.tableScroll.addEventListener("scroll", function () {
      var e = el.tableScroll;
      if (e.scrollTop + e.clientHeight >= e.scrollHeight - 600) loadMore();
    });

    // `error` does not bubble, so it has to be caught on the way down.
    document.addEventListener("error", function (e) {
      if (e.target && e.target.classList && e.target.classList.contains("art-img")) {
        e.target.classList.add("is-broken");
      }
    }, true);

    [el.rows, el.favRows, el.recentRows, el.customRows].forEach(bindRowList);

    el.recRows.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-act]");
      if (!btn || !el.recRows.contains(btn)) return;
      var item = state.recordings[+btn.dataset.i];
      if (!item) return;
      var act = btn.dataset.act;
      if (act === "download") { downloadRecording(item); return; }
      if (act === "delete") { deleteRecording(item); return; }
      var cur = state.current && state.current.recordingId === item.id;
      if (cur && state.playing) audio.pause();
      else if (cur) resumePlayback();
      else play(recStation(item));
    });

    // custom stream
    el.customForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var url = el.customUrl.value.trim();
      if (!/^https?:\/\/\S+$/i.test(url)) {
        el.customError.hidden = false;
        el.customError.textContent = "Enter a full http(s) stream URL.";
        return;
      }
      el.customError.hidden = true;
      var station = {
        name: el.customName.value.trim() || url.replace(/^https?:\/\//, "").split("/")[0],
        url: url, url_resolved: url, custom: true, codec: "custom", country: "Custom"
      };
      state.customs = [station]
        .concat(state.customs.filter(function (c) { return c.url !== url; }))
        .slice(0, 20);
      save(LS.custom, state.customs);
      el.customUrl.value = "";
      el.customName.value = "";
      play(station);
    });
    el.customUrl.addEventListener("input", function () { el.customError.hidden = true; });

    // library
    $("#clear-recent").addEventListener("click", function () {
      state.recent = [];
      save(LS.recent, state.recent);
      renderLibrary();
    });

    // sleep timer
    el.sleepOpts.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-min]");
      if (b) setSleep(+b.dataset.min);
    });
    setInterval(function () {
      sleepTick();
      if (rec) renderPlayer();               // live elapsed / size readout
    }, 1000);

    addEventListener("beforeunload", function (e) {
      if (!rec) return;
      e.preventDefault();
      e.returnValue = "";                    // unsaved recording in memory
    });

    // install
    syncInstallButton();
    el.install.addEventListener("click", function () {
      if (!installPrompt) return;
      installPrompt.prompt();
      installPrompt.userChoice.then(function () {
        installPrompt = null;
        syncInstallButton();
      });
    });

    // theme
    el.themeToggle.addEventListener("click", openThemeModal);
    addEventListener("keydown", function (e) {
      if (e.altKey && (e.key === "t" || e.key === "T")) { e.preventDefault(); toggleTheme(); }
      if (e.key === "Escape" && !el.themeModal.hidden) closeThemeModal();
      trapTab(e);
    });

    el.themeModal.addEventListener("click", function (e) {
      if (e.target.hasAttribute("data-close")) closeThemeModal();
    });

    el.themeGrid.addEventListener("click", function (e) {
      var del = e.target.closest("[data-del]");
      if (del) { e.stopPropagation(); deletePreset(del.dataset.del); return; }
      var b = e.target.closest("[data-preset]");
      if (b) setTheme(allPresets()[+b.dataset.preset]);
    });

    // Typing a hex value directly, rather than through the OS colour picker.
    // Partial input ("#ff") is flagged and ignored rather than applied, which would
    // otherwise push an invalid value into the CSS variables.
    el.swatchGrid.addEventListener("input", function (e) {
      var hex = e.target.closest("input[data-hex]");
      if (!hex) return;
      var v = normaliseHex(hex.value);
      hex.classList.toggle("is-bad", !!hex.value.trim() && !v);
      if (!v) return;
      var tokens = Object.assign({}, state.theme.tokens);
      tokens[hex.dataset.hex] = v;
      setTheme({ id: "custom", name: "Custom", dark: state.theme.dark, tokens: tokens });
    });

    el.fontSelect.addEventListener("change", function () { applyFont(el.fontSelect.value); });

    el.presetSave.addEventListener("click", function () {
      saveCurrentAsPreset(el.presetName.value);
      el.presetName.value = "";
      presetsDirty = true;
      renderThemeModal();
      el.presetSave.textContent = "Saved";
      setTimeout(function () { el.presetSave.textContent = "Save as preset"; }, 1400);
    });

    el.swatchGrid.addEventListener("input", function (e) {
      var inp = e.target.closest("input[data-token]");
      if (!inp) return;
      // Editing any colour forks the current theme into a custom one.
      var tokens = Object.assign({}, state.theme.tokens);
      tokens[inp.dataset.token] = inp.value;
      setTheme({ id: "custom", name: "Custom", dark: state.theme.dark, tokens: tokens });
    });

    el.themeCopy.addEventListener("click", function () {
      el.themeCode.select();
      if (navigator.clipboard) navigator.clipboard.writeText(currentCode()).catch(function () {});
      el.themeCopy.textContent = "Copied";
      setTimeout(function () { el.themeCopy.textContent = "Copy"; }, 1500);
    });

    el.themeApply.addEventListener("click", function () {
      var t = TH.decode(el.themeLoad.value);
      if (!t) {
        el.themeError.hidden = false;
        el.themeError.textContent = "That doesn't look like a Radial theme code.";
        return;
      }
      el.themeError.hidden = true;
      el.themeLoad.value = "";
      setTheme(t);
    });

    // transport
    el.togglePlay.addEventListener("click", togglePlay);
    el.stopPlay.addEventListener("click", stop);
    el.recBtn.addEventListener("click", toggleRecording);
    el.shareBtn.addEventListener("click", function () {
      var cur = state.current;
      if (!cur) return;
      var url = cur.url_resolved || cur.url;
      if (navigator.clipboard) navigator.clipboard.writeText(url).catch(function () {});
      state.shared = true;
      renderPlayer();
      clearTimeout(shareT);
      shareT = setTimeout(function () { state.shared = false; renderPlayer(); }, 1600);
    });
    el.favCurrent.addEventListener("click", function () {
      if (state.current) toggleFav(state.current);
    });
    el.volume.addEventListener("input", function () {
      var v = +el.volume.value;
      el.volume.style.setProperty("--vol-pct", v + "%");
      applyVolume(v);
      state.volume = v;
      save(LS.vol, v);
      el.volumeLabel.textContent = v + "%";
    });

    // map iframe
    addEventListener("message", function (e) {
      if (e.source !== frameWin()) return;
      var d = e.data || {};
      if (d.type === "map-ready") pushMap();
      if (d.type === "viewport") {
        state.viewport = { n: d.n, s: d.s, e: d.e, w: d.w };
        if (state.view === "map") {
          state.splitShown = SPLIT_PAGE;      // a new area starts from the top
          renderBrowse();
        }
      }
      if (d.type === "play") {
        var s = state.mapStations.concat(state.stations).find(function (x) {
          return x.stationuuid === d.uuid;
        });
        if (s) play(s);
      }
    });

    idbAll().then(function (list) {
      state.recordings = (list || []).sort(function (a, b) { return b.createdAt - a.createdAt; });
      renderRecordings();
      syncRows();
    }).catch(function () { /* no IndexedDB — recording still works, just no history */ });

    el.railToggle.addEventListener("click", function () {
      state.railed = !state.railed;
      save(LS.rail, state.railed);
      syncRail();
    });
    NARROW.addEventListener("change", syncRail);
    syncRail();
    initSplit();

    setView(state.view);

    renderAll();
    renderSleep();
    registerServiceWorker();
    probeProxy();
    loadMeta();
    fetchStations();
  }

  if (document.readyState === "loading") addEventListener("DOMContentLoaded", init);
  else init();
})();
