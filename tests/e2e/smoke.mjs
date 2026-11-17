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
  console.log("groups", JSON.stringify(await t.worker.evaluate(() => chrome.tabGroups.query({}))));
  console.log("errors", t.errors);
} finally { await t.stop(); }
