// The command bar. One box that switches tabs, opens pinned tabs, goes to
// links, searches, and runs sidebar actions. It shows up two ways:
//   mode=tab     the new tab page (Cmd+T)
//   mode=window  a small window over the current tab (the shortcut, or the link pill)

import { hostOf, score, toUrl } from "../lib/url.js";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "window" ? "window" : "tab";
const prefill = params.get("q") || "";
const input = document.getElementById("q");
const list = document.getElementById("results");
const lead = document.getElementById("lead");

let windowId = Number(params.get("w")) || null;
let selfTab = null;
let data = null;
let hits = [];
let selected = 0;
let leaving = false;
let historyHits = [];
let historyFor = "";

const ICONS = {
  search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>',
  globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/>',
  bolt: '<path d="M9 2 3.5 9H8l-1 5 5.5-7H8z"/>',
  arrow: '<path d="M3 8h10M9 4l4 4-4 4"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round", class: "icon", "aria-hidden": "true" })) {
    svg.setAttribute(key, value);
  }
  svg.innerHTML = ICONS[name];
  return svg;
}

function el(tag, className, ...kids) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const kid of kids) if (kid != null && kid !== false) node.append(kid);
  return node;
}

/** A tab that is open knows its own icon. Anything else comes from Chrome's saved icons. */
function favicon(url, live) {
  const saved = new URL(chrome.runtime.getURL("_favicon/"));
  saved.searchParams.set("pageUrl", url);
  saved.searchParams.set("size", "32");
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.addEventListener("error", () => {
    if (img.src !== saved.toString()) img.src = saved.toString();
  });
  img.src = /^(https?|data):/.test(live || "") ? live : saved.toString();
  return img;
}

async function send(type, payload = {}) {
  const reply = await chrome.runtime.sendMessage({ type, payload: { windowId, ...payload } });
  if (!reply?.ok) throw new Error(reply?.error || `${type} failed`);
  return reply.result;
}

// ---------------------------------------------------------------- leaving

async function dismiss() {
  if (leaving) return;
  leaving = true;
  if (mode === "window") window.close();
  else await send("dismissBarTab", { tabId: selfTab.id }).catch(() => chrome.tabs.remove(selfTab.id));
}

async function closeSelf() {
  leaving = true;
  if (mode === "window") window.close();
  else await chrome.tabs.remove(selfTab.id).catch(() => {});
}

/** Go to a link, in the way that fits how the bar was opened. */
async function go(url) {
  leaving = true;
  if (mode === "tab") await chrome.tabs.update(selfTab.id, { url });
  else if (prefill && data.current) {
    await chrome.tabs.update(data.current.tabId, { url, active: true });
    window.close();
  } else {
    await send("newTab", { url });
    window.close();
  }
}

async function search(text) {
  leaving = true;
  if (mode === "tab") return chrome.search.query({ text, tabId: selfTab.id });
  if (prefill && data.current) await chrome.search.query({ text, tabId: data.current.tabId });
  else {
    const tab = await chrome.tabs.create({ windowId, url: "about:blank", active: true });
    await chrome.search.query({ text, tabId: tab.id });
  }
  window.close();
}

// ---------------------------------------------------------------- actions

function actions() {
  const current = data.current;
  const names = { 12: "12 hours", 24: "24 hours", 168: "7 days", 720: "30 days" };
  const then = (type, payload) => async () => {
    await send(type, payload);
    await dismiss();
  };
  return [
    current && { label: "Copy link", keys: "⌘⇧C", run: then("copyUrl") },
    current && !current.saved && { label: "Pin tab", run: then("togglePin") },
    current?.saved === "pin" && { label: "Unpin tab", run: then("togglePin") },
    current && current.saved !== "fav" && { label: "Add to favorites", run: then("favoriteCurrent") },
    current && { label: "Close tab", keys: "⌘W", run: then("closeCurrent") },
    { label: "View archive…", run: () => showSidebar("archive") },
    { label: "Clear unpinned tabs", run: then("clearToday") },
    { label: "Show sidebar", run: () => showSidebar("tabs") },
    { label: "New tab group", run: async () => { showSidebar("tabs", false); await send("addSpace"); await closeSelf(); } },
    ...data.spaces.filter((s) => s.id !== data.activeSpaceId).map((s) => ({ label: `Go to ${s.name}`, run: async () => { await send("switchSpace", { id: s.id }); await closeSelf(); } })),
    ...data.archiveHours.filter((h) => h !== data.settings.archiveAfterHours).map((h) => ({ label: `Archive unpinned tabs after ${names[h]}`, rare: true, run: then("setSetting", { key: "archiveAfterHours", value: h }) })),
    { label: "Set up keyboard shortcuts", run: () => go("chrome://extensions/shortcuts") },
    !data.history && { label: "Search my browsing history too", run: askForHistory },
  ].filter(Boolean);
}

function showSidebar(panelMode, leave = true) {
  // open() has to run inside the click or key press, before anything is awaited.
  chrome.sidePanel.open({ windowId }).catch(() => {});
  chrome.storage.session.set({ panelMode });
  chrome.runtime.sendMessage({ type: "panel:show", windowId, mode: panelMode }).catch(() => {});
  if (leave) dismiss();
}

async function askForHistory() {
  const granted = await chrome.permissions.request({ permissions: ["history"] }).catch(() => false);
  data.history = !!granted;
  input.focus();
  render();
}

// ---------------------------------------------------------------- results

function build(q) {
  const text = q.trim();
  if (!text) {
    return [
      ...data.tabs.slice(0, 5).map((tab) => tabHit(tab)),
      ...actions().slice(0, 3).map(actionHit),
    ];
  }
  const found = [];
  for (const tab of data.tabs) {
    const s = score(text, tab.title, tab.url);
    if (s) found.push({ ...tabHit(tab), s: s + 5 });
  }
  for (const entry of data.entries) {
    const s = score(text, entry.title, entry.url);
    if (s) found.push({ ...entryHit(entry), s: s + 3 });
  }
  for (const action of actions()) {
    const s = score(text, action.label, "");
    // Settings are still findable, but they should not outrank the thing people do every day.
    if (s) found.push({ ...actionHit(action), s: action.rare ? Math.min(s, 55) : s });
  }
  const open = new Set([...data.tabs, ...data.entries].map((x) => x.url));
  for (const item of historyFor === text ? historyHits : []) {
    if (open.has(item.url)) continue;
    const s = score(text, item.title, item.url);
    found.push({ kind: "history", title: item.title || hostOf(item.url), sub: hostOf(item.url), url: item.url, run: () => go(item.url), s: Math.max(20, s - 12) });
  }
  found.sort((a, b) => b.s - a.s);
  const strong = found.filter((x) => x.s >= 70);
  const weak = found.filter((x) => x.s < 70);
  const url = toUrl(text);
  const typed = url
    ? { kind: "go", title: text, sub: "Go to this link", url, run: () => go(url) }
    : { kind: "search", title: text, sub: "Search", run: () => search(text) };
  const typedFirst = url || !strong.length;
  const out = typedFirst ? [typed, ...strong, ...weak] : [...strong, typed, ...weak];
  if (url) out.splice(1 + strong.length, 0, { kind: "search", title: text, sub: "Search", run: () => search(text) });
  return out.slice(0, 9);
}

function tabHit(tab) {
  return { kind: "tab", title: tab.title || hostOf(tab.url), sub: hostOf(tab.url), url: tab.url, icon: tab.icon, side: "Switch to Tab", run: async () => { await send("activateTab", { tabId: tab.tabId }); await closeSelf(); } };
}

function entryHit(entry) {
  return { kind: "entry", title: entry.title || hostOf(entry.url), sub: entry.space, url: entry.url, side: "Open", run: async () => { await send("openEntry", { id: entry.id }); await closeSelf(); } };
}

function actionHit(action) {
  return { kind: "action", title: action.label, keys: action.keys, run: action.run };
}

function render() {
  hits = build(input.value);
  selected = Math.min(selected, Math.max(0, hits.length - 1));
  list.replaceChildren(
    ...hits.map((hit, index) => {
      const glyph = el("span", "glyph", hit.kind === "action" ? icon("bolt") : hit.kind === "search" ? icon("search") : hit.kind === "go" ? icon("globe") : favicon(hit.url, hit.icon));
      const text = el("span", "text", el("span", "title", hit.title), hit.sub ? el("span", "sub", hit.sub) : null);
      const side = el("span", "side", hit.keys ? el("kbd", "", hit.keys) : null, hit.side || null, hit.side ? el("span", "go", icon("arrow")) : null);
      const row = el("div", `hit${index === selected ? " on" : ""}`, glyph, text, side);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === selected));
      row.addEventListener("mousemove", () => select(index));
      row.addEventListener("click", () => run(index));
      return row;
    }),
  );
  const top = hits[selected];
  lead.replaceChildren(top && top.url && top.kind !== "go" ? favicon(top.url, top.icon) : icon(top?.kind === "action" ? "bolt" : top?.kind === "go" ? "globe" : "search"));
}

function select(index) {
  if (index === selected) return;
  selected = index;
  [...list.children].forEach((row, i) => {
    row.classList.toggle("on", i === selected);
    row.setAttribute("aria-selected", String(i === selected));
  });
}

let running = false;
async function run(index) {
  const hit = hits[index];
  // A second Enter while the first is still working must not run the action twice.
  if (!hit || running) return;
  running = true;
  try {
    await hit.run();
  } catch (error) {
    leaving = false;
    console.warn(error);
  } finally {
    running = false;
  }
}

let historyTimer;
function lookUpHistory() {
  clearTimeout(historyTimer);
  const text = input.value.trim();
  if (!data.history || text.length < 2) return;
  historyTimer = setTimeout(async () => {
    const found = await chrome.history.search({ text, maxResults: 8, startTime: 0 }).catch(() => []);
    if (input.value.trim() !== text) return;
    historyHits = found;
    historyFor = text;
    render();
  }, 90);
}

// ---------------------------------------------------------------- keys

input.addEventListener("input", () => {
  selected = 0;
  render();
  lookUpHistory();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
    event.preventDefault();
    select((selected + 1) % Math.max(1, hits.length));
  } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
    event.preventDefault();
    select((selected - 1 + hits.length) % Math.max(1, hits.length));
  } else if (event.key === "Enter") {
    event.preventDefault();
    run(selected);
  } else if (event.key === "Escape") {
    event.preventDefault();
    dismiss();
  }
});

document.addEventListener("mousedown", (event) => {
  if (event.target !== input) event.preventDefault();
});

if (mode === "window") {
  document.body.classList.add("window");
  window.addEventListener("blur", () => {
    if (!leaving) window.close();
  });
} else {
  // Clicking away from an untouched new tab throws it away, the way the bar would close.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !leaving && !input.value && selfTab) chrome.tabs.remove(selfTab.id).catch(() => {});
  });
}

(async () => {
  if (mode === "tab") {
    selfTab = await chrome.tabs.getCurrent();
    windowId = selfTab.windowId;
  }
  data = await send("barData");
  const space = data.spaces.find((s) => s.id === data.activeSpaceId);
  document.body.dataset.color = space?.color || "purple";
  document.documentElement.style.fontSize = `${data.settings.textSize}px`;
  if (prefill) {
    input.value = prefill;
    input.select();
  }
  render();
  lookUpHistory();
  input.focus();
})();
