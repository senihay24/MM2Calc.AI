"""Make game-like test screenshots with known items and counts.

usage: python tests/make_screenshots.py <site_dir> <out_dir>
Writes shot_*.png and truth.json ({shot: [[item_id, count], ...] in reading order}).
"""
import json
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

site, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
values = json.loads((site / "data/values.json").read_text())
items = [i for i in values["items"] if i.get("image")]
rnd = random.Random(21)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
RARITY = [(120, 40, 160), (200, 40, 40), (40, 110, 200), (60, 160, 70), (210, 150, 30)]


def slot(item, size, count, style):
    if style == "none":
        im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    else:
        top = rnd.choice(RARITY)
        im = Image.new("RGBA", (size, size))
        d = ImageDraw.Draw(im)
        for y in range(size):
            k = y / size
            d.line([(0, y), (size, y)], fill=tuple(int(c * (1 - 0.55 * k) + 12 * k) for c in top) + (255,))
        if style == "framed":
            d.rectangle([0, 0, size - 1, size - 1], outline=(225, 225, 235, 255), width=3)
    art = Image.open(site / item["image"]).convert("RGBA")
    s = rnd.uniform(0.62, 0.78) * size / max(art.size)
    art = art.resize((max(1, int(art.width * s)), max(1, int(art.height * s))), Image.LANCZOS)
    im.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2 - size // 14))
    if count > 1:
        d = ImageDraw.Draw(im)
        f = ImageFont.truetype(FONT, max(12, size // 6))
        txt = f"x{count}"
        tw = d.textlength(txt, font=f)
        d.text((size - tw - size * 0.07, size * 0.74), txt, font=f, fill=(255, 255, 255, 255),
               stroke_width=2, stroke_fill=(0, 0, 0, 255))
    return im


def make(name, cols, rows, size, gap, style, page=(30, 31, 40), title=True, button=True):
    picks = rnd.sample(items, cols * rows)
    counts = [rnd.choice([1, 1, 1, 2, 3, 5, 12]) for _ in picks]
    W = 40 + cols * size + (cols - 1) * gap + 40
    H = (70 if title else 30) + rows * size + (rows - 1) * gap + (90 if button else 40)
    im = Image.new("RGBA", (W, H), page + (255,))
    d = ImageDraw.Draw(im)
    if title:
        d.text((40, 22), "Your Offer", font=ImageFont.truetype(FONT, 26), fill=(240, 240, 240, 255))
    oy = 70 if title else 30
    for r in range(rows):
        for c in range(cols):
            k = r * cols + c
            im.alpha_composite(slot(picks[k], size, counts[k], style), (40 + c * (size + gap), oy + r * (size + gap)))
    if button:
        by = oy + rows * size + (rows - 1) * gap + 25
        d.rounded_rectangle([W // 2 - 90, by, W // 2 + 90, by + 46], 10, fill=(60, 180, 90, 255))
        d.text((W // 2 - 42, by + 9), "Accept", font=ImageFont.truetype(FONT, 24), fill=(255, 255, 255, 255))
    im = im.convert("RGB").filter(ImageFilter.GaussianBlur(0.4))
    im.save(out / f"{name}.png")
    return [[p["id"], n] for p, n in zip(picks, counts)]


truth = {
    "shot_trade_gaps": make("shot_trade_gaps", 4, 2, 110, 10, "plain"),
    "shot_inventory_touching": make("shot_inventory_touching", 5, 3, 96, 0, "framed", title=False),
    "shot_no_slots": make("shot_no_slots", 4, 2, 120, 14, "none", button=False),
    "shot_big_phone": make("shot_big_phone", 3, 3, 230, 18, "framed"),
}
(out / "truth.json").write_text(json.dumps(truth))
print({k: len(v) for k, v in truth.items()})
