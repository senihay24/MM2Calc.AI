#!/usr/bin/env python3
"""
Sync item values from MM2Values.com into docs/data/values.json.

How it works
------------
1. Loads the MM2Values home page and reads the "VALUES UPDATED: ..." stamp.
2. If that stamp matches the one we saved last time (and we did a full sync
   in the last 24 hours), it stops: nothing changed.
3. Otherwise it loads every category page, reads each item's picture, name,
   value, range, demand, rarity and stability, downloads any new pictures,
   and writes docs/data/values.json.
4. Before saving it runs sanity checks. If the site's layout changed and the
   parser suddenly finds far fewer items, it exits with an error instead of
   overwriting good data, so GitHub emails you that the sync failed.

The parser doesn't depend on MM2Values' HTML class names. It reads the page
as a stream of pictures and text in order, and looks for the
"Value: / Range: / Demand: / Rarity: / Stability:" pattern, so small redesigns
usually don't break it.

Usage:
    python scraper/sync_values.py            # normal run (skips if unchanged)
    python scraper/sync_values.py --force    # always do a full sync
    python scraper/sync_values.py --from-dir tests/fixtures   # offline test
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
import urllib.robotparser
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup, NavigableString, Tag, Comment

BASE = "https://mm2values.com/"
USER_AGENT = "MM2ValueCalculatorSync/1.0 (personal fan project; runs a few times a day)"

# (url parameter, display name). Matches the site's navigation.
CATEGORIES = [
    ("ancient", "Ancient"),
    ("unique", "Unique"),
    ("chroma", "Chroma"),
    ("godly", "Godly"),
    ("legend", "Legendary"),
    ("rare", "Rare"),
    ("uncommon", "Uncommon"),
    ("common", "Common"),
    ("vintage", "Vintage"),
    ("pets", "Pets"),
    ("misc", "Misc"),
]

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"
IMG_DIR = DATA_DIR / "img"
VALUES_FILE = DATA_DIR / "values.json"

FIELD_NAMES = ["value", "range", "demand", "rarity", "stability"]
LABEL_RE = re.compile(r"^(value|range|demand|rarity|stability)\b\s*[:\-]?\s*(.*)$", re.I)
STAMP_RE = re.compile(r"VALUES\s+UPDATED\s*:?\s*([0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4}[^A-Za-z]*?[0-9:]+\s*(?:am|pm)?\s*(?:[A-Z]{2,4})?)", re.I)
TIER_RE = re.compile(r"^tier\s*\d+$", re.I)

# Minimum items for the whole site; below this we assume the layout changed.
MIN_TOTAL_ITEMS = 60
# If a sync finds fewer than this share of last time's items, refuse to save.
MIN_SHARE_OF_PREVIOUS = 0.7
FULL_SYNC_EVERY = dt.timedelta(hours=24)


# --------------------------------------------------------------------------- #
# Fetching
# --------------------------------------------------------------------------- #
class Fetcher:
    def __init__(self, from_dir: Path | None = None, delay: float = 1.5):
        self.from_dir = from_dir
        self.delay = delay
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self._last = 0.0
        self._robots = None

    def _polite_wait(self):
        wait = self.delay - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()

    def allowed(self, url: str) -> bool:
        if self.from_dir:
            return True
        if self._robots is None:
            rp = urllib.robotparser.RobotFileParser()
            try:
                r = self.session.get(urljoin(BASE, "/robots.txt"), timeout=20)
                rp.parse(r.text.splitlines() if r.status_code == 200 else [])
            except requests.RequestException:
                rp.parse([])
            self._robots = rp
        return self._robots.can_fetch(USER_AGENT, url)

    def page(self, param: str) -> str:
        if self.from_dir:
            return (self.from_dir / f"{param}.html").read_text(encoding="utf-8")
        url = f"{BASE}?p={param}"
        if not self.allowed(url):
            raise SystemExit(f"robots.txt on mm2values.com now disallows {url}; stopping.")
        self._polite_wait()
        r = self.session.get(url, timeout=30)
        r.raise_for_status()
        return r.text

    def binary(self, url: str) -> bytes | None:
        if self.from_dir:
            p = self.from_dir / "img" / Path(urlparse(url).path).name
            return p.read_bytes() if p.exists() else None
        if not self.allowed(url):
            return None
        self._polite_wait()
        try:
            r = self.session.get(url, timeout=30)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
                return r.content
        except requests.RequestException:
            pass
        return None


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
def page_text(html: str) -> str:
    return BeautifulSoup(html, "html.parser").get_text(" ", strip=True)


def read_stamp(html: str) -> str | None:
    m = STAMP_RE.search(page_text(html))
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None


def tokenize(html: str, page_url: str) -> list[tuple[str, str]]:
    """Flatten the page into ('img', url) and ('text', line) tokens, in order."""
    soup = BeautifulSoup(html, "html.parser")
    for bad in soup(["script", "style", "noscript", "head"]):
        bad.decompose()
    tokens: list[tuple[str, str]] = []
    for node in soup.descendants:
        if isinstance(node, Comment):
            continue
        if isinstance(node, NavigableString):
            for line in str(node).splitlines():
                line = re.sub(r"\s+", " ", line).strip()
                if line:
                    tokens.append(("text", line))
        elif isinstance(node, Tag) and node.name == "img":
            src = node.get("src") or node.get("data-src") or ""
            if src:
                tokens.append(("img", urljoin(page_url, src)))
    return merge_labels(tokens)


def merge_labels(tokens):
    """Join 'Value:' + '4,600' when the label and number are separate elements."""
    out = []
    i = 0
    while i < len(tokens):
        kind, val = tokens[i]
        if kind == "text":
            m = LABEL_RE.match(val)
            if m and not m.group(2).strip() and i + 1 < len(tokens) and tokens[i + 1][0] == "text" \
                    and not LABEL_RE.match(tokens[i + 1][1]):
                out.append(("text", f"{m.group(1)}: {tokens[i + 1][1]}"))
                i += 2
                continue
        out.append((kind, val))
        i += 1
    return out


def is_item_image(url: str) -> bool:
    path = urlparse(url).path.lower()
    if not re.search(r"\.(png|jpe?g|webp|gif)$", path):
        return False
    skip = ("banner", "logo", "discord", "twitter", "youtube", "icon-", "favicon", "hot")
    return not any(s in path for s in skip)


def parse_number(raw: str):
    s = raw.replace(",", "").strip()
    m = re.match(r"^-?\d+(\.\d+)?", s)
    if not m:
        return None
    n = float(m.group(0))
    return int(n) if n.is_integer() else n


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def starts_item(tokens, i) -> bool:
    """True if token i is a 'Value' label followed soon by Demand/Rarity labels."""
    text = tokens[i][1]
    m = LABEL_RE.match(text)
    if not m or m.group(1).lower() != "value":
        return False
    rest = m.group(2).strip()
    # The value itself should be short: "4,600", "N/A", "O/C", "1.5k" etc.
    if len(rest) > 20 or len(rest.split()) > 3:
        return False
    for k, v in tokens[i + 1:i + 9]:
        if k == "text":
            m2 = LABEL_RE.match(v)
            if m2 and m2.group(1).lower() == "value":
                return False
            if m2 and m2.group(1).lower() in ("demand", "rarity", "stability"):
                return True
    return False


def parse_items(html: str, cat_param: str, cat_name: str) -> list[dict]:
    page_url = f"{BASE}?p={cat_param}"
    tokens = tokenize(html, page_url)
    items = []
    last_img_idx = None
    tier = None
    i = 0
    while i < len(tokens):
        kind, val = tokens[i]
        if kind == "img" and is_item_image(val):
            last_img_idx = i
        elif kind == "text" and TIER_RE.match(val):
            tier = val.upper()
        elif kind == "text" and starts_item(tokens, i):
            # Name: first plain text after the item's picture; otherwise the
            # nearest plain text line before "Value:".
            name = None
            start = last_img_idx + 1 if last_img_idx is not None else max(0, i - 3)
            for j in range(start, i):
                k2, v2 = tokens[j]
                if k2 == "text" and not LABEL_RE.match(v2) and not TIER_RE.match(v2) and v2 != "---":
                    name = v2
                    break
            if name is None:
                for j in range(i - 1, max(-1, i - 4), -1):
                    k2, v2 = tokens[j]
                    if k2 == "text" and not LABEL_RE.match(v2):
                        name = v2
                        break
            fields = {}
            j = i
            while j < len(tokens) and len(fields) < len(FIELD_NAMES):
                k2, v2 = tokens[j]
                if k2 == "img" and j > i:
                    break
                if k2 == "text":
                    m = LABEL_RE.match(v2)
                    if m:
                        key = m.group(1).lower()
                        if key in fields:  # next item's block started
                            break
                        fields[key] = m.group(2).strip()
                j += 1
            img = tokens[last_img_idx][1] if last_img_idx is not None and last_img_idx < i else None
            if name and (img or parse_number(fields.get("value", "")) is not None):
                raw_value = fields.get("value", "")
                items.append({
                    "id": f"{cat_param}-{slugify(name)}",
                    "name": name,
                    "category": cat_name,
                    "tier": tier,
                    "value": parse_number(raw_value),
                    "valueText": raw_value,
                    "range": fields.get("range") or None,
                    "demand": parse_number(fields.get("demand", "")),
                    "rarity": parse_number(fields.get("rarity", "")),
                    "stability": fields.get("stability") or None,
                    "sourceImage": img,
                })
            last_img_idx = None  # each picture belongs to one item
            i = j
            continue
        i += 1

    # De-duplicate ids within the category (same name twice -> suffix)
    seen = {}
    for it in items:
        n = seen.get(it["id"], 0)
        seen[it["id"]] = n + 1
        if n:
            it["id"] = f"{it['id']}-{n + 1}"
    return items


# --------------------------------------------------------------------------- #
# Images
# --------------------------------------------------------------------------- #
def local_image_name(url: str) -> str:
    p = urlparse(url).path
    name = Path(p).name
    folder = Path(p).parent.name  # img / imgs
    return slugify(f"{folder}-{Path(name).stem}") + Path(name).suffix.lower()


def sync_images(items, fetcher: Fetcher, previous: dict) -> int:
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    prev_by_src = {it.get("sourceImage"): it.get("image") for it in previous.get("items", [])}
    downloaded = 0
    for it in items:
        src = it.get("sourceImage")
        if not src:
            it["image"] = None
            continue
        fname = local_image_name(src)
        target = IMG_DIR / fname
        if not target.exists():
            data = fetcher.binary(src)
            if data:
                target.write_bytes(data)
                downloaded += 1
        if target.exists():
            it["image"] = f"data/img/{fname}"
        else:
            it["image"] = prev_by_src.get(src)
    return downloaded


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def load_previous() -> dict:
    if VALUES_FILE.exists():
        try:
            return json.loads(VALUES_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="full sync even if the stamp is unchanged")
    ap.add_argument("--from-dir", type=Path, help="read saved HTML pages from this folder (testing)")
    ap.add_argument("--data-dir", type=Path, help="write values.json + img/ here instead of docs/data")
    args = ap.parse_args()

    global DATA_DIR, IMG_DIR, VALUES_FILE
    if args.data_dir:
        DATA_DIR = args.data_dir
        IMG_DIR = DATA_DIR / "img"
        VALUES_FILE = DATA_DIR / "values.json"

    fetcher = Fetcher(args.from_dir, delay=0 if args.from_dir else 1.5)
    previous = load_previous()

    home = fetcher.page("home")
    stamp = read_stamp(home)
    print(f"Site says values updated: {stamp or '(stamp not found)'}")

    last_full = previous.get("lastFullSync")
    recent_full = False
    if last_full:
        try:
            recent_full = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(last_full) < FULL_SYNC_EVERY
        except ValueError:
            pass

    if (not args.force and stamp and previous.get("siteUpdated") == stamp
            and previous.get("items") and recent_full):
        previous["lastChecked"] = now_iso()
        VALUES_FILE.write_text(json.dumps(previous, indent=1, ensure_ascii=False), encoding="utf-8")
        print("No change on the site since the last sync. Only lastChecked was updated.")
        return 0

    all_items = []
    problems = []
    for param, name in CATEGORIES:
        try:
            html = fetcher.page(param)
        except Exception as e:  # noqa: BLE001
            problems.append(f"{name}: could not load page ({e})")
            continue
        items = parse_items(html, param, name)
        print(f"  {name:<10} {len(items):>4} items")
        if not items and param not in ("misc", "unique"):
            problems.append(f"{name}: found 0 items")
        all_items.extend(items)

    prev_count = len(previous.get("items", []))
    if len(all_items) < MIN_TOTAL_ITEMS:
        problems.append(f"only {len(all_items)} items in total (expected at least {MIN_TOTAL_ITEMS})")
    if prev_count and len(all_items) < prev_count * MIN_SHARE_OF_PREVIOUS:
        problems.append(f"item count dropped from {prev_count} to {len(all_items)}")
    with_value = sum(1 for it in all_items if it["value"] is not None)
    if all_items and with_value < len(all_items) * 0.6:
        problems.append(f"only {with_value} of {len(all_items)} items have a number value")

    if problems:
        print("\nSYNC FAILED - the site's layout may have changed. Old values were kept.")
        for p in problems:
            print("  - " + p)
        return 1

    downloaded = sync_images(all_items, fetcher, previous)

    # Work out what changed, for the "Recent changes" panel in the app.
    prev_vals = {it["id"]: it.get("value") for it in previous.get("items", [])}
    changes = []
    for it in all_items:
        old = prev_vals.get(it["id"])
        if it["id"] in prev_vals and old != it["value"]:
            changes.append({"id": it["id"], "name": it["name"], "from": old, "to": it["value"]})
        elif prev_vals and it["id"] not in prev_vals:
            changes.append({"id": it["id"], "name": it["name"], "from": None, "to": it["value"], "new": True})

    history = previous.get("changeLog", [])
    if changes:
        history.insert(0, {"date": now_iso(), "siteUpdated": stamp, "changes": changes})
    history = history[:15]

    out = {
        "source": "MM2Values.com",
        "sourceUrl": BASE,
        "siteUpdated": stamp,
        "lastFullSync": now_iso(),
        "lastChecked": now_iso(),
        "itemCount": len(all_items),
        "categories": [n for _, n in CATEGORIES],
        "items": all_items,
        "changeLog": history,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    VALUES_FILE.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\nSaved {len(all_items)} items, {downloaded} new pictures, {len(changes)} value changes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
