/*
 * The item list, the filters ("ignore chromas"), totals and undo.
 * Shared by the page (app.js) and the chat (chat.js).
 */
(function (global) {
  "use strict";

  const KEY = "mm2calc.state.v2";

  function createStore(db, opts = {}) {
    const byId = new Map(db.items.map((it) => [it.id, it]));
    const nameIndex = db.items
      .map((it) => ({ id: it.id, n: it.name.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim() }))
      .sort((a, b) => b.n.length - a.n.length);
    const listeners = [];
    const undoStack = [];
    let state = { rows: [], filters: { onlyCats: null, excludeCats: [], excludeItems: [] } };

    if (opts.persist !== false) {
      try {
        const saved = JSON.parse(localStorage.getItem(KEY));
        if (saved && Array.isArray(saved.rows)) state = { rows: saved.rows, filters: { ...state.filters, ...saved.filters } };
      } catch (e) { /* no storage */ }
    }

    const clone = (s) => JSON.parse(JSON.stringify(s));
    function changed() {
      if (opts.persist !== false) {
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
      }
      listeners.forEach((fn) => fn());
    }

    function whyNotCounted(row) {
      const it = byId.get(row.id);
      if (!it) return "no longer on MM2Values";
      const f = state.filters;
      if (f.excludeItems.includes(row.id)) return "ignored";
      if (f.excludeCats.includes(it.category)) return `${it.category} ignored`;
      if (f.onlyCats && !f.onlyCats.includes(it.category)) return `only counting ${f.onlyCats.join(", ")}`;
      if (it.value == null) return "no value listed";
      return null;
    }

    function summary() {
      let total = 0, countedQty = 0, skippedQty = 0;
      const rows = state.rows.map((r) => {
        const it = byId.get(r.id);
        const reason = whyNotCounted(r);
        const unit = it ? it.value : null;
        const subtotal = unit == null ? 0 : unit * r.qty;
        if (reason) skippedQty += r.qty; else { total += subtotal; countedQty += r.qty; }
        return { ...r, name: it ? it.name : r.id, category: it ? it.category : "?", unit, subtotal, counted: !reason, reason };
      });
      return { total, countedQty, skippedQty, rows };
    }

    const api = {
      db, byId,
      item: (id) => byId.get(id),
      nameIndex: () => nameIndex,
      inventory: () => state.rows,
      getFilters: () => state.filters,
      setFilters(f) { state.filters = { onlyCats: f.onlyCats || null, excludeCats: f.excludeCats || [], excludeItems: f.excludeItems || [] }; changed(); },
      snapshot() { undoStack.push(clone(state)); if (undoStack.length > 30) undoStack.shift(); },
      undo() { if (!undoStack.length) return false; state = undoStack.pop(); changed(); return true; },
      addItem(id, qty = 1, extra = {}) {
        if (!byId.has(id)) return;
        const row = state.rows.find((r) => r.id === id && !extra.uid);
        if (row && !extra.separate) row.qty += qty;
        else state.rows.push({ uid: Math.random().toString(36).slice(2, 9), id, qty, ...extra });
        changed();
      },
      addMany(list) { // [{id, qty, ...extra}] from a scan, merged by item
        for (const e of list) {
          const row = state.rows.find((r) => r.id === e.id);
          if (row) { row.qty += e.qty; row.tags = (row.tags || []).concat(e.tags || []); row.check = row.check || e.check; }
          else state.rows.push({ uid: Math.random().toString(36).slice(2, 9), ...e });
        }
        changed();
      },
      setQty(id, qty) {
        const row = state.rows.find((r) => r.id === id || r.uid === id);
        if (row) { if (qty > 0) row.qty = qty; else state.rows = state.rows.filter((r) => r !== row); }
        else if (qty > 0) state.rows.push({ uid: Math.random().toString(36).slice(2, 9), id, qty });
        changed();
      },
      changeItem(uid, newId) {
        const row = state.rows.find((r) => r.uid === uid);
        if (!row || !byId.has(newId)) return;
        const other = state.rows.find((r) => r.id === newId && r !== row);
        if (other) { other.qty += row.qty; state.rows = state.rows.filter((r) => r !== row); }
        else { row.id = newId; row.checked = true; }
        changed();
      },
      removeItem(id) { state.rows = state.rows.filter((r) => r.id !== id && r.uid !== id); changed(); },
      clearInventory() { state.rows = []; changed(); },
      summary,
      whyNotCounted,
      onChange(fn) { listeners.push(fn); },
    };
    return api;
  }

  global.MM2Store = { createStore };
})(typeof window !== "undefined" ? window : globalThis);
