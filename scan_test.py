"""Run the real scan code (detect + match + OCR) in Chrome on test screenshots.

usage: python tests/scan_test.py <site_dir> <shots_dir> [--no-ocr]
"""
import functools
import http.server
import json
import shutil
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

site, shots = Path(sys.argv[1]), Path(sys.argv[2])
use_ocr = "--no-ocr" not in sys.argv
shutil.copytree(shots, site / "_shots", dirs_exist_ok=True)
(site / "_test.html").write_text("""<!DOCTYPE html><html><body>
<script src="match.js"></script><script src="detect.js"></script>
<script src="ocr.js"></script><script src="scan.js"></script></body></html>""")

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(site), **k)

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8770), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
truth = json.loads((shots / "truth.json").read_text())

JS = """async ([name, useOcr]) => {
  if (!window.__refs) {
    const v = await (await fetch('data/values.json')).json();
    window.__refs = new Map();
    for (const it of v.items) { if (!it.image) continue;
      const r = new Image(); r.src = it.image; await r.decode();
      const px = MM2Match.pixelsFrom(r, 0, 0, r.naturalWidth, r.naturalHeight, 128);
      window.__refs.set(it.id, MM2Match.fingerprint(px.data, px.w, px.h, 'ref')); }
  }
  const img = new Image(); img.src = '_shots/' + name + '.png'; await img.decode();
  const t0 = performance.now();
  const v = await (await fetch('data/values.json')).json();
  const out = await MM2Scan.scanImage(img, v.items, window.__refs, {readText: useOcr});
  const res = out.found.map(f => ({id: f.id, count: f.count, alts: f.alts.map(id => ({id})), score: f.sure ? 1 : 0}));
  return {ms: Math.round(performance.now() - t0), boxes: MM2Detect.detectSlots(img).length,
    rows: res.map(r => [r.id, r.count, r.alts.slice(0,5).map(a => a.id), +r.score.toFixed(3)])};
}"""

tot = {"slots": 0, "found": 0, "top1": 0, "top5": 0, "count_ok": 0, "extra": 0}
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8770/_test.html")
    for name, exp in truth.items():
        r = pg.evaluate(JS, [name, use_ocr])
        rows = r["rows"]
        n = len(exp)
        top1 = sum(1 for (eid, _), row in zip(exp, rows) if row[0] == eid) if len(rows) == n else None
        top5 = sum(1 for (eid, _), row in zip(exp, rows) if eid in row[2]) if len(rows) == n else None
        cnt = sum(1 for (_, ec), row in zip(exp, rows) if row[1] == ec) if len(rows) == n else None
        print(f"{name}: slots {n}, detected {r['boxes']}, kept {len(rows)}, top1 {top1}, top5 {top5}, counts {cnt}, {r['ms']} ms")
        if len(rows) == n:
            bad = [(i, ec, row[1]) for i, ((_, ec), row) in enumerate(zip(exp, rows)) if row[1] != ec]
            if bad:
                print("   count misses (slot, expected, read):", bad)
        if len(rows) != n:
            print("   scores:", [row[3] for row in rows])
        tot["slots"] += n; tot["found"] += len(rows)
        if top1 is not None:
            tot["top1"] += top1; tot["top5"] += top5; tot["count_ok"] += cnt
    print("TOTAL", tot, "errors:", errs[:5] or "none")
    b.close()
srv.shutdown()
