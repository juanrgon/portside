#!/usr/bin/env node
// Makes the 1280x800 screenshots for the Chrome Web Store listing.
// Everything on screen is fake data served from this machine.
import { mkdirSync, readFileSync } from "node:fs";
import { start } from "../tests/e2e/harness.mjs";

const out = new URL("../store/screenshots/", import.meta.url);
mkdirSync(out, { recursive: true });
const t = await start({ domain: "test" });

/** Put the sidebar next to a page, the way it sits in a Chrome window. */
async function sideBySide(name, { pageHtml }) {
  const panel = await t.panel.screenshot();
  const stage = await t.context.newPage();
  await stage.setViewportSize({ width: 1280, height: 800 });
  await stage.setContent(`<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; display: flex; height: 800px; font-family: -apple-system, system-ui, sans-serif; background: #fff; }
    img { width: 380px; height: 800px; object-fit: cover; object-position: top; flex: none; }
    main { flex: 1; overflow: hidden; }
  </style><img src="data:image/png;base64,${panel.toString("base64")}"><main>${pageHtml}</main>`);
  await stage.screenshot({ path: new URL(`${name}.png`, out).pathname });
  await stage.close();
}

/** A promo tile: the name, one line, and the real sidebar peeking in from the right. */
async function tile(name, panel, { width, height, scale }) {
  const icon = readFileSync(new URL("../extension/icons/icon128.png", import.meta.url));
  const stage = await t.context.newPage();
  await stage.setViewportSize({ width, height });
  const px = (n) => `${Math.round(n * scale)}px`;
  await stage.setContent(`<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; position: relative;
      font-family: -apple-system, system-ui, sans-serif; color: white;
      background: linear-gradient(150deg, oklch(0.52 0.17 295), oklch(0.34 0.15 314)); }
    .words { position: absolute; left: ${px(34)}; top: 50%; transform: translateY(-50%); width: ${px(215)}; }
    .mark { width: ${px(40)}; height: ${px(40)}; display: block; margin-bottom: ${px(14)}; filter: drop-shadow(0 0 ${px(1)} oklch(1 0 0 / 0.55)) drop-shadow(0 ${px(4)} ${px(10)} oklch(0.2 0.1 300 / 0.4)); }
    h1 { margin: 0; font-size: ${px(38)}; line-height: 1; font-weight: 800; letter-spacing: -0.03em; }
    p { margin: ${px(10)} 0 0; font-size: ${px(15)}; line-height: 1.3; font-weight: 500; opacity: 0.86; }
    .side { position: absolute; right: ${px(26)}; top: ${px(30)}; width: ${px(160)}; border-radius: ${px(12)};
      box-shadow: 0 ${px(16)} ${px(44)} oklch(0.18 0.1 300 / 0.55); }
  </style>
  <div class="words"><img class="mark" src="data:image/png;base64,${icon.toString("base64")}"><h1>Portside</h1><p>Your tab groups, in a sidebar.</p></div>
  <img class="side" src="data:image/png;base64,${panel.toString("base64")}">`);
  await stage.screenshot({ path: new URL(`../${name}.png`, out).pathname });
  await stage.close();
}

const article = (title, lines) => `<div style="max-width:620px;margin:0 auto;padding:72px 48px;color:#1d1b26">
  <p style="margin:0 0 10px;color:#6f6a80;font-size:15px">Launch plan</p>
  <h1 style="margin:0 0 22px;font-size:40px;line-height:1.12;letter-spacing:-0.02em">${title}</h1>
  ${lines.map((l) => `<p style="margin:0 0 16px;font-size:18px;line-height:1.6;color:#3c384a">${l}</p>`).join("")}
</div>`;

try {
  await t.panel.setViewportSize({ width: 380, height: 800 });
  await t.ask("updateSpace", { id: (await t.ask("view")).space.id, patch: { name: "Work", icon: "💼" } });
  const ids = {};
  for (const [host, title] of [["mail", "Inbox"], ["calendar", "This week"], ["music", "Focus mix"], ["chat", "Team chat"],
    ["code", "Pull requests"], ["deploys", "Deployments"], ["logs", "Production logs"], ["docs", "Launch plan"], ["billing", "Subscriptions"],
    ["reference", "Storage API reference"], ["guide", "Writing better release notes"], ["forum", "Why does my query refetch on focus?"]]) ids[host] = await t.open(host, title);
  for (const host of ["mail", "calendar", "music", "chat"]) await t.ask("move", { item: { kind: "tab", tabId: ids[host] }, to: { zone: "favs" } });
  for (const host of ["code", "deploys", "logs", "docs", "billing"]) await t.ask("move", { item: { kind: "tab", tabId: ids[host] }, to: { zone: "pinned" } });
  const folder = await t.ask("addFolder", { name: "Billing" });
  const view = await t.ask("view");
  await t.ask("move", { item: { kind: "pin", id: view.pinned.find((p) => p.title === "Subscriptions").id }, to: { zone: "pinned", folderId: folder } });
  await t.ask("closeEntryTab", { id: view.pinned.find((p) => p.title === "Production logs").id });
  await t.ask("activateTab", { tabId: ids.docs });
  await t.settle(1200);
  // One picture of the sidebar for the tiles, taken before anything else opens a tab.
  const hero = await t.panel.screenshot();
  await sideBySide("1-sidebar", { pageHtml: article("Pinned tabs stay put. Everything else tidies itself up.", [
    "Keep the pages you use every day above the line. They stay there, and they never get archived.",
    "Tabs below the line are for today. Leave one alone long enough and it moves to the archive, where you can search for it and bring it back.",
    "Favorites along the top follow you into every tab group.",
  ]) });

  await tile("promo-small-440x280", hero, { width: 440, height: 280, scale: 1 });
  await tile("promo-marquee-1400x560", hero, { width: 1400, height: 560, scale: 2.1 });

  // 2: the command bar on a new tab
  const bar = await t.newTab();
  await bar.waitForSelector(".hit");
  await bar.setViewportSize({ width: 1280, height: 800 });
  await bar.locator("#q").fill("pu");
  await t.settle(400);
  await bar.screenshot({ path: new URL("2-command-bar.png", out).pathname });
  await bar.keyboard.press("Escape");
  await t.settle(400);

  // 3: a second tab group in its own color
  await t.ask("addSpace", { name: "Reading" });
  await t.ask("updateSpace", { id: (await t.ask("view")).space.id, patch: { icon: "📚", color: "green" } });
  await t.open("essays", "The case for vertical tabs");
  await t.open("notes", "Notes on focus");
  const saved = await t.open("longread", "How we got to tab overload");
  await t.ask("move", { item: { kind: "tab", tabId: saved }, to: { zone: "pinned" } });
  await t.ask("activateTab", { tabId: saved });
  await t.settle(1200);
  await sideBySide("3-tab-groups", { pageHtml: article("One tab group at a time, each in its own color.", [
    "The sidebar shows the tab group you are in. The others fold away in Chrome's tab strip until you switch.",
    "Switch with the icons at the bottom, or swipe left and right with two fingers.",
  ]).replace("Launch plan", "Reading") });

  // 4: the archive, with a few days of closed tabs in it
  for (const [host, title] of [["recipes", "Weeknight dinners"], ["maps", "Trail map"], ["shop", "Standing desk comparison"], ["wiki", "History of the web browser"], ["video", "Conference talk: small tools"]]) {
    await t.ask("closeTab", { tabId: await t.open(host, title) });
  }
  await t.ask("closeTab", { tabId: (await t.ask("view")).today[0].tabId });
  await t.worker.evaluate(async () => {
    const { state } = await chrome.storage.local.get("state");
    const day = 86400000;
    state.archive.forEach((item, index) => (item.closedAt -= [0, 0, day, day, 3 * day, 3 * day][index] || 0));
    await chrome.storage.local.set({ state });
  });
  await t.panel.locator(".foot .chip[title='Archived tabs']").click();
  await t.settle(500);
  await sideBySide("4-archive", { pageHtml: article("Closed tabs are never really gone.", [
    "Tabs you close from the sidebar, and tabs you stop using, land in the archive.",
    "Search it by name or link and click to bring a tab back.",
  ]).replace("Launch plan", "Reading") });
  console.log("errors", t.errors.filter((e) => !e.includes("ERR_FAILED")));
} finally {
  await t.stop();
}
