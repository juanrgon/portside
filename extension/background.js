// The background worker. Every change to tabs, spaces, pins, and the archive
// happens here, one at a time, so the sidebar and the command bar only have
// to ask for things and draw the result.

import { ARCHIVE_HOURS, ARCHIVE_LIMIT, COLORS, getSess, getState, mutate, uid } from "./lib/store.js";
import { cleanUrl, hostOf, isWeb, staleTabs } from "./lib/url.js";

const ORIGIN = chrome.runtime.getURL("");
const BAR_URL = chrome.runtime.getURL("bar/bar.html");
// The command bar's own tab, and the blank new tab page it replaces, are not "tabs" to list or archive.
const isOurs = (url) => (url || "").startsWith(ORIGIN) || url === "chrome://newtab/";

// ---------------------------------------------------------------- spaces ↔ tab groups

function uniqueName(state, wanted, exceptId) {
  const base = (wanted || "").trim() || "Space";
  const taken = new Set(state.spaces.filter((s) => s.id !== exceptId).map((s) => s.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/**
 * Line up spaces with the tab groups in one window. A space is a tab group.
 * Group ids change after a restart, so a lost id is found again by its title.
 * A titled group nobody owns becomes a new space.
 */
async function resolveGroups(state, sess, windowId) {
  const groups = await chrome.tabGroups.query({ windowId });
  const byId = new Map(groups.map((g) => [g.id, g]));
  const map = (sess.groups[windowId] ||= {});
  for (const spaceId of Object.keys(map)) {
    if (!state.spaces.some((s) => s.id === spaceId) || !byId.has(map[spaceId])) delete map[spaceId];
  }
  const used = new Set(Object.values(map));
  for (const space of state.spaces) {
    if (map[space.id] != null) continue;
    const match = groups.find((g) => g.title === space.name && !used.has(g.id));
    if (match) {
      map[space.id] = match.id;
      used.add(match.id);
    }
  }
  for (const space of state.spaces) {
    // The group was renamed or recolored in Chrome's own tab strip: follow it.
    const group = byId.get(map[space.id]);
    if (!group) continue;
    if (group.title && group.title !== space.name) space.name = uniqueName(state, group.title, space.id);
    if (group.color !== space.color) space.color = group.color;
  }
  for (const group of groups) {
    if (used.has(group.id) || !group.title) continue;
    const space = { id: uid(), name: uniqueName(state, group.title), icon: "", color: group.color };
    state.spaces.push(space);
    map[space.id] = group.id;
    used.add(group.id);
  }
  return map;
}

async function putInSpace(state, sess, windowId, spaceId, tabIds) {
  if (!tabIds.length) return;
  const space = state.spaces.find((s) => s.id === spaceId) || state.spaces[0];
  const map = (sess.groups[windowId] ||= {});
  let groupId = map[space.id];
  if (groupId != null) {
    try {
      await chrome.tabs.group({ tabIds, groupId });
      return;
    } catch {
      delete map[space.id];
    }
  }
  groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: space.name, color: space.color });
  map[space.id] = groupId;
}

function spaceOfTab(state, sess, tab) {
  if (tab.pinned) return null;
  const map = sess.groups[tab.windowId] || {};
  const hit = Object.entries(map).find(([, groupId]) => groupId === tab.groupId);
  return hit ? hit[0] : state.activeSpaceId;
}

// ---------------------------------------------------------------- keeping things in step

function allEntries(state) {
  return [...state.favorites.map((e) => ({ ...e, kind: "fav" })), ...state.pinned.map((e) => ({ ...e, kind: "pin" }))];
}

/** Group loose tabs, forget dead links, and re-link saved tabs after a restart. */
async function syncNow(state, sess) {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"], populate: true });
  const tabs = [];
  for (const win of windows) {
    await resolveGroups(state, sess, win.id);
    const loose = win.tabs.filter((t) => !t.pinned && t.groupId === -1).map((t) => t.id);
    try {
      await putInSpace(state, sess, win.id, state.activeSpaceId, loose);
    } catch {
      // Chrome refuses to move tabs while one is being dragged. The next event retries.
    }
    tabs.push(...win.tabs);
  }
  const live = new Map(tabs.map((t) => [t.id, t]));
  const entries = allEntries(state);
  for (const [entryId, tabId] of Object.entries(sess.links)) {
    if (!live.has(tabId) || !entries.some((e) => e.id === entryId)) delete sess.links[entryId];
  }
  const linked = new Set(Object.values(sess.links));
  for (const entry of entries) {
    if (sess.links[entry.id] != null) continue;
    const want = cleanUrl(entry.url);
    const match = tabs.find((t) => {
      if (linked.has(t.id) || isOurs(t.url)) return false;
      const url = cleanUrl(t.pendingUrl || t.url || "");
      if (entry.kind === "fav") return t.pinned && (url === want || hostOf(url) === hostOf(want));
      return !t.pinned && url === want && spaceOfTab(state, sess, t) === entry.spaceId;
    });
    if (match) {
      sess.links[entry.id] = match.id;
      linked.add(match.id);
    }
  }
  // A tab pinned with Chrome's own menu becomes a favorite.
  for (const tab of tabs) {
    if (!tab.pinned || linked.has(tab.id) || !isWeb(tab.url)) continue;
    const entry = { id: uid(), url: cleanUrl(tab.url), title: tab.title || hostOf(tab.url) };
    state.favorites.push(entry);
    sess.links[entry.id] = tab.id;
    linked.add(tab.id);
  }
}

let syncTimer;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => mutate(syncNow).catch(console.warn), 150);
}

// ---------------------------------------------------------------- tabs

/** Close tabs without letting Chrome close the whole window with them. */
async function safeRemove(tabIds) {
  if (!tabIds.length) return;
  const closing = new Set(tabIds);
  const windowIds = new Set();
  for (const id of tabIds) {
    try {
      windowIds.add((await chrome.tabs.get(id)).windowId);
    } catch {
      closing.delete(id);
    }
  }
  for (const windowId of windowIds) {
    const all = await chrome.tabs.query({ windowId });
    if (all.every((t) => closing.has(t.id))) await chrome.tabs.create({ windowId });
  }
  await chrome.tabs.remove([...closing]);
}

function archiveRecord(state, sess, tab, reason) {
  if (!isWeb(tab.url)) return;
  state.archive.unshift({
    id: uid(),
    url: tab.url,
    title: tab.title || hostOf(tab.url),
    spaceId: spaceOfTab(state, sess, tab),
    closedAt: Date.now(),
    reason,
  });
  if (state.archive.length > ARCHIVE_LIMIT) state.archive.length = ARCHIVE_LIMIT;
}

async function archiveTabs(state, sess, tabs, reason) {
  for (const tab of tabs) archiveRecord(state, sess, tab, reason);
  await safeRemove(tabs.map((t) => t.id));
}

async function todayTabs(state, sess, windowId, spaceId = state.activeSpaceId) {
  const linked = new Set(Object.values(sess.links));
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.filter((t) => !t.pinned && !linked.has(t.id) && !isOurs(t.url) && spaceOfTab(state, sess, t) === spaceId);
}

async function autoArchive() {
  await mutate(async (state, sess) => {
    const limit = state.settings.archiveAfterHours * 3600 * 1000;
    const linked = new Set(Object.values(sess.links));
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    const stale = staleTabs(tabs, { linkedIds: linked, limitMs: limit, isOurs });
    if (stale.length) await archiveTabs(state, sess, stale, "auto");
  });
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return tab;
}

/** The most recent tab in this window that still exists, is not ours, and is not `skipId`. */
async function recentTab(sess, windowId, skipId) {
  for (const id of sess.prev[windowId] || []) {
    if (id === skipId) continue;
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab && !isOurs(tab.url)) return tab;
  }
  return null;
}

/** The tab the person is "on". If the command bar's own tab is in front, that is the one before it. */
async function contextTab(sess, windowId) {
  const [active] = await chrome.tabs.query({ windowId, active: true });
  if (active && !isOurs(active.url)) return active;
  return recentTab(sess, windowId, active?.id);
}

// ---------------------------------------------------------------- space switching

async function switchSpaceIn(state, sess, spaceId, windowId) {
  if (!state.spaces.some((s) => s.id === spaceId)) return;
  const map = await resolveGroups(state, sess, windowId);
  let tabs = await chrome.tabs.query({ windowId });
  // A tab opened a moment ago may not be filed yet. It belongs to the space being left.
  const loose = tabs.filter((t) => !t.pinned && t.groupId === -1).map((t) => t.id);
  if (loose.length && state.activeSpaceId !== spaceId) {
    await putInSpace(state, sess, windowId, state.activeSpaceId, loose).catch(() => {});
    tabs = await chrome.tabs.query({ windowId });
  }
  state.activeSpaceId = spaceId;
  const mine = tabs.filter((t) => !t.pinned && t.groupId === map[spaceId] && map[spaceId] != null);
  const [active] = tabs.filter((t) => t.active);
  if (map[spaceId] != null) await chrome.tabGroups.update(map[spaceId], { collapsed: false }).catch(() => {});
  if (!active?.pinned || !mine.length) {
    // Favorites belong to every space, so stay on one. Otherwise go to this space's latest tab.
    const target = mine.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (target) await chrome.tabs.update(target.id, { active: true });
    else if (!active?.pinned) {
      const fresh = await chrome.tabs.create({ windowId, active: true });
      await putInSpace(state, sess, windowId, spaceId, [fresh.id]);
    }
  }
  for (const [otherId, groupId] of Object.entries(sess.groups[windowId] || {})) {
    if (otherId !== spaceId) await chrome.tabGroups.update(groupId, { collapsed: true }).catch(() => {});
  }
}

async function retitleGroups(sess, space) {
  for (const map of Object.values(sess.groups)) {
    if (map[space.id] == null) continue;
    await chrome.tabGroups.update(map[space.id], { title: space.name, color: space.color }).catch(() => {});
  }
}

// ---------------------------------------------------------------- pins and favorites

function insertAmong(list, entry, siblings, index) {
  const before = index != null && index < siblings.length ? siblings[index] : null;
  if (before) list.splice(list.indexOf(before), 0, entry);
  else list.push(entry);
}

/** Move a tab, a pinned tab, or a favorite to a new home. This is what drag and drop calls. */
async function moveItem(state, sess, { item, to, windowId }) {
  let entry = null;
  let from = null;
  let tab = null;
  if (item.kind === "tab") tab = await chrome.tabs.get(item.tabId);
  else if (item.kind === "fav") [entry, from] = [state.favorites.find((e) => e.id === item.id), "favs"];
  else [entry, from] = [state.pinned.find((e) => e.id === item.id), "pinned"];
  if (!tab && !entry) return;
  let tabId = tab ? tab.id : sess.links[entry.id];
  const home = tab?.windowId ?? windowId;

  if (to.zone === "today") {
    if (tab) return reorderToday(state, sess, tab, to.index);
    state.favorites = state.favorites.filter((e) => e.id !== entry.id);
    state.pinned = state.pinned.filter((e) => e.id !== entry.id);
    delete sess.links[entry.id];
    if (tabId == null) tabId = (await chrome.tabs.create({ windowId: home, url: entry.url, active: false })).id;
    else if (from === "favs") await chrome.tabs.update(tabId, { pinned: false });
    await putInSpace(state, sess, home, state.activeSpaceId, [tabId]);
    return;
  }

  const moved = entry || { id: uid(), url: cleanUrl(tab.url), title: tab.title || hostOf(tab.url) };
  state.favorites = state.favorites.filter((e) => e.id !== moved.id);
  state.pinned = state.pinned.filter((e) => e.id !== moved.id);
  if (to.zone === "favs") {
    delete moved.spaceId;
    delete moved.folderId;
    insertAmong(state.favorites, moved, state.favorites, to.index);
    if (tabId != null) await chrome.tabs.update(tabId, { pinned: true });
  } else {
    moved.spaceId = to.spaceId || state.activeSpaceId;
    moved.folderId = to.folderId || null;
    const siblings = state.pinned.filter((e) => e.spaceId === moved.spaceId && (e.folderId || null) === moved.folderId);
    insertAmong(state.pinned, moved, siblings, to.index);
    if (tabId != null) {
      const live = await chrome.tabs.get(tabId);
      if (live.pinned) await chrome.tabs.update(tabId, { pinned: false });
      await putInSpace(state, sess, live.windowId, moved.spaceId, [tabId]);
    }
  }
  if (tabId != null) sess.links[moved.id] = tabId;
}

/** The sidebar lists today's tabs newest first, so its order is the tab strip backwards. */
async function reorderToday(state, sess, tab, index) {
  const strip = (await todayTabs(state, sess, tab.windowId)).filter((t) => t.id !== tab.id);
  const shown = [...strip].reverse();
  if (!shown.length) return;
  if (index == null || index >= shown.length) {
    const first = strip[0];
    await chrome.tabs.move(tab.id, { index: tab.index < first.index ? first.index - 1 : first.index });
  } else {
    const anchor = shown[index];
    await chrome.tabs.move(tab.id, { index: tab.index < anchor.index ? anchor.index : anchor.index + 1 });
  }
  const after = await chrome.tabs.get(tab.id);
  if (after.groupId === -1) await putInSpace(state, sess, tab.windowId, state.activeSpaceId, [tab.id]);
}

async function openEntry(state, sess, { id, windowId }) {
  const entry = allEntries(state).find((e) => e.id === id);
  if (!entry) return;
  const linked = sess.links[id];
  if (linked != null) {
    try {
      await focusTab(linked);
      return;
    } catch {
      delete sess.links[id];
    }
  }
  const tab = await chrome.tabs.create({ windowId, url: entry.url, active: true, pinned: entry.kind === "fav" });
  if (entry.kind === "pin") await putInSpace(state, sess, tab.windowId, entry.spaceId, [tab.id]);
  sess.links[id] = tab.id;
}

// ---------------------------------------------------------------- what the sidebar draws

async function view({ windowId }) {
  const state = await getState();
  const sess = await getSess();
  const tabs = await chrome.tabs.query({ windowId });
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const linked = new Set(Object.values(sess.links));
  const slim = (t) => ({ tabId: t.id, title: t.title || hostOf(t.url) || "New Tab", url: t.url, icon: t.favIconUrl || "", active: t.active, audible: !!t.audible, loading: t.status === "loading" });
  const dress = (e) => {
    const tab = byId.get(sess.links[e.id]);
    return {
      id: e.id,
      url: e.url,
      icon: tab?.favIconUrl || "",
      folderId: e.folderId || null,
      title: e.customTitle || (tab ? tab.title : e.title) || hostOf(e.url),
      tabId: tab?.id ?? null,
      loaded: sess.links[e.id] != null,
      active: !!tab?.active,
      audible: !!tab?.audible,
      drifted: !!tab && isWeb(tab.url) && cleanUrl(tab.url) !== cleanUrl(e.url),
    };
  };
  const space = state.spaces.find((s) => s.id === state.activeSpaceId);
  const active = tabs.find((t) => t.active);
  return {
    windowId,
    spaces: state.spaces,
    space,
    colors: COLORS,
    favorites: state.favorites.map(dress),
    pinned: state.pinned.filter((e) => e.spaceId === space.id).map(dress),
    folders: state.folders.filter((f) => f.spaceId === space.id),
    today: tabs
      .filter((t) => !t.pinned && !linked.has(t.id) && !isOurs(t.url) && spaceOfTab(state, sess, t) === space.id)
      .reverse()
      .map(slim),
    activeUrl: active && !isOurs(active.url) ? active.url : "",
    archiveCount: state.archive.length,
    settings: state.settings,
    archiveHours: ARCHIVE_HOURS,
  };
}

async function barData({ windowId }) {
  const state = await getState();
  const sess = await getSess();
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  const name = (id) => state.spaces.find((s) => s.id === id)?.name || "";
  const current = await contextTab(sess, windowId);
  const linkedEntry = current && allEntries(state).find((e) => sess.links[e.id] === current.id);
  return {
    tabs: tabs
      .filter((t) => !isOurs(t.url) && t.id !== current?.id)
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
      .map((t) => ({ tabId: t.id, title: t.title, url: t.url, icon: t.favIconUrl || "", space: t.pinned ? "Favorite" : name(spaceOfTab(state, sess, t)) })),
    entries: allEntries(state)
      .filter((e) => sess.links[e.id] == null)
      .map((e) => ({ id: e.id, title: e.customTitle || e.title, url: e.url, space: e.kind === "fav" ? "Favorite" : name(e.spaceId) })),
    spaces: state.spaces,
    activeSpaceId: state.activeSpaceId,
    current: current ? { tabId: current.id, url: current.url, title: current.title, saved: linkedEntry?.kind || null } : null,
    settings: state.settings,
    archiveHours: ARCHIVE_HOURS,
    history: await chrome.permissions.contains({ permissions: ["history"] }),
  };
}

// ---------------------------------------------------------------- clipboard and little signals

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Before Chrome 157 a background worker cannot reach the clipboard. Use a hidden page.
  }
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "Copy the current tab's link.",
    });
  } catch {
    // Already open.
  }
  await chrome.runtime.sendMessage({ type: "offscreen:copy", text });
  await chrome.offscreen.closeDocument().catch(() => {});
}

function signal(message) {
  chrome.runtime.sendMessage({ type: "toast", message }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#3b2f63" }).catch(() => {});
  chrome.action.setBadgeText({ text: "✓" }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ text: "" }).catch(() => {}), 1400);
}

async function copyUrl({ windowId, url }) {
  let link = url;
  if (!link) {
    const tab = await contextTab(await getSess(), windowId);
    link = tab?.url;
  }
  if (!link) return false;
  await writeClipboard(cleanUrl(link));
  signal("Link copied");
  return true;
}

async function openBar({ windowId, prefill }) {
  const win = await chrome.windows.get(windowId);
  const width = 720;
  const height = 468;
  const url = new URL(BAR_URL);
  url.searchParams.set("mode", "window");
  url.searchParams.set("w", String(windowId));
  if (prefill) url.searchParams.set("q", prefill);
  await chrome.windows.create({
    url: url.toString(),
    type: "popup",
    width,
    height,
    left: Math.round(win.left + (win.width - width) / 2),
    top: Math.round(win.top + Math.max(96, (win.height - height) / 3)),
    focused: true,
  });
}

function toggleSidebar(windowId) {
  // open() must run right away or Chrome forgets the key press. If the sidebar
  // is already open, open() does nothing and the sidebar closes itself instead.
  chrome.sidePanel.open({ windowId }).catch(() => {});
  chrome.runtime.sendMessage({ type: "panel:toggle", windowId }).catch(() => {});
}

// ---------------------------------------------------------------- everything the pages can ask for

const change = (fn) => (payload) => mutate((state, sess) => fn(state, sess, payload || {}));

const handlers = {
  view,
  barData,
  copyUrl,
  openBar,
  sync: () => mutate(syncNow),
  move: change(moveItem),
  openEntry: change(openEntry),
  switchSpace: change((state, sess, { id, windowId }) => switchSpaceIn(state, sess, id, windowId)),

  stepSpace: change((state, sess, { dir, windowId }) => {
    const at = state.spaces.findIndex((s) => s.id === state.activeSpaceId);
    const next = state.spaces[(at + dir + state.spaces.length) % state.spaces.length];
    return switchSpaceIn(state, sess, next.id, windowId);
  }),

  activateTab: ({ tabId }) => focusTab(tabId),

  newTab: change(async (state, sess, { windowId, url }) => {
    const tab = await chrome.tabs.create({ windowId, url, active: true });
    await putInSpace(state, sess, tab.windowId, state.activeSpaceId, [tab.id]);
  }),

  closeTab: change(async (state, sess, { tabId }) => {
    const tab = await chrome.tabs.get(tabId);
    const rest = (await todayTabs(state, sess, tab.windowId)).filter((t) => t.id !== tabId);
    const spaceHasMore = rest.length || Object.entries(sess.links).some(([id]) => state.pinned.some((e) => e.id === id && e.spaceId === state.activeSpaceId));
    if (tab.active && !spaceHasMore) {
      // Keep the person in this space instead of letting Chrome jump to another one.
      const fresh = await chrome.tabs.create({ windowId: tab.windowId, active: true });
      await putInSpace(state, sess, tab.windowId, state.activeSpaceId, [fresh.id]);
    }
    await archiveTabs(state, sess, [tab], "manual");
  }),

  closeEntryTab: change(async (state, sess, { id }) => {
    const tabId = sess.links[id];
    delete sess.links[id];
    if (tabId != null) await safeRemove([tabId]);
  }),

  removeEntry: change(async (state, sess, { id }) => {
    const tabId = sess.links[id];
    delete sess.links[id];
    state.favorites = state.favorites.filter((e) => e.id !== id);
    state.pinned = state.pinned.filter((e) => e.id !== id);
    if (tabId != null) await safeRemove([tabId]);
  }),

  renameEntry: change((state, sess, { id, title }) => {
    const entry = [...state.favorites, ...state.pinned].find((e) => e.id === id);
    if (!entry) return;
    if (title && title.trim()) entry.customTitle = title.trim();
    else delete entry.customTitle;
  }),

  resetEntry: change(async (state, sess, { id }) => {
    const entry = [...state.favorites, ...state.pinned].find((e) => e.id === id);
    if (entry && sess.links[id] != null) await chrome.tabs.update(sess.links[id], { url: entry.url });
  }),

  saveEntryUrl: change(async (state, sess, { id }) => {
    const entry = [...state.favorites, ...state.pinned].find((e) => e.id === id);
    if (!entry || sess.links[id] == null) return;
    const tab = await chrome.tabs.get(sess.links[id]);
    entry.url = cleanUrl(tab.url);
    entry.title = tab.title || entry.title;
  }),

  moveTabToSpace: change(async (state, sess, { tabId, spaceId }) => {
    const tab = await chrome.tabs.get(tabId);
    await putInSpace(state, sess, tab.windowId, spaceId, [tabId]);
    const entry = state.pinned.find((e) => sess.links[e.id] === tabId);
    if (entry) {
      entry.spaceId = spaceId;
      entry.folderId = null;
    }
  }),

  moveEntryToSpace: change(async (state, sess, { id, spaceId }) => {
    const entry = state.pinned.find((e) => e.id === id);
    if (!entry) return;
    entry.spaceId = spaceId;
    entry.folderId = null;
    const tabId = sess.links[id];
    if (tabId != null) {
      const tab = await chrome.tabs.get(tabId);
      await putInSpace(state, sess, tab.windowId, spaceId, [tabId]);
    }
  }),

  togglePin: change(async (state, sess, { windowId }) => {
    const tab = await contextTab(sess, windowId);
    if (!tab) return;
    const fav = state.favorites.find((e) => sess.links[e.id] === tab.id);
    const pin = state.pinned.find((e) => sess.links[e.id] === tab.id);
    if (fav) return;
    if (pin) await moveItem(state, sess, { item: { kind: "pin", id: pin.id }, to: { zone: "today" }, windowId });
    else await moveItem(state, sess, { item: { kind: "tab", tabId: tab.id }, to: { zone: "pinned" }, windowId });
    signal(pin ? "Unpinned" : "Pinned");
  }),

  favoriteCurrent: change(async (state, sess, { windowId }) => {
    const tab = await contextTab(sess, windowId);
    if (!tab) return;
    const pin = state.pinned.find((e) => sess.links[e.id] === tab.id);
    const item = pin ? { kind: "pin", id: pin.id } : { kind: "tab", tabId: tab.id };
    await moveItem(state, sess, { item, to: { zone: "favs" }, windowId });
    signal("Added to favorites");
  }),

  closeCurrent: change(async (state, sess, { windowId }) => {
    const tab = await contextTab(sess, windowId);
    if (tab) await archiveTabs(state, sess, [tab], "manual");
  }),

  addFolder: change((state, sess, { name }) => {
    const folder = { id: uid(), spaceId: state.activeSpaceId, name: name || "New Folder", open: true };
    state.folders.push(folder);
    return folder.id;
  }),

  renameFolder: change((state, sess, { id, name }) => {
    const folder = state.folders.find((f) => f.id === id);
    if (folder && name && name.trim()) folder.name = name.trim();
  }),

  toggleFolder: change((state, sess, { id }) => {
    const folder = state.folders.find((f) => f.id === id);
    if (folder) folder.open = !folder.open;
  }),

  deleteFolder: change((state, sess, { id }) => {
    state.folders = state.folders.filter((f) => f.id !== id);
    for (const entry of state.pinned) if (entry.folderId === id) entry.folderId = null;
  }),

  addSpace: change(async (state, sess, { windowId, name, naming }) => {
    const color = COLORS.find((c) => c !== "grey" && !state.spaces.some((s) => s.color === c)) || "blue";
    const space = { id: uid(), name: uniqueName(state, name || "New Space"), icon: "", color };
    state.spaces.push(space);
    if (naming) {
      // The sidebar is about to ask for a name. Opening the space's first tab now
      // would pull the cursor out of that box, so the sidebar switches once naming is done.
      const tabs = await chrome.tabs.query({ windowId });
      const loose = tabs.filter((t) => !t.pinned && t.groupId === -1).map((t) => t.id);
      await putInSpace(state, sess, windowId, state.activeSpaceId, loose).catch(() => {});
      state.activeSpaceId = space.id;
    } else await switchSpaceIn(state, sess, space.id, windowId);
    return space.id;
  }),

  updateSpace: change(async (state, sess, { id, patch }) => {
    const space = state.spaces.find((s) => s.id === id);
    if (!space) return;
    if (typeof patch.name === "string" && patch.name.trim()) space.name = uniqueName(state, patch.name, id);
    if (typeof patch.icon === "string") space.icon = patch.icon;
    if (COLORS.includes(patch.color)) space.color = patch.color;
    await retitleGroups(sess, space);
  }),

  deleteSpace: change(async (state, sess, { id, windowId }) => {
    if (state.spaces.length < 2) return;
    const at = state.spaces.findIndex((s) => s.id === id);
    const next = state.spaces[at === 0 ? 1 : at - 1];
    for (const [winId, map] of Object.entries(sess.groups)) {
      if (map[id] == null) continue;
      const tabs = await chrome.tabs.query({ groupId: map[id] });
      delete map[id];
      await putInSpace(state, sess, Number(winId), next.id, tabs.map((t) => t.id));
    }
    for (const entry of state.pinned.filter((e) => e.spaceId === id)) delete sess.links[entry.id];
    state.pinned = state.pinned.filter((e) => e.spaceId !== id);
    state.folders = state.folders.filter((f) => f.spaceId !== id);
    state.spaces = state.spaces.filter((s) => s.id !== id);
    await switchSpaceIn(state, sess, next.id, windowId);
  }),

  clearToday: change(async (state, sess, { windowId }) => {
    const tabs = await todayTabs(state, sess, windowId);
    await archiveTabs(state, sess, tabs, "manual");
    if (tabs.length) signal(tabs.length === 1 ? "1 tab archived" : `${tabs.length} tabs archived`);
  }),

  archiveList: async ({ q }) => {
    const state = await getState();
    const needle = (q || "").trim().toLowerCase();
    const name = (id) => state.spaces.find((s) => s.id === id)?.name || "";
    return state.archive
      .filter((a) => !needle || a.title.toLowerCase().includes(needle) || a.url.toLowerCase().includes(needle))
      .slice(0, 300)
      .map((a) => ({ ...a, space: name(a.spaceId) }));
  },

  restoreArchived: change(async (state, sess, { id, windowId }) => {
    const item = state.archive.find((a) => a.id === id);
    if (!item) return;
    state.archive = state.archive.filter((a) => a.id !== id);
    const spaceId = state.spaces.some((s) => s.id === item.spaceId) ? item.spaceId : state.activeSpaceId;
    if (spaceId !== state.activeSpaceId) await switchSpaceIn(state, sess, spaceId, windowId);
    const tab = await chrome.tabs.create({ windowId, url: item.url, active: true });
    await putInSpace(state, sess, tab.windowId, spaceId, [tab.id]);
  }),

  clearArchive: change((state) => {
    state.archive = [];
  }),

  setSetting: change((state, sess, { key, value }) => {
    if (key === "archiveAfterHours" && ARCHIVE_HOURS.includes(value)) state.settings.archiveAfterHours = value;
    if (key === "barOnNewTab") state.settings.barOnNewTab = !!value;
  }),

  lastTab: async ({ windowId }) => {
    const sess = await getSess();
    const [active] = await chrome.tabs.query({ windowId, active: true });
    const target = await recentTab(sess, windowId, active?.id);
    if (target) await focusTab(target.id).catch(() => {});
  },

  /** Close the command bar's own tab and land back where the person was. */
  dismissBarTab: async ({ tabId, windowId }) => {
    const sess = await getSess();
    const target = await recentTab(sess, windowId, tabId);
    if (target) await chrome.tabs.update(target.id, { active: true }).catch(() => {});
    await safeRemove([tabId]);
  },
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message.payload || {}))
    .then((result) => respond({ ok: true, result }))
    .catch((error) => {
      console.warn(message.type, error);
      respond({ ok: false, error: String(error?.message || error) });
    });
  return true;
});

// ---------------------------------------------------------------- browser events

chrome.commands.onCommand.addListener((command, tab) => {
  const windowId = tab?.windowId;
  if (windowId == null) return;
  if (command === "toggle-sidebar") toggleSidebar(windowId);
  else if (command === "copy-url") copyUrl({ windowId }).catch(console.warn);
  else if (command === "command-bar") openBar({ windowId }).catch(console.warn);
  else if (command === "last-tab") handlers.lastTab({ windowId });
  else if (command === "next-space") handlers.stepSpace({ dir: 1, windowId });
  else if (command === "previous-space") handlers.stepSpace({ dir: -1, windowId });
  else if (command === "pin-tab") handlers.togglePin({ windowId });
  else if (command === "clear-today") handlers.clearToday({ windowId });
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  mutate(async (state, sess) => {
    const prev = sess.prev[windowId] || [];
    sess.prev[windowId] = [tabId, ...prev.filter((id) => id !== tabId)].slice(0, 6);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.pinned || tab.groupId === -1) return;
    // Clicking a tab that lives in another space takes the sidebar there too.
    const owner = Object.entries(sess.groups[windowId] || {}).find(([, groupId]) => groupId === tab.groupId);
    if (owner && owner[0] !== state.activeSpaceId) state.activeSpaceId = owner[0];
  }).catch(console.warn);
});

chrome.tabs.onCreated.addListener((created) => {
  // File the tab under the space that is current right now, not the one that
  // happens to be current when the next tidy-up runs.
  mutate(async (state, sess) => {
    const tab = await chrome.tabs.get(created.id).catch(() => null);
    if (!tab || tab.pinned || tab.groupId !== -1) return;
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (win?.type === "normal") await putInSpace(state, sess, tab.windowId, state.activeSpaceId, [tab.id]).catch(() => {});
  }).catch(console.warn);
  scheduleSync();
});
chrome.tabs.onRemoved.addListener(scheduleSync);
chrome.tabs.onAttached.addListener(scheduleSync);
chrome.tabs.onDetached.addListener(scheduleSync);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if ("pinned" in info || "groupId" in info || "url" in info) scheduleSync();
});
chrome.tabGroups.onCreated.addListener(scheduleSync);
chrome.tabGroups.onRemoved.addListener(scheduleSync);
chrome.tabGroups.onUpdated.addListener(scheduleSync);
chrome.windows.onCreated.addListener(scheduleSync);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "archive") autoArchive().catch(console.warn);
});

async function boot() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  if (!(await chrome.alarms.get("archive"))) await chrome.alarms.create("archive", { periodInMinutes: 5 });
  await mutate(syncNow).catch(console.warn);
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
