// Run with Node's test runner and Playwright on the module path; see README.md.
// The Usage page's allowances as a table beside the cards (zysicyj on X: "a
// dozen-plus accounts, the waterfall is hard to scan, could it be a
// table"). Cards stay the default and the table is the reader's own pick,
// remembered on this computer: a row an account, its subscription and
// account first, then its windows' share and when they start again; a click
// on a head sorts by it, again the other way, a third time back to the
// cards' order. A narrow window scrolls the table in its own box, never the
// page. Both engines, every language, wide and narrow; no backend, the API
// is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const H = 3600e3;
const at = (h) => new Date(Date.now() + h * H).toISOString();
const w = (name, used, h) => ({ name, used, resetsAt: at(h) });
// as a user with a dozen-plus accounts has them: several of one agent,
// plans with other windows, a balance, a failed read
const quotas = [
  ...[["a", 20, 40], ["b", 90, 10], ["c", 55, 75], ["d", 5, 99]].map(([u, five, week]) => (
    { provider: "codex", name: "Codex", kind: "subscription", icon: "codex-color", plan: "Plus", user: u + "@example.com", windows: [w("5 hours", five, 2), w("7 days", week, 90)] })),
  ...[["e", 33, 12], ["f", 71, 61], ["g", 9, 3]].map(([u, five, week]) => (
    { provider: "claude", name: "Claude Code", kind: "subscription", icon: "claude-color", plan: "Max 5x", user: u + "@example.com", windows: [w("5 hours", five, 3), w("7 days", week, 80), w("7 days Opus", 14, 80)] })),
  { provider: "antigravity", name: "Antigravity", icon: "antigravity-color", plan: "Google AI Pro", user: "h@example.com", windows: [
    { name: "Gemini 3 Flash", family: "Gemini", used: 100, resetsAt: at(13) }, { name: "Claude Sonnet 4.6", family: "Claude", used: 0, resetsAt: at(5) }] },
  { provider: "kimi", name: "Kimi", icon: "kimi", user: "i@example.com", windows: [w("Weekly", 42, 70)] },
  { provider: "zai", name: "Z.ai", icon: "zai", user: "j@example.com", windows: [w("5 hours", 64, 1), w("Weekly", 12, 70)] },
  { provider: "deepseek", name: "DeepSeek", icon: "deepseek", windows: [], balance: "¥17.41" },
  { provider: "minimax", name: "MiniMax", icon: "minimax", user: "k@example.com", windows: [], error: "unauthorized" },
  { provider: "codex", name: "Codex", kind: "subscription", icon: "codex-color", plan: "Pro", user: "l@example.com", windows: [w("5 hours", 0, 5), w("7 days", 0, 160)] },
  { provider: "claude", name: "Claude Code", kind: "subscription", icon: "claude-color", plan: "Pro", user: "m@example.com", windows: [w("5 hours", 12, 4), w("7 days", 25, 100)] },
  { provider: "kimi", name: "Kimi", icon: "kimi", user: "n@example.com", windows: [w("Weekly", 77, 70)] },
];

function serve(lang, left, cards = quotas, provs = [], more = {}) {
  const settings = { theme: "light", lang, tray: "panel", quotaLeft: left, currency: "usd", ...more };
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings });
    if (url.pathname === "/api/settings") return json(settings);
    if (url.pathname === "/api/providers") return json({ providers: provs, presets: [], excluded: [], gateway: { running: true, window: true } });
    if (url.pathname === "/api/usage/quotas") return json(cards);
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

const CARDS = { en: "Cards", zh: "卡片", "zh-TW": "卡片", ja: "カード", de: "Karten" };
const TABLE = { en: "Table", zh: "表格", "zh-TW": "表格", ja: "表", de: "Tabelle" };

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) {
    for (const width of [1100, 420]) {
      test(`${engine} ${lang} ${width}px: the allowances as cards or a table`, async (t) => {
        const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
        t.after(() => browser.close());
        const page = await (await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: "reduce" })).newPage();
        page.setDefaultTimeout(5000);
        page.setDefaultNavigationTimeout(60000);
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("**/*", serve(lang, false));
        await page.goto("http://magpie.test/?view=usage");
        await page.waitForSelector("#subscriptionUsage .subscription-card");

        // cards until the reader picks the table
        assert.equal(await page.locator(".qt").count(), 0);
        assert.equal(await page.locator("#quotaView .opt.on").innerText(), CARDS[lang]);
        assert.equal(await page.evaluate(() => localStorage.getItem("magpie.quotaView")), null, "nothing is saved until the reader picks");

        await page.locator("#quotaView .opt", { hasText: TABLE[lang] }).click();
        await page.waitForSelector("#subscriptionUsage .qt tbody tr");
        assert.equal(await page.locator("#subscriptionUsage .subscription-card").count(), 0);
        // a row a provider, its several accounts folded under it (#6740)
        const accounts = quotas.length;
        assert.equal(await page.locator(".qt tbody tr").count(), 7);
        assert.equal(await page.locator(".qt tbody tr.qt-group").count(), 3);
        const heads = await page.$$eval(".qt thead th", (ths) => ths.map((x) => x.textContent.trim()));
        assert.equal(heads.length, 2 + 4 + 1, `${heads}`);
        // the cards' figures, the same readings
        const nth = (n) => page.$eval(`.qt tbody tr:nth-child(${n})`, (tr) => tr.innerText.replace(/\s+/g, " "));
        // Codex's five accounts: their windows' mean share
        const group = await nth(1);
        assert.match(group, /Codex/);
        assert.match(group, /34%/);
        assert.match(group, /45%/);
        while (await page.locator('.qt-fold[aria-expanded="false"]').count()) await page.locator('.qt-fold[aria-expanded="false"]').first().click();
        assert.equal(await page.locator(".qt tbody tr").count(), accounts + 3);
        const row = await nth(2);
        assert.match(row, /a@example\.com/);
        assert.match(row, /20%/);
        assert.match(row, /40%/);
        // when each starts again
        assert.ok((await page.$$eval(".qt .qt-reset", (x) => x.length)) >= accounts, "resets are shown");
        // a failed read and a balance say so across the windows
        assert.equal(await page.locator('.qt tbody tr:has-text("¥17.41")').count(), 1);
        assert.equal(await page.locator(".qt tbody tr .qt-msg").count(), 2);

        // the pick is remembered
        assert.equal(await page.evaluate(() => localStorage.getItem("magpie.quotaView")), '"table"');
        await page.reload();
        await page.waitForSelector("#subscriptionUsage .qt tbody tr");
        assert.equal(await page.locator("#quotaView .opt.on").innerText(), TABLE[lang]);
        assert.equal(await page.locator(".qt tbody tr").count(), accounts + 3, "the open providers stay open");

        // sorted by a window: the most used first, again the least, then the cards' order
        // a provider by its accounts' mean, its accounts among themselves
        const first = () => nth(1);
        const fiveHours = page.locator(".qt thead th.qt-w .qt-sort").first();
        await fiveHours.click();
        assert.match(await first(), /j@example\.com/, "Z.ai's 64% over Codex's 34%");
        assert.match(await nth(2), /Codex/);
        assert.match(await nth(3), /b@example\.com/);
        assert.equal(await page.locator('.qt thead th[aria-sort="descending"]').count(), 1);
        await page.locator(".qt thead th.qt-w .qt-sort").first().click();
        assert.match(await first(), /Claude Code/, "ascending: Claude Code's 31% first");
        assert.match(await nth(2), /g@example\.com/);
        assert.equal(await page.locator('.qt thead th[aria-sort="ascending"]').count(), 1);
        await page.locator(".qt thead th.qt-w .qt-sort").first().click();
        assert.match(await first(), /Codex/, "back to the cards' order");
        assert.match(await nth(2), /a@example\.com/);
        assert.equal(await page.locator('.qt thead th[aria-sort]:not([aria-sort="none"])').count(), 0);
        // by account, A first
        await page.locator(".qt thead th.qt-acct .qt-sort").click();
        assert.match(await nth(2), /a@example\.com/);

        // the page itself never scrolls sideways; the table scrolls in its box
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(over <= 0, `the page scrolls sideways by ${over}px`);
        const box = await page.$eval(".qt-wrap", (b) => ({ w: b.clientWidth, s: b.scrollWidth, page: document.documentElement.clientWidth, right: b.getBoundingClientRect().right }));
        assert.ok(box.right <= box.page + 1, "the table's box stays inside the page");
        if (width === 420) assert.ok(box.s > box.w, "a narrow table scrolls in its box");

        // back to the cards
        await page.locator("#quotaView .opt", { hasText: CARDS[lang] }).click();
        await page.waitForSelector("#subscriptionUsage .subscription-card");
        assert.equal(await page.locator(".qt").count(), 0);
        assert.equal(await page.evaluate(() => document.querySelector("#subscriptionUsage").classList.contains("tabled")), false);
        assert.deepEqual(errors, []);
      });
    }
  }
  test(`${engine}: Left reads in the table too`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 }, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(5000);
    await page.addInitScript(() => { localStorage.setItem("magpie.quotaView", '"table"'); localStorage.setItem("magpie.quotaTableOpen", '["codex"]'); });
    await page.route("**/*", serve("en", true));
    await page.goto("http://magpie.test/?view=usage");
    await page.waitForSelector("#subscriptionUsage .qt tbody tr");
    assert.match(await page.$eval(".qt tbody tr:nth-child(1)", (tr) => tr.innerText.replace(/\s+/g, " ")), /66%/, "Codex's accounts' mean left");
    const row = await page.$eval(".qt tbody tr:nth-child(2)", (tr) => tr.innerText.replace(/\s+/g, " "));
    assert.match(row, /80%/);
    assert.match(row, /60%/);
  });
}

// seven accounts each capped at 95% (the reader's own, whose 16% of five
// hours used was in fact none left): four with their week at the cap,
// which holds their five hours, and one past it in its five hours
const capCards = () => [
  ["hunter", 0, 95], ["hater", 1, 67], ["skater", 12, 94], ["runner", 0, 96],
  ["swimmer", 0, 96], ["otter", 0, 95], ["panther", 98, 39],
].map(([user, five, week]) => ({
  provider: "claude", name: "Claude Code", kind: "subscription", icon: "claude-color", plan: "Pro", user: user + "@example.com",
  windows: [["5 hours", five, 4], ["7 days", week, 72]].map(([name, used, hours]) => ({ name, used, resetsAt: at(hours) })),
}));
const capProvider = { id: "claude", accountCaps: Object.fromEntries(capCards().map((q) => [q.user, 95])) };
for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  test(`${engine} zh: Used and Left each count against the whole allowance or up to the cap`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(60000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem("magpie.quotaView", '"table"'));
    await page.route("**/*", serve("zh", false, capCards(), [capProvider]));
    await page.goto("http://magpie.test/?view=usage");
    const group = page.locator(".qt tbody tr.qt-group");
    await group.waitFor();
    const text = async () => (await group.innerText()).replace(/\s+/g, " ");
    assert.match(await text(), /16%/, "the original percentage view is unchanged");
    assert.match(await text(), /83%/);
    const modes = page.locator("#quotaMode .opt");
    assert.equal(await modes.count(), 2, "Used and Left stay the head's only two choices");
    const label = async () => (await page.locator("#quotaMode .opt.on").innerText()).trim();
    assert.equal(await label(), "已用", "the whole allowance says nothing more");
    const waitFor = (sel, s) => page.waitForFunction(([sel, s]) => document.querySelector(sel)?.innerText.includes(s), [sel, s], { timeout: 3000 }).catch(async () => {
      throw new Error(`${sel} never said ${s}: ` + (await page.locator(sel).first().innerText()).replace(/\s+/g, " ") + " · page errors: " + errors.join(" | "));
    });
    // the picked one, clicked again, opens the menu of what it counts against
    const countAgainst = async (name) => {
      await page.locator("#quotaMode .opt.on").click();
      const items = page.locator(".proto-menu .pm-item");
      assert.deepEqual((await items.locator(".pm-name").allInnerTexts()).map((s) => s.trim()), ["全部额度", "上限内"]);
      await items.filter({ hasText: name }).click();
    };

    // the page's refresh draws the allowances again while the menu is open:
    // the menu stays on its button, and a click on that button closes it
    await page.locator("#quotaMode .opt.on").click();
    await page.locator(".proto-menu").waitFor();
    await page.evaluate(() => renderQuotas());
    assert.equal(await page.locator("#quotaMode .opt.on.open").count(), 1, "the open menu's button is kept through a redraw");
    await page.locator("#quotaMode .opt.on").click();
    await page.locator(".proto-menu").waitFor({ state: "detached" });
    assert.equal(await page.locator("#quotaMode .opt.open").count(), 0);

    // Used, up to the cap: 95% is all of it, and a week at its cap holds
    // the five hours, so the summary is 73% and not the vendor's 16%
    await countAgainst("上限内");
    await waitFor(".qt-group", "73%");
    assert.equal(await label(), "已用 · 上限内");
    assert.match(await text(), /87%/, "the weeks up to their caps: " + await text());
    await group.locator(".qt-fold").click();
    const hunter = page.locator(".qt tbody tr", { hasText: "hunter@example.com" });
    const panther = page.locator(".qt tbody tr", { hasText: "panther@example.com" });
    const row = async (r) => (await r.innerText()).replace(/\s+/g, " ");
    assert.match(await row(hunter), /100%.*100%/, "hunter's week at its cap, and the five hours it holds: " + await row(hunter));
    assert.match(await row(panther), /100%.*41%/, "panther past its cap in five hours, its week 39 of 95: " + await row(panther));

    // Left keeps it: what is left before the caps
    await modes.filter({ hasText: "剩余" }).click();
    await waitFor(".qt-group", "27%");
    assert.equal(await label(), "剩余 · 上限内");
    assert.match(await text(), /13%/, "the weeks left before their caps: " + await text());
    assert.match(await row(hunter), /0%.*0%/, "the capped week holds hunter's five hours");
    assert.match(await row(panther), /0%.*59%/);
    if (process.env.ARTIFACT_DIR) {
      await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `quota-up-to-cap-${engine}.png`), fullPage: true });
    }

    // the cards' all-accounts strip counts the same shares, held ones none left
    await page.locator("#quotaView .opt", { hasText: "卡片", exact: true }).click();
    const strip = '#subscriptionUsage > [data-key="claude"] .quota-all';
    await waitFor(strip, "26.6%");
    assert.match((await page.locator(strip).innerText()).replace(/\s+/g, " "), /12\.8%/);
    await modes.filter({ hasText: "已用" }).click();
    await waitFor(strip, "73.4%");
    assert.match((await page.locator(strip).innerText()).replace(/\s+/g, " "), /87\.2%/);
    await page.locator("#quotaView .opt", { hasText: "表格", exact: true }).click();
    await page.waitForSelector(".qt-group");
    await modes.filter({ hasText: "剩余" }).click();
    await waitFor(".qt-group", "27%");

    // the whole allowance again, Left as it was
    await countAgainst("全部额度");
    await waitFor(".qt-group", "84%");
    assert.equal(await label(), "剩余");
    assert.match(await text(), /17%/, "switching back restores the raw percentages left: " + await text());
    await modes.filter({ hasText: "已用" }).click();
    await waitFor(".qt-group", "16%");
    assert.match(await text(), /83%/, "and used");
    assert.deepEqual(errors, []);
  });

  // a row hidden from the Overview (settings.usageWindowsHidden) still
  // counts: the weeks at their caps, hidden, hold the five hours shown
  test(`${engine} zh: up to the cap, a week hidden at its cap still holds the five hours`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(60000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      localStorage.setItem("magpie.quotaView", '"table"');
      localStorage.setItem("magpie.quotaUnderCap", "true");
    });
    await page.route("**/*", serve("zh", false, capCards(), [capProvider], { usageWindowsHidden: ["claude|7 days"] }));
    await page.goto("http://magpie.test/?view=usage");
    const group = page.locator(".qt tbody tr.qt-group");
    await group.waitFor();
    const heads = await page.$$eval(".qt thead th", (ths) => ths.map((x) => x.textContent.trim()));
    assert.ok(!heads.some((h) => h.startsWith("7 天")), "the week's row is hidden: " + heads.join(", "));
    await page.waitForFunction(() => document.querySelector(".qt-group")?.innerText.includes("73%"), undefined, { timeout: 5000 }).catch(async () => {
      throw new Error("the hidden weeks held no five hours: " + (await group.innerText()).replace(/\s+/g, " ") + " · page errors: " + errors.join(" | "));
    });
    assert.equal((await page.locator("#quotaMode .opt.on").innerText()).trim(), "已用 · 上限内");
    await group.locator(".qt-fold").click();
    const hunter = page.locator(".qt tbody tr", { hasText: "hunter@example.com" });
    assert.match((await hunter.innerText()).replace(/\s+/g, " "), /100%/, "hunter's hidden week at its cap holds its five hours");
    assert.deepEqual(errors, []);
  });
}
