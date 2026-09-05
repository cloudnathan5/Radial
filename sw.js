/* Radial service worker.
   Caches the app shell so the installed app opens instantly and survives a flaky
   connection. It deliberately does NOT touch anything cross-origin — the
   radio-browser API, audio streams, map tiles and fonts all pass straight
   through. Intercepting an endless audio stream would be a memory leak. */

var VERSION = "radial-v4";

// Must match the ?v= stamps in index.html. GitHub Pages serves assets with
// max-age=600, so without a changing URL a visitor can end up running new HTML
// against a stale script. Bump both together on release.
var ASSET_V = "3";
var v = function (p) { return p + "?v=" + ASSET_V; };

var SHELL = [
  "./",
  "./index.html",
  v("./styles.css"),
  v("./app.js"),
  v("./config.js"),
  v("./themes.js"),
  v("./lib.js"),
  "./map.html",
  v("./manifest.json"),
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", function (e) {
  // No skipWaiting here on purpose: a new worker waits rather than taking over a
  // page that is already running (and possibly playing audio). It activates when
  // every tab is closed, or immediately if the page asks it to below.
  e.waitUntil(
    caches.open(VERSION).then(function (c) { return c.addAll(SHELL); })
  );
});

self.addEventListener("message", function (e) {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === VERSION ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // Everything off-origin (API, streams, tiles, fonts) is left entirely alone.
  if (url.origin !== self.location.origin) return;
  // Range requests are media seeks — never serve those from the cache.
  if (req.headers.has("range")) return;

  // Network-first for everything same-origin. A cache-first shell would serve the
  // previous deploy's JS/CSS for one more load, so people would always be a
  // version behind; the cache is the offline fallback, not the primary source.
  // `cache: "no-cache"` forces a revalidation with the server. Without it the SW's
  // own fetch is served by the browser's HTTP cache, so "network-first" would still
  // hand back a stale asset — GitHub Pages sends max-age=600, which would delay a
  // deploy by up to ten minutes. Revalidation is cheap: unchanged files return 304.
  e.respondWith(
    fetch(req, { cache: "no-cache" }).then(function (res) {
      if (res && res.ok && res.type === "basic") {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === "navigate") {
          return caches.match("./index.html", { ignoreSearch: true })
            .then(function (r) { return r || Response.error(); });
        }
        return Response.error();
      });
    })
  );
});
