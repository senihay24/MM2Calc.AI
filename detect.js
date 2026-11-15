/*
 * Finds the item slots in an MM2 inventory / trade screenshot.
 *
 *  1. Learn the page background from the screenshot's edges and flood-fill it
 *     away. What's left are "islands": item slots plus other UI (title text,
 *     buttons, avatars).
 *  2. Filled, roughly square islands of a common size are slots. Tiny or
 *     odd-sized ones (letters, buttons) are ignored.
 *  3. A big filled island that is really a grid of touching slots is split up
 *     by finding the repeating slot borders inside it.
 *  4. When slots blend into the page (dark slot on a dark page), the items
 *     themselves are islands. Nearby pieces are merged first (an item with
 *     gaps in it is still one item), then boxed with a little padding.
 *
 * detectSlots(img) -> [{x, y, w, h}] in the image's own pixels, reading order.
 */
(function (global) {
  "use strict";

  const MAX_SIDE = 1000;

  function getPixels(img) {
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    const s = Math.min(1, MAX_SIDE / Math.max(W, H));
    const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, w, h, scale: s };
  }

  function backgroundMask(data, w, h) {
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
    const buckets = new Map();
    let total = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x >= band && y >= band && x < w - band && y < h - band) continue;
      const i = (y * w + x) * 4;
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      let b = buckets.get(key);
      if (!b) { b = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, b); }
      b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2]; total++;
    }
    const palette = [...buckets.values()].filter((b) => b.n >= total * 0.01)
      .sort((a, b) => b.n - a.n).slice(0, 12)
      .map((b) => [b.r / b.n, b.g / b.n, b.b / b.n]);
    const T2 = 22 * 22;
    const near = (i) => {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      for (const p of palette) {
        const dr = r - p[0], dg = g - p[1], db = b - p[2];
        if (dr * dr + dg * dg + db * db < T2) return true;
      }
      return false;
    };
    const bg = new Uint8Array(w * h);
    const stack = [];
    const seed = (i) => { if (!bg[i] && near(i)) { bg[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (stack.length) {
      const i = stack.pop(), x = i % w;
      if (x > 0) seed(i - 1);
      if (x < w - 1) seed(i + 1);
      if (i >= w) seed(i - w);
      if (i < w * (h - 1)) seed(i + w);
    }
    return bg;
  }

  /** Islands of mask==0 pixels. Returns boxes with area and fill ratio. */
  function islands(mask, w, h) {
    const label = new Int32Array(w * h);
    const out = [];
    for (let s = 0; s < w * h; s++) {
      if (mask[s] || label[s]) continue;
      const id = out.length + 1;
      let n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      const st = [s]; label[s] = id;
      while (st.length) {
        const i = st.pop(), x = i % w, y = (i - x) / w;
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && !mask[i - 1] && !label[i - 1]) { label[i - 1] = id; st.push(i - 1); }
        if (x < w - 1 && !mask[i + 1] && !label[i + 1]) { label[i + 1] = id; st.push(i + 1); }
        if (y > 0 && !mask[i - w] && !label[i - w]) { label[i - w] = id; st.push(i - w); }
        if (y < h - 1 && !mask[i + w] && !label[i + w]) { label[i + w] = id; st.push(i + w); }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      out.push({ x: x0, y: y0, w: bw, h: bh, area: n, fill: n / (bw * bh) });
    }
    return out;
  }

  /** Grow the foreground (mask==0) by r pixels so nearby pieces join up. */
  function dilateFg(bg, w, h, r) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let last = -1e9;
      for (let x = 0; x < w; x++) { if (!bg[y * w + x]) last = x; if (x - last <= r) tmp[y * w + x] = 1; }
      last = 1e9;
      for (let x = w - 1; x >= 0; x--) { if (!bg[y * w + x]) last = x; if (last - x <= r) tmp[y * w + x] = 1; }
    }
    for (let x = 0; x < w; x++) {
      let last = -1e9;
      for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
      last = 1e9;
      for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
    }
    for (let i = 0; i < w * h; i++) out[i] = out[i] ? 0 : 1; // back to "1 = background"
    return out;
  }

  /*
   * Slot borders inside a block repeat at a fixed step. For each column (or
   * row) measure how much of it is a strong edge: slot borders are edges along
   * their whole length, item outlines aren't. Then find the step whose "comb"
   * of positions lines up with the strongest edges.
   */
  function gridStep(data, w, box, vertical, minStep) {
    const len = vertical ? box.w : box.h, across = vertical ? box.h : box.w;
    const prof = new Float32Array(len);
    for (let a = 1; a < len; a++) {
      let n = 0;
      for (let b = 0; b < across; b++) {
        const x = vertical ? box.x + a : box.x + b, y = vertical ? box.y + b : box.y + a;
        const px = vertical ? x - 1 : x, py = vertical ? y : y - 1;
        const i = (y * w + x) * 4, j = (py * w + px) * 4;
        const d = Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]);
        if (d > 60) n++;
      }
      prof[a] = n / across;
    }
    const sm = new Float32Array(len); // merge 1-2px wide lines
    for (let a = 0; a < len; a++) sm[a] = Math.max(prof[a], a ? prof[a - 1] : 0, a + 1 < len ? prof[a + 1] : 0);
    // Only look inside the block: its own outer edges say nothing about a grid.
    const lo = 4, hi = len - 4;
    if (hi - lo < minStep) return 0;
    let mean = 0; for (let a = lo; a < hi; a++) mean += sm[a]; mean /= hi - lo;
    if (mean <= 0) return 0;
    let best = 0, bestStep = 0;
    for (let step = Math.round(minStep); step <= len / 1.8; step++) {
      const count = len / step;
      if (Math.abs(count - Math.round(count)) > 0.15) continue; // must divide the block evenly
      // Inner borders sit at multiples of the step (from the block's left/top edge).
      let s = 0, k = 0, weakest = 1;
      for (let c = 1; c < Math.round(count); c++) {
        const a = Math.round(c * len / Math.round(count));
        let v = 0;
        for (let d = -2; d <= 2; d++) if (a + d >= lo && a + d < hi) v = Math.max(v, sm[a + d]);
        s += v; k++; weakest = Math.min(weakest, v);
      }
      if (!k) continue;
      const score = s / k / mean;
      // Every inner border must be a long line, clearly stronger than average.
      if (weakest > 0.5 && score > best) { best = score; bestStep = len / Math.round(count); }
    }
    return best > 2 ? bestStep : 0;
  }

  /** True if the shape is mostly white/grey pixels: on-screen text, not an item. */
  function mostlyWhite(data, w, bg, b) {
    let n = 0, white = 0;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
      const p = y * w + x;
      if (bg[p]) continue;
      const i = p * 4, mx = Math.max(data[i], data[i + 1], data[i + 2]), mn = Math.min(data[i], data[i + 1], data[i + 2]);
      n++;
      if ((mx > 190 && mx - mn < 45) || mx < 40) white++; // white text + its dark outline
    }
    return n > 0 && white / n > 0.75;
  }

  function splitGrid(box, cw, ch) {
    const cols = Math.max(1, Math.round(box.w / cw)), rows = Math.max(1, Math.round(box.h / ch));
    const out = [];
    const sw = box.w / cols, sh = box.h / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      out.push({ x: box.x + c * sw, y: box.y + r * sh, w: sw, h: sh });
    }
    return out;
  }

  function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }
  /** Median of the larger values: ignores small junk like letters. */
  function bigMedian(a) {
    if (!a.length) return 0;
    const mx = Math.max(...a);
    return median(a.filter((v) => v >= mx * 0.5));
  }
  const squareish = (b, lo = 0.6) => b.w / b.h > lo && b.w / b.h < 1 / lo;
  const inside = (b, o) => b.x + b.w / 2 >= o.x && b.x + b.w / 2 <= o.x + o.w && b.y + b.h / 2 >= o.y && b.y + b.h / 2 <= o.y + o.h;

  /** Slots from a background mask (1 = background). */
  function slotsFromMask(data, w, h, bg, minSide, allowLoose) {
    const all = islands(bg, w, h);

    // 1+2. Solid islands: either one slot, or a grid of touching slots.
    const solid = all.filter((b) => b.fill > 0.6 && Math.min(b.w, b.h) >= minSide);
    const groups = [];
    for (const b of solid) {
      let cw = gridStep(data, w, b, true, minSide), ch = gridStep(data, w, b, false, minSide);
      if (!cw && ch && b.w / ch > 1.5) cw = ch;            // assume square slots
      if (!ch && cw && b.h / cw > 1.5) ch = cw;
      if (!cw && ch && b.w / ch <= 1.5) cw = b.w;          // a single column
      if (!ch && cw && b.h / cw <= 1.5) ch = b.h;          // a single row
      if (cw && ch && cw / ch > 0.7 && cw / ch < 1.43) {
        const cells = splitGrid(b, cw, ch);
        if (cells.length >= 2) { groups.push({ cells, block: b }); continue; }
      }
      if (squareish(b)) groups.push({ cells: [b], block: b });
    }
    // Typical slot size; drop odd sizes (avatars, buttons, cut-off slots).
    const cells = groups.flatMap((g) => g.cells);
    const refW = bigMedian(cells.map((c) => c.w)), refH = bigMedian(cells.map((c) => c.h));
    const ref = Math.max(refW, refH);
    const fits = (c) => c.w >= refW * 0.8 && c.w <= refW * 1.25 && c.h >= refH * 0.8 && c.h <= refH * 1.25;
    let out = [];
    for (const g of groups) {
      if (g.cells.length > 1 && !fits(g.cells[0]) && fits(g.block)) { out.push(g.block); continue; }
      out.push(...g.cells.filter(fits));
    }
    if (out.length < 2 && groups.length) out = groups.length === 1 ? groups[0].cells : out;

    // 3. items with no visible slot
    const leftovers = allowLoose ? all.filter((b) => !out.some((o) => inside(b, o)) && b.area > 20) : [];
    if (leftovers.length) {
      const r = Math.max(2, Math.round(Math.min(w, h) * 0.012));
      const merged = islands(dilateFg(bg, w, h, r), w, h)
        .map((b) => ({ ...b, x: b.x + r, y: b.y + r, w: b.w - 2 * r, h: b.h - 2 * r }))
        .filter((b) => b.w > 4 && b.h > 4 && !out.some((o) => inside(b, o)));
      const sizes = merged.map((b) => Math.max(b.w, b.h)).filter((v) => v >= minSide * 0.8);
      const lref = out.length >= 2 ? ref : bigMedian(sizes.filter((v) => v < Math.max(w, h) * 0.6));
      for (const b of merged) {
        const side = Math.max(b.w, b.h);
        if (side < Math.max(minSide * 0.8, lref * 0.5) || side > lref * 1.8) continue;
        if (b.w > w * 0.6 || b.h > h * 0.6) continue; // panels / screen edges
        if (!squareish(b, 0.4)) continue; // words and bars are long and thin
        if (mostlyWhite(data, w, bg, b)) continue; // count text like "x12"
        const half = side * 0.58, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        const x0 = Math.max(0, cx - half), y0 = Math.max(0, cy - half);
        out.push({ x: x0, y: y0, w: Math.min(w, cx + half) - x0, h: Math.min(h, cy + half) - y0, loose: true });
      }
    }
    return out;
  }

  /*
   * In the game, the inventory sits on a flat dark panel, with game scenery
   * around it. So besides "background = whatever is at the screenshot's edges"
   * also try "background = one of the most common flat grey colors", and keep
   * whichever finds the most same-sized slots.
   */
  function flatColorMasks(data, w, h) {
    const counts = new Map();
    for (let i = 0; i < w * h; i += 3) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 14) continue; // greys only
      const key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .filter(([, n]) => n * 3 > w * h * 0.03);
    return top.map(([key]) => {
      const c = [((key >> 10) & 31) * 8 + 4, ((key >> 5) & 31) * 8 + 4, (key & 31) * 8 + 4];
      const m = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        if (Math.abs(data[i * 4] - c[0]) <= 7 && Math.abs(data[i * 4 + 1] - c[1]) <= 7 && Math.abs(data[i * 4 + 2] - c[2]) <= 7) m[i] = 1;
      }
      return m;
    });
  }

  function consistency(out) {
    if (!out.length) return 0;
    const loose = out.filter((b) => b.loose).length;
    return out.length - loose * 0.5;
  }

  function detectSlots(img) {
    const { data, w, h, scale } = getPixels(img);
    const minSide = Math.max(28, Math.min(w, h) * 0.05);
    let best = slotsFromMask(data, w, h, backgroundMask(data, w, h), minSide, true);
    for (const m of flatColorMasks(data, w, h)) {
      const cand = slotsFromMask(data, w, h, m, minSide, false);
      if (cand.length >= 3 && consistency(cand) > consistency(best)) best = cand;
    }
    let out = best.map((b) => ({ x: b.x / scale, y: b.y / scale, w: b.w / scale, h: b.h / scale }));
    const rowTol = median(out.map((b) => b.h)) * 0.5 || 10;
    out.sort((a, b) => (Math.abs(a.y - b.y) < rowTol ? a.x - b.x : a.y - b.y));
    return out;
  }

  global.MM2Detect = { detectSlots };
})(typeof window !== "undefined" ? window : globalThis);
