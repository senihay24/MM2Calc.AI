/*
 * Reads text from slots: the item name on the colored bar under each item
 * (e.g. "Blue Seer"), the "Chroma" tag, and counts like "x19", on the device, using
 * Tesseract.js (bundled in vendor/tesseract so it doesn't depend on any CDN).
 * The OCR engine (~6 MB) only downloads the first time a screenshot is scanned.
 */
(function (global) {
  "use strict";

  // The reader files sit next to index.html.
  const BASE = "./";
  let workerPromise = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("load " + src));
      document.head.appendChild(s);
    });
  }

  async function getWorker() {
    if (!workerPromise) {
      workerPromise = (async () => {
        if (!global.Tesseract) await loadScript(BASE + "tesseract.min.js");
        const abs = (p) => new URL(BASE + p, location.href).href;
        const worker = await global.Tesseract.createWorker("eng", 1, {
          workerPath: abs("worker.min.js"),
          corePath: abs(""),
          langPath: abs(""),
          gzip: true,
          cacheMethod: "write",
        });
        return worker;
      })();
      workerPromise.catch(() => { workerPromise = null; });
    }
    return workerPromise;
  }

  /*
   * Count text in MM2 is bright (white/yellow) with a dark outline. Keep only
   * bright, low-color pixels as black-on-white, 3x enlarged, which is what
   * Tesseract reads best.
   */
  function prepare(img, box, opts = {}) {
    // Trim the slot's own frame (a white border confuses the reader).
    if (opts.inset !== false) {
      const ix = box.w * 0.06, iy = box.h * 0.06;
      box = { x: box.x + ix, y: box.y + iy, w: box.w - 2 * ix, h: box.h - 2 * iy };
    }
    const scale = opts.height ? Math.max(0.5, Math.min(5, opts.height / box.h))
      : Math.max(1, Math.min(4, 240 / Math.max(box.w, box.h)));
    const w = Math.round(box.w * scale), h = Math.round(box.h * scale);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, w, h);
    const id = ctx.getImageData(0, 0, w, h), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const bright = max > 200 && (max - min) < 70 || (r > 220 && g > 200 && b < 120); // white or yellow
      const v = bright ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return c;
  }

  function parseCount(text) {
    const t = text.replace(/\s+/g, " ");
    let m = t.match(/[xX]\s?(\d{1,4})\b/) || t.match(/\b(\d{1,4})\s?[xX]/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= 9999 ? n : null;
  }

  const COUNT_PARAMS = { tessedit_char_whitelist: "xX0123456789", tessedit_pageseg_mode: "11" };
  const NAME_PARAMS = {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '-.&",
    tessedit_pageseg_mode: "7", // one line of text
  };

  async function countFor(worker, img, b) {
    // Top-right corner first (where MM2 puts "x19"), then the whole slot,
    // then the bottom and top halves.
    const tries = [{ x: b.x + b.w * 0.35, y: b.y, w: b.w * 0.65, h: b.h * 0.3 }, b,
      { x: b.x, y: b.y + b.h * 0.5, w: b.w, h: b.h * 0.5 }, { x: b.x, y: b.y, w: b.w, h: b.h * 0.5 }];
    for (const t of tries) {
      try {
        const { data } = await worker.recognize(prepare(img, t));
        const c = parseCount(data.text || "");
        if (c) return c;
      } catch (e) { /* next */ }
    }
    return null;
  }

  /** Returns a count per box (null where no count was found). */
  async function readCounts(img, boxes, onProgress) {
    const worker = await getWorker();
    await worker.setParameters(COUNT_PARAMS);
    const out = [];
    for (let i = 0; i < boxes.length; i++) {
      out.push(await countFor(worker, img, boxes[i]));
      if (onProgress) onProgress(i + 1, boxes.length);
    }
    return out;
  }

  /** Is there a rainbow "Chroma" tag just above the name bar? */
  function hasChromaTag(img, b) {
    // The tag sits just above the name bar, on the left.
    const box = b.bar ? { x: b.bar.x, y: Math.max(0, b.bar.y - b.bar.h * 1.05), w: b.bar.w * 0.6, h: b.bar.h }
      : { x: b.x + b.w * 0.02, y: b.y + b.h * 0.64, w: b.w * 0.6, h: b.h * 0.16 };
    const w = 60, h = Math.max(8, Math.round(60 * box.h / box.w));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const bins = new Array(12).fill(0);
    let sat = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, bl = d[i + 2] / 255;
      const max = Math.max(r, g, bl), min = Math.min(r, g, bl), dd = max - min;
      if (max < 0.35 || dd / max < 0.5) continue;
      let hh = max === r ? ((g - bl) / dd) % 6 : max === g ? (bl - r) / dd + 2 : (r - g) / dd + 4;
      hh = (hh * 60 + 360) % 360;
      bins[Math.floor(hh / 30)]++;
      sat++;
    }
    const n = w * h;
    const used = bins.filter((v) => v > n * 0.008).length;
    return sat > n * 0.12 && used >= 5; // lots of strong, very different colors
  }

  /**
   * Reads every slot: [{name: "Blue Seer" | "", chroma: bool, count: n | null}]
   */
  async function readSlots(img, boxes, onProgress) {
    const worker = await getWorker();
    const out = boxes.map((b) => ({ name: "", chroma: hasChromaTag(img, b), count: null }));
    await worker.setParameters(NAME_PARAMS);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const strip = b.bar || { x: b.x + b.w * 0.03, y: b.y + b.h * 0.79, w: b.w * 0.94, h: b.h * 0.19 };
      try {
        const { data } = await worker.recognize(prepare(img, strip, { inset: false, height: 70 }));
        const text = (data.text || "").replace(/\s+/g, " ").trim();
        // Only trust it as a name if it has real words and the reader is fairly sure.
        // Keep anything word-like with how sure the reader was; the scanner
        // decides (a low-confidence read is only used if it matches a real item).
        if (/[A-Za-z]{3,}/.test(text)) { out[i].name = text; out[i].conf = data.confidence ?? 100; }
      } catch (e) { /* unreadable */ }
      if (onProgress) onProgress(i + 1, boxes.length * 2);
    }
    await worker.setParameters(COUNT_PARAMS);
    for (let i = 0; i < boxes.length; i++) {
      out[i].count = await countFor(worker, img, boxes[i]);
      if (onProgress) onProgress(boxes.length + i + 1, boxes.length * 2);
    }
    return out;
  }

  global.MM2Ocr = { readCounts, readSlots, hasChromaTag, parseCount, _prepare: prepare, _worker: getWorker, warmUp: () => getWorker().then(() => true, () => false) };
})(typeof window !== "undefined" ? window : globalThis);
