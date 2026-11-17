// The background worker. Every change to tabs, spaces, pins, and the archive
// happens here, one at a time, so the sidebar and the command bar only have
// to ask for things and draw the result.

import { ARCHIVE_HOURS, ARCHIVE_LIMIT, COLORS, TEXT_SIZES, getSess, getState, mutate, settled, uid } from "./lib/store.js";
import { cleanUrl, hostOf, isWeb, staleTabs } from "./lib/url.js";

const ORIGIN = chrome.runtime.getURL("");
const BAR_URL = chrome.runtime.getURL("bar/bar.html");
// The command bar's own tab, and the blank new tab page it replaces, are not "tabs" to list or archive.
const isOurs = (url) => (url || "").startsWith(ORIGIN) || url === "chrome://newtab/";
// Where a tab is, or is on its way to. A tab still loading its first page has only a pending link.
const urlOf = (tab) => (isWeb(tab.pendingUrl) ? tab.pendingUrl : tab.url) || "";

/** Each window shows its own tab group. A window that has not picked one uses the last one picked anywhere. */
function activeOf(state, sess, windowId) {
  const id = sess.active?.[windowId];
  return state.spaces.some((s) => s.id === id) ? id : state.activeSpaceId;
}

function setActive(state, sess, windowId, spaceId) {
  (sess.active ||= {})[windowId] = spaceId;
  state.activeSpaceId = spaceId;
}

/** Forget which tab a saved entry had open. */
function unlink(state, sess, entryId) {
  delete sess.links[entryId];
  const entry = [...state.favorites, ...state.pinned].find((e) => e.id === entryId);
  if (entry) delete entry.live;
}

/**
 * Remember, in storage that survives a restart, which page each open saved tab
 * is on. After a restart that is how a pin finds its tab again, even one that
 * wandered off its saved page. A pin whose tab was closed has no such note, so
 * it never claims somebody else's tab.
 */
async function stampLive(state, sess) {
  const ids = Object.values(sess.links);
  if (!ids.length) return;
  const byId = new Map((await chrome.tabs.query({})).map((t) => [t.id, t]));
  for (const entry of [...state.favorites, ...state.pinned]) {
    const tab = byId.get(sess.links[entry.id]);
    if (tab && isWeb(urlOf(tab))) entry.live = cleanUrl(urlOf(tab));
  }
}

// ---------------------------------------------------------------- spaces ↔ tab groups

function uniqueName(state, wanted, exceptId) {
  const base = (wanted || "").trim() || "Group";
  const taken = new Set(state.spaces.filter((s) => s.id !== exceptId).map((s) => s.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/**
 * Line up saved tab groups with Chrome's tab groups in one window. Group ids
 * change after a restart, so a lost id is found again by the title the group
 * has in Chrome (and its color, when two groups share a title). Any group
 * nobody owns, titled or not, becomes a new saved group, so its tabs are never
 * mistaken for another group's.
 */
async function resolveGroups(state, sess, windowId) {
  const groups = await chrome.tabGroups.query({ windowId });
  const byId = new Map(groups.map((g) => [g.id, g]));
  const map = (sess.groups[windowId] ||= {});
  for (const spaceId of Object.keys(map)) {
    if (!state.spaces.some((s) => s.id === spaceId) || !byId.has(map[spaceId])) delete map[spaceId];
  }
  const used = new Set(Object.values(map));
  for (const sameColor of [true, false]) {
    for (const space of state.spaces) {
      if (map[space.id] != null) continue;
      const title = space.groupTitle ?? space.name;
      const match = groups.find((g) => !used.has(g.id) && (g.title || "") === title && (!sameColor || g.color === space.color));
      if (match) {
        map[space.id] = match.id;
        used.add(match.id);
      }
    }
  }
  for (const group of groups) {
    if (used.has(group.id)) continue;
    const space = { id: uid(), name: uniqueName(state, group.title || "Untitled"), groupTitle: group.title || "", icon: "", color: group.color };
    state.spaces.push(space);
    map[space.id] = group.id;
    used.add(group.id);
  }
  return map;
}

/**
 * A group renamed or recolored in Chrome's own tab strip: the saved group
 * follows it, and so do that group's twins in other windows. The group that
 * differs from what was last saved is the one the person just changed.
 */
async function followGroups(state, sess) {
  for (const space of state.spaces) {
    const groups = [];
    for (const map of Object.values(sess.groups)) {
      if (map[space.id] == null) continue;
      const group = await chrome.tabGroups.get(map[space.id]).catch(() => null);
      if (group) groups.push(group);
    }
    if (!groups.length) continue;
    const known = space.groupTitle ?? space.name;
    const changed = groups.find((g) => (g.title || "") !== known || g.color !== space.color);
    if (!changed) {
      space.groupTitle = known;
      continue;
    }
    if ((changed.title || "") !== known) {
      space.groupTitle = changed.title || "";
      if (changed.title) space.name = uniqueName(state, changed.title, space.id);
    }
    space.color = changed.color;
    for (const group of groups) {
      if (group.id === changed.id) continue;
      await chrome.tabGroups.update(group.id, { title: space.groupTitle, color: space.color }).catch(() => {});
    }
  }
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
  await chrome.tabGroups.update(groupId, { title: space.groupTitle ?? space.name, color: space.color });
  map[space.id] = groupId;
}

function spaceOfTab(state, sess, tab) {
  if (tab.pinned) return null;
  const map = sess.groups[tab.windowId] || {};
  const hit = Object.entries(map).find(([, groupId]) => groupId === tab.groupId);
  return hit ? hit[0] : activeOf(state, sess, tab.windowId);
}

// ---------------------------------------------------------------- keeping things in step

function allEntries(state) {
  return [...state.favorites.map((e) => ({ ...e, kind: "fav" })), ...state.pinned.map((e) => ({ ...e, kind: "pin" }))];
}

/** Group loose tabs, follow what Chrome's own menus changed, and re-link saved tabs after a restart. */
async function syncNow(state, sess) {
  // Session storage starts empty after a restart. For the next minute, while
  // Chrome is still restoring tabs, pins may look for the tab they had open.
  if (sess.recoverUntil == null) sess.recoverUntil = Date.now() + 60 * 1000;
  const recovering = Date.now() < sess.recoverUntil;

  const windows = await chrome.windows.getAll({ windowTypes: ["normal"], populate: true });
  for (const win of windows) {
    const map = await resolveGroups(state, sess, win.id);
    // A window that has not picked a tab group yet shows the one its front tab is in.
    // Without this, switching groups in one window would drag every other window along.
    if (!state.spaces.some((sp) => sp.id === sess.active?.[win.id])) {
      const front = win.tabs.find((t) => t.active && !t.pinned);
      const owner = front && Object.entries(map).find(([, groupId]) => groupId === front.groupId)?.[0];
      (sess.active ||= {})[win.id] = owner || state.activeSpaceId;
    }
  }
  await followGroups(state, sess);
  const tabs = [];
  for (const win of windows) {
    const loose = win.tabs.filter((t) => !t.pinned && t.groupId === -1).map((t) => t.id);
    try {
      await putInSpace(state, sess, win.id, activeOf(state, sess, win.id), loose);
    } catch {
      // Chrome refuses to move tabs while one is being dragged. The next event retries.
    }
    tabs.push(...(loose.length ? await chrome.tabs.query({ windowId: win.id }) : win.tabs));
  }
  const live = new Map(tabs.map((t) => [t.id, t]));
  for (const [entryId, tabId] of Object.entries(sess.links)) {
    if (!live.has(tabId) || !allEntries(state).some((e) => e.id === entryId)) unlink(state, sess, entryId);
  }
  const owner = (tab) => Object.entries(sess.groups[tab.windowId] || {}).find(([, groupId]) => groupId === tab.groupId)?.[0] || null;

  // Chrome's own menus can pin, unpin, or move a saved tab. Follow what Chrome shows.
  for (const pin of [...state.pinned]) {
    const tab = live.get(sess.links[pin.id]);
    if (!tab) continue;
    if (tab.pinned) {
      state.pinned = state.pinned.filter((e) => e !== pin);
      delete pin.spaceId;
      delete pin.folderId;
      state.favorites.push(pin);
    } else if (owner(tab) && owner(tab) !== pin.spaceId) {
      pin.spaceId = owner(tab);
      pin.folderId = null;
    }
  }
  // A favorite's tab that was unpinned in Chrome is an ordinary tab again.
  // The favorite itself is kept, so nothing saved is lost by a stray click.
  for (const fav of state.favorites) {
    const tab = live.get(sess.links[fav.id]);
    if (tab && !tab.pinned) unlink(state, sess, fav.id);
  }

  const linked = new Set(Object.values(sess.links));
  const free = (t) => !linked.has(t.id) && !isOurs(t.url);
  const claim = (entry, tab) => {
    if (!tab) return;
    sess.links[entry.id] = tab.id;
    linked.add(tab.id);
  };
  // A pinned tab in Chrome is a favorite by definition, so a favorite may claim
  // one at any time: first the page it was last on, then its saved page, then its site.
  const at = (t) => cleanUrl(urlOf(t));
  for (const test of [(f, t) => f.live && at(t) === f.live, (f, t) => at(t) === cleanUrl(f.url), (f, t) => hostOf(at(t)) === hostOf(f.url)]) {
    for (const fav of state.favorites) {
      if (sess.links[fav.id] == null) claim(fav, tabs.find((t) => t.pinned && free(t) && test(fav, t)));
    }
  }
  // A pin only looks for a tab right after a restart, and only if it had one open.
  // Otherwise an ordinary tab that happens to share its link would be swallowed.
  if (recovering) {
    for (const want of [(p) => p.live, (p) => cleanUrl(p.url)]) {
      for (const pin of state.pinned) {
        if (sess.links[pin.id] != null || !pin.live) continue;
        claim(pin, tabs.find((t) => !t.pinned && free(t) && at(t) === want(pin) && owner(t) === pin.spaceId));
      }
    }
  }
  // A tab pinned with Chrome's own menu becomes a favorite.
  for (const tab of tabs) {
    if (!tab.pinned || linked.has(tab.id) || !isWeb(urlOf(tab))) continue;
    const entry = { id: uid(), url: cleanUrl(urlOf(tab)), title: tab.title || hostOf(urlOf(tab)) };
    state.favorites.push(entry);
    claim(entry, tab);
  }
  await stampLive(state, sess);
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
  const url = urlOf(tab);
  if (!isWeb(url)) return;
  state.archive.unshift({
    id: uid(),
    url,
    // While a page is still loading, the title belongs to the page being left.
    title: (url === tab.url && tab.title) || hostOf(url),
    spaceId: spaceOfTab(state, sess, tab),
    closedAt: Date.now(),
    reason,
  });
  if (state.archive.length > ARCHIVE_LIMIT) state.archive.length = ARCHIVE_LIMIT;
}

/**
 * Archive tabs and close them. A page that is not a normal web link (a local
 * file, a Chrome page, another extension's page) cannot be brought back from
 * the archive, so it is left open unless the person closed that one tab themselves.
 */
async function archiveTabs(state, sess, tabs, reason, { closeUnsaved = false } = {}) {
  const saved = tabs.filter((tab) => isWeb(urlOf(tab)));
  for (const tab of saved) archiveRecord(state, sess, tab, reason);
  // Write the archive before closing anything, so a crash cannot lose a tab.
  if (saved.length) await chrome.storage.local.set({ state });
  await safeRemove((closeUnsaved ? tabs : saved).map((t) => t.id));
  return saved.length;
}

async function todayTabs(state, sess, windowId, spaceId = activeOf(state, sess, windowId)) {
  const linked = new Set(Object.values(sess.links));
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.filter((t) => !t.pinned && !linked.has(t.id) && !isOurs(t.url) && spaceOfTab(state, sess, t) === spaceId);
}

async function autoArchive() {
  await mutate(async (state, sess) => {
    const limit = state.settings.archiveAfterHours * 3600 * 1000;
    const linked = new Set(Object.values(sess.links));
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    const stale = staleTabs(tabs, { linkedIds: linked, limitMs: limit, since: state.installedAt || 0, isOurs });
    if (stale.length) await archiveTabs(state, sess, stale, "auto");
  });
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return tab;
}

/** The most recent tab that is still in this window, is not ours, and is not `skipId`. */
async function recentTab(sess, windowId, skipId) {
  for (const id of sess.prev[windowId] || []) {
    if (id === skipId) continue;
    const tab = await chrome.tabs.get(id).catch(() => null);
    // A tab dragged to another window is no longer "the tab I was on" here.
    if (tab && tab.windowId === windowId && !isOurs(tab.url)) return tab;
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
  const leaving = activeOf(state, sess, windowId);
  if (loose.length && leaving !== spaceId) {
    await putInSpace(state, sess, windowId, leaving, loose).catch(() => {});
    tabs = await chrome.tabs.query({ windowId });
  }
  setActive(state, sess, windowId, spaceId);
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
    await chrome.tabGroups.update(map[space.id], { title: space.groupTitle ?? space.name, color: space.color }).catch(() => {});
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
    await putInSpace(state, sess, home, activeOf(state, sess, home), [tabId]);
    return;
  }

  const moved = entry || { id: uid(), url: cleanUrl(urlOf(tab)), title: tab.title || hostOf(urlOf(tab)) };
  state.favorites = state.favorites.filter((e) => e.id !== moved.id);
  state.pinned = state.pinned.filter((e) => e.id !== moved.id);
  if (to.zone === "favs") {
    delete moved.spaceId;
    delete moved.folderId;
    insertAmong(state.favorites, moved, state.favorites, to.index);
    if (tabId != null) await chrome.tabs.update(tabId, { pinned: true });
  } else {
    moved.spaceId = to.spaceId || activeOf(state, sess, home);
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
  if (after.groupId === -1) await putInSpace(state, sess, tab.windowId, activeOf(state, sess, tab.windowId), [tab.id]);
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
      unlink(state, sess, id);
    }
  }
  const tab = await chrome.tabs.create({ windowId, url: entry.url, active: true, pinned: entry.kind === "fav" });
  if (entry.kind === "pin") await putInSpace(state, sess, tab.windowId, entry.spaceId, [tab.id]);
  sess.links[id] = tab.id;
}

// ---------------------------------------------------------------- what the sidebar draws

async function view({ windowId }) {
  await settled();
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
  const space = state.spaces.find((s) => s.id === activeOf(state, sess, windowId));
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
    textSizes: TEXT_SIZES,
  };
}

async function barData({ windowId }) {
  await settled();
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
    activeSpaceId: activeOf(state, sess, windowId),
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

const change = (fn) => (payload) =>
  mutate(async (state, sess) => {
    const result = await fn(state, sess, payload || {});
    await stampLive(state, sess);
    return result;
  });

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
    const at = state.spaces.findIndex((s) => s.id === activeOf(state, sess, windowId));
    const next = state.spaces[(at + dir + state.spaces.length) % state.spaces.length];
    return switchSpaceIn(state, sess, next.id, windowId);
  }),

  activateTab: ({ tabId }) => focusTab(tabId),

  newTab: change(async (state, sess, { windowId, url }) => {
    const tab = await chrome.tabs.create({ windowId, url, active: true });
    await putInSpace(state, sess, tab.windowId, activeOf(state, sess, tab.windowId), [tab.id]);
  }),

  closeTab: change(async (state, sess, { tabId }) => {
    const tab = await chrome.tabs.get(tabId);
    const rest = (await todayTabs(state, sess, tab.windowId)).filter((t) => t.id !== tabId);
    const here = activeOf(state, sess, tab.windowId);
    const spaceHasMore = rest.length || Object.entries(sess.links).some(([id]) => state.pinned.some((e) => e.id === id && e.spaceId === here));
    if (tab.active && !spaceHasMore) {
      // Keep the person in this tab group instead of letting Chrome jump to another one.
      const fresh = await chrome.tabs.create({ windowId: tab.windowId, active: true });
      await putInSpace(state, sess, tab.windowId, here, [fresh.id]);
    }
    await archiveTabs(state, sess, [tab], "manual", { closeUnsaved: true });
  }),

  closeEntryTab: change(async (state, sess, { id }) => {
    const tabId = sess.links[id];
    unlink(state, sess, id);
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
    if (state.favorites.some((e) => sess.links[e.id] === tab.id)) return;
    const pin = state.pinned.find((e) => sess.links[e.id] === tab.id);
    const item = pin ? { kind: "pin", id: pin.id } : { kind: "tab", tabId: tab.id };
    await moveItem(state, sess, { item, to: { zone: "favs" }, windowId });
    signal("Added to favorites");
  }),

  closeCurrent: change(async (state, sess, { windowId }) => {
    const tab = await contextTab(sess, windowId);
    if (tab) await archiveTabs(state, sess, [tab], "manual", { closeUnsaved: true });
  }),

  addFolder: change((state, sess, { name, windowId }) => {
    const folder = { id: uid(), spaceId: activeOf(state, sess, windowId), name: name || "New Folder", open: true };
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
    const space = { id: uid(), name: uniqueName(state, name || "New Group"), icon: "", color };
    state.spaces.push(space);
    if (naming) {
      // The sidebar is about to ask for a name. Opening the space's first tab now
      // would pull the cursor out of that box, so the sidebar switches once naming is done.
      const tabs = await chrome.tabs.query({ windowId });
      const loose = tabs.filter((t) => !t.pinned && t.groupId === -1).map((t) => t.id);
      await putInSpace(state, sess, windowId, activeOf(state, sess, windowId), loose).catch(() => {});
      setActive(state, sess, windowId, space.id);
    } else await switchSpaceIn(state, sess, space.id, windowId);
    return space.id;
  }),

  updateSpace: change(async (state, sess, { id, patch }) => {
    const space = state.spaces.find((s) => s.id === id);
    if (!space) return;
    if (typeof patch.name === "string" && patch.name.trim()) {
      space.name = uniqueName(state, patch.name, id);
      space.groupTitle = space.name;
    }
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
    const count = await archiveTabs(state, sess, tabs, "manual");
    if (count) signal(count === 1 ? "1 tab archived" : `${count} tabs archived`);
  }),

  archiveList: async ({ q }) => {
    await settled();
    const state = await getState();
    const needle = (q || "").trim().toLowerCase();
    const name = (id) => state.spaces.find((s) => s.id === id)?.name || "";
    return state.archive
      .filter((a) => !needle || a.title.toLowerCase().includes(needle) || a.url.toLowerCase().includes(needle))
      .slice(0, ARCHIVE_LIMIT)
      .map((a) => ({ ...a, space: name(a.spaceId) }));
  },

  restoreArchived: change(async (state, sess, { id, windowId }) => {
    const item = state.archive.find((a) => a.id === id);
    if (!item) return;
    state.archive = state.archive.filter((a) => a.id !== id);
    const here = activeOf(state, sess, windowId);
    const spaceId = state.spaces.some((s) => s.id === item.spaceId) ? item.spaceId : here;
    if (spaceId !== here) await switchSpaceIn(state, sess, spaceId, windowId);
    const tab = await chrome.tabs.create({ windowId, url: item.url, active: true });
    await putInSpace(state, sess, tab.windowId, spaceId, [tab.id]);
  }),

  clearArchive: change((state) => {
    state.archive = [];
  }),

  setSetting: change((state, sess, { key, value }) => {
    if (key === "archiveAfterHours" && ARCHIVE_HOURS.includes(value)) state.settings.archiveAfterHours = value;
    if (key === "barOnNewTab") state.settings.barOnNewTab = !!value;
    if (key === "textSize" && TEXT_SIZES.includes(value)) state.settings.textSize = value;
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
    // Clicking a tab that lives in another tab group takes this window's sidebar there too.
    const owner = Object.entries(sess.groups[windowId] || {}).find(([, groupId]) => groupId === tab.groupId);
    if (owner && owner[0] !== activeOf(state, sess, windowId)) setActive(state, sess, windowId, owner[0]);
  }).catch(console.warn);
});

chrome.tabs.onCreated.addListener((created) => {
  // File the tab under the space that is current right now, not the one that
  // happens to be current when the next tidy-up runs.
  mutate(async (state, sess) => {
    const tab = await chrome.tabs.get(created.id).catch(() => null);
    if (!tab || tab.pinned || tab.groupId !== -1) return;
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (win?.type === "normal") await putInSpace(state, sess, tab.windowId, activeOf(state, sess, tab.windowId), [tab.id]).catch(() => {});
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

async function boot(details) {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  if (!(await chrome.alarms.get("archive"))) await chrome.alarms.create("archive", { periodInMinutes: 5 });
  await mutate(async (state, sess) => {
    // Tabs that were already open do not start counting as idle until now.
    if (details?.reason === "install" || !state.installedAt) state.installedAt = Date.now();
    await syncNow(state, sess);
  }).catch(console.warn);
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(() => boot());
