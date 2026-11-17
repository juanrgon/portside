// Regression checks for defects found in a QA pass. Each one failed before its fix.
// Run all with `node tests/e2e/qa/defects.mjs`, or one by passing part of its name.
import assert from "node:assert/strict";
import { start } from "../harness.mjs";

const only = process.argv[2] || "";
const results = [];

async function check(name, fn) {
  if (!name.includes(only)) return;
  const t = await start();
  try {
    await t.ask("sync");
    await fn(t);
    console.log(`PASS ${name}`);
    results.push({ name, passed: true });
  } catch (error) {
    console.log(`FAIL ${name}\n${error.stack}`);
    results.push({ name, passed: false });
  } finally {
    await t.stop();
  }
}

async function pin(t, tabId) {
  await t.ask("move", { item: { kind: "tab", tabId }, to: { zone: "pinned" } });
  return (await t.ask("view")).pinned.find((p) => p.tabId === tabId);
}

async function nativeSync(t) {
  await t.settle(500);
  await t.ask("sync");
}

await check("native-unpin-favorite", async (t) => {
  const tabId = await t.open("mail", "Inbox");
  await t.ask("move", { item: { kind: "tab", tabId }, to: { zone: "favs" } });
  await t.worker.evaluate((id) => chrome.tabs.update(id, { pinned: false }), tabId);
  await nativeSync(t);
  const v = await t.ask("view");
  // The favorite is kept so a stray unpin cannot delete something saved,
  // but it lets go of the tab, which is an ordinary tab again.
  assert.equal(v.favorites.length, 1);
  assert.equal(v.favorites[0].loaded, false, "the favorite must stop claiming a tab Chrome no longer pins");
  assert.ok(v.today.some((tab) => tab.tabId === tabId), "the unpinned tab must show as an ordinary tab");
});

await check("native-pin-saved-pin", async (t) => {
  const tabId = await t.open("docs", "Saved document");
  await pin(t, tabId);
  await t.worker.evaluate((id) => chrome.tabs.update(id, { pinned: true }), tabId);
  await nativeSync(t);
  const v = await t.ask("view");
  assert.ok(v.favorites.some((f) => f.tabId === tabId),
    "A saved pin pinned through Chrome must become a favorite, not remain group-only");
  assert.ok(!v.pinned.some((p) => p.tabId === tabId));
});

await check("native-move-pin-between-groups", async (t) => {
  const tabId = await t.open("docs", "Move me");
  const entry = await pin(t, tabId);
  const home = (await t.ask("view")).space.id;
  const work = await t.ask("addSpace", { name: "Work" });
  await t.open("work", "Work page");
  await nativeSync(t);
  const groupId = await t.worker.evaluate(async ([windowId, work]) =>
    (await chrome.storage.session.get("sess")).sess.groups[windowId][work],
  [t.mainWindowId, work]);
  await t.worker.evaluate(([tabId, groupId]) => chrome.tabs.group({ tabIds: [tabId], groupId }),
    [tabId, groupId]);
  await nativeSync(t);
  const v = await t.ask("view");
  assert.equal(v.space.id, work);
  assert.ok(v.pinned.some((p) => p.id === entry.id),
    `The pin must follow its live tab into Work instead of remaining in ${home}`);
});

await check("untitled-native-group", async (t) => {
  const tabId = await t.open("docs", "Ungrouped project");
  const groupId = await t.worker.evaluate(async (id) => {
    const tab = await chrome.tabs.get(id);
    return chrome.tabs.group({ tabIds: [id], createProperties: { windowId: tab.windowId } });
  }, tabId);
  await nativeSync(t);
  const v = await t.ask("view");
  const sess = await t.worker.evaluate(async () => (await chrome.storage.session.get("sess")).sess);
  assert.ok(Object.values(sess.groups[t.mainWindowId]).includes(groupId),
    "A native untitled group must get its own sidebar group instead of being treated as Home");
  assert.equal(v.spaces.length, 2);
});

await check("duplicate-native-group-restart", async (t) => {
  const tabId = await t.open("docs", "Second Home");
  await t.worker.evaluate(async (id) => {
    const tab = await chrome.tabs.get(id);
    const groupId = await chrome.tabs.group({ tabIds: [id], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: "Home", color: "red" });
  }, tabId);
  await nativeSync(t);
  const before = await t.ask("view");
  assert.equal(before.spaces.length, 2, "setup must import the second group");
  await t.worker.evaluate(() => chrome.storage.session.remove("sess"));
  await t.ask("sync");
  const after = await t.ask("view");
  assert.equal(after.spaces.length, before.spaces.length,
    `Restart must not invent another group; before=${before.spaces.map((s) => s.name)}, after=${after.spaces.map((s) => s.name)}`);
});

await check("closed-pin-steals-ordinary-duplicate", async (t) => {
  const original = await t.open("docs", "Shared page");
  const entry = await pin(t, original);
  await t.ask("closeEntryTab", { id: entry.id });
  const ordinary = await t.open("docs", "Shared page");
  await nativeSync(t);
  const v = await t.ask("view");
  assert.equal(v.pinned.find((p) => p.id === entry.id).loaded, false,
    "A deliberately closed pin must stay closed when a separate ordinary tab uses its URL");
  assert.ok(v.today.some((tab) => tab.tabId === ordinary));
});

await check("closed-pin-steals-loaded-pin-after-restart", async (t) => {
  const first = await t.open("docs", "Shared page");
  const second = await t.open("docs", "Shared page");
  const firstPin = await pin(t, first);
  const secondPin = await pin(t, second);
  await t.ask("renameEntry", { id: firstPin.id, title: "Closed pin" });
  await t.ask("renameEntry", { id: secondPin.id, title: "Open pin" });
  await t.ask("closeEntryTab", { id: firstPin.id });
  await nativeSync(t);
  const before = await t.ask("view");
  assert.equal(before.pinned.find((p) => p.id === firstPin.id).loaded, false);
  assert.equal(before.pinned.find((p) => p.id === secondPin.id).tabId, second);
  await t.worker.evaluate(() => chrome.storage.session.remove("sess"));
  await t.ask("sync");
  const v = await t.ask("view");
  assert.equal(v.pinned.find((p) => p.id === secondPin.id).tabId, second,
    "The open pin must keep its own tab instead of the earlier closed pin claiming it");
  assert.equal(v.pinned.find((p) => p.id === firstPin.id).loaded, false);
});

await check("close-loading-tab-loses-url", async (t) => {
  const url = t.site("slow", "Still loading", "held");
  const [page, tabId] = await Promise.all([
    t.context.waitForEvent("page"),
    t.worker.evaluate(async (windowId) =>
      (await chrome.tabs.create({ windowId, url: "about:blank", active: true })).id,
    t.mainWindowId),
  ]);
  await page.waitForLoadState();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await t.context.route(url, async (route) => {
    await held;
    await route.abort().catch(() => {});
  });
  const request = t.context.waitForEvent("request", (req) => req.url() === url);
  await t.worker.evaluate(([id, url]) => chrome.tabs.update(id, { url }), [tabId, url]);
  await request;
  const tab = await t.worker.evaluate((id) => chrome.tabs.get(id), tabId);
  assert.equal(tab.pendingUrl, url, "setup must hold the real local navigation before commit");
  try {
    await t.ask("closeTab", { tabId });
    const archive = await t.ask("archiveList");
    assert.ok(archive.some((item) => item.url === url),
      `Closing a loading web tab must archive its pending URL; committed URL was ${JSON.stringify(tab.url)}, archive=${JSON.stringify(archive)}`);
  } finally {
    release();
    await t.context.unroute(url);
  }
});

await check("clear-loading-navigation-saves-wrong-url", async (t) => {
  const tabId = await t.open("docs", "Old page", "old");
  const next = t.site("docs", "Important new page", "new");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await t.context.route(next, async (route) => {
    await held;
    await route.abort().catch(() => {});
  });
  const request = t.context.waitForEvent("request", (req) => req.url() === next);
  await t.worker.evaluate(([id, url]) => chrome.tabs.update(id, { url }), [tabId, next]);
  await request;
  try {
    await t.ask("clearToday");
    const archive = await t.ask("archiveList");
    assert.ok(archive.some((item) => item.url === next),
      `Clear must preserve the page being loaded, not just the previous document: ${JSON.stringify(archive)}`);
  } finally {
    release();
    await t.context.unroute(next);
  }
});

await check("command-bar-go-to-group", async (t) => {
  const home = (await t.ask("view")).space.id;
  const work = await t.ask("addSpace", { name: "Work" });
  await t.open("work", "Work document");
  await t.ask("switchSpace", { id: home });
  const [bar] = await Promise.all([
    t.context.waitForEvent("page", (page) => page.url().includes("bar/bar.html")),
    t.worker.evaluate((windowId) => chrome.tabs.create({ windowId }).then(() => {}), t.mainWindowId),
  ]);
  await bar.waitForSelector(".hit");
  await bar.locator("#q").fill("Go to Work");
  await bar.waitForSelector(".hit.on:has-text('Go to Work')");
  const closed = bar.waitForEvent("close");
  await bar.keyboard.press("Enter").catch((error) => {
    if (!bar.isClosed()) throw error;
  });
  await closed;
  await nativeSync(t);
  assert.equal((await t.ask("view")).space.id, work,
    "The Go to Work command must switch spaces before destroying its own page");
});

await check("second-window-changes-first-window-group", async (t) => {
  const home = (await t.ask("view")).space.id;
  await t.open("home", "Window one Home");
  const secondWindow = await t.worker.evaluate((url) =>
    chrome.windows.create({ url, type: "normal" }), t.site("second", "Window two"));
  await nativeSync(t);
  const work = await t.ask("addSpace", { windowId: secondWindow.id, name: "Work" });
  await nativeSync(t);
  const one = await t.ask("view");
  const active = (await t.tabs()).find((tab) => tab.active);
  assert.ok(active && one.space.id === home,
    `Window one still displays Home's active tab (${active?.title}), but its sidebar switched to ${one.space.name} (${work})`);
});

await check("archive-list-hides-older-records", async (t) => {
  await t.worker.evaluate(async (base) => {
    const { state } = await chrome.storage.local.get("state");
    state.archive = Array.from({ length: 301 }, (_, i) => ({
      id: `seed-${i}`,
      title: `Archived page ${i}`,
      url: `${base}&page=${i}`,
      spaceId: state.activeSpaceId,
      closedAt: Date.now() - i * 1000,
      reason: "manual",
    }));
    await chrome.storage.local.set({ state });
  }, t.site("archive", "Saved"));
  const v = await t.ask("view");
  assert.equal(v.archiveCount, 301, "setup must stay far below the 1,000-record storage cap");
  await t.panel.locator(".foot .chip[title='Archived tabs']").click();
  await t.panel.waitForSelector(".row.old");
  const listed = await t.ask("archiveList");
  assert.equal(listed.length, 301,
    "All retained archive records must be reachable by browsing, not only the newest 300");
});

await check("restart-forgets-drifted-pin", async (t) => {
  const tabId = await t.open("docs", "Saved document", "saved");
  const entry = await pin(t, tabId);
  const current = t.site("docs", "Draft in progress", "draft");
  await t.worker.evaluate(([id, url]) => chrome.tabs.update(id, { url }), [tabId, current]);
  for (let i = 0; i < 80; i++) {
    const tab = await t.worker.evaluate((id) => chrome.tabs.get(id), tabId);
    if (tab.url === current && tab.status === "complete") break;
    await t.settle(50);
  }
  await nativeSync(t);
  assert.equal((await t.ask("view")).pinned.find((p) => p.id === entry.id).tabId, tabId);
  await t.worker.evaluate(() => chrome.storage.session.remove("sess"));
  await t.ask("sync");
  const v = await t.ask("view");
  assert.equal(v.pinned.find((p) => p.id === entry.id).tabId, tabId,
    "Restart must retain a pin's live tab even when it has left its saved page");
  assert.ok(!v.today.some((tab) => tab.tabId === tabId));
});

await check("last-tab-does-not-jump-to-another-window", async (t) => {
  const first = await t.open("docs", "Stay in this window");
  const moved = await t.open("news", "Moved away");
  await t.ask("activateTab", { tabId: first });
  await nativeSync(t);
  const secondWindow = await t.worker.evaluate((url) =>
    chrome.windows.create({ url, type: "normal" }), t.site("second", "Second window"));
  await nativeSync(t);
  await t.worker.evaluate(([id, windowId]) => chrome.tabs.move(id, { windowId, index: -1 }),
    [moved, secondWindow.id]);
  await nativeSync(t);
  assert.equal((await t.worker.evaluate((id) => chrome.tabs.get(id), moved)).active, false);
  await t.ask("lastTab");
  const after = await t.worker.evaluate((id) => chrome.tabs.get(id), moved);
  assert.equal(after.active, false,
    "Previous tab in window one must not activate a stale history entry moved to window two");
});

await check("command-bar-double-enter-duplicates-favorite", async (t) => {
  const tabId = await t.open("mail", "Inbox");
  const [bar] = await Promise.all([t.context.waitForEvent("page"), t.ask("openBar")]);
  await bar.waitForSelector(".hit");
  await bar.locator("#q").fill("Add to favorites");
  await bar.waitForSelector(".hit.on:has-text('Add to favorites')");
  const closed = bar.waitForEvent("close");
  await bar.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }).catch((error) => {
    if (!bar.isClosed()) throw error;
  });
  await closed;
  await nativeSync(t);
  const v = await t.ask("view");
  assert.equal(v.favorites.filter((f) => f.tabId === tabId).length, 1,
    "Two Enter events before the first action finishes must not create duplicate favorites");
});

await check("command-bar-close-targets-other-window", async (t) => {
  const first = await t.open("docs", "Window one document");
  const moved = await t.open("news", "Do not close window two");
  await t.ask("activateTab", { tabId: first });
  const initial = (await t.tabs()).find((tab) => tab.title === "Start");
  await t.worker.evaluate((id) => chrome.tabs.remove(id), initial.id);
  const secondWindow = await t.worker.evaluate((url) =>
    chrome.windows.create({ url, type: "normal" }), t.site("second", "Second window"));
  await t.worker.evaluate(([id, windowId]) => chrome.tabs.move(id, { windowId, index: -1 }),
    [moved, secondWindow.id]);
  await nativeSync(t);
  const [bar] = await Promise.all([
    t.context.waitForEvent("page", (page) => page.url().includes("bar/bar.html")),
    t.worker.evaluate((windowId) => chrome.tabs.create({ windowId }).then(() => {}), t.mainWindowId),
  ]);
  await bar.waitForSelector(".hit");
  // The new-tab bar stays open when another, inactive tab is closed in Chrome.
  await t.worker.evaluate((id) => chrome.tabs.remove(id), first);
  await nativeSync(t);
  await t.ask("closeCurrent");
  const otherTabs = await t.worker.evaluate((windowId) => chrome.tabs.query({ windowId }), secondWindow.id);
  assert.ok(otherTabs.some((tab) => tab.id === moved),
    "Close tab from window one's command bar must not close a moved history tab in window two");
});

await check("command-bar-ipv6-address-is-not-a-search", async (t) => {
  const [bar] = await Promise.all([t.context.waitForEvent("page"), t.ask("openBar")]);
  await bar.waitForSelector(".hit");
  const port = new URL(t.site("local", "Local")).port;
  await bar.locator("#q").fill(`[::ffff:127.0.0.1]:${port}/?t=Local`);
  assert.match(await bar.locator(".hit.on").innerText(), /Go to this link/,
    "A valid bare IPv6 loopback address must be treated as a link, not sent to search");
});

await check("native-rename-overwritten-by-second-window", async (t) => {
  const home = (await t.ask("view")).space.id;
  const groupId = await t.worker.evaluate(async ([windowId, home]) =>
    (await chrome.storage.session.get("sess")).sess.groups[windowId][home],
  [t.mainWindowId, home]);
  await t.worker.evaluate((url) =>
    chrome.windows.create({ url, type: "normal" }), t.site("second", "Second Home window"));
  await nativeSync(t);
  await t.worker.evaluate((id) =>
    chrome.tabGroups.update(id, { title: "Research", color: "orange" }), groupId);
  await nativeSync(t);
  const v = await t.ask("view");
  assert.deepEqual({ name: v.space.name, color: v.space.color },
    { name: "Research", color: "orange" },
    "A native rename and recolor in window one must not be overwritten by window two's stale group");
});

await check("clear-crosses-into-untitled-native-group", async (t) => {
  const tabId = await t.open("docs", "Separate untitled group");
  await t.worker.evaluate(async (id) => {
    const tab = await chrome.tabs.get(id);
    await chrome.tabs.group({ tabIds: [id], createProperties: { windowId: tab.windowId } });
  }, tabId);
  await nativeSync(t);
  const start = (await t.tabs()).find((tab) => tab.title === "Start");
  await t.ask("activateTab", { tabId: start.id });
  await nativeSync(t);
  await t.ask("clearToday");
  assert.ok((await t.tabs()).some((tab) => tab.id === tabId),
    "Clearing Home must leave tabs in a separate native group open, even when that group has no title");
});

console.log(`\n${results.filter((r) => r.passed).length}/${results.length} QA checks passed`);
process.exitCode = results.some((r) => !r.passed) ? 1 : 0;
