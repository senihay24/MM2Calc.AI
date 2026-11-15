"""Build fake MM2Values-style pages + item pictures for offline testing.

Two different HTML layouts are used on purpose, so the parser is shown to
work without depending on specific class names.
"""
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures")
(OUT / "img").mkdir(parents=True, exist_ok=True)
random.seed(7)

CATS = ["ancient", "unique", "chroma", "godly", "legend", "rare", "uncommon",
        "common", "vintage", "pets", "misc"]
PALETTE = [(220, 40, 40), (40, 160, 220), (250, 200, 30), (130, 60, 200), (40, 190, 90),
           (240, 120, 20), (200, 200, 210), (30, 30, 30), (230, 80, 170), (120, 80, 40)]


def make_item_png(path, seed):
    r = random.Random(seed)
    im = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c1, c2 = r.sample(PALETTE, 2)
    kind = seed % 4
    ang = r.uniform(-0.9, 0.9)
    if kind == 0:  # knife: blade + handle
        pts = [(20, 100), (100 + r.randint(-10, 10), 15 + r.randint(0, 15)), (90, 40), (35, 108)]
        d.polygon(pts, fill=c1 + (255,))
        d.rectangle([10, 98, 40, 120], fill=c2 + (255,))
    elif kind == 1:  # gun
        d.rectangle([15, 40, 110, 62 + r.randint(0, 10)], fill=c1 + (255,))
        d.polygon([(30, 60), (55, 60), (45, 115), (22, 112)], fill=c2 + (255,))
    elif kind == 2:  # pet blob
        d.ellipse([20 + r.randint(0, 10), 30, 108, 110], fill=c1 + (255,))
        d.ellipse([40, 45, 55, 60], fill=c2 + (255,))
        d.ellipse([75, 45, 90, 60], fill=c2 + (255,))
    else:  # star-ish
        n = r.randint(5, 8)
        pts = []
        for k in range(2 * n):
            rad = 55 if k % 2 == 0 else 25
            a = ang + k * math.pi / n
            pts.append((64 + rad * math.cos(a), 64 + rad * math.sin(a)))
        d.polygon(pts, fill=c1 + (255,))
        d.ellipse([52, 52, 76, 76], fill=c2 + (255,))
    # a few detail stripes
    for _ in range(r.randint(1, 4)):
        x = r.randint(20, 100)
        d.line([(x, 20), (x + r.randint(-20, 20), 110)], fill=r.choice(PALETTE) + (255,), width=3)
    # keep stripes only where the shape is
    alpha = im.split()[3]
    base = Image.new("RGBA", im.size, (0, 0, 0, 0))
    im = Image.composite(im, base, alpha.point(lambda a: 255 if a > 0 else 0))
    im.save(path)


NAV = """<nav><a href="?p=home">Home</a> <a href="?p=checker">Trade Checker</a>
<img src="/imgs/HotItemsBanner.png"> <a href="https://discord.gg/x"><img src="/imgs/discord.png"></a></nav>
<div class="hdr">VALUES UPDATED: 11/13/2026 12:19:30pm EST</div>
<p>Value list made by the top traders. Demand is how wanted an item is.</p>"""


def layout_a(items):
    out = [NAV, "<h2>TIER 5</h2>"]
    for it in items:
        out.append(f"""<div class="card"><img src="/img/{it['img']}"><b>{it['name']}</b><br>
Value: {it['value']}<br>Range: {it['range']}<br>Demand: {it['demand']}<br>
Rarity: {it['rarity']}<br>Stability: {it['stab']}<br><a href="#">Wiki</a><br>---</div>""")
    return "<html><body>" + "\n".join(out) + "</body></html>"


def layout_b(items):
    out = [NAV, "<table>"]
    for it in items:
        out.append(f"""<tr><td><img data-src="/img/{it['img']}" src="/img/{it['img']}"></td><td>
<span class="nm"><strong>{it['name']}</strong></span>
<div><b>Value:</b> <span>{it['value']}</span></div><div><b>Range:</b> <span>{it['range']}</span></div>
<div><b>Demand:</b><span>{it['demand']}</span></div><div><b>Rarity:</b><span>{it['rarity']}</span></div>
<div><b>Stability:</b><span>{it['stab']}</span></div></td></tr>""")
    return "<html><body>" + "\n".join(out) + "</table></body></html>"


truth = []
seed = 0
for ci, cat in enumerate(CATS):
    items = []
    for k in range(12 if cat != "misc" else 4):
        seed += 1
        name = f"{cat.title()} Item {k + 1}"
        img = f"{cat}_{k + 1}.png"
        make_item_png(OUT / "img" / img, seed)
        value = random.choice([random.randint(1, 5000), "N/A"]) if k == 3 else random.randint(1, 5000)
        v_str = f"{value:,}" if isinstance(value, int) else value
        items.append(dict(name=name, img=img, value=v_str, range="N/A", demand=random.randint(1, 10),
                          rarity=random.randint(1, 10), stab=random.choice(["Stable", "Doing Well", "Underpaid For"])))
        truth.append((cat, name, value, img))
    html = layout_a(items) if ci % 2 == 0 else layout_b(items)
    (OUT / f"{cat}.html").write_text(html, encoding="utf-8")
(OUT / "home.html").write_text("<html><body>" + NAV + "</body></html>", encoding="utf-8")

import json
(OUT / "truth.json").write_text(json.dumps(truth))
print(f"wrote {len(truth)} items to {OUT}")
