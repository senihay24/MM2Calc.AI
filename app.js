(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n == null ? "N/A" : Number(n).toLocaleString());
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");

  let DB = null, store = null;
  let refPrints = null, refLoading = null;
  let shot = null;          // {img, results:[{box, n}]}
  let boxCounter = 0;

  // ------------------------------------------------------------------ data
  async function loadValues() {
    try {
      const res = await fetch("data/values.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      DB = await res.json();
    } catch (e) {
      $("status").textContent = "No values yet. If you just set this up, run the \"Sync MM2 values\" " +
        "workflow once on GitHub (Actions tab), wait a minute, then refresh.";
      return;
    }
    store = MM2Store.createStore(DB);
    store.onChange(render);
    boxCounter = Math.max(0, ...store.inventory().flatMap((r) => r.tags || []));
    showStatus();
    renderChanges();
    render();
    bot("Hi! Scan a screenshot and I'll add everything up. Then tell me things like **ignore chromas** or " +
      "**only count godlies and ancients**. Type **help** for more.");
  }

  function timeAgo(iso) {
    if (!iso) return "never";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400 * 2) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }
  function showStatus() {
    const stale = !DB.lastChecked || (Date.now() - new Date(DB.lastChecked).getTime()) / 3600000 > 12;
    $("status").innerHTML = `${DB.itemCount} items · MM2Values updated <b>${esc(DB.siteUpdated || "?")}</b> · ` +
      `checked ${timeAgo(DB.lastChecked)}` + (stale ? ` <span class="warn">· sync may be stuck, values could be old</span>` : "");
  }

  // ----------------------------------------------------------- rendering
  function render() {
    if (!store) return;
    const s = store.summary();
    $("total").textContent = fmt(s.total);
    $("totalSub").textContent = s.rows.length
      ? `${s.countedQty} item${s.countedQty === 1 ? "" : "s"} counted` + (s.skippedQty ? ` · ${s.skippedQty} not counted` : "")
      : "No items yet";
    $("clearBtn").hidden = !s.rows.length;
    renderChips();
    renderInventory(s);
    drawShot();
  }

  function renderChips() {
    const f = store.getFilters();
    const chips = [];
    if (f.onlyCats) chips.push({ label: `Only ${f.onlyCats.join(", ")}`, clear: () => ({ ...f, onlyCats: null }) });
    f.excludeCats.forEach((c) => chips.push({ label: `No ${c}`, clear: () => ({ ...f, excludeCats: f.excludeCats.filter((x) => x !== c) }) }));
    f.excludeItems.forEach((id) => {
      const it = store.item(id);
      chips.push({ label: `No ${it ? it.name : id}`, clear: () => ({ ...f, excludeItems: f.excludeItems.filter((x) => x !== id) }) });
    });
    const box = $("chips");
    box.innerHTML = "";
    chips.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip";
      b.innerHTML = `${esc(c.label)} <span aria-hidden="true">✕</span>`;
      b.title = "Stop this filter";
      b.addEventListener("click", () => { store.snapshot(); store.setFilters(c.clear()); });
      box.appendChild(b);
    });
  }

  function renderInventory(s) {
    const box = $("inventory");
    if (!s.rows.length) {
      box.innerHTML = `<p class="muted">Scan a screenshot, or add items by name below.</p>`;
      $("checkNote").hidden = true;
      return;
    }
    box.innerHTML = "";
    let checks = 0;
    for (const r of s.rows) {
      const it = store.item(r.id);
      const needsCheck = r.check && !r.checked;
      if (needsCheck) checks++;
      const el = document.createElement("div");
      el.className = "inv-row" + (r.counted ? "" : " off");
      el.innerHTML = `
        <button type="button" class="thumb" data-act="change" title="Change item">
          <img src="${it && it.image ? it.image : "icon.svg"}" alt="">
          ${r.tags && r.tags.length ? `<span class="tag">${r.tags.slice(0, 3).join(",")}${r.tags.length > 3 ? "…" : ""}</span>` : ""}
        </button>
        <div class="mid">
          <button type="button" class="nm link-like" data-act="change">${esc(r.name)}${needsCheck ? ` <span class="badge">Check</span>` : ""}</button>
          <div class="sub">${esc(r.category)} · Value: ${fmt(r.unit)} each${r.counted ? "" : ` · <i>${esc(r.reason)}</i>`}</div>
          <div class="stepper">
            <button type="button" data-act="dec" aria-label="One fewer">−</button>
            <input type="number" min="0" inputmode="numeric" value="${r.qty}" aria-label="How many">
            <button type="button" data-act="inc" aria-label="One more">+</button>
          </div>
        </div>
        <div class="right">
          <div class="subtotal">${r.counted ? fmt(r.subtotal) : "—"}</div>
          <button type="button" class="rm" data-act="rm">Remove</button>
        </div>`;
      el.addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (!act) return;
        if (act === "inc") { store.snapshot(); store.setQty(r.uid, r.qty + 1); }
        if (act === "dec") { store.snapshot(); store.setQty(r.uid, r.qty - 1); }
        if (act === "rm") { store.snapshot(); store.removeItem(r.uid); }
        if (act === "change") openPicker({ row: r });
      });
      const input = el.querySelector("input");
      input.addEventListener("change", () => { store.snapshot(); store.setQty(r.uid, Math.max(0, parseInt(input.value, 10) || 0)); });
      box.appendChild(el);
    }
    $("checkNote").hidden = !checks;
    $("checkNote").textContent = checks ? `${checks} to check: tap a name to fix it` : "";
  }

  function renderChanges() {
    const log = DB.changeLog || [];
    if (!log.length) return;
    $("changes").innerHTML = log.slice(0, 5).map((entry) => `
      <div><h3>${new Date(entry.date).toLocaleString()} (${entry.changes.length} changes)</h3>
      ${entry.changes.slice(0, 40).map((c) => {
        const cls = c.from == null || c.to == null ? "" : c.to > c.from ? "up" : "down";
        return `<div class="chg"><span>${esc(c.name)}${c.new ? " <small class='muted'>(new)</small>" : ""}</span>
          <span class="${cls}">${c.new ? "" : fmt(c.from) + " → "}${fmt(c.to)}</span></div>`;
      }).join("")}</div>`).join("");
  }

  $("clearBtn").addEventListener("click", () => {
    store.snapshot(); store.clearInventory();
    shot = null; $("shotArea").hidden = true; $("drop").hidden = false;
    bot("Cleared your items. Say **undo** to bring them back.");
  });

  // ------------------------------------------------------- item pictures
  function ensureRefs(onProgress) {
    if (refPrints) return Promise.resolve(refPrints);
    if (refLoading) return refLoading;
    const items = DB.items.filter((it) => it.image);
    const map = new Map();
    let done = 0;
    refLoading = new Promise((resolve) => {
      let i = 0, active = 0;
      const next = () => {
        if (i >= items.length && active === 0) { refPrints = map; resolve(map); return; }
        while (active < 8 && i < items.length) {
          const it = items[i++];
          active++;
          const img = new Image();
          img.onload = () => {
            try {
              const p = MM2Match.pixelsFrom(img, 0, 0, img.naturalWidth, img.naturalHeight, 128);
              map.set(it.id, MM2Match.fingerprint(p.data, p.w, p.h, "ref"));
            } catch (e) { /* skip */ }
            finish();
          };
          img.onerror = finish;
          img.src = it.image;
        }
      };
      const finish = () => { active--; done++; if (onProgress && done % 20 === 0) onProgress(done, items.length); next(); };
      next();
    });
    return refLoading;
  }

  // ------------------------------------------------------------- scanning
  const canvas = $("shot"), ctx = canvas.getContext("2d");
  let drawMode = false, drag = null, dragBox = null;

  function loadFile(file) {
    if (!file || !file.type.startsWith("image/") || !store) return;
    const img = new Image();
    img.onload = () => runScan(img);
    img.src = URL.createObjectURL(file);
  }

  async function runScan(img) {
    shot = { img, results: [] };
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    $("drop").hidden = true; $("shotArea").hidden = false;
    setDrawMode(false);
    drawShot();
    const msg = (t) => { $("scanMsg").textContent = t; };
    $("anotherBtn").disabled = true;
    try {
      msg("Getting item pictures ready…");
      const refs = await ensureRefs((d, n) => msg(`Getting item pictures ready… ${d}/${n}`));
      const { found, unknown } = await MM2Scan.scanImage(img, DB.items, refs, { onStatus: msg });
      if (!found.length) {
        msg("I couldn't find any items in that screenshot. Try a clearer one, or use “Add a missed item”.");
        bot("I couldn't find any items in that screenshot." +
          (unknown.length ? ` I could read ${unknown.map((u) => "“" + u + "”").join(", ")}, but they're not on MM2Values.` : "") +
          " Try a screenshot where the items are bigger, or box them yourself with **Add a missed item**.");
        return;
      }
      // Group by item and add.
      const groups = new Map();
      found.forEach((f) => {
        const n = ++boxCounter;
        shot.results.push({ box: f.box, n });
        const g = groups.get(f.id) || { id: f.id, qty: 0, tags: [], check: false, alts: f.alts };
        g.qty += f.count; g.tags.push(n); g.check = g.check || !f.sure;
        groups.set(f.id, g);
      });
      store.snapshot();
      store.addMany([...groups.values()]);
      const s = store.summary();
      const added = found.reduce((a, f) => a + f.count, 0);
      const checks = [...groups.values()].filter((g) => g.check).length;
      msg(`Found ${found.length} slot${found.length === 1 ? "" : "s"} (${added} item${added === 1 ? "" : "s"}).` +
        (checks ? ` ${checks} marked “Check”.` : ""));
      bot(`Added ${added} item${added === 1 ? "" : "s"} from your screenshot. Total: **${fmt(s.total)}**.` +
        (checks ? ` I'm not sure about ${checks}, so they're marked **Check**. Tap a name to fix it.` : "") +
        (unknown.length ? ` I couldn't find ${unknown.map((u) => "“" + u + "”").join(", ")} on MM2Values, so ${unknown.length === 1 ? "it isn't" : "they aren't"} counted.` : "") +
        ` Want me to leave anything out? For example, say **ignore chromas**.`);
    } catch (e) {
      console.error(e);
      msg("Something went wrong reading that picture. Try again.");
    } finally {
      $("anotherBtn").disabled = false;
      drawShot();
    }
  }

  function drawShot() {
    if (!shot) return;
    const { img } = shot;
    ctx.drawImage(img, 0, 0);
    const lw = Math.max(2, canvas.width / 320);
    const fs = Math.max(12, canvas.width / 38);
    ctx.font = `bold ${fs}px system-ui, sans-serif`;
    for (const r of shot.results) {
      const row = store && store.inventory().find((x) => (x.tags || []).includes(r.n));
      const off = row && store.whyNotCounted(row);
      ctx.strokeStyle = !row ? "#666" : off ? "#888" : row.check && !row.checked ? "#f4c542" : "#3ecf8e";
      ctx.lineWidth = lw;
      ctx.strokeRect(r.box.x, r.box.y, r.box.w, r.box.h);
      ctx.fillStyle = ctx.strokeStyle;
      const label = String(r.n);
      const tw = ctx.measureText(label).width + 8;
      ctx.fillRect(r.box.x, r.box.y, tw, fs + 6);
      ctx.fillStyle = "#000";
      ctx.fillText(label, r.box.x + 4, r.box.y + fs);
    }
    if (dragBox && dragBox.w > 2) {
      ctx.setLineDash([lw * 4, lw * 2]);
      ctx.strokeStyle = "#ff6b5e"; ctx.lineWidth = lw;
      ctx.strokeRect(dragBox.x, dragBox.y, dragBox.w, dragBox.h);
      ctx.setLineDash([]);
    }
  }

  $("file").addEventListener("change", (e) => { loadFile(e.target.files[0]); e.target.value = ""; });
  $("anotherBtn").addEventListener("click", () => $("file").click());
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));
  document.addEventListener("paste", (e) => {
    if (e.target && e.target.tagName === "INPUT") return;
    const f = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
    if (f) loadFile(f);
  });

  // Draw a box for a missed item
  function setDrawMode(on) {
    drawMode = on;
    $("drawHint").hidden = !on;
    canvas.classList.toggle("drawing", on);
    dragBox = null; drawShot();
  }
  $("missedBtn").addEventListener("click", () => setDrawMode(true));
  $("cancelDrawBtn").addEventListener("click", () => setDrawMode(false));
  const toImg = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(canvas.width, (e.clientX - r.left) / r.width * canvas.width)),
      y: Math.max(0, Math.min(canvas.height, (e.clientY - r.top) / r.height * canvas.height)) };
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (!drawMode) return;
    canvas.setPointerCapture(e.pointerId);
    drag = toImg(e); dragBox = { x: drag.x, y: drag.y, w: 0, h: 0 };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = toImg(e);
    dragBox = { x: Math.min(p.x, drag.x), y: Math.min(p.y, drag.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) };
    drawShot();
  });
  const endDrag = async () => {
    if (!drag) return;
    drag = null;
    const b = dragBox;
    if (!b || b.w < 8 || b.h < 8) { dragBox = null; drawShot(); return; }
    const refs = await ensureRefs();
    const p = MM2Match.pixelsFrom(shot.img, b.x, b.y, b.w, b.h, 160);
    const q = MM2Match.fingerprint(p.data, p.w, p.h, "query");
    let alts = [...refs].map(([id, fp]) => ({ id, score: MM2Match.compare(q, fp) }))
      .sort((a, c) => c.score - a.score).slice(0, 8).map((a) => a.id);
    let count = 1;
    try {
      const r = (await MM2Ocr.readSlots(shot.img, [b]))[0];
      count = r.count || 1;
      const named = MM2Scan.nameMatches(r.name, r.chroma, DB.items).slice(0, 4).map((c) => c.id);
      alts = [...new Set([...named, ...alts])].slice(0, 8);
    } catch (e) { /* default 1 */ }
    openPicker({ alts, crop: b, onPick: (id) => {
      const n = ++boxCounter;
      shot.results.push({ box: b, n });
      store.snapshot();
      store.addMany([{ id, qty: count, tags: [n], checked: true }]);
      setDrawMode(false);
      bot(`Added ${store.item(id).name}${count > 1 ? ` ×${count}` : ""}. Total: **${fmt(store.summary().total)}**.`);
    } });
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // ----------------------------------------------------------- the picker
  let pickerCtx = null;
  function cand(item, onPick, best) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cand" + (best ? " best" : "");
    b.innerHTML = `<img src="${item.image || "icon.svg"}" alt="" loading="lazy">
      <div><div class="nm">${esc(item.name)}</div><div class="sub">${esc(item.category)}</div>
      <div class="val">${fmt(item.value)}</div></div>`;
    b.addEventListener("click", () => onPick(item.id));
    return b;
  }
  function openPicker(opts) {
    pickerCtx = opts;
    const row = opts.row;
    const alts = row ? (row.alts || []) : opts.alts;
    const onPick = (id) => {
      closePicker();
      if (row) { store.snapshot(); store.changeItem(row.uid, id); }
      else if (opts.onPick) opts.onPick(id);
    };
    pickerCtx.onPick = onPick;
    $("pickerTitle").textContent = row ? `Is this right? (${row.name})` : "Which item is it?";
    // show the crop if we have it
    const crop = opts.crop || (row && shot && shot.results.find((r) => (row.tags || []).includes(r.n))?.box);
    const pc = $("pickerCrop");
    if (crop && shot) {
      pc.hidden = false;
      const s = 96 / Math.max(crop.w, crop.h);
      pc.width = Math.round(crop.w * s); pc.height = Math.round(crop.h * s);
      pc.getContext("2d").drawImage(shot.img, crop.x, crop.y, crop.w, crop.h, 0, 0, pc.width, pc.height);
    } else pc.hidden = true;
    const box = $("pickerAlts");
    box.innerHTML = "";
    const list = alts.length ? alts : row ? [row.id] : [];
    list.map((id) => store.item(id)).filter(Boolean)
      .forEach((it, i) => box.appendChild(cand(it, onPick, row ? it.id === row.id : i === 0)));
    if (!list.length) box.innerHTML = `<p class="muted small">Search for the item below.</p>`;
    $("pickerSearch").value = "";
    $("pickerResults").innerHTML = "";
    $("picker").hidden = false;
  }
  function closePicker() { $("picker").hidden = true; pickerCtx = null; if (drawMode) { dragBox = null; drawShot(); } }
  $("pickerClose").addEventListener("click", closePicker);
  $("picker").addEventListener("click", (e) => { if (e.target === $("picker")) closePicker(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("picker").hidden) closePicker(); });

  // ---------------------------------------------------------------- search
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  function searchItems(q) {
    q = norm(q);
    if (!q || !DB) return [];
    const words = q.split(" ");
    return DB.items
      .map((it) => { const n = norm(it.name); return words.every((w) => n.includes(w)) ? { it, s: (n.startsWith(q) ? 0 : 1) + n.length / 100 } : null; })
      .filter(Boolean).sort((a, b) => a.s - b.s).slice(0, 8).map((h) => h.it);
  }
  $("search").addEventListener("input", () => {
    const out = $("searchResults");
    out.innerHTML = "";
    searchItems($("search").value).forEach((it) => out.appendChild(cand(it, (id) => {
      store.snapshot(); store.addMany([{ id, qty: 1, checked: true }]);
      $("search").value = ""; out.innerHTML = "";
    })));
  });
  $("pickerSearch").addEventListener("input", () => {
    const out = $("pickerResults");
    out.innerHTML = "";
    searchItems($("pickerSearch").value).forEach((it) => out.appendChild(cand(it, (id) => pickerCtx && pickerCtx.onPick(id))));
  });

  // ------------------------------------------------------------------ chat
  function addMsg(text, who) {
    const d = document.createElement("div");
    d.className = "msg " + who;
    d.innerHTML = md(text);
    $("chatLog").appendChild(d);
    $("chatLog").scrollTop = $("chatLog").scrollHeight;
  }
  function bot(text) { addMsg(text, "bot"); }
  function send(text) {
    text = text.trim();
    if (!text || !store) return;
    addMsg(text, "me");
    bot(MM2Chat.handle(text, store));
  }
  $("chatForm").addEventListener("submit", (e) => { e.preventDefault(); send($("chatInput").value); $("chatInput").value = ""; });
  document.querySelectorAll(".chip-btn").forEach((b) => b.addEventListener("click", () => send(b.textContent)));

  // Re-check for new values when the person comes back to the tab.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !DB) return;
    if (Date.now() - new Date(DB.lastChecked).getTime() < 30 * 60 * 1000) return;
    try {
      const res = await fetch("data/values.json", { cache: "no-cache" });
      const fresh = await res.json();
      if (fresh.siteUpdated !== DB.siteUpdated) location.reload();
      else { DB.lastChecked = fresh.lastChecked; showStatus(); }
    } catch (e) { /* offline */ }
  });

  loadValues();
})();
