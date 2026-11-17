// Chrome puts the cursor in its address bar on a new tab page, and a page
// cannot take it back. Moving this same tab on to the command bar's own page
// is what gives the page the cursor.
//
// The tab must stay the same tab. Other extensions and tools open a blank tab
// and then drive it by its id, so swapping it for a fresh tab would break them.
const { state } = await chrome.storage.local.get("state");
if (state?.settings?.barOnNewTab === false) {
  const tab = await chrome.tabs.getCurrent();
  await chrome.tabs.update(tab.id, { url: "chrome://new-tab-page/" });
} else {
  location.replace(chrome.runtime.getURL("bar/bar.html?mode=tab"));
}
