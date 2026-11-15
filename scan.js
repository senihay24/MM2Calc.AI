/*
 * Full scan of one screenshot:
 *   1. find the slots                       (MM2Detect)
 *   2. read each slot's name bar, the        (MM2Ocr)
 *      "Chroma" tag and the "x19" count
 *   3. look the name up in the MM2Values list (fuzzy, so small reading
 *      mistakes still match); if two items share a name (e.g. the Bluesteel
 *      knife and gun) the picture decides
 *   4. if there's no readable name, fall back to matching the picture
 */
(function (global) {
  "use strict";

  const MIN_PICTURE_SCORE = 0.56;   // picture-only matches below this are dropped
  const MIN_NAME_SIM = 0.72;        // how close the read name must be to a real name
  const UI_WORDS = /^(view|redeem|invite|search|craft|crafting|enter ?code|weapons|effects|powers|emotes|radios|pets|on|off|trade|accept|decline|cancel|ready)$/i;

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m || !n) return Math.max(m, n);
    let prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }
  const similarity = (a, b) => 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

  /** Items whose name matches the text read from the slot, best first. */
  function nameMatches(text, chroma, items) {
    const t = norm(text);
    if (t.length < 2) return [];
    const scored = [];
    for (const it of items) {
      const n = norm(it.name);
      const isChroma = it.category === "Chroma" || n.startsWith("chroma ");
      const plain = n.replace(/^chroma /, "");
      let sim = similarity(t, plain);
      // The tag is shown separately in the game, so "Laser" + tag = "Chroma Laser".
      if (chroma && !isChroma) sim -= 0.15;
      if (!chroma && isChroma) sim -= 0.15;
      if (sim >= MIN_NAME_SIM - 0.15) scored.push({ id: it.id, sim });
    }
    return scored.sort((a, b) => b.sim - a.sim);
  }

  function pictureScores(img, box, refs) {
    if (!refs || !refs.size) return [];
    const p = global.MM2Match.pixelsFrom(img, box.x, box.y, box.w, box.h * 0.78, 160); // skip the name bar
    const q = global.MM2Match.fingerprint(p.data, p.w, p.h, "query");
    const out = [];
    for (const [id, fp] of refs) out.push({ id, score: global.MM2Match.compare(q, fp) });
    return out.sort((a, b) => b.score - a.score);
  }

  /**
   * items: the MM2Values item list; refs: Map(id -> picture fingerprint).
   * Returns {found:[{box, id, count, how, sure, alts:[id]}], unknown:[name]}
   */
  async function scanImage(img, items, refs, opts = {}) {
    const say = opts.onStatus || (() => {});
    say("Finding items…");
    const boxes = global.MM2Detect.detectSlots(img);
    if (!boxes.length) return { found: [], unknown: [] };

    let reads = boxes.map(() => ({ name: "", chroma: false, count: null }));
    if (global.MM2Ocr && opts.readText !== false) {
      say(`Found ${boxes.length} slots. Reading names and counts…`);
      try {
        reads = await global.MM2Ocr.readSlots(img, boxes,
          (i, n) => say(`Found ${boxes.length} slots. Reading names and counts… ${Math.round(100 * i / n)}%`));
      } catch (e) {
        say("Couldn't load the text reader, so I'm matching by picture only.");
      }
    }

    const found = [], unknown = [];
    boxes.forEach((box, k) => {
      const r = reads[k];
      const byName = nameMatches(r.name, r.chroma, items);
      const best = byName[0];
      let pics = null;
      const getPics = () => (pics = pics || pictureScores(img, box, refs));

      if (best && best.sim >= MIN_NAME_SIM) {
        // Several items with (almost) the same name: let the picture choose.
        const tied = byName.filter((c) => c.sim >= best.sim - 0.02);
        let id = best.id;
        if (tied.length > 1) {
          const ps = new Map(getPics().map((p) => [p.id, p.score]));
          id = tied.sort((a, b) => (ps.get(b.id) || 0) - (ps.get(a.id) || 0))[0].id;
        }
        const alts = [...new Set([id, ...byName.slice(0, 5).map((c) => c.id), ...getPics().slice(0, 6).map((p) => p.id)])].slice(0, 8);
        found.push({ box, id, count: r.count || 1, how: "name", read: r.name,
          sure: best.sim >= 0.85 && tied.length === 1, alts });
        return;
      }
      const readable = norm(r.name);
      if (readable.length >= 3 && !UI_WORDS.test(readable)) {
        // There's a name, but it isn't on MM2Values (or was misread badly).
        const ps = getPics();
        if (ps[0] && ps[0].score >= 0.8) {
          found.push({ box, id: ps[0].id, count: r.count || 1, how: "picture", read: r.name, sure: false, alts: ps.slice(0, 8).map((p) => p.id) });
        } else unknown.push((r.chroma ? "Chroma " : "") + r.name);
        return;
      }
      if (readable.length) return; // UI button text like "View"
      // No name bar at all (other screens / layouts): use the picture.
      const ps = getPics();
      if (ps[0] && ps[0].score >= MIN_PICTURE_SCORE) {
        const margin = ps[1] ? ps[0].score - ps[1].score : 1;
        found.push({ box, id: ps[0].id, count: r.count || 1, how: "picture", sure: margin > 0.03 && ps[0].score > 0.75,
          alts: ps.slice(0, 8).map((p) => p.id) });
      }
    });
    return { found, unknown };
  }

  global.MM2Scan = { scanImage, nameMatches, similarity };
})(typeof window !== "undefined" ? window : globalThis);
