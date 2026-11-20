// The Usage page's Up to the cap: each share taken up to its account's
// cap, the cap as 100%, and a window a longer one at its cap stops held as
// used up (capShares in the usage plugin). The cards are as
// /api/usage/quotas sends them, with no capped or capId; the real cap
// readers from app.js; no browser or network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const read = (f) => fs.readFileSync(path.resolve(__dirname, "../assets/" + f), "utf8").replace(/\r\n/g, "\n");
const app = read("app.js"), page = read("plugins/usage/page.js");
const a = app.indexOf("function accountCapOf("), b = app.indexOf("// capHeldOf:", a);
const c = page.indexOf("function capShares("), d = page.indexOf("\n}\n", page.indexOf("function capSpan(")) + 3;
assert(a >= 0 && b > a && c >= 0 && d > c, "the cap readers and capShares");

function context(under = true, ps) {
  const ctx = vm.createContext({
    quotaUnderCap: under,
    providers: { providers: ps || [{ id: "claude", accountCaps: { "a@example.com": 95 } }] },
    providersEarly: null,
  });
  vm.runInContext(app.slice(a, b) + "\n" + page.slice(c, d), ctx);
  return ctx;
}
const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const card = (five, week, more = {}) => ({
  provider: "claude", user: "a@example.com", ...more,
  windows: [
    { name: "5 hours", used: five, resetsAt: soon(4) },
    { name: "7 days", used: week, resetsAt: soon(72) },
  ],
});
const used = (ctx, q) => ctx.capShares([q])[0].windows.map((w) => +w.used.toFixed(2));

test("the whole allowance leaves the cards as they are", () => {
  const ctx = context(false), list = [card(50, 20)];
  assert.equal(ctx.capShares(list), list);
});

test("a share is counted up to the cap, the cap as 100%", () => {
  const ctx = context();
  assert.deepEqual(used(ctx, card(47.5, 19)), [50, 20]);
  assert.deepEqual(used(ctx, card(12, 94)), [12.63, 98.95]);
  assert.deepEqual(used(ctx, card(98, 39)), [100, 41.05], "past its cap is all used, and the week isn't held by five hours");
});

test("a longer window at its cap holds the shorter one as used up", () => {
  const ctx = context(), [five, week] = ctx.capShares([card(0, 95)])[0].windows;
  assert.equal(five.used, 100);
  assert.equal(five.heldBy, "7 days", "held as the gateway's own holds are, for the all-accounts strip");
  assert.equal(week.used, 100);
  assert.equal(week.heldBy, undefined);
});

test("a cap renewed since its reading, or a window of some models, holds nothing", () => {
  const ctx = context(), renewed = card(10, 95);
  renewed.windows[1].resetsAt = new Date(Date.now() - 60e3).toISOString();
  assert.deepEqual(used(ctx, renewed), [10.53, 100]);
  const some = card(10, 20);
  some.windows.push({ name: "7 days Opus", used: 99, resetsAt: soon(72) });
  assert.deepEqual(used(ctx, some), [10.53, 21.05, 100], "Opus at its cap stops Opus, not the account");
  const pool = card(10, 20);
  pool.windows.push({ name: "7 days", pool: "Gemini", used: 99, resetsAt: soon(72) });
  assert.deepEqual(used(ctx, pool), [10.53, 21.05, 100], "a pool's window stops its pool's models");
});

test("a pool's own window at its cap holds its own pool's windows, no other", () => {
  // Antigravity's pools as /api/usage/quotas sends them (window_held_test.go's
  // TestHeldWindowsInAPool): a pool's own windows name no family, its models' do
  const ctx = context(true, [{ id: "antigravity", accountCaps: { "a@example.com": 95 } }]);
  // the week and its model start again together (one reading), so the
  // week doesn't outlast, and doesn't hold, the model's own window
  const weekEnds = soon(80);
  const card = (week) => ({ provider: "antigravity", user: "a@example.com", windows: [
    { name: "Claude Opus 5.5 (Thinking)", family: "Claude", pool: "Claude & GPT", used: 40, resetsAt: weekEnds },
    { name: "Gemini 3.8 Flash", family: "Gemini", pool: "Gemini", used: 50, resetsAt: soon(2) },
    { name: "5 hours", pool: "Gemini", used: 50, resetsAt: soon(2) },
    { name: "7 days", pool: "Gemini", used: 24, resetsAt: soon(140) },
    { name: "5 hours", pool: "Claude & GPT", used: 0, resetsAt: soon(2) },
    { name: "7 days", pool: "Claude & GPT", used: week, resetsAt: weekEnds },
  ] });
  const held = (q) => ctx.capShares([q])[0].windows.filter((w) => w.heldBy).map((w) => `${w.pool} · ${w.name} by ${w.heldBy}`);
  assert.deepEqual(held(card(95)), ["Claude & GPT · 5 hours by 7 days"], "the week at its cap holds its pool's 5 hours, not Gemini's");
  assert.deepEqual(held(card(94)), [], "a week below its cap holds nothing");
  assert.deepEqual(used(ctx, card(95)), [42.11, 52.63, 52.63, 25.26, 100, 100]);
});

test("with no reset said, the longer window by its name outlasts", () => {
  const ctx = context(), q = card(30, 96);
  for (const w of q.windows) delete w.resetsAt;
  assert.deepEqual(used(ctx, q), [100, 100]);
  const weekly = { provider: "claude", user: "a@example.com", windows: [{ name: "5h", used: 10 }, { name: "Weekly", used: 95 }] };
  assert.deepEqual(used(ctx, weekly), [100, 100]);
});

test("what the cap doesn't count, or can't be read, stays as it was", () => {
  const ctx = context(), q = card(50, 20);
  q.windows.push({ name: "Overages", used: 100, text: true }, { name: "Usage credits", used: 40, extra: true });
  const [, , text, extra] = ctx.capShares([q])[0].windows;
  assert.equal(text, q.windows[2], "a text window");
  assert.equal(extra.used, 40, "money set aside past the plan");
  const remote = card(50, 95, { from: "office" });
  assert.equal(ctx.capShares([remote])[0], remote, "another magpie's card: its caps are its own");
  const none = context(true, [{ id: "claude" }]);
  assert.deepEqual(used(none, card(50, 95)), [50, 95], "no cap is the vendor's 100%");
  const unread = context(true, []);
  unread.providers = null;
  const list = [card(50, 95)];
  assert.equal(unread.capShares(list), list, "caps not read yet");
});

test("a window's own cap, known by its name as WindowCapID makes it, wins over the account's", () => {
  const ctx = context(true, [{ id: "claude", accountCaps: { "a@example.com": 95 },
    accountWindowCaps: { "a@example.com": { "5 hours": 50, "gemini · 5 hours": 40 } } }]);
  assert.deepEqual(used(ctx, card(25, 19)), [50, 20]);
  const pool = { provider: "claude", user: "a@example.com", windows: [{ name: "5 hours", pool: "Gemini", used: 20 }] };
  assert.deepEqual(used(ctx, pool), [50], "a pool's window by its pool's name before its own");
});

test("the cards themselves are left as they were", () => {
  const ctx = context(), q = card(0, 95), before = JSON.stringify(q);
  ctx.capShares([q]);
  assert.equal(JSON.stringify(q), before);
});
