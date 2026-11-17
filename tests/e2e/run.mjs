// End-to-end checks. Each one drives the real extension in a throwaway
// Chromium and looks at what a person would see: the sidebar, the tab strip,
// and the command bar.
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

const only = process.argv[2];
const results = [];

async function check(name, fn) {
  if (only && !name.includes(only)) return;
  const t = await start();
  try {
    await fn(t);
    const noise = t.errors.filter((e) => !e.includes("ERR_FAILED"));
    assert.deepEqual(noise, [], "the extension logged errors");
    results.push([name, true]);
    console.log(`✔ ${name}`);
  } catch (error) {
    results.push([name, false]);
    if (t.errors.length) console.log(`  logged: ${t.errors.join(" | ")}`);
    console.log(`✖ ${name}\n  ${String(error.stack || error).split("\n").slice(0, 14).join("\n  ")}`);
  } finally {
    await t.stop();
  }
}

/** Wait until the sidebar's data matches, the way a person waits for the screen to catch up. */
async function until(t, test, message) {
  let last;
  for (let i = 0; i < 60; i++) {
    last = await t.ask("view");
    if (test(last)) return last;
    await t.settle(60);
  }
  assert.fail(`${message}\n  last view: ${JSON.stringify({ today: last.today.map((x) => x.title), pinned: last.pinned.map((x) => [x.title, x.loaded]), favorites: last.favorites.map((x) => [x.title, x.loaded]), space: last.space.name })}`);
}

const titles = (rows) => rows.map((row) => row.title);
const row = (t, text) => t.panel.locator(".row", { hasText: text }).first();

await check("new tabs land in the current tab group, newest on top", async (t) => {
  await t.open("docs", "Plan");
  await t.open("news", "Fees");
  const view = await until(t, (v) => v.today.length === 3, "three tabs should be listed");
  assert.deepEqual(titles(view.today), ["Fees", "Plan", "Start"]);
  let tabs = [];
  let groups = [];
  for (let i = 0; i < 40 && !(groups.length === 1 && tabs.every((tab) => tab.groupId === groups[0].id)); i++) {
    await t.settle(60);
    tabs = await t.tabs();
    groups = await t.worker.evaluate(() => chrome.tabGroups.query({}));
  }
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "Home");
  assert.ok(tabs.every((tab) => tab.groupId === groups[0].id), "every tab should sit in the space's tab group");
  await t.panel.waitForSelector(".today .row.active:has-text('Fees')");
});

await check("a pinned tab outlives its tab and reopens on its saved page", async (t) => {
  const tabId = await t.open("github", "Pull requests");
  await until(t, (v) => v.today.length === 2, "the new tab should be listed");
  await row(t, "Pull requests").click({ button: "right" });
  await t.panel.locator(".menu .item", { hasText: "Pin to this tab group" }).click();
  let view = await until(t, (v) => v.pinned.length === 1 && v.today.length === 1, "the tab should move above the line");
  assert.equal(view.pinned[0].loaded, true);

  // Wander off the pinned page, then close the tab from the sidebar.
  await t.worker.evaluate(([id, url]) => chrome.tabs.update(id, { url }), [tabId, t.site("github", "Issue 12", "issues/12")]);
  view = await until(t, (v) => v.pinned[0].drifted, "the pin should notice it left its page");
  assert.equal(view.pinned[0].title, "Issue 12");
  await row(t, "Issue 12").hover();
  await row(t, "Issue 12").locator(".close").click();
  view = await until(t, (v) => v.pinned.length === 1 && !v.pinned[0].loaded, "the pin should stay after its tab closes");
  assert.equal(view.pinned[0].title, "Pull requests");
  assert.ok(!(await t.tabs()).some((tab) => tab.id === tabId), "the tab itself should be gone");

  await row(t, "Pull requests").click();
  view = await until(t, (v) => v.pinned[0].loaded && v.pinned[0].active, "clicking the pin should open it again");
  const reopened = (await t.tabs()).find((tab) => tab.active);
  assert.equal(new URL(reopened.pendingUrl || reopened.url).pathname, "/", "it should open the saved page, not the page it wandered to");
  assert.equal(view.today.length, 1, "a pinned tab is not listed twice");
});

await check("a favorite is pinned in Chrome and shows in every tab group", async (t) => {
  const tabId = await t.open("mail", "Inbox");
  await until(t, (v) => v.today.length === 2, "the new tab should be listed");
  await row(t, "Inbox").click({ button: "right" });
  await t.panel.locator(".menu .item", { hasText: "Add to favorites" }).click();
  await until(t, (v) => v.favorites.length === 1 && v.today.length === 1, "the tab should become a favorite");
  assert.equal((await t.tabs()).find((tab) => tab.id === tabId).pinned, true);

  await t.panel.locator(".foot .chip[title='New tab group']").click();
  await t.panel.locator(".space-head input.rename").waitFor();
  await t.panel.keyboard.type("Work");
  await t.panel.keyboard.press("Enter");
  const view = await until(t, (v) => v.space.name === "Work", "the new space should be named and current");
  assert.equal(view.favorites.length, 1, "favorites follow you into the new space");
  assert.equal(view.spaces.length, 2);
});

await check("switching tab groups swaps the tab list and folds the other group away", async (t) => {
  await t.open("docs", "Home doc");
  await until(t, (v) => v.today.length === 2, "home should have two tabs");
  const work = await t.ask("addSpace", { name: "Work" });
  let view = await until(t, (v) => v.space.id === work && v.today.length === 0, "a fresh space starts with only its new tab page, which is not listed");
  await t.open("jira", "Ticket");
  view = await until(t, (v) => v.today.length === 1, "the work tab should be listed");
  assert.deepEqual(titles(view.today), ["Ticket"]);

  await t.panel.locator(".foot .dot").first().click();
  view = await until(t, (v) => v.space.name === "Home", "clicking the first dot goes back home");
  assert.deepEqual(titles(view.today), ["Home doc", "Start"]);
  const groups = await t.worker.evaluate(() => chrome.tabGroups.query({}));
  assert.equal(groups.find((g) => g.title === "Work").collapsed, true, "the other space is folded in the tab strip");
  assert.equal(groups.find((g) => g.title === "Home").collapsed, false);
  const active = (await t.tabs()).find((tab) => tab.active);
  assert.equal(active.title, "Home doc", "you land on the tab you last used there");
  assert.equal(await t.panel.locator("#app").getAttribute("data-color"), "purple");
});

await check("closing a tab archives it, and the archive gives it back", async (t) => {
  await t.open("news", "Long read");
  await until(t, (v) => v.today.length === 2, "the new tab should be listed");
  await row(t, "Long read").hover();
  await row(t, "Long read").locator(".close").click();
  let view = await until(t, (v) => v.today.length === 1 && v.archiveCount === 1, "the tab should be archived");

  await t.panel.locator(".foot .chip[title='Archived tabs']").click();
  await t.panel.locator(".search input").fill("long");
  await t.panel.locator(".row.old", { hasText: "Long read" }).click();
  view = await until(t, (v) => v.today.length === 2 && v.archiveCount === 0, "restoring should bring the tab back");
  assert.equal(view.today[0].title, "Long read");
});

await check("clear archives every unpinned tab but leaves pins and the window", async (t) => {
  const keep = await t.open("github", "Keep me");
  await t.open("a", "One");
  await t.open("b", "Two");
  await t.ask("move", { item: { kind: "tab", tabId: keep }, to: { zone: "pinned" } });
  await until(t, (v) => v.today.length === 3 && v.pinned.length === 1, "setup");
  await t.panel.locator(".scroll").hover();
  await t.panel.locator(".divider button").click();
  const view = await until(t, (v) => v.today.length === 0, "today should be empty");
  assert.equal(view.archiveCount, 3);
  assert.equal(view.pinned[0].loaded, true, "the pinned tab stays open");
  assert.ok((await t.tabs()).length >= 1, "the window is still there");
});

await check("dragging a tab above the line pins it, and into the grid makes it a favorite", async (t) => {
  await t.open("docs", "Spec");
  await t.open("mail", "Inbox");
  await until(t, (v) => v.today.length === 3, "setup");
  await row(t, "Spec").dragTo(t.panel.locator(".space-head"));
  let view = await until(t, (v) => v.pinned.length === 1, "dropping above the line should pin");
  assert.equal(view.pinned[0].title, "Spec");
  assert.deepEqual(titles(view.today), ["Inbox", "Start"]);

  await row(t, "Inbox").dragTo(t.panel.locator(".link"));
  view = await until(t, (v) => v.favorites.length === 1, "dropping in the grid should favorite");
  assert.equal(view.favorites[0].title, "Inbox");

  await row(t, "Spec").dragTo(t.panel.locator(".list.today"));
  view = await until(t, (v) => v.pinned.length === 0, "dragging back below the line should unpin");
  assert.ok(titles(view.today).includes("Spec"), "and the tab stays open");
});

await check("the command bar switches to an open tab, and searches when nothing matches", async (t) => {
  const target = await t.open("github", "Pull requests");
  await t.open("docs", "Spec");
  await until(t, (v) => v.today.length === 3, "setup");
  const [bar] = await Promise.all([t.context.waitForEvent("page"), t.ask("openBar")]);
  await bar.waitForSelector(".hit");
  await bar.locator("#q").fill("git");
  await bar.waitForSelector(".hit.on:has-text('Pull requests')");
  assert.match(await bar.locator(".hit.on").innerText(), /Switch to Tab/);
  await bar.locator("#q").fill("how do tab groups work");
  assert.match(await bar.locator(".hit.on").innerText(), /Search/);
  await bar.locator("#q").fill("git");
  await bar.waitForSelector(".hit.on:has-text('Pull requests')");
  await Promise.all([bar.waitForEvent("close"), bar.keyboard.press("Enter")]);
  await until(t, (v) => v.today.find((x) => x.tabId === target)?.active, "enter should switch to the matching tab");
});

await check("a new tab opens the command bar, and a link typed there loads in that tab", async (t) => {
  await until(t, (v) => v.today.length === 1, "setup");
  const [bar] = await Promise.all([
    t.context.waitForEvent("page", (page) => page.url().includes("bar/bar.html")),
    t.worker.evaluate((windowId) => chrome.tabs.create({ windowId }).then(() => {}), t.mainWindowId),
  ]);
  await bar.waitForSelector(".hit");
  assert.equal(await bar.evaluate(() => document.activeElement?.id), "q", "the cursor should be in the box");
  let view = await t.ask("view");
  assert.equal(view.today.length, 1, "the bar's own tab is not listed as a tab");
  const before = (await t.tabs()).length;
  const url = t.site("docs", "Typed");
  await bar.locator("#q").fill(url.replace("http://", ""));
  assert.match(await bar.locator(".hit.on").innerText(), /Go to this link/);
  await bar.keyboard.press("Enter");
  view = await until(t, (v) => v.today.some((x) => x.title === "Typed" && x.active), "the typed link should load");
  assert.equal((await t.tabs()).length, before, "it loads in the same tab instead of opening another");
});

await check("escape on a new tab goes back to the tab you came from", async (t) => {
  const from = await t.open("docs", "Where I was");
  await t.open("news", "Other");
  await t.ask("activateTab", { tabId: from });
  await until(t, (v) => v.today.find((x) => x.tabId === from)?.active, "setup");
  const [bar] = await Promise.all([
    t.context.waitForEvent("page", (page) => page.url().includes("bar/bar.html")),
    t.worker.evaluate((windowId) => chrome.tabs.create({ windowId }).then(() => {}), t.mainWindowId),
  ]);
  await bar.waitForSelector(".hit");
  await Promise.all([bar.waitForEvent("close"), bar.keyboard.press("Escape")]);
  await until(t, (v) => v.today.find((x) => x.tabId === from)?.active, "escape should return to the earlier tab");
});

await check("a tab group made in Chrome's tab strip shows up in the sidebar", async (t) => {
  const tabId = await t.open("shop", "Cart");
  await until(t, (v) => v.today.length === 2, "setup");
  await t.worker.evaluate(async (id) => {
    const { windowId } = await chrome.tabs.get(id);
    const groupId = await chrome.tabs.group({ tabIds: [id], createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: "Shopping", color: "green" });
  }, tabId);
  const view = await until(t, (v) => v.spaces.some((s) => s.name === "Shopping"), "the group should show up as a space");
  assert.equal(view.spaces.find((s) => s.name === "Shopping").color, "green");
  assert.deepEqual(titles(view.today), ["Start"], "its tab leaves the current space's list");
});

await check("after a restart, pins, favorites, and tab groups find their tabs again", async (t) => {
  // A restart hands out new tab and group ids. Wiping what the extension
  // remembers for this session is the same thing from its point of view.
  const inbox = await t.open("mail", "Inbox", "inbox");
  const sent = await t.open("mail", "Sent", "sent");
  const pulls = await t.open("github", "Pull requests", "pulls");
  await t.open("docs", "Loose tab");
  await t.ask("move", { item: { kind: "tab", tabId: inbox }, to: { zone: "favs" } });
  await t.ask("move", { item: { kind: "tab", tabId: sent }, to: { zone: "favs" } });
  await t.ask("move", { item: { kind: "tab", tabId: pulls }, to: { zone: "pinned" } });
  const work = await t.ask("addSpace", { name: "Work" });
  const ticket = await t.open("jira", "Ticket");
  await t.ask("move", { item: { kind: "tab", tabId: ticket }, to: { zone: "pinned" } });
  const home = (await t.ask("view")).spaces[0].id;
  await t.ask("switchSpace", { id: home });
  const before = await until(t, (v) => v.space.id === home && v.pinned.length === 1 && v.favorites.length === 2, "setup");
  const shape = (v) => ({
    favorites: v.favorites.map((f) => [f.title, f.tabId]),
    pinned: v.pinned.map((p) => [p.title, p.tabId]),
    today: titles(v.today),
    spaces: v.spaces.map((s) => s.name),
  });

  await t.worker.evaluate(() => chrome.storage.session.remove("sess"));
  await t.ask("sync");
  const after = await t.ask("view");
  assert.deepEqual(shape(after), shape(before), "home should look the same, with each favorite on its own tab");
  assert.deepEqual(after.favorites.map((f) => f.tabId), [inbox, sent], "two favorites on one site keep their own tabs");
  assert.equal(after.spaces.length, 2, "no extra spaces appear");

  await t.ask("switchSpace", { id: work });
  const workView = await until(t, (v) => v.space.id === work, "switch to work");
  assert.deepEqual(workView.pinned.map((p) => [p.title, p.tabId]), [["Ticket", ticket]], "the other space's pin is still tied to its tab");
});

await check("clear leaves open the pages the archive could not bring back", async (t) => {
  await t.open("news", "Story");
  await t.worker.evaluate((windowId) => chrome.tabs.create({ windowId, url: "chrome://version/" }).then(() => {}), t.mainWindowId);
  await until(t, (v) => v.today.length === 3, "setup");
  await t.ask("clearToday");
  const view = await until(t, (v) => v.archiveCount === 2, "the two web pages should be archived");
  assert.equal(view.today.length, 1, "the Chrome page stays open");
  assert.match(view.today[0].url, /^chrome:\/\/version/);
});

await check("the new tab switch gives Chrome's own new tab page back", async (t) => {
  await t.ask("setSetting", { key: "barOnNewTab", value: false });
  await t.worker.evaluate((windowId) => chrome.tabs.create({ windowId }).then(() => {}), t.mainWindowId);
  let tabs = [];
  for (let i = 0; i < 50 && !tabs.some((tab) => tab.active && /^chrome:\/\/new-tab-page/.test(tab.url)); i++) {
    await t.settle(60);
    tabs = await t.tabs();
  }
  const active = tabs.find((tab) => tab.active);
  assert.match(active.url, /^chrome:\/\/new-tab-page/, "the new tab should be Chrome's page");
  assert.ok(!tabs.some((tab) => tab.url.includes("bar/bar.html")), "the command bar should not open");
});

await check("copy link puts the clean link on the clipboard", async (t) => {
  // Headless Chromium keeps its own clipboard, so this never touches the Mac's.
  const tabId = await t.open("news", "Fees", "story");
  await t.worker.evaluate(([id, url]) => chrome.tabs.update(id, { url }), [tabId, `${t.site("news", "Fees", "story")}&utm_source=mail&fbclid=zzz`]);
  await until(t, (v) => v.activeUrl.includes("fbclid"), "the tab should be on the link with tracking codes");
  await t.panel.locator(".link .chip[title='Copy link']").click();
  await t.panel.locator("#toast.show", { hasText: "Link copied" }).waitFor();
  await t.context.grantPermissions(["clipboard-read"]);
  const reader = await t.context.newPage();
  await reader.goto(t.site("reader", "Reader"));
  await reader.bringToFront();
  assert.equal(await reader.evaluate(() => navigator.clipboard.readText()), t.site("news", "Fees", "story"));
});

await check("dragging a pinned tab shows where it will land and reorders the pins", async (t) => {
  const one = await t.open("a", "One");
  const two = await t.open("b", "Two");
  const three = await t.open("c", "Three");
  for (const tabId of [one, two, three]) await t.ask("move", { item: { kind: "tab", tabId }, to: { zone: "pinned" } });
  await until(t, (v) => v.pinned.length === 3, "setup");
  await t.panel.locator(".list.pins > .row").nth(2).waitFor();
  const from = await row(t, "Three").boundingBox();
  const to = await row(t, "One").boundingBox();
  await t.panel.mouse.move(from.x + 80, from.y + 10);
  await t.panel.mouse.down();
  for (let i = 0; i < 4; i++) await t.panel.mouse.move(to.x + 80 + i, to.y + 6, { steps: 2 });
  await t.panel.locator(".drop-line").waitFor();
  await t.panel.mouse.up();
  const view = await until(t, (v) => v.pinned[0].title === "Three", "the dragged pin should move to the top");
  assert.deepEqual(titles(view.pinned), ["Three", "One", "Two"]);
});

await check("the sidebar shortcut closes a sidebar that is already open", async (t) => {
  await t.settle(600);
  const closed = t.panel.waitForEvent("close", { timeout: 5000 }).then(() => true, () => false);
  await t.worker.evaluate((windowId) => chrome.runtime.sendMessage({ type: "panel:toggle", windowId }).catch(() => {}), t.mainWindowId);
  assert.equal(await closed, true);
});

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
