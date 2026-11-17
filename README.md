# Portside

A Chrome extension that makes Chrome feel like a sidebar browser: spaces, favorites, pinned tabs, a command bar, and tabs that tidy themselves up.

Everything stays on this computer. The extension has no server and sends nothing anywhere. The only images it loads are the icons of sites you already have open.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension` folder in this repo.
4. Click the Portside icon in the toolbar to open the sidebar. Pin the icon so it stays there.
5. Move the sidebar to the left: Chrome Settings, Appearance, Side panel position, **Show on left**.
6. Open a new tab. Chrome asks if you meant to change the new tab page. Choose **Keep it**.

What happens the moment you load it:

- Every open tab that is not in a tab group is put into one group called "Home". That group is your first space.
- Tabs you pinned in Chrome become favorites.
- Nothing is closed. Tabs that were already open start counting as unused from the install time, so the first ones move to the archive 12 hours later at the earliest. Change that time in the archive view.
- Local files, Chrome pages, and other extensions' pages are never archived, because the archive could not reopen them.

After you change the code, press the reload arrow on the Portside card in `chrome://extensions`.

## What is in the sidebar

From top to bottom:

- **Link pill.** Shows the site you are on. Click it to edit the link in the command bar. The chain icon copies the link.
- **Favorites.** A grid of icons that shows in every space. A favorite is a pinned tab in Chrome's tab strip.
- **Space name.** Double-click to rename. The `...` button changes its color and icon, adds folders, sets the text size, and deletes the space.
- **Pinned tabs.** They belong to one space and never get archived. A dimmed pin has no tab open. Click it and it opens on its saved page.
- **The line.** Above it is pinned. Below it is today. **Clear** archives everything below the line.
- **Today.** Normal tabs, newest on top. They move to the archive after 12 hours of no use.
- **Bottom bar.** Archive on the left, one icon per space in the middle, new space on the right.

Things to try:

- Drag a tab above the line to pin it. Drag it into the favorites grid to keep it in every space. Drag it onto a space icon to move it there.
- Close a pinned tab with its `x`. The pin stays. This is also how you send a pin back to its saved page.
- A `/` in front of a pin's name means its tab has left the saved page.
- Swipe left or right with two fingers on the sidebar to change spaces.
- Right-click anything for more.

## The command bar

- **New tab (Cmd+T)** opens the command bar in the middle of the window. Type to switch to an open tab, open a pinned tab, go to a link, search, or run an action such as "view archive" or "pin tab". Escape takes you back to the tab you were on.
- **Cmd+Shift+K** opens the same bar in a small window over the current tab.

To get Chrome's own new tab page back, open the space's `...` menu and choose "Use Chrome's own new tab page".

History search is off until you turn it on. Type "history" in the command bar and pick "Search my browsing history too". Chrome asks for permission once.

## Shortcuts

| Does | Mac |
| --- | --- |
| Show or hide the sidebar | Cmd+S |
| Command bar over the current tab | Cmd+Shift+K |
| Copy the current link, without tracking codes | Option+Shift+C |
| Jump back to the tab you were on before | Option+Q |
| Next space, previous space, pin tab, clear | not set |

Change any of these at `chrome://extensions/shortcuts`. Chrome already uses Cmd+Shift+C itself, so the copy shortcut cannot claim it by default. You can try setting it by hand on that page.

## How it maps onto Chrome

Chrome does not let an extension redraw the browser, so each idea is built from a part Chrome already has:

| Idea | Built from |
| --- | --- |
| Sidebar | Chrome's side panel |
| Space | A tab group with the same name and color. Other spaces are folded shut in the tab strip. |
| Favorite | A pinned tab |
| Pinned tab | A saved link, tied to a live tab while one is open |
| Command bar | The new tab page, plus a small window |
| Archive | A list saved in the extension's own storage |

What that means in practice:

- Chrome's tab strip is still there. Leave it on top. If you turn on Chrome's own vertical tabs you get two sidebars.
- A tab group you make in the tab strip shows up as a space. Rename or recolor a group there and the space follows.
- Chrome's side panel has its own small header and a minimum width. The extension cannot remove either.
- Chrome cannot hide tabs, so tabs from other spaces sit in folded groups instead of vanishing.
- Not built: split view (Chrome has its own), link previews, and a floating mini window.
- Closing a tab with Cmd+W does not add it to the archive. Closing it from the sidebar does. Cmd+Shift+T still reopens it.

## Develop

```bash
bun install
```

```bash
bun run check
```

`check` runs the unit tests and then drives the real extension in a throwaway headless Chromium (the one Playwright already installed on this machine). It never opens your own Chrome and never touches the real web.

```bash
node tests/e2e/smoke.mjs
```

That builds a realistic sidebar and saves screenshots to `tests/e2e/out`. Add `dark` for dark mode.

Layout:

- `extension/background.js` makes every change: spaces, pins, archive, shortcuts.
- `extension/panel/` is the sidebar. It only draws what the background worker hands it.
- `extension/bar/` is the command bar and the new tab page.
- `extension/lib/` holds saved state, colors, and small link helpers.
