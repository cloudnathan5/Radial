#!/usr/bin/env python3
"""Radial app icons.

The mark is the radiation trefoil with each blade drawn as wifi arcs instead of a
solid wedge — three fans at 120 degrees around a central hub.

Run from the repo root:  python3 icons/generate.py
Requires Pillow.
"""
from PIL import Image, ImageDraw
import math, os

ACCENT = (204, 85, 0, 255)       # --accent
WHITE = (255, 255, 255, 255)
SS = 4                           # supersample, then downsample for clean edges

BLADES = (-90, 30, 150)          # 120 apart, one pointing straight up

def draw(size, scale=1.0, shape="circle", arcs=3, span=52, fg=WHITE, bg=ACCENT):
    """shape="circle" for icons shown as-is, "square" for ones the OS masks itself.

    A circle sits better among the round icons most Linux docks use, and it degrades
    gracefully everywhere else — a circular icon inside a squircle mask still reads
    as a circle, whereas a rounded square inside a circular mask gets its corners
    clipped. The maskable and Apple variants stay full-bleed square: those platforms
    apply their own mask and expect to be given the whole tile.
    """
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if shape == "circle":
        d.ellipse([0, 0, S - 1, S - 1], fill=bg)
    else:
        d.rectangle([0, 0, S, S], fill=bg)       # maskable: the OS supplies the mask

    cx = cy = S / 2
    w   = S * 0.072 * scale
    hub = S * 0.088 * scale
    radii = [S * r * scale for r in ([0.215, 0.315, 0.415] if arcs == 3 else [0.25, 0.38])]

    d.ellipse([cx - hub, cy - hub, cx + hub, cy + hub], fill=fg)

    # Flat radial cuts at each arc end, matching the straight edges of the
    # radiation trefoil. Pillow's arc already ends square, so nothing is added.
    for ang in BLADES:
        a0, a1 = ang - span / 2, ang + span / 2
        for r in radii:
            d.arc([cx - r, cy - r, cx + r, cy + r], a0, a1, fill=fg, width=int(round(w)))

    return img.resize((size, size), Image.LANCZOS)

here = os.path.dirname(os.path.abspath(__file__))
out = lambda n: os.path.join(here, n)

# Slightly reduced so the blades keep a margin from the circle's edge, which sits
# closer than a rounded square's corners did.
draw(192, scale=0.92).save(out("icon-192.png"))
draw(512, scale=0.92).save(out("icon-512.png"))
# maskable: keep the mark inside the centre 80% safe zone
draw(192, scale=0.78, shape="square").save(out("icon-maskable-192.png"))
draw(512, scale=0.78, shape="square").save(out("icon-maskable-512.png"))
draw(180, scale=0.94, shape="square").save(out("apple-touch-icon.png"))
draw(32, scale=0.92, arcs=2).save(out("favicon-32.png"))
print("wrote 6 icons to", here)
