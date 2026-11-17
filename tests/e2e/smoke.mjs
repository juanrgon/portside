// Builds a realistic sidebar and saves pictures of it to tests/e2e/out.
import { start } from "./harness.mjs";
import { mkdirSync } from "node:fs";
const out = new URL("./out/", import.meta.url);
mkdirSync(out, { recursive: true });
const shot = (page, name) => page.screenshot({ path: new URL(`${name}.png`, out).pathname });
const scheme = process.argv[2] || "light";
const t = await start({ colorScheme: scheme });
try {
  await t.ask("updateSpace", { id: (await t.ask("view")).space.id, patch: { name: "Work", icon: "💼" } });
  const ids = {};
  for (const [host, title] of [["mail", "Inbox (3)"], ["calendar", "Week of Nov 16"], ["music", "Focus mix"], ["chat", "Team chat"], ["linear", "My issues"],
    ["github", "Pull requests"], ["vercel", "Deployments"], ["axiom", "Production logs"], ["docs", "Launch plan"], ["stripe", "Subscriptions"],
    ["tiptap", "Extensions – Tiptap docs"], ["mdn", "IndexedDB API"], ["news", "The Latest on Resort Fees"], ["so", "Why does my query refetch on focus?"]]) ids[host] = await t.open(host, title);
  for (const host of ["mail", "calendar", "music", "chat", "linear"]) await t.ask("move", { item: { kind: "tab", tabId: ids[host] }, to: { zone: "favs" } });
  for (const host of ["github", "vercel", "axiom", "docs", "stripe"]) await t.ask("move", { item: { kind: "tab", tabId: ids[host] }, to: { zone: "pinned" } });
  const folder = await t.ask("addFolder", { name: "Billing" });
  const view = await t.ask("view");
  await t.ask("move", { item: { kind: "pin", id: view.pinned.find((p) => p.title === "Subscriptions").id }, to: { zone: "pinned", folderId: folder } });
  await t.ask("closeEntryTab", { id: view.pinned.find((p) => p.title === "Production logs").id });
  await t.ask("closeEntryTab", { id: view.favorites.find((p) => p.title === "Focus mix").id });
  await t.ask("activateTab", { tabId: ids.docs });
  await t.settle(700);
  await shot(t.panel, `panel-${scheme}`);

  // context menu on a pinned tab
  await t.panel.locator(".row", { hasText: "Pull requests" }).click({ button: "right" });
  await t.settle(200);
  await shot(t.panel, `menu-${scheme}`);
  await t.panel.keyboard.press("Escape");

  // space options
  await t.panel.locator(".space-head").hover();
  await t.panel.locator(".space-head .chip").click();
  await t.settle(200);
  await shot(t.panel, `space-menu-${scheme}`);
  await t.panel.keyboard.press("Escape");

  // mid-drag
  const box = await t.panel.locator(".row", { hasText: "IndexedDB API" }).boundingBox();
  const target = await t.panel.locator(".row", { hasText: "Deployments" }).boundingBox();
  await t.panel.mouse.move(box.x + 60, box.y + 12);
  await t.panel.mouse.down();
  await t.panel.mouse.move(box.x + 70, box.y - 40, { steps: 4 });
  await t.panel.mouse.move(target.x + 80, target.y + 30, { steps: 6 });
  await t.settle(200);
  await shot(t.panel, `drag-${scheme}`);
  await t.panel.mouse.move(box.x + 60, box.y + 12, { steps: 4 });
  await t.panel.mouse.up();
  await t.settle(300);

  // command bar over the current tab
  const [bar] = await Promise.all([t.context.waitForEvent("page"), t.ask("openBar")]);
  await bar.waitForSelector(".hit");
  await bar.setViewportSize({ width: 720, height: 440 });
  await shot(bar, `bar-empty-${scheme}`);
  await bar.locator("#q").fill("mo");
  await t.settle(250);
  await shot(bar, `bar-typed-${scheme}`);
  await bar.locator("#q").fill("archive");
  await t.settle(250);
  await shot(bar, `bar-actions-${scheme}`);
  await bar.close().catch(() => {});

  // archive
  await t.ask("closeTab", { tabId: ids.news });
  await t.ask("closeTab", { tabId: ids.so });
  await t.panel.locator(".foot .chip[title='Archived tabs']").click();
  await t.settle(300);
  await shot(t.panel, `archive-${scheme}`);
  await t.panel.locator(".sheet-head .chip").click();

  // a second space, in another color
  await t.ask("addSpace", { name: "Reading" });
  await t.ask("updateSpace", { id: (await t.ask("view")).space.id, patch: { icon: "📚", color: "green" } });
  await t.open("longform", "The case for vertical tabs");
  await t.open("blog", "Notes on focus");
  await t.settle(600);
  await shot(t.panel, `space-two-${scheme}`);

  // the new tab page
  const [newTab] = await Promise.all([
    t.context.waitForEvent("page", (page) => page.url().includes("bar/bar.html")),
    t.worker.evaluate((windowId) => chrome.tabs.create({ windowId }).then(() => {}), t.mainWindowId),
  ]);
  await newTab.waitForSelector(".hit");
  await newTab.setViewportSize({ width: 1100, height: 700 });
  await newTab.locator("#q").fill("git");
  await t.settle(250);
  await shot(newTab, `newtab-${scheme}`);
  console.log("groups", JSON.stringify(await t.worker.evaluate(() => chrome.tabGroups.query({}))));
  console.log("errors", t.errors);
} finally { await t.stop(); }
