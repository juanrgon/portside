# Chrome Web Store listing

Everything to paste into the Developer Dashboard. Build the zip with `script/package.sh` and the screenshots with `node script/store-shots.mjs`.

## Store listing tab

**Name:** Portside

**Summary** (comes from the manifest):
A sidebar for your tab groups, with pinned tabs, a command bar, and tabs that tidy themselves up. Everything stays on this computer.

**Category:** Workflow & Planning

**Language:** English

**Description:**

Portside turns Chrome's side panel into a home for your tabs.

It shows one tab group at a time. Each group has its own color, its own pinned tabs, and its own list of today's tabs. The other groups fold away in the tab strip until you switch.

What you get:

- Pinned tabs that stay put. A pinned tab keeps a saved page. Close it and the pin stays. Click it and it opens on that page again.
- Favorites. A grid of icons at the top that follows you into every tab group.
- Tabs that tidy themselves up. Unpinned tabs you have not used for a while move to an archive. Pick 12 hours, 24 hours, 7 days, or 30 days.
- An archive you can search. Closed a tab you needed? Find it by name or link and bring it back.
- A command bar. Open a new tab and type to switch to an open tab, open a pinned tab, go to a link, search the web, or run an action.
- Copy a clean link. One shortcut copies the current page's link without tracking codes.
- Drag and drop. Drag a tab above the line to pin it, into the grid to make it a favorite, or onto another tab group to move it.
- Folders for pinned tabs, light and dark mode, and a text size setting.

Portside works with Chrome's own tab groups. A group you make in the tab strip shows up in the sidebar, and a rename or recolor in either place shows in the other.

Private by design. Portside has no server. Your tabs, pins, and archive are saved on your computer and are never sent anywhere. There are no ads, no analytics, and no account.

Good to know:

- Portside replaces the new tab page with its command bar. You can turn that off in the sidebar's menu.
- Chrome's tab strip stays where it is. Portside does not replace it.
- To put the sidebar on the left, open Chrome Settings, then Appearance, then Side panel position.

**Screenshots (1280x800):** `store/screenshots/1-sidebar.png`, `2-command-bar.png`, `3-tab-groups.png`, `4-archive.png`

**Store icon (128x128):** `extension/icons/icon128.png`

**Small promo tile (440x280):** `store/promo-small-440x280.png`

**Marquee promo tile (1400x560, optional):** `store/promo-marquee-1400x560.png`

**Homepage URL:** https://github.com/juanrgon/portside

**Support URL:** https://github.com/juanrgon/portside/issues

## Privacy tab

**Single purpose:**
Portside is a tab manager. It shows the current tab group in the side panel, keeps pinned tabs and favorites, archives tabs that have not been used, and gives one command bar on the new tab page for switching between tabs and opening links.

**Permission justifications:**

| Permission | Why it is needed |
| --- | --- |
| tabs | To list open tabs by title and link in the sidebar, switch to them, close them, and reopen pinned or archived tabs. |
| tabGroups | Each section of the sidebar is a Chrome tab group. The extension creates, names, colors, and collapses groups when the user switches between them. |
| sidePanel | The sidebar is shown in Chrome's side panel. |
| storage | To save pinned tabs, favorites, folders, the archive of closed tabs, and settings on the user's device. |
| alarms | To check every few minutes for unpinned tabs that have not been used for the time the user chose, and move them to the archive. |
| favicon | To show the site icon next to pinned and archived tabs that are not currently open. |
| clipboardWrite | For the "copy link" button and shortcut, which copy the current tab's link. |
| offscreen | Used only to write to the clipboard on Chrome versions where the background worker cannot. |
| search | When the user types a search in the command bar, it runs in their default search engine. The extension never changes the search engine. |
| history (optional) | Asked for only if the user turns on "Search my browsing history too", so the command bar can suggest pages they visited. Read on the device only. |
| New tab page override | The command bar is the new tab page. It respects the user's default search engine, and it can be turned off in the sidebar's menu. |

**Remote code:** No, I am not using remote code.

**Data usage:** tick "Web history" (tab titles and links, and browsing history if the user turns it on). It is used only to show the user their own tabs and is stored only on their device. Nothing else applies.

Certify all three: no sale or transfer to third parties, no use unrelated to the single purpose, no use for creditworthiness or lending.

**Privacy policy URL:** https://github.com/juanrgon/portside/blob/main/PRIVACY.md

## Distribution tab

**Visibility:** Public

**Regions:** all
