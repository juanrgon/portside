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
    results.push(true);
  } catch (error) {
    console.log(`FAIL ${name}\n${error.stack}`);
    results.push(false);
  } finally {
    await t.stop();
  }
}

await check("native-rename-and-recolor", async (t) => {
  const home = (await t.ask("view")).space.id;
  const groupId = await t.worker.evaluate(async ([windowId, home]) =>
    (await chrome.storage.session.get("sess")).sess.groups[windowId][home],
  [t.mainWindowId, home]);
  await t.worker.evaluate((groupId) =>
    chrome.tabGroups.update(groupId, { title: "Renamed in Chrome", color: "orange" }), groupId);
  await t.settle(500);
  await t.ask("sync");
  const v = await t.ask("view");
  assert.equal(v.space.name, "Renamed in Chrome");
  assert.equal(v.space.color, "orange");
});

await check("deleting-folder-keeps-open-and-closed-pins", async (t) => {
  const first = await t.open("docs", "Open pin");
  const second = await t.open("docs", "Closed pin");
  const folderId = await t.ask("addFolder", { name: "To keep" });
  for (const tabId of [first, second]) {
    await t.ask("move", {
      item: { kind: "tab", tabId },
      to: { zone: "pinned", folderId },
    });
  }
  const before = await t.ask("view");
  await t.ask("closeEntryTab", { id: before.pinned.find((p) => p.tabId === second).id });
  await t.ask("deleteFolder", { id: folderId });
  const after = await t.ask("view");
  assert.equal(after.folders.length, 0);
  assert.equal(after.pinned.length, 2);
  assert.ok(after.pinned.every((p) => p.folderId === null));
  assert.equal(after.pinned.find((p) => p.title === "Open pin").tabId, first);
  assert.equal(after.pinned.find((p) => p.title === "Closed pin").loaded, false);
});

await check("clear-preserves-non-web-pages-and-last-window", async (t) => {
  await t.open("docs", "Archive me");
  await t.worker.evaluate((windowId) =>
    chrome.tabs.create({ windowId, url: "chrome://version/", active: true }), t.mainWindowId);
  await t.ask("sync");
  await t.ask("clearToday");
  const v = await t.ask("view");
  assert.equal(v.archiveCount, 2);
  assert.equal(v.today.length, 1);
  assert.equal(v.today[0].url, "chrome://version/");
  await t.ask("closeTab", { tabId: v.today[0].tabId });
  assert.ok((await t.tabs()).length > 0);
  assert.equal((await t.ask("view")).archiveCount, 2);
});

await check("deleting-group-keeps-ordinary-live-tabs", async (t) => {
  const home = (await t.ask("view")).space.id;
  const work = await t.ask("addSpace", { name: "Work" });
  const tabId = await t.open("docs", "Keep this document");
  await t.ask("deleteSpace", { id: work });
  const v = await t.ask("view");
  assert.equal(v.space.id, home);
  assert.ok(v.today.some((tab) => tab.tabId === tabId));
  assert.equal(v.archiveCount, 0);
});

await check("native-pin-ordinary-tab-imports-favorite", async (t) => {
  const tabId = await t.open("mail", "Inbox");
  await t.worker.evaluate((id) => chrome.tabs.update(id, { pinned: true }), tabId);
  await t.settle(500);
  await t.ask("sync");
  const v = await t.ask("view");
  assert.equal(v.favorites.length, 1);
  assert.equal(v.favorites[0].tabId, tabId);
});

await check("archive-cap-retains-newest-1000", async (t) => {
  await t.worker.evaluate(async (base) => {
    const { state } = await chrome.storage.local.get("state");
    state.archive = Array.from({ length: 1000 }, (_, i) => ({
      id: `seed-${i}`,
      title: `Archived page ${i}`,
      url: `${base}&page=${i}`,
      spaceId: state.activeSpaceId,
      closedAt: Date.now() - i * 1000,
      reason: "manual",
    }));
    await chrome.storage.local.set({ state });
  }, t.site("archive", "Saved"));
  const tabId = await t.open("docs", "Newest archived page");
  await t.ask("closeTab", { tabId });
  const stored = await t.worker.evaluate(async () =>
    (await chrome.storage.local.get("state")).state.archive);
  assert.equal(stored.length, 1000);
  assert.equal(stored[0].title, "Newest archived page");
  assert.equal(stored.at(-1).id, "seed-998");
});

await check("ordinary-messages-serialize-without-lost-pins", async (t) => {
  const tabIds = [];
  for (let i = 0; i < 8; i++) tabIds.push(await t.open("docs", `Concurrent ${i}`));
  await Promise.all(tabIds.map((tabId) => t.ask("move", {
    item: { kind: "tab", tabId },
    to: { zone: "pinned" },
  })));
  const v = await t.ask("view");
  assert.equal(v.pinned.length, tabIds.length);
  assert.equal(new Set(v.pinned.map((p) => p.tabId)).size, tabIds.length);
  assert.ok(v.pinned.every((p) => p.loaded));
});

await check("automatic-archive-protects-active-and-saved-tabs", async (t) => {
  const idle = await t.open("idle", "Idle page");
  const pin = await t.open("docs", "Protected pin");
  const fav = await t.open("mail", "Protected favorite");
  const active = await t.open("active", "Protected active page");
  await t.ask("move", { item: { kind: "tab", tabId: pin }, to: { zone: "pinned" } });
  await t.ask("move", { item: { kind: "tab", tabId: fav }, to: { zone: "favs" } });
  await t.ask("activateTab", { tabId: active });
  await t.ask("sync");
  await t.worker.evaluate(async () => {
    const now = Date.now();
    const realNow = Date.now;
    Date.now = () => realNow() + 13 * 3600 * 1000;
    await chrome.alarms.create("archive", { when: now + 100 });
  });
  let v;
  for (let i = 0; i < 160; i++) {
    v = await t.ask("view");
    if (v.archiveCount >= 2) break;
    await t.settle(100);
  }
  assert.equal(v.archiveCount, 2, "Start and the idle page should be archived by the real alarm handler");
  const tabs = await t.tabs();
  assert.ok(!tabs.some((tab) => tab.id === idle));
  for (const id of [pin, fav, active]) assert.ok(tabs.some((tab) => tab.id === id));
});

await check("saved-titles-render-as-literal-text", async (t) => {
  const tabId = await t.open("docs", "Rename me");
  await t.ask("move", { item: { kind: "tab", tabId }, to: { zone: "pinned" } });
  const entry = (await t.ask("view")).pinned[0];
  const title = '<b>"Quotes" & apostrophes\' \ud83d\udea2</b>';
  await t.ask("renameEntry", { id: entry.id, title });
  const name = '<u>"Group" & \ud83d\udea2</u>';
  await t.ask("updateSpace", { id: (await t.ask("view")).space.id, patch: { name } });
  await t.panel.getByText(title, { exact: true }).waitFor();
  await t.panel.getByText(name, { exact: true }).waitFor();
  assert.equal(await t.panel.locator(".list.pins b, .space-head u").count(), 0);
});

await check("cleaned-pin-keeps-functional-query-and-fragment", async (t) => {
  const original = `${t.site("docs", "Functional parameters", "item")}&id=a%2Bb&utm_source=mail&fbclid=tracking#details`;
  const tabId = await t.worker.evaluate(async ([windowId, url]) =>
    (await chrome.tabs.create({ windowId, url, active: true })).id,
  [t.mainWindowId, original]);
  for (let i = 0; i < 80; i++) {
    const tab = await t.worker.evaluate((id) => chrome.tabs.get(id), tabId);
    if (tab.url === original && tab.status === "complete") break;
    await t.settle(50);
  }
  await t.ask("move", { item: { kind: "tab", tabId }, to: { zone: "pinned" } });
  const entry = (await t.ask("view")).pinned[0];
  const saved = new URL(entry.url);
  assert.equal(saved.searchParams.get("id"), "a+b");
  assert.ok(!saved.searchParams.has("utm_source"));
  assert.ok(!saved.searchParams.has("fbclid"));
  assert.equal(saved.hash, "#details");
  assert.equal(saved.pathname, "/item");
  await t.ask("closeEntryTab", { id: entry.id });
  await t.ask("openEntry", { id: entry.id });
  const reopened = (await t.tabs()).find((tab) => tab.active);
  const actual = new URL(reopened.pendingUrl || reopened.url);
  assert.equal(actual.searchParams.get("id"), "a+b");
  assert.equal(actual.hash, "#details");
});

console.log(`\n${results.filter(Boolean).length}/${results.length} control checks passed`);
process.exitCode = results.some((ok) => !ok) ? 1 : 0;
