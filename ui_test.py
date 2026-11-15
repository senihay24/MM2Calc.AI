"""End-to-end check of the website in Chrome: scan -> list -> chat filters -> picker.

usage: python tests/ui_test.py <site_dir> <shots_dir> <out_dir>
"""
import http.server
import json
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

site, shots, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(site), **k)

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8773), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
values = {i["id"]: i for i in json.loads((site / "data/values.json").read_text())["items"]}

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 400, "height": 860}, device_scale_factor=2)
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8773/index.html")
    pg.wait_for_selector(".msg.bot")

    pg.set_input_files("#file", str(shots / "shot_inventory_touching.png"))
    pg.wait_for_function("document.querySelectorAll('.msg.bot').length >= 2", timeout=60000)
    print("scan msg:", pg.inner_text("#scanMsg"))
    print("bot:", pg.locator(".msg.bot").last.inner_text())

    def state():
        return pg.evaluate("""() => { const s = JSON.parse(localStorage.getItem('mm2calc.state.v2'));
            return s; }""")

    def expected_total(st):
        f = st["filters"]
        t = 0
        for r in st["rows"]:
            it = values[r["id"]]
            if it["value"] is None or r["id"] in f["excludeItems"] or it["category"] in f["excludeCats"]:
                continue
            if f["onlyCats"] and it["category"] not in f["onlyCats"]:
                continue
            t += it["value"] * r["qty"]
        return t

    def check(label):
        st = state()
        shown = int(pg.inner_text("#total").replace(",", ""))
        exp = expected_total(st)
        print(f"{label}: total shown {shown:,}, expected {exp:,}, rows {len(st['rows'])}, filters {st['filters']}")
        assert shown == exp, label

    check("after scan")
    pg.screenshot(path=str(out / "ui_after_scan.png"), full_page=True)

    for cmd in ["ignore chromas", "only count godlies and ancients", "count everything", "ignore pets and uncommons", "top 3", "breakdown"]:
        pg.fill("#chatInput", cmd)
        pg.press("#chatInput", "Enter")
        pg.wait_for_timeout(150)
        print(f"  > {cmd}\n    {pg.locator('.msg.bot').last.inner_text()[:160]!r}")
        check(f"after '{cmd}'")

    # chip removal
    pg.locator("#chips .chip").first.click()
    check("after removing a chip")

    # picker: change first row's item
    pg.locator(".inv-row .nm").first.click()
    pg.wait_for_selector("#picker:not([hidden])")
    pg.screenshot(path=str(out / "ui_picker.png"))
    pg.locator("#pickerAlts .cand").nth(1).click()
    check("after changing an item")

    # add a second screenshot
    n_before = pg.locator(".msg.bot").count()
    pg.set_input_files("#file", str(shots / "shot_trade_gaps.png"))
    pg.wait_for_function(f"document.querySelectorAll('.msg.bot').length > {n_before}", timeout=60000)
    print("second scan:", pg.inner_text("#scanMsg"))
    check("after second scan")
    pg.fill("#chatInput", "undo")
    pg.press("#chatInput", "Enter")
    check("after undo")

    pg.screenshot(path=str(out / "ui_final.png"), full_page=True)
    print("page errors:", errs or "none")
    b.close()
srv.shutdown()
