// The sidebar. It asks the background worker what to draw, draws it, and
// sends every click and drop back as a request. It keeps no state of its own
// beyond what is on screen.

import { dayLabel, hostOf } from "../lib/url.js";

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");
const openedAt = Date.now();

let windowId;
let model = null;
let mode = "tabs"; // or "archive"
let archiveQuery = "";
let frozen = false; // true while dragging or renaming, so a redraw cannot pull the row away
let drag = null;
let lastSpaceIndex = -1;

const ICONS = {
  lock: '<path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2M4 7h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z"/>',
  link: '<path d="M6.8 9.2a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.9.9M9.2 6.8a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.9-.9"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  box: '<path d="M2.5 3h11v3h-11zM3.5 6v6.5h9V6M6.5 9h3"/>',
  folder: '<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"/>',
  folderOpen: '<path d="M2 12V4.5a1 1 0 0 1 1-1h3L7.5 5H12a1 1 0 0 1 1 1v1M2 12l1.6-4.3a1 1 0 0 1 .9-.7H14a.6.6 0 0 1 .6.8L13.2 12a1 1 0 0 1-1 .8H2.8A.8.8 0 0 1 2 12Z"/>',
  dots: '<circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>',
  back: '<path d="M9.5 3.5 5 8l4.5 4.5"/>',
  down: '<path d="M8 3v9M4.5 8.5 8 12l3.5-3.5"/>',
  sound: '<path d="M3 6.5h2L8 4v8L5 9.5H3zM10.5 6a3 3 0 0 1 0 4M12 4.3a5.4 5.4 0 0 1 0 7.4"/>',
};

const EMOJI = ["🏠", "💼", "🧪", "📚", "🎧", "🛒", "✈️", "🎮", "🧠", "🌱", "🔧", "📝", "💬", "📈", "🎨", "🍿", "🐙", "⚡️", "🌊", "🔥", "🧭", "🗂", "❤️", "🌙"];

// ---------------------------------------------------------------- small helpers

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name];
  return svg;
}

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "data") Object.assign(el.dataset, value);
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key in el && key !== "list") el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
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

async function act(type, payload) {
  try {
    const result = await send(type, payload);
    await refresh();
    return result;
  } catch (error) {
    toast(error.message);
  }
}

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
}

// ---------------------------------------------------------------- menu

let menuEl = null;
let redrawAfterMenu = false;
function closeMenu() {
  menuEl?.remove();
  menuEl = null;
  if (redrawAfterMenu) {
    redrawAfterMenu = false;
    queue();
  }
}

function openMenu(x, y, items) {
  closeMenu();
  menuEl = h("div", { class: "menu", role: "menu" });
  for (const item of items.filter(Boolean)) {
    if (item === "-") menuEl.append(h("hr"));
    else if (item.label && !item.run) menuEl.append(h("div", { class: "label" }, item.label));
    else if (item.node) menuEl.append(item.node);
    else {
      menuEl.append(
        h("button", {
          class: `item${item.danger ? " danger" : ""}`,
          role: "menuitem",
          onclick: () => {
            if (!item.keepOpen) closeMenu();
            item.run();
          },
        }, item.label),
      );
    }
  }
  app.append(menuEl);
  const box = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
  menuEl.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
  menuEl.querySelector("button")?.focus({ preventScroll: true });
}

document.addEventListener("pointerdown", (event) => {
  if (menuEl && !menuEl.contains(event.target)) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});
window.addEventListener("blur", closeMenu);

function menuAt(event, items) {
  event.preventDefault();
  event.stopPropagation();
  const box = event.currentTarget.getBoundingClientRect();
  const fromKeys = event.clientX === 0 && event.clientY === 0;
  openMenu(fromKeys ? box.left : event.clientX, fromKeys ? box.bottom : event.clientY, items);
}

function moveToSpaceItems(run) {
  const others = model.spaces.filter((s) => s.id !== model.space.id);
  if (!others.length) return [];
  return ["-", { label: "Move to" }, ...others.map((s) => ({ label: `${s.icon ? s.icon + "  " : ""}${s.name}`, run: () => run(s.id) }))];
}

function copyLink(url) {
  return { label: "Copy link", run: () => act("copyUrl", { url }) };
}

// ---------------------------------------------------------------- rename in place

function renameIn(row, current, commit, after) {
  const title = row.querySelector(".title, .name");
  if (!title) return;
  frozen = true;
  const input = h("input", { class: "rename", value: current, spellcheck: false });
  title.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    frozen = false;
    if (save && input.value.trim() && input.value.trim() !== current) await commit(input.value.trim());
    if (after) await after();
    await refresh();
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (event) => event.stopPropagation());
}

// ---------------------------------------------------------------- drag and drop

function dragProps(item) {
  return {
    draggable: true,
    ondragstart: (event) => {
      drag = item;
      frozen = true;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.url || "");
      event.currentTarget.classList.add("ghost");
      requestAnimationFrame(() => app.classList.add("dragging"));
    },
    ondragend: (event) => {
      event.currentTarget.classList.remove("ghost");
      endDrag();
      refresh();
    },
  };
}

function endDrag() {
  drag = null;
  frozen = false;
  app.classList.remove("dragging");
  clearDropMarks();
}

function clearDropMarks(keep) {
  app.querySelectorAll(".drop-line").forEach((el) => el !== keep && el.remove());
  app.querySelectorAll(".drop-before, .drop-after, .drop-into").forEach((el) => el !== keep && el.classList.remove("drop-before", "drop-after", "drop-into"));
}

// Every drop target stops the event, so a dragover that reaches the page means
// the pointer is over nothing that takes a drop.
document.addEventListener("dragover", () => drag && clearDropMarks());

function isSelf(el) {
  if (!drag) return false;
  return (drag.kind === "tab" && el.dataset.tabId === String(drag.tabId)) || (drag.kind !== "tab" && el.dataset.id === drag.id);
}

/** Where in a vertical list the pointer is, counting only rows that are not the dragged one. */
function listSpot(list, y) {
  const rows = [...list.children].filter((el) => el.matches(".row, .folder") && !isSelf(el) && !el.classList.contains("new"));
  const entries = rows.filter((el) => el.matches(".row"));
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    if (y < box.top + box.height / 2) return { index: entries.indexOf(row) === -1 ? entries.length : entries.indexOf(row), top: row.offsetTop };
  }
  const last = rows[rows.length - 1];
  return { index: entries.length, top: last ? last.offsetTop + last.offsetHeight : 0 };
}

function dropList(zone) {
  return {
    ondragover: (event) => {
      if (!drag) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      const list = event.currentTarget;
      const spot = listSpot(list, event.clientY);
      const firstFolder = [...list.children].find((el) => el.matches(".folder"));
      // Folders sit under the loose pins, so a pin can never land below one.
      const top = firstFolder && spot.top > firstFolder.offsetTop ? firstFolder.offsetTop : spot.top;
      let line = [...list.children].find((el) => el.matches(".drop-line"));
      if (!line) list.append((line = h("div", { class: "drop-line" })));
      line.style.top = `${top}px`;
      clearDropMarks(line);
      list.dataset.dropIndex = String(spot.index);
    },
    ondrop: (event) => {
      if (!drag) return;
      event.preventDefault();
      event.stopPropagation();
      const item = drag;
      const index = Number(event.currentTarget.dataset.dropIndex || 0);
      endDrag();
      act("move", { item, to: { ...zone, index } });
    },
  };
}

function dropInto(to, canTake = () => true) {
  return {
    ondragover: (event) => {
      if (!drag || !canTake(drag)) return;
      event.preventDefault();
      event.stopPropagation();
      clearDropMarks(event.currentTarget);
      event.currentTarget.classList.add("drop-into");
    },
    ondrop: (event) => {
      if (!drag || !canTake(drag)) return;
      event.preventDefault();
      event.stopPropagation();
      const item = drag;
      endDrag();
      to(item);
    },
  };
}

const favDrop = {
  ondragover: (event) => {
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    clearDropMarks();
    const grid = event.currentTarget;
    const tiles = [...grid.children].filter((el) => !isSelf(el));
    let index = tiles.length;
    for (const [i, tile] of tiles.entries()) {
      const box = tile.getBoundingClientRect();
      if (event.clientY > box.bottom) continue;
      if (event.clientY < box.top || event.clientX < box.left + box.width / 2) {
        index = i;
        tile.classList.add("drop-before");
        break;
      }
    }
    if (index === tiles.length && tiles.length) tiles[tiles.length - 1].classList.add("drop-after");
    grid.dataset.dropIndex = String(index);
  },
  ondrop: (event) => {
    if (!drag) return;
    event.preventDefault();
    const item = drag;
    const index = Number(event.currentTarget.dataset.dropIndex || 0);
    endDrag();
    act("move", { item, to: { zone: "favs", index } });
  },
};

// ---------------------------------------------------------------- pieces of the sidebar

function linkPill() {
  const host = hostOf(model.activeUrl);
  const takesFavs = model.favorites.length ? {} : dropInto((item) => act("move", { item, to: { zone: "favs" } }));
  return h("div", { class: `link${model.favorites.length ? "" : " takes-drop"}`, data: { drop: "Drop here to keep it in every space" }, ...takesFavs, role: "button", tabIndex: 0, title: "Search or go to a link", onclick: () => send("openBar", { prefill: model.activeUrl }), onkeydown: (e) => e.key === "Enter" && send("openBar", { prefill: model.activeUrl }) },
    icon(host ? "lock" : "search"),
    h("span", { class: "host" }, host || "Search or enter a link"),
    model.activeUrl && h("button", { class: "chip", title: "Copy link", "aria-label": "Copy link", onclick: (e) => { e.stopPropagation(); act("copyUrl", {}); } }, icon("link")),
  );
}

function favTile(fav) {
  return h("button", {
    class: `fav${fav.active ? " active" : ""}${fav.loaded ? "" : " asleep"}`,
    title: fav.title,
    "aria-label": fav.title,
    data: { id: fav.id },
    onclick: () => act("openEntry", { id: fav.id }),
    oncontextmenu: (event) => menuAt(event, [
      fav.drifted && { label: "Go back to the saved page", run: () => act("resetEntry", { id: fav.id }) },
      fav.drifted && { label: "Save this page as the favorite", run: () => act("saveEntryUrl", { id: fav.id }) },
      fav.loaded && { label: "Close its tab", run: () => act("closeEntryTab", { id: fav.id }) },
      { label: "Move to pinned tabs", run: () => act("move", { item: { kind: "fav", id: fav.id }, to: { zone: "pinned" } }) },
      copyLink(fav.url),
      "-",
      { label: "Remove favorite", danger: true, run: () => act("removeEntry", { id: fav.id }) },
    ]),
    ...dragProps({ kind: "fav", id: fav.id, url: fav.url }),
  }, favicon(fav.url, fav.icon));
}

function pinRow(pin) {
  const item = { kind: "pin", id: pin.id, url: pin.url };
  const row = h("div", {
    class: `row${pin.active ? " active" : ""}${pin.loaded ? "" : " asleep"}`,
    role: "button",
    tabIndex: 0,
    title: pin.title,
    data: { id: pin.id },
    onclick: () => act("openEntry", { id: pin.id }),
    onkeydown: (e) => e.key === "Enter" && act("openEntry", { id: pin.id }),
    ondblclick: () => renameIn(row, pin.title, (title) => send("renameEntry", { id: pin.id, title })),
    oncontextmenu: (event) => menuAt(event, [
      { label: "Rename", run: () => renameIn(row, pin.title, (title) => send("renameEntry", { id: pin.id, title })) },
      pin.drifted && { label: "Go back to the pinned page", run: () => act("resetEntry", { id: pin.id }) },
      pin.drifted && { label: "Pin this page instead", run: () => act("saveEntryUrl", { id: pin.id }) },
      { label: "Unpin", run: () => act("move", { item, to: { zone: "today" } }) },
      { label: "Add to favorites", run: () => act("move", { item, to: { zone: "favs" } }) },
      pin.folderId && { label: "Take out of folder", run: () => act("move", { item, to: { zone: "pinned" } }) },
      copyLink(pin.url),
      ...moveToSpaceItems((spaceId) => act("moveEntryToSpace", { id: pin.id, spaceId })),
      "-",
      { label: "Remove pinned tab", danger: true, run: () => act("removeEntry", { id: pin.id }) },
    ]),
    ...dragProps(item),
  },
    favicon(pin.url, pin.icon),
    pin.drifted && h("span", { class: "slash", title: "Not on the pinned page" }, "/"),
    h("span", { class: "title" }, pin.title),
    pin.audible && icon("sound"),
    pin.loaded && h("button", { class: "chip close", title: "Close tab, keep the pin", "aria-label": "Close tab", onclick: (e) => { e.stopPropagation(); act("closeEntryTab", { id: pin.id }); } }, icon("x")),
  );
  return row;
}

function folderBlock(folder, pins) {
  const takesPins = (item) => item.kind !== "fav" || true;
  const row = h("div", {
    class: "row",
    role: "button",
    tabIndex: 0,
    "aria-expanded": String(folder.open),
    onclick: () => act("toggleFolder", { id: folder.id }),
    onkeydown: (e) => e.key === "Enter" && act("toggleFolder", { id: folder.id }),
    ondblclick: () => renameIn(row, folder.name, (name) => send("renameFolder", { id: folder.id, name })),
    oncontextmenu: (event) => menuAt(event, [
      { label: "Rename", run: () => renameIn(row, folder.name, (name) => send("renameFolder", { id: folder.id, name })) },
      "-",
      { label: "Delete folder, keep its tabs", danger: true, run: () => act("deleteFolder", { id: folder.id }) },
    ]),
  }, icon(folder.open ? "folderOpen" : "folder"), h("span", { class: "title" }, folder.name));
  return h("div", { class: "folder", ...dropInto((item) => act("move", { item, to: { zone: "pinned", folderId: folder.id } }), takesPins) },
    row,
    folder.open && h("div", { class: "list kids", ...dropList({ zone: "pinned", folderId: folder.id }) }, pins.map(pinRow)),
  );
}

function todayRow(tab) {
  const item = { kind: "tab", tabId: tab.tabId, url: tab.url };
  return h("div", {
    class: `row${tab.active ? " active" : ""}`,
    role: "button",
    tabIndex: 0,
    title: tab.title,
    data: { tabId: tab.tabId },
    onclick: () => act("activateTab", { tabId: tab.tabId }),
    onkeydown: (e) => e.key === "Enter" && act("activateTab", { tabId: tab.tabId }),
    onauxclick: (e) => e.button === 1 && act("closeTab", { tabId: tab.tabId }),
    oncontextmenu: (event) => menuAt(event, [
      { label: "Pin to this space", run: () => act("move", { item, to: { zone: "pinned" } }) },
      { label: "Add to favorites", run: () => act("move", { item, to: { zone: "favs" } }) },
      copyLink(tab.url),
      ...moveToSpaceItems((spaceId) => act("moveTabToSpace", { tabId: tab.tabId, spaceId })),
      "-",
      { label: "Archive tab", run: () => act("closeTab", { tabId: tab.tabId }) },
    ]),
    ...dragProps(item),
  },
    favicon(tab.url, tab.icon),
    h("span", { class: "title" }, tab.title),
    tab.audible && icon("sound"),
    h("button", { class: "chip close", title: "Archive tab", "aria-label": "Archive tab", onclick: (e) => { e.stopPropagation(); act("closeTab", { tabId: tab.tabId }); } }, icon("x")),
  );
}

function spaceMenu(space) {
  const swatches = h("div", { class: "swatches" }, model.colors.map((color) =>
    h("button", { class: `swatch${color === space.color ? " on" : ""}`, title: color, "aria-label": color, data: { color }, onclick: () => { closeMenu(); act("updateSpace", { id: space.id, patch: { color } }); } }),
  ));
  const emojis = h("div", { class: "emojis" },
    EMOJI.map((emoji) => h("button", { "aria-label": emoji, onclick: () => { closeMenu(); act("updateSpace", { id: space.id, patch: { icon: emoji } }); } }, emoji)),
  );
  return [
    { label: "Rename space", run: () => renameSpace(space) },
    { label: "New folder", run: async () => { const id = await act("addFolder", {}); const row = app.querySelector(`.folder[data-id="${id}"] > .row`); if (row) renameIn(row, "New Folder", (name) => send("renameFolder", { id, name })); } },
    "-",
    { label: "Color" },
    { node: swatches },
    { label: "Icon" },
    { node: emojis },
    space.icon && { label: "No icon", run: () => act("updateSpace", { id: space.id, patch: { icon: "" } }) },
    "-",
    { label: model.settings.barOnNewTab ? "Use Chrome's own new tab page" : "Use the command bar for new tabs", run: () => act("setSetting", { key: "barOnNewTab", value: !model.settings.barOnNewTab }) },
    { label: "Set up keyboard shortcuts", run: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }) },
    model.spaces.length > 1 && "-",
    model.spaces.length > 1 && {
      label: "Delete space…",
      danger: true,
      keepOpen: true,
      run: () => {
        const box = menuEl.getBoundingClientRect();
        openMenu(box.left, box.top, [
          { label: `Delete “${space.name}” and its pinned tabs?` },
          { label: "Delete space", danger: true, run: () => act("deleteSpace", { id: space.id }) },
          { label: "Keep it", run: () => {} },
        ]);
      },
    },
  ];
}

function renameSpace(space, after) {
  const head = app.querySelector(".space-head");
  if (head) renameIn(head, space.name, (name) => send("updateSpace", { id: space.id, patch: { name } }), after);
  else if (after) after();
}

function spaceHead() {
  const space = model.space;
  const empty = !model.pinned.length && !model.folders.length;
  return h("div", {
    class: `space-head${empty ? " takes-drop" : ""}`,
    data: { drop: "Drop here to pin it to this space" },
    ...dropInto((item) => act("move", { item, to: { zone: "pinned", index: 0 } })),
    ondblclick: () => renameSpace(space),
    oncontextmenu: (event) => menuAt(event, spaceMenu(space)),
  },
    space.icon && h("span", { class: "emoji" }, space.icon),
    h("span", { class: "name" }, space.name),
    h("button", { class: "chip", title: "Space options", "aria-label": "Space options", onclick: (event) => { const box = event.currentTarget.getBoundingClientRect(); event.stopPropagation(); openMenu(box.left, box.bottom + 4, spaceMenu(space)); } }, icon("dots")),
  );
}

function foot() {
  return h("div", { class: "foot" },
    h("button", { class: "chip", title: "Archived tabs", "aria-label": "Archived tabs", onclick: () => { mode = mode === "archive" ? "tabs" : "archive"; archiveQuery = ""; refresh(); } }, icon("box")),
    h("div", { class: "spaces" }, model.spaces.map((space) =>
      h("button", {
        class: `dot${space.id === model.space.id ? " active" : ""}`,
        title: space.name,
        "aria-label": `Go to ${space.name}`,
        data: { color: space.color },
        onclick: () => { mode = "tabs"; act("switchSpace", { id: space.id }); },
        oncontextmenu: (event) => menuAt(event, space.id === model.space.id ? spaceMenu(space) : [{ label: `Go to ${space.name}`, run: () => act("switchSpace", { id: space.id }) }]),
        ...dropInto((item) => {
          if (item.kind === "tab") act("moveTabToSpace", { tabId: item.tabId, spaceId: space.id });
          else if (item.kind === "pin") act("moveEntryToSpace", { id: item.id, spaceId: space.id });
        }, (item) => item.kind !== "fav" && space.id !== model.space.id),
      }, space.icon || h("i")),
    )),
    h("button", { class: "chip", title: "New space", "aria-label": "New space", onclick: async () => {
      mode = "tabs";
      const id = await act("addSpace", { naming: true });
      if (id) renameSpace(model.space, () => send("switchSpace", { id }));
    } }, icon("plus")),
  );
}

function tabsBody() {
  const loose = model.pinned.filter((p) => !p.folderId || !model.folders.some((f) => f.id === p.folderId));
  const folders = model.folders.map((folder) => {
    const block = folderBlock(folder, model.pinned.filter((p) => p.folderId === folder.id));
    block.dataset.id = folder.id;
    return block;
  });
  const empty = !loose.length && !folders.length && !model.today.length;
  return [
    h("div", { class: "list pins", ...dropList({ zone: "pinned" }) }, loose.map(pinRow), folders),
    h("div", { class: "divider" }, model.today.length > 0 && h("button", { title: "Archive every unpinned tab in this space", onclick: () => act("clearToday", {}) }, icon("down"), "Clear")),
    h("div", { class: "list today", ...dropList({ zone: "today" }) },
      h("div", { class: "row new", role: "button", tabIndex: 0, onclick: () => act("newTab", {}), onkeydown: (e) => e.key === "Enter" && act("newTab", {}) }, icon("plus"), h("span", { class: "title" }, "New Tab")),
      model.today.map(todayRow),
    ),
    empty && h("div", { class: "hint" }, "Drag a tab above the line to pin it to this space. Unpinned tabs move to the archive after a while."),
  ];
}

async function archiveBody() {
  const items = await send("archiveList", { q: archiveQuery });
  const out = [];
  let label = "";
  for (const item of items) {
    const next = dayLabel(item.closedAt);
    if (next !== label) out.push(h("div", { class: "day" }, (label = next)));
    out.push(h("div", { class: "row old", role: "button", tabIndex: 0, title: item.url, onclick: () => { mode = "tabs"; act("restoreArchived", { id: item.id }); }, onkeydown: (e) => e.key === "Enter" && act("restoreArchived", { id: item.id }) },
      favicon(item.url),
      h("div", { class: "text" }, h("span", { class: "title" }, item.title), h("span", { class: "sub" }, item.space ? `${hostOf(item.url)}, in ${item.space}` : hostOf(item.url))),
    ));
  }
  if (!items.length) out.push(h("div", { class: "hint" }, archiveQuery ? "No archived tabs match that." : "Nothing here yet. Tabs you close or stop using land here, so you can get them back."));
  return out;
}

function archiveSettings() {
  const names = { 12: "12 hours", 24: "24 hours", 168: "7 days", 720: "30 days" };
  return h("div", { class: "settings" },
    h("label", {}, "Archive unpinned tabs after",
      h("select", { onchange: (e) => act("setSetting", { key: "archiveAfterHours", value: Number(e.target.value) }) },
        model.archiveHours.map((hours) => h("option", { value: String(hours), selected: hours === model.settings.archiveAfterHours }, names[hours])),
      ),
    ),
    model.archiveCount > 0 && h("button", { onclick: (event) => menuAt(event, [{ label: "Empty the archive for good?" }, { label: "Empty archive", danger: true, run: () => act("clearArchive", {}) }]) }, "Empty the archive…"),
  );
}

// ---------------------------------------------------------------- drawing

let drawing = false;
let again = false;

async function refresh() {
  if (frozen) return;
  if (menuEl) {
    // A tab finishing its load must not yank an open menu away.
    redrawAfterMenu = true;
    return;
  }
  if (drawing) {
    again = true;
    return;
  }
  drawing = true;
  try {
    const next = await send("view");
    if (frozen) return;
    if (menuEl) {
      redrawAfterMenu = true;
      return;
    }
    model = next;
    const spaceIndex = model.spaces.findIndex((s) => s.id === model.space.id);
    const enter = lastSpaceIndex !== -1 && spaceIndex !== lastSpaceIndex ? (spaceIndex > lastSpaceIndex ? "next" : "prev") : null;
    lastSpaceIndex = spaceIndex;
    const keepScroll = app.querySelector(".scroll")?.scrollTop || 0;
    const hadSearchFocus = document.activeElement?.matches?.(".search input");
    app.dataset.color = model.space.color;

    const scroll = h("div", { class: "scroll" });
    if (mode === "archive") {
      const input = h("input", { type: "search", placeholder: "Search archived tabs", value: archiveQuery, oninput: (e) => { archiveQuery = e.target.value; queue(); } });
      scroll.append(...(await archiveBody()));
      app.replaceChildren(
        h("div", { class: "sheet-head" },
          h("button", { class: "chip", title: "Back to tabs", "aria-label": "Back to tabs", onclick: () => { mode = "tabs"; refresh(); } }, icon("back")),
          h("div", { class: "search" }, icon("search"), input),
        ),
        scroll,
        archiveSettings(),
        foot(),
      );
      if (hadSearchFocus || !archiveQuery) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    } else {
      scroll.append(...tabsBody().filter(Boolean));
      if (enter) scroll.dataset.enter = enter;
      app.replaceChildren(linkPill(), h("div", { class: "favs", ...favDrop }, model.favorites.map(favTile)), spaceHead(), scroll, foot());
    }
    scroll.scrollTop = enter ? 0 : keepScroll;
  } catch (error) {
    console.warn(error);
  } finally {
    drawing = false;
    if (again) {
      again = false;
      queue();
    }
  }
}

let queued;
function queue() {
  clearTimeout(queued);
  queued = setTimeout(refresh, 60);
}

// ---------------------------------------------------------------- two-finger swipe between spaces

let swipe = 0;
let swipeAt = 0;
let swipeLock = 0;
app.addEventListener("wheel", (event) => {
  if (Math.abs(event.deltaX) < Math.abs(event.deltaY) * 1.5 || mode !== "tabs" || !model || model.spaces.length < 2) return;
  event.preventDefault();
  const now = Date.now();
  if (now < swipeLock) return;
  if (now - swipeAt > 250) swipe = 0;
  swipeAt = now;
  swipe += event.deltaX;
  if (Math.abs(swipe) < 70) return;
  const dir = swipe > 0 ? 1 : -1;
  swipe = 0;
  swipeLock = now + 650;
  act("stepSpace", { dir });
}, { passive: false });

// ---------------------------------------------------------------- staying fresh

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "toast") toast(message.message);
  if (message?.type === "panel:toggle" && message.windowId === windowId && Date.now() - openedAt > 500) window.close();
  if (message?.type === "panel:show" && message.windowId === windowId) {
    mode = message.mode || "tabs";
    refresh();
  }
});

for (const event of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onMoved, chrome.tabs.onActivated, chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.tabGroups.onUpdated]) {
  event.addListener(queue);
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if ("title" in info || "url" in info || "audible" in info || "pinned" in info || "groupId" in info || "favIconUrl" in info || info.status === "complete") queue();
});
chrome.storage.onChanged.addListener(queue);

(async () => {
  // `?w=` lets the tests draw the sidebar for a window it is not docked in.
  windowId = Number(new URLSearchParams(location.search).get("w")) || (await chrome.windows.getCurrent()).id;
  const { panelMode } = await chrome.storage.session.get("panelMode");
  if (panelMode) {
    mode = panelMode;
    await chrome.storage.session.remove("panelMode");
  }
  await send("sync").catch(() => {});
  await refresh();
})();
