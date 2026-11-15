/*
 * The chat assistant. It understands plain-English commands about the item
 * list, entirely on the device (no AI service, no cost):
 *
 *   ignore chromas / don't count pets / skip Chroma Luger
 *   only count godlies and ancients / just ancients
 *   count chromas again / include pets
 *   count everything / reset filters
 *   set Seer to 3 / I have 2 Icebreakers / add 4 Candy
 *   remove Harvester / clear my items / undo
 *   what's my total / breakdown / top 5 / how much is Seer worth
 *   what's ignored / help
 *
 * Several commands can go in one message, separated by commas or "then":
 *   "only godlies and ancients, ignore Chroma Seer"
 *
 * It talks to the page through an `api` object (see app.js).
 */
(function (global) {
  "use strict";

  const CATS = [
    ["Chroma", /\bchromas?\b/],
    ["Godly", /\bgod(ly|lies|lys|s)\b/],
    ["Ancient", /\bancients?\b/],
    ["Unique", /\buniques?\b/],
    ["Legendary", /\blegend(ary|aries|s)?\b|\blegs\b/],
    ["Uncommon", /\buncommons?\b/],
    ["Common", /\bcommons?\b/],
    ["Rare", /\brares?\b/],
    ["Vintage", /\bvintages?\b|\bclassics?\b/],
    ["Pets", /\bpets?\b/],
    ["Misc", /\bmisc(ellaneous)?\b/],
  ];
  const PLURAL = { Chroma: "chromas", Godly: "godlies", Ancient: "ancients", Unique: "uniques", Legendary: "legendaries",
    Uncommon: "uncommons", Common: "commons", Rare: "rares", Vintage: "vintages", Pets: "pets", Misc: "misc items" };

  const norm = (s) => s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const fmt = (n) => (n == null ? "N/A" : Number(n).toLocaleString());
  const listJoin = (a) => a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
  const catWord = (c) => PLURAL[c] || c.toLowerCase();

  /** Find item names in the text (longest names first). Returns {ids, rest}. */
  function findItems(text, api) {
    let rest = " " + norm(text) + " ";
    const found = [];
    const owned = new Set(api.inventory().map((r) => r.id));
    const names = api.nameIndex(); // [{id, n}] sorted longest first
    for (const { id, n } of names) {
      if (n.length < 3) continue;
      const re = new RegExp(" " + n.replace(/ /g, "s? ") + "s? ");
      if (re.test(rest)) {
        // Prefer the one you own when two items share a name.
        const dup = found.find((f) => f.n === n);
        if (dup) { if (owned.has(id) && !owned.has(dup.id)) dup.id = id; continue; }
        found.push({ id, n });
        rest = rest.replace(re, " ");
      }
    }
    return { ids: found.map((f) => f.id), rest };
  }

  function findCats(text) {
    const t = " " + norm(text) + " ";
    return CATS.filter(([, re]) => re.test(t)).map(([c]) => c);
  }

  function totalLine(api) {
    const s = api.summary();
    let line = `Total: **${fmt(s.total)}** from ${s.countedQty} item${s.countedQty === 1 ? "" : "s"}`;
    if (s.skippedQty) line += ` (${s.skippedQty} not counted)`;
    return line + ".";
  }

  function describeFilters(f) {
    const parts = [];
    if (f.onlyCats && f.onlyCats.length) parts.push(`only counting ${listJoin(f.onlyCats.map(catWord))}`);
    if (f.excludeCats.length) parts.push(`ignoring ${listJoin(f.excludeCats.map(catWord))}`);
    if (f.excludeItems.length) parts.push(`ignoring ${f.excludeItems.length} specific item${f.excludeItems.length > 1 ? "s" : ""}`);
    return parts.length ? "I'm " + parts.join(", ") + "." : "Everything is being counted.";
  }

  const HELP = `Here's what I can do:
• **ignore chromas** / **don't count pets** / **skip Chroma Luger**
• **only count godlies and ancients**
• **count chromas again** / **count everything**
• **set Seer to 3** / **add 2 Icebreaker** / **remove Harvester**
• **total** / **breakdown** / **top 5** / **how much is Seer worth**
• **what's ignored** / **undo** / **clear my items**
You can chain them: "only godlies and ancients, ignore Chroma Seer".`;

  function handleClause(raw, api, replies) {
    const t = " " + norm(raw) + " ";
    if (!t.trim()) return;
    const f = api.getFilters();

    if (/^ (help|commands|what can you do|how do i use this|\?) $/.test(t) || / help /.test(t) && t.length < 12) {
      replies.push(HELP); return;
    }
    if (/ undo /.test(t)) { replies.push(api.undo() ? "Undone." : "Nothing to undo."); return; }
    if (/ (clear|delete|remove|empty|wipe) (all |my |the |everything in my )*(items|list|inventory|trade|offer)\b/.test(t) ||
        / (start over|new trade) /.test(t)) {
      api.snapshot(); api.clearInventory();
      replies.push("Cleared your items. Say **undo** to bring them back."); return;
    }
    if (/ (what|which|show).*(ignored|excluded|filtered|not counted|counting|filters?)|^ (my )?(filters?|settings) $/.test(t)) {
      replies.push(describeFilters(f)); return;
    }

    const items = findItems(raw, api);
    const cats = findCats(items.rest);
    const itemNames = items.ids.map((id) => api.item(id).name);

    // "count everything except chromas" -> treat as ignore
    const except = / (except|but not|other than|apart from|besides|excluding) /.test(t);
    const reset = /^ reset $| (reset|clear) (the |my |all )?(filters?|settings)| count (everything|all|it all)| include (everything|all)| remove (the |all )?filters?| no filters /.test(t);

    if (reset && !except && !cats.length && !items.ids.length) {
      api.snapshot(); api.setFilters({ onlyCats: null, excludeCats: [], excludeItems: [] });
      replies.push("Counting everything again. " + totalLine(api)); return;
    }

    // Quantity: "set X to 3", "change X to 3", "X = 3", "i have 3 X", "add 3 X", "3x X"
    let qty = null, mode = null;
    let m = t.match(/ (set|change|make|put) .+? (to|=|at) (\d{1,5}) /) || t.match(/ .+? (=) (\d{1,5}) /);
    if (m) { qty = parseInt(m[m.length - 1], 10); mode = "set"; }
    else if ((m = t.match(/ i (have|got|own) (\d{1,5}) /))) { qty = parseInt(m[2], 10); mode = "set"; }
    else if ((m = t.match(/ (add|plus) (\d{1,5}) /)) || (m = t.match(/ (add) (a|an|one) /))) {
      qty = /^\d/.test(m[2]) ? parseInt(m[2], 10) : 1; mode = "add";
    } else if ((m = t.match(/^ (\d{1,5}) ?x? /)) && items.ids.length) { qty = parseInt(m[1], 10); mode = "add"; }
    if (mode && items.ids.length) {
      api.snapshot();
      for (const id of items.ids) mode === "set" ? api.setQty(id, qty) : api.addItem(id, qty);
      replies.push(`${mode === "set" ? "Set" : "Added"} ${listJoin(itemNames)} ${mode === "set" ? "to" : "×"} ${qty}. ` + totalLine(api));
      return;
    }
    if (mode && !items.ids.length) {
      replies.push("Which item? I couldn't find that name on MM2Values. Try the exact name, like \"set Seer to 3\"."); return;
    }

    // Remove specific items from the list
    if (/ (remove|delete|take off|get rid of) /.test(t) && items.ids.length && !cats.length) {
      api.snapshot();
      items.ids.forEach((id) => api.removeItem(id));
      replies.push(`Removed ${listJoin(itemNames)}. ` + totalLine(api)); return;
    }

    // Value lookup: "how much is X worth", "value of X", "what's X worth", "price of X"
    if (items.ids.length && / (worth|value|price|how much|cost) /.test(t) && !/ (ignore|exclude|only|count|skip) /.test(t)) {
      replies.push(items.ids.map((id) => {
        const it = api.item(id);
        const extra = [it.demand != null ? `demand ${it.demand}` : "", it.stability || "", it.range && it.range !== "N/A" ? `range ${it.range}` : ""]
          .filter(Boolean).join(", ");
        return `**${it.name}** (${it.category}) is worth **${fmt(it.value)}**${extra ? ` (${extra})` : ""}.`;
      }).join("\n"));
      return;
    }

    const only = / (only|just|nothing but|solely) /.test(t);
    const ignore = except || / (ignore|exclude|dont count|do not count|don t count|not count|without|skip|leave out|take out|minus|no|not|remove|hide|forget|drop) /.test(t);
    const include = / (include|add back|bring back|unignore|stop ignoring|again|too|as well|also count|count) /.test(t);

    if ((only || ignore || include) && (cats.length || items.ids.length)) {
      api.snapshot();
      const nf = { onlyCats: f.onlyCats ? [...f.onlyCats] : null, excludeCats: [...f.excludeCats], excludeItems: [...f.excludeItems] };
      let did;
      if (only && !except) {
        nf.onlyCats = cats.length ? cats : nf.onlyCats;
        nf.excludeCats = nf.excludeCats.filter((c) => !cats.includes(c));
        if (items.ids.length && !cats.length) {
          // "only count Seer" -> ignore everything else you own
          nf.onlyCats = null;
          nf.excludeItems = api.inventory().map((r) => r.id).filter((id) => !items.ids.includes(id));
        }
        did = `Now only counting ${listJoin(cats.map(catWord).concat(itemNames))}.`;
      } else if (ignore) {
        cats.forEach((c) => { if (!nf.excludeCats.includes(c)) nf.excludeCats.push(c); });
        if (nf.onlyCats) nf.onlyCats = nf.onlyCats.filter((c) => !cats.includes(c));
        items.ids.forEach((id) => { if (!nf.excludeItems.includes(id)) nf.excludeItems.push(id); });
        did = `Ignoring ${listJoin(cats.map(catWord).concat(itemNames))}.`;
      } else {
        nf.excludeCats = nf.excludeCats.filter((c) => !cats.includes(c));
        if (nf.onlyCats) cats.forEach((c) => { if (!nf.onlyCats.includes(c)) nf.onlyCats.push(c); });
        nf.excludeItems = nf.excludeItems.filter((id) => !items.ids.includes(id));
        did = `Counting ${listJoin(cats.map(catWord).concat(itemNames))} again.`;
      }
      if (nf.onlyCats && !nf.onlyCats.length) nf.onlyCats = null;
      api.setFilters(nf);
      replies.push(did + " " + totalLine(api));
      return;
    }

    if (cats.length && !items.ids.length && / (worth|value|how much|total) /.test(t)) {
      const rows = api.summary().rows.filter((r) => cats.includes(r.category));
      const sum = rows.reduce((a, r) => a + (r.unit || 0) * r.qty, 0);
      const qty = rows.reduce((a, r) => a + r.qty, 0);
      replies.push(`Your ${listJoin(cats.map(catWord))}: ${qty} item${qty === 1 ? "" : "s"} worth **${fmt(sum)}**.`);
      return;
    }
    if (/ (top|most valuable|best|highest|biggest)( \d+)? /.test(t)) {
      const n = parseInt((t.match(/ (\d{1,2}) /) || [])[1], 10) || 5;
      const rows = api.summary().rows.filter((r) => r.counted).sort((a, b) => b.subtotal - a.subtotal).slice(0, n);
      replies.push(rows.length
        ? `Your top ${rows.length}:\n` + rows.map((r, i) => `${i + 1}. ${r.name} ×${r.qty} = **${fmt(r.subtotal)}**`).join("\n")
        : "Nothing is being counted yet.");
      return;
    }
    if (/ (breakdown|by category|categories|summary|split) /.test(t)) {
      const s = api.summary();
      const by = {};
      s.rows.filter((r) => r.counted).forEach((r) => { by[r.category] = (by[r.category] || 0) + r.subtotal; });
      const lines = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, v]) => `• ${c}: **${fmt(v)}**`);
      replies.push(lines.length ? lines.join("\n") + "\n" + totalLine(api) : "Nothing is being counted yet.");
      return;
    }
    if (/ (total|worth|how much|value|sum|calculate|count) /.test(t)) {
      replies.push(totalLine(api) + (describeFilters(f) !== "Everything is being counted." ? " " + describeFilters(f) : ""));
      return;
    }
    if (cats.length || items.ids.length) {
      replies.push(`Do you want me to ignore ${listJoin(cats.map(catWord).concat(itemNames))}, only count them, or count them again? ` +
        `For example: "ignore ${cats[0] ? catWord(cats[0]) : itemNames[0]}".`);
      return;
    }
    replies.push(`Sorry, I didn't get "${raw.trim()}". Type **help** to see what I can do.`);
  }

  const VERB = /\b(ignore|exclude|don'?t|do not|not|skip|without|only|just|count|include|add|set|change|make|remove|delete|clear|reset|undo|help|total|worth|value|price|how|what|top|best|breakdown|summary|have|got|own|bring|stop|leave|take|minus|except|no|forget|drop|hide)\b/i;

  function handle(text, api) {
    const replies = [];
    const parts = text.split(/[,;\n]+| then |\. /i).map((c) => c.trim()).filter(Boolean);
    // "only godlies, ancients and uniques": a part with no command word
    // belongs to the part before it.
    const clauses = [];
    for (const p of parts) {
      if (clauses.length && !VERB.test(p)) clauses[clauses.length - 1] += " and " + p;
      else clauses.push(p);
    }
    for (const c of clauses) handleClause(c, api, replies);
    return replies.join("\n\n");
  }

  global.MM2Chat = { handle, HELP };
})(typeof window !== "undefined" ? window : globalThis);
