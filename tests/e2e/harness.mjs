// Starts a throwaway Chromium with the extension loaded, plus a tiny local
// site so tests never touch the real web.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("../../extension", import.meta.url));

export async function start({ colorScheme = "light" } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const title = url.searchParams.get("t") || url.pathname.slice(1) || "Page";
    res.setHeader("content-type", "text/html");
    const hue = [...url.hostname].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
    const letter = (req.headers.host || "x")[0].toUpperCase();
    const mark = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='hsl(${hue} 65% 48%)'/><text x='16' y='23' font-size='20' font-family='Arial' font-weight='700' text-anchor='middle' fill='white'>${letter}</text></svg>`;
    res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:image/svg+xml,${encodeURIComponent(mark)}"><h1>${title}</h1>`);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const site = (host, title, path = "") => `http://${host}.localhost:${port}/${path}?t=${encodeURIComponent(title)}`;

  const profile = mkdtempSync(join(tmpdir(), "portside-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    colorScheme,
    viewport: { width: 380, height: 760 },
    args: ["--headless=new", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run"],
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const errors = [];
  const watch = (page) => {
    page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${page.url()}: ${m.text()}`));
  };
  context.on("page", watch);
  worker.on("console", (m) => ["error", "warning"].includes(m.type()) && errors.push(`worker: ${m.text()}`));

  // The sidebar cannot be docked by a test, so draw it in its own small window
  // and point it at the main window.
  // The worker's `chrome` object fills in a moment after the worker shows up.
  for (let i = 0; i < 100; i++) {
    if (await worker.evaluate(() => typeof chrome?.windows?.getAll === "function" && typeof chrome?.tabs?.create === "function").catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const first = context.pages()[0];
  await first.goto(site("start", "Start"));
  const mainWindowId = await worker.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ["normal"] }))[0].id);
  const [panel] = await Promise.all([
    context.waitForEvent("page"),
    worker.evaluate((w) => chrome.windows.create({ type: "popup", width: 320, height: 760, url: `panel/panel.html?w=${w}` }).then(() => {}), mainWindowId).catch(() => {}),
  ]);
  watch(panel);
  await panel.waitForSelector(".foot");

  /** Ask the background worker for something, the way the sidebar does. */
  const ask = (type, payload = {}) =>
    panel.evaluate(async ([type, payload, windowId]) => {
      const reply = await chrome.runtime.sendMessage({ type, payload: { windowId, ...payload } });
      if (!reply.ok) throw new Error(reply.error);
      return reply.result;
    }, [type, payload, mainWindowId]);

  /** Open a page of the fake site as a new tab in the main window. Returns its tab id. */
  const open = async (host, title, path) => {
    const url = site(host, title, path);
    const tabId = await worker.evaluate(async ([windowId, url]) => (await chrome.tabs.create({ windowId, url, active: true })).id, [mainWindowId, url]);
    await worker.evaluate(async (tabId) => {
      for (let i = 0; i < 100; i++) {
        if ((await chrome.tabs.get(tabId)).status === "complete") return;
        await new Promise((r) => setTimeout(r, 30));
      }
    }, tabId);
    return tabId;
  };
  const tabs = () => worker.evaluate((windowId) => chrome.tabs.query({ windowId }), mainWindowId);
  const settle = (ms = 350) => panel.waitForTimeout(ms);

  const stop = async () => {
    await context.close();
    server.close();
    rmSync(profile, { recursive: true, force: true });
  };

  return { context, worker, id, panel, ask, open, tabs, settle, site, errors, stop, mainWindowId };
}
