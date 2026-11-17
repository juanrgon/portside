// Chrome puts the cursor in its address bar on a new tab page, and a page
// cannot take it back. So this page swaps itself for a normal tab that holds
// the command bar, which does get the cursor.
const { state } = await chrome.storage.local.get("state");
const tab = await chrome.tabs.getCurrent();
if (state?.settings?.barOnNewTab === false) {
  await chrome.tabs.update(tab.id, { url: "chrome://new-tab-page/" });
} else {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("bar/bar.html?mode=tab"),
    windowId: tab.windowId,
    index: tab.index,
    active: true,
  });
  await chrome.tabs.remove(tab.id);
}
