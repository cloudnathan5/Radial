/* Radial themes.
 *
 * A theme is the twelve CSS custom properties the whole UI is built from, plus a
 * `dark` flag (used for `color-scheme` and for tinting the map iframe). Presets and
 * custom themes are the same shape, so anything the picker can show, a share code
 * can carry.
 */
(function () {
  "use strict";

  // Order matters: the share code packs colours in exactly this sequence.
  var TOKENS = ["bg", "bg2", "bg3", "bg4", "fg", "fg2", "fg3",
                "line", "accent", "accent-fg", "accent-soft", "ok"];

  var LABELS = {
    bg: "Background", bg2: "Surface", bg3: "Raised", bg4: "Highest",
    fg: "Text", fg2: "Text muted", fg3: "Text faint",
    line: "Borders", accent: "Accent", "accent-fg": "On accent",
    "accent-soft": "Accent wash", ok: "Live"
  };

  function t(id, name, dark, c) {
    return { id: id, name: name, dark: dark, tokens: {
      bg: c[0], bg2: c[1], bg3: c[2], bg4: c[3],
      fg: c[4], fg2: c[5], fg3: c[6], line: c[7],
      accent: c[8], "accent-fg": c[9], "accent-soft": c[10], ok: c[11]
    }};
  }

  var PRESETS = [
    // The two defaults — these must stay in step with the base tokens in styles.css.
    t("radial-light", "Radial Light", false, ["#ffffff","#f5f5f3","#ebebe8","#e0e0dc","#121211","#5c5c57","#90908a","#dededa","#cc5500","#ffffff","#fdece0","#1f9d64"]),
    t("radial-dark",  "Radial Dark",  true,  ["#0d0d0f","#16161a","#1f1f24","#2b2b32","#f2f2f0","#a3a39c","#6e6e68","#2a2a30","#ff8a3d","#1c0d03","#2e1708","#3dd68c"]),

    t("carbon",   "Carbon",   true,  ["#0b0e11","#12171c","#1a2129","#253039","#e6edf3","#9aa8b4","#66757f","#232c35","#29d3c4","#04211f","#0d2b2a","#3fbf7f"]),
    t("terminal", "Terminal", true,  ["#05080a","#0a1013","#10191d","#1a262b","#c8f5d4","#7fbf94","#4d8060","#16232a","#35ff7a","#01180a","#0a2a15","#35ff7a"]),
    t("frost",    "Frost",    true,  ["#1e242e","#262d3a","#313a48","#3f4a5a","#e6ecf3","#a8b4c4","#718094","#364052","#7fb3e0","#10202e","#24344a","#8fce8f"]),
    t("orchid",   "Orchid",   true,  ["#1a1626","#221d33","#2c2542","#3a3155","#eee6ff","#b3a6cc","#7d7196","#322a49","#ff79c6","#260f1e","#34203a","#59e6a0"]),
    t("ember",    "Ember",    true,  ["#14100e","#1c1714","#26201b","#352c24","#f5ece4","#b8a496","#806f62","#2c2520","#ff7a33","#1c0d03","#33190a","#7ecb6b"]),
    t("matcha",   "Matcha",   true,  ["#12160f","#191e15","#22291d","#2e3728","#e8f0e2","#a6b39c","#71806a","#262e21","#9bd35a","#10190a","#1f2a14","#9bd35a"]),
    t("mono",     "Mono",     true,  ["#0f0f0f","#171717","#202020","#2e2e2e","#f0f0f0","#a0a0a0","#6e6e6e","#2a2a2a","#ffffff","#0f0f0f","#262626","#b8b8b8"]),

    t("paper",  "Paper",  false, ["#fbf7ef","#f3ede1","#eae2d2","#ded4c0","#2b241c","#6b5f4f","#9b8e7c","#e0d7c6","#b5442b","#fff8f0","#f6e2da","#4d7c3f"]),
    t("solar",  "Solar",  false, ["#fdf6e3","#f5ecd6","#ece1c6","#ded2b4","#3b3223","#6f6449","#9c9072","#e3d7bb","#c07a00","#fff9ec","#f8e9c8","#6b8e23"]),
    t("rose",   "Rose",   false, ["#fff7f9","#fbecf0","#f5e0e7","#ecccd7","#2c1f25","#6b5560","#9c8791","#f0dae1","#c2185b","#fff5f8","#fadfe8","#2e7d4f"]),
    t("slate",  "Slate",  false, ["#f7f8fa","#eef0f4","#e3e7ed","#d3d9e2","#1b1f26","#545c69","#8b95a3","#dfe3ea","#2563eb","#ffffff","#dfe8fd","#15803d"])
  ];

  /* ------------------------------------------------------------ share codes */

  function hex(v) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(v || "").trim());
    return m ? m[1].toLowerCase() : "000000";
  }
  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64url(str) {
    var s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // [version][dark][12 x RGB][nameLen][name] -> base64url, about 60 characters.
  function encode(theme) {
    var out = [1, theme.dark ? 1 : 0];
    TOKENS.forEach(function (k) {
      var h = hex(theme.tokens[k]);
      out.push(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
    });
    var name = new TextEncoder().encode((theme.name || "Custom").slice(0, 24));
    out.push(name.length);
    for (var i = 0; i < name.length; i++) out.push(name[i]);
    return b64url(new Uint8Array(out));
  }

  function decode(code) {
    var b;
    try { b = unb64url(String(code).trim().replace(/^(radial|radium):/i, "")); }   // radium: kept for codes shared under the old name
    catch (e) { return null; }
    if (b.length < 2 + 36 + 1 || b[0] !== 1) return null;

    var tokens = {}, p = 2;
    for (var i = 0; i < TOKENS.length; i++) {
      tokens[TOKENS[i]] = "#" +
        [b[p], b[p + 1], b[p + 2]].map(function (n) {
          return n.toString(16).padStart(2, "0");
        }).join("");
      p += 3;
    }
    var len = b[p++];
    var name = "Custom";
    if (len && p + len <= b.length) {
      try { name = new TextDecoder().decode(b.slice(p, p + len)) || "Custom"; } catch (e) {}
    }
    return { id: "custom", name: name, dark: !!b[1], tokens: tokens };
  }

  /* ----------------------------------------------------------------- fonts */

  // Each option sets both faces so the pairing stays coherent. `google` is the
  // fonts.googleapis.com family string, loaded on demand; omit it for faces that
  // need no download.
  //
  // OCR-B is not on any font CDN — the only free cut is a download, not a webfont —
  // so it is offered as a local face with the closest webfont behind it. Anyone who
  // has OCR-B installed gets the real thing; everyone else gets Share Tech Mono.
  var FONTS = [
    { id: "archivo", name: "Archivo",  google: "Archivo:wght@400;500;600;700&family=Archivo+Mono:wght@400;500",
      ui: "Archivo, system-ui, sans-serif", mono: "'Archivo Mono', ui-monospace, monospace" },
    { id: "ocrb", name: "OCR-B", google: "Share+Tech+Mono",
      ui: "'OCR B Std','OCRB','OCR-B','OCR B','Share Tech Mono',ui-monospace,monospace",
      mono: "'OCR B Std','OCRB','OCR-B','OCR B','Share Tech Mono',ui-monospace,monospace" },
    { id: "plex", name: "IBM Plex", google: "IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500",
      ui: "'IBM Plex Sans', system-ui, sans-serif", mono: "'IBM Plex Mono', ui-monospace, monospace" },
    { id: "space", name: "Space", google: "Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700",
      ui: "'Space Grotesk', system-ui, sans-serif", mono: "'Space Mono', ui-monospace, monospace" },
    { id: "jetbrains", name: "JetBrains", google: "Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500",
      ui: "Inter, system-ui, sans-serif", mono: "'JetBrains Mono', ui-monospace, monospace" },
    { id: "system", name: "System", google: "",
      ui: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", mono: "ui-monospace, SFMono-Regular, Menlo, monospace" }
  ];

  window.RADIAL_THEMES = {
    FONTS: FONTS,
    fontById: function (id) {
      for (var i = 0; i < FONTS.length; i++) if (FONTS[i].id === id) return FONTS[i];
      return FONTS[0];
    },
    TOKENS: TOKENS, LABELS: LABELS, PRESETS: PRESETS,
    encode: encode, decode: decode,
    byId: function (id) {
      for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
      return null;
    }
  };
})();
