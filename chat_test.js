// node tests/chat_test.js  — checks the chat assistant's commands
require("../docs/store.js");
require("../docs/chat.js");
const assert = require("assert");

const db = { items: [
  { id: "godly-seer", name: "Seer", category: "Godly", value: 40 },
  { id: "chroma-chroma-seer", name: "Chroma Seer", category: "Chroma", value: 200 },
  { id: "godly-icebreaker", name: "Icebreaker", category: "Godly", value: 60 },
  { id: "ancient-harvester", name: "Harvester", category: "Ancient", value: 900 },
  { id: "chroma-chroma-luger", name: "Chroma Luger", category: "Chroma", value: 150 },
  { id: "godly-luger", name: "Luger", category: "Godly", value: 10 },
  { id: "pets-dog", name: "Dog", category: "Pets", value: 5 },
  { id: "uncommon-crimson", name: "Crimson", category: "Uncommon", value: 1 },
  { id: "common-lava", name: "Lava", category: "Common", value: null },
] };

function fresh() {
  const s = MM2Store.createStore(db, { persist: false });
  s.addMany([
    { id: "godly-seer", qty: 2 }, { id: "chroma-chroma-seer", qty: 1 }, { id: "godly-icebreaker", qty: 3 },
    { id: "ancient-harvester", qty: 1 }, { id: "chroma-chroma-luger", qty: 2 }, { id: "pets-dog", qty: 4 },
    { id: "uncommon-crimson", qty: 2 }, { id: "common-lava", qty: 1 },
  ]);
  return s;
}
const total = (s) => s.summary().total;
const say = (s, msg) => { const r = MM2Chat.handle(msg, s); console.log(`> ${msg}\n  ${r.replace(/\n/g, "\n  ")}`); return r; };

// all: 80 + 200 + 180 + 900 + 300 + 20 + 2 = 1682 (lava has no value)
let s = fresh();
assert.strictEqual(total(s), 1682);

say(s, "ignore chromas");
assert.strictEqual(total(s), 1682 - 500);
say(s, "count chromas again");
assert.strictEqual(total(s), 1682);

say(s, "only count godlies and ancients");
assert.strictEqual(total(s), 80 + 180 + 900);
say(s, "include pets");
assert.strictEqual(total(s), 80 + 180 + 900 + 20);
say(s, "count everything");
assert.strictEqual(total(s), 1682);

say(s, "only godlies, ancients and chromas");
assert.strictEqual(total(s), 80 + 180 + 900 + 500);
say(s, "reset filters");

say(s, "don't count Chroma Seer");               // item, not the category
assert.strictEqual(total(s), 1682 - 200);
say(s, "undo");
assert.strictEqual(total(s), 1682);

say(s, "set seer to 5");
assert.strictEqual(total(s), 1682 + 3 * 40);
say(s, "I have 1 icebreaker");
assert.strictEqual(total(s), 1682 + 120 - 120);
say(s, "add 2 luger");
assert.strictEqual(total(s), 1682 + 20);
say(s, "remove harvester");
assert.strictEqual(total(s), 1682 + 20 - 900);
say(s, "undo"); say(s, "undo"); say(s, "undo"); say(s, "undo");
assert.strictEqual(total(s), 1682);

say(s, "everything except pets and uncommons");
assert.strictEqual(total(s), 1682 - 22);
say(s, "what's ignored?");
say(s, "reset");
say(s, "how much is chroma luger worth");
say(s, "how much are my chromas worth");
say(s, "top 3");
say(s, "breakdown");
say(s, "what's my total");
say(s, "ignore chromas, then only godlies");
assert.strictEqual(total(s), 80 + 180);
say(s, "clear my items");
assert.strictEqual(s.inventory().length, 0);
say(s, "undo");
assert.strictEqual(s.inventory().length, 8);
say(s, "blah blah");
say(s, "help");
console.log("\nALL CHAT TESTS PASSED");
