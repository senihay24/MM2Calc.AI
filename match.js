/*
 * Picture matching for MM2 items.
 *
 * Every item picture from MM2Values (transparent PNG) and every screenshot
 * crop is turned into a small "fingerprint":
 *   - the item's outline (32x32 mask)
 *   - a color histogram of the item's pixels
 *   - an 8x8 grid of average colors
 *   - its width/height ratio
 * Fingerprints are compared and the closest items are returned.
 *
 * Screenshots have a background (the inventory slot), so for crops we guess
 * the background from the colors along the crop's edges and ignore them.
 */
(function (global) {
  "use strict";

  const N = 32;          // mask resolution
  const G = 8;           // color grid resolution
  const HUE_BINS = 18;
  const GRAY_BINS = 6;

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, max ? d / max : 0, max];
  }

  /** Decide which pixels belong to the item. Returns Uint8Array (1 = item). */
  function foreground(data, w, h, mode) {
    const fg = new Uint8Array(w * h);
    if (mode === "ref") {
      let any = 0;
      for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] > 100) { fg[i] = 1; any++; }
      if (!any) fg.fill(1);
      return fg;
    }
    // Screenshot crop. 1) Learn the background colors from a band around the
    // edges (slot frame + slot background). 2) Flood-fill from the edges
    // through pixels of those colors: that connected area is background.
    // Item pixels that happen to share a background color but sit inside the
    // item are not reached by the fill, so they stay part of the item.
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.12));
    const buckets = new Map();
    let bandCount = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x >= band && y >= band && x < w - band && y < h - band) continue;
        const i = (y * w + x) * 4;
        const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
        let b = buckets.get(key);
        if (!b) { b = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, b); }
        b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
        bandCount++;
      }
    }
    const sortedB = [...buckets.values()].filter((b) => b.n >= bandCount * 0.02).sort((a, b) => b.n - a.n);
    const palette = sortedB.slice(0, 16).map((b) => [b.r / b.n, b.g / b.n, b.b / b.n]);
    // A flat background (like MM2's grey slots) only needs a tight match, so
    // dull-colored items (grey/blue knives) aren't mistaken for background.
    const flat = sortedB.length && sortedB[0].n >= bandCount * 0.45;
    const T2 = flat ? 18 * 18 : 40 * 40;
    // Blends of two background colors (anti-aliased frame edges, gradients)
    // also count as background.
    const segs = [];
    for (let a = 0; a < palette.length; a++) for (let b = a + 1; b < palette.length; b++) {
      const p = palette[a], q = palette[b];
      const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      if (len2 > 0) segs.push([p, d, len2]);
    }
    const bgLike = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], bl = data[i * 4 + 2];
      let hit = false;
      for (const p of palette) {
        const dr = r - p[0], dg = g - p[1], db = bl - p[2];
        if (dr * dr + dg * dg + db * db < T2) { hit = true; break; }
      }
      if (!hit) {
        for (const [p, d, len2] of segs) {
          const vr = r - p[0], vg = g - p[1], vb = bl - p[2];
          let t = (vr * d[0] + vg * d[1] + vb * d[2]) / len2;
          if (t < 0 || t > 1) continue;
          const er = vr - t * d[0], eg = vg - t * d[1], eb = vb - t * d[2];
          if (er * er + eg * eg + eb * eb < T2 * 0.5) { hit = true; break; }
        }
      }
      if (hit) bgLike[i] = 1;
    }
    const isBg = new Uint8Array(w * h);
    const stack = [];
    const seed = (x, y) => { const i = y * w + x; if (bgLike[i] && !isBg[i]) { isBg[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
    for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      if (x > 0) seed(x - 1, y);
      if (x < w - 1) seed(x + 1, y);
      if (y > 0) seed(x, y - 1);
      if (y < h - 1) seed(x, y + 1);
    }
    for (let i = 0; i < w * h; i++) if (!isBg[i]) fg[i] = 1;
    // Drop small separate specks (like the "x3" count text): keep only pieces
    // at least 8% the size of the biggest piece.
    const label = new Int32Array(w * h);
    const sizes = [0];
    for (let i = 0; i < w * h; i++) {
      if (!fg[i] || label[i]) continue;
      const id = sizes.length;
      let n = 0;
      const st = [i];
      label[i] = id;
      while (st.length) {
        const j = st.pop(); n++;
        const x = j % w, y = (j - x) / w;
        const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1];
        for (const k of nb) if (k >= 0 && fg[k] && !label[k]) { label[k] = id; st.push(k); }
      }
      sizes.push(n);
    }
    // Pieces touching the crop's edge (other than the main piece) are usually
    // a neighbouring slot's frame or item poking into the box: drop them too.
    const biggest = Math.max(0, ...sizes);
    const mainId = sizes.indexOf(biggest);
    const touchesEdge = new Uint8Array(sizes.length);
    for (let x = 0; x < w; x++) { touchesEdge[label[x]] = 1; touchesEdge[label[(h - 1) * w + x]] = 1; }
    for (let y = 0; y < h; y++) { touchesEdge[label[y * w]] = 1; touchesEdge[label[y * w + w - 1]] = 1; }
    let count = 0;
    for (let i = 0; i < w * h; i++) {
      if (!fg[i]) continue;
      const id = label[i];
      if (sizes[id] < biggest * 0.08 || (touchesEdge[id] && id !== mainId)) fg[i] = 0;
      else count++;
    }
    // If that went badly (nothing or everything), use the whole crop.
    if (count < w * h * 0.03 || count > w * h * 0.97) fg.fill(1);
    return fg;
  }

  /** Build a fingerprint from RGBA pixel data. mode: "ref" | "query" */
  function fingerprint(data, w, h, mode) {
    const fg = foreground(data, w, h, mode);

    // Bounding box of the item
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (fg[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const scale = N / Math.max(bw, bh);
    const offX = (N - bw * scale) / 2, offY = (N - bh * scale) / 2;

    const cellTot = new Float32Array(N * N), cellFg = new Float32Array(N * N);
    const cellRGB = new Float32Array(N * N * 3);
    const hist = new Float32Array(HUE_BINS + GRAY_BINS);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const cx = Math.min(N - 1, Math.floor((x - x0) * scale + offX));
        const cy = Math.min(N - 1, Math.floor((y - y0) * scale + offY));
        const c = cy * N + cx;
        cellTot[c]++;
        const p = y * w + x;
        if (!fg[p]) continue;
        cellFg[c]++;
        const i = p * 4, r = data[i], g = data[i + 1], b = data[i + 2];
        cellRGB[c * 3] += r; cellRGB[c * 3 + 1] += g; cellRGB[c * 3 + 2] += b;
        const [hh, s, v] = rgbToHsv(r, g, b);
        if (s > 0.25 && v > 0.2) {
          const f = (hh / 360) * HUE_BINS;
          const bin = Math.floor(f) % HUE_BINS;
          hist[bin] += 1;
          hist[(bin + 1) % HUE_BINS] += 0.4;
          hist[(bin + HUE_BINS - 1) % HUE_BINS] += 0.4;
        } else {
          const bin = HUE_BINS + Math.min(GRAY_BINS - 1, Math.floor(v * GRAY_BINS));
          hist[bin] += 1;
        }
      }
    }
    let hs = 0; for (const v of hist) hs += v;
    if (hs) for (let i = 0; i < hist.length; i++) hist[i] /= hs;

    const mask = new Uint8Array(N * N);
    for (let c = 0; c < N * N; c++) mask[c] = cellTot[c] && cellFg[c] / cellTot[c] > 0.4 ? 1 : 0;

    const k = N / G;
    const grid = new Float32Array(G * G * 3), gridFg = new Float32Array(G * G);
    for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
      let n = 0, r = 0, g = 0, b = 0;
      for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) {
        const c = (gy * k + yy) * N + gx * k + xx;
        n += cellFg[c]; r += cellRGB[c * 3]; g += cellRGB[c * 3 + 1]; b += cellRGB[c * 3 + 2];
      }
      const gi = gy * G + gx;
      gridFg[gi] = n;
      if (n) { grid[gi * 3] = r / n; grid[gi * 3 + 1] = g / n; grid[gi * 3 + 2] = b / n; }
    }
    return { mask, hist, grid, gridFg, aspect: bw / bh };
  }

  function iou(a, b, flip) {
    let inter = 0, uni = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const av = a[y * N + x], bv = b[y * N + (flip ? N - 1 - x : x)];
      if (av && bv) inter++;
      if (av || bv) uni++;
    }
    return uni ? inter / uni : 0;
  }

  function gridSim(a, b, flip) {
    let sum = 0, n = 0;
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const i = y * G + x, j = y * G + (flip ? G - 1 - x : x);
      if (!a.gridFg[i] || !b.gridFg[j]) continue;
      const dr = a.grid[i * 3] - b.grid[j * 3], dg = a.grid[i * 3 + 1] - b.grid[j * 3 + 1],
        db = a.grid[i * 3 + 2] - b.grid[j * 3 + 2];
      sum += 1 - Math.sqrt(dr * dr + dg * dg + db * db) / 441.7;
      n++;
    }
    return n ? sum / n : 0;
  }

  /** Similarity between 0 and 1 (higher = more alike). */
  function compare(q, r) {
    let hist = 0;
    for (let i = 0; i < q.hist.length; i++) hist += Math.min(q.hist[i], r.hist[i]);
    const aspect = Math.min(q.aspect, r.aspect) / Math.max(q.aspect, r.aspect);
    let best = 0;
    for (const flip of [false, true]) {
      const s = 0.25 * iou(q.mask, r.mask, flip) + 0.50 * gridSim(q, r, flip);
      if (s > best) best = s;
    }
    return 0.20 * hist + best + 0.05 * aspect;
  }

  /** Outline-only similarity: for telling apart same-named items (knife vs gun). */
  function compareShape(q, r) {
    const aspect = Math.min(q.aspect, r.aspect) / Math.max(q.aspect, r.aspect);
    return Math.max(iou(q.mask, r.mask, false), iou(q.mask, r.mask, true)) * 0.8 + aspect * 0.2;
  }

  /** Draw an image (or part of it) to a small canvas and return its pixels. */
  function pixelsFrom(source, sx, sy, sw, sh, maxSide) {
    const s = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, w, h };
  }

  global.MM2Match = { fingerprint, compare, compareShape, pixelsFrom };
})(typeof window !== "undefined" ? window : globalThis);
