"""Serve a test copy of the site with fixture data, then check in a real
browser: page loads, search works, adding items totals correctly, and picture
matching finds items placed on game-like slot backgrounds.

usage: python tests/browser_test.py <site_dir> <fixtures_dir> <out_dir>
"""
import base64
import functools
import http.server
import io
import json
import random
import sys
import threading
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter
from playwright.sync_api import sync_playwright

site, fx, out = map(Path, sys.argv[1:4])
out.mkdir(parents=True, exist_ok=True)
random.seed(3)

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(site))
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8765), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

values = json.loads((site / "data/values.json").read_text())
items = [it for it in values["items"] if it.get("image")]


def fake_slot(item_png: Path, size=150):
    """Put an item picture on an MM2-style slot: gradient + border + 'x3' text, jpeg'd."""
    top = random.choice([(60, 20, 90), (25, 60, 110), (110, 30, 30), (40, 40, 48)])
    bg = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(bg)
    for y in range(size):
        k = y / size
        d.line([(0, y), (size, y)], fill=tuple(int(c * (1 - 0.5 * k) + 15 * k) for c in top))
    d.rectangle([0, 0, size - 1, size - 1], outline=(200, 200, 210), width=4)
    it = Image.open(item_png).convert("RGBA")
    s = random.uniform(0.75, 0.95) * size / max(it.size)
    it = it.resize((int(it.width * s), int(it.height * s)), Image.LANCZOS)
    ox = (size - it.width) // 2 + random.randint(-6, 6)
    oy = (size - it.height) // 2 + random.randint(-6, 6)
    bg.paste(it, (ox, oy), it)
    d.text((size - 28, size - 20), "x3", fill=(255, 255, 255))
    bg = bg.filter(ImageFilter.GaussianBlur(0.6))
    buf = io.BytesIO()
    bg.save(buf, "JPEG", quality=70)
    return buf.getvalue()


results = {"top1": 0, "top5": 0, "n": 0}
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 420, "height": 900}, device_scale_factor=2)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("http://127.0.0.1:8765/index.html")
    page.wait_for_function("document.getElementById('status').textContent.includes('items')")
    print("status:", page.inner_text("#status"))

    # Search + add
    page.fill("#search", "godly item 1")
    page.wait_for_selector("#searchResults .cand")
    first = page.inner_text("#searchResults .cand .nm")
    page.click("#searchResults .cand")
    page.fill("#addQty", "3")
    page.click("#addBtn")
    it = next(i for i in values["items"] if i["name"] == first)
    total = page.inner_text("#total")
    exp = f"{it['value'] * 3:,}" if it["value"] is not None else "0"
    print(f"search add: {first} x3 -> total {total} (expected {exp})")
    assert total == exp, "total mismatch"

    # Picture matching: feed fake slot screenshots through the real UI code.
    page.evaluate("""() => { window.__prep = MM2Match; }""")
    sample = random.sample(items, min(60, len(items)))
    for k, it in enumerate(sample):
        png = fake_slot(site / it["image"])
        b64 = base64.b64encode(png).decode()
        ids = page.evaluate("""async ([b64]) => {
            const img = new Image();
            img.src = "data:image/jpeg;base64," + b64;
            await img.decode();
            if (!window.__refs) {
              const vals = await (await fetch('data/values.json')).json();
              window.__refs = [];
              for (const it of vals.items) {
                if (!it.image) continue;
                const r = new Image(); r.src = it.image; await r.decode();
                const px = MM2Match.pixelsFrom(r, 0, 0, r.naturalWidth, r.naturalHeight, 128);
                window.__refs.push([it.id, MM2Match.fingerprint(px.data, px.w, px.h, 'ref')]);
              }
            }
            const px = MM2Match.pixelsFrom(img, 0, 0, img.naturalWidth, img.naturalHeight, 160);
            const q = MM2Match.fingerprint(px.data, px.w, px.h, 'query');
            return window.__refs.map(([id, fp]) => [id, MM2Match.compare(q, fp)])
              .sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);
        }""", [b64])
        results["n"] += 1
        results["top1"] += ids[0] == it["id"]
        results["top5"] += it["id"] in ids
        if k == 0:
            (out / "sample_slot.jpg").write_bytes(png)
    print(f"matching: top-1 {results['top1']}/{results['n']}, top-5 {results['top5']}/{results['n']}")

    # Full UI flow with a "screenshot" made of 3 slots side by side
    slots = [Image.open(io.BytesIO(fake_slot(site / i["image"]))) for i in sample[:3]]
    shot = Image.new("RGB", (3 * 160 + 10, 180), (20, 20, 26))
    for i, s in enumerate(slots):
        shot.paste(s, (10 + i * 160, 15))
    shot_path = out / "inventory_shot.png"
    shot.save(shot_path)
    page.set_input_files("#file", str(shot_path))
    page.wait_for_selector("#shotArea:not([hidden])")
    # drag a box around the middle slot
    bb = page.locator("#shot").bounding_box()
    sx = bb["width"] / shot.width
    page.mouse.move(bb["x"] + 168 * sx, bb["y"] + 13 * sx)
    page.mouse.down()
    page.mouse.move(bb["x"] + 250 * sx, bb["y"] + 100 * sx, steps=5)
    page.mouse.move(bb["x"] + 332 * sx, bb["y"] + 167 * sx, steps=5)
    page.mouse.up()
    page.locator(".canvas-wrap").screenshot(path=str(out / "crop_box.png"))
    page.click("#findBtn")
    page.wait_for_selector("#candidates .cand", timeout=30000)
    best = page.inner_text("#candidates .cand.best .nm")
    print("candidates:", page.eval_on_selector_all("#candidates .cand .nm", "els => els.map(e => e.textContent)"))
    print("box:", page.evaluate("document.getElementById('shot').width"))
    print(f"UI crop flow: expected {sample[1]['name']}, best match {best}")
    page.click("#candidates .cand.best")
    page.click("#addBtn")
    page.screenshot(path=str(out / "phone_view.png"), full_page=True)
    print("page errors:", errors or "none")
    browser.close()
srv.shutdown()
