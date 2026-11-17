import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanUrl, dayLabel, hostOf, score, staleTabs, toUrl } from "../../extension/lib/url.js";

test("copying a link drops tracking codes and keeps the real ones", () => {
  assert.equal(
    cleanUrl("https://example.com/post?id=7&utm_source=mail&utm_campaign=x&fbclid=abc&page=2#top"),
    "https://example.com/post?id=7&page=2#top",
  );
  assert.equal(cleanUrl("https://example.com/a?gclid=1"), "https://example.com/a");
  assert.equal(cleanUrl("chrome://extensions/?utm_source=x"), "chrome://extensions/?utm_source=x");
  assert.equal(cleanUrl("not a link"), "not a link");
});

test("typed text is a link only when it looks like one", () => {
  assert.equal(toUrl("github.com/octocat"), "https://github.com/octocat");
  assert.equal(toUrl("localhost:3000/project"), "http://localhost:3000/project");
  assert.equal(toUrl("app.localhost:3000"), "http://app.localhost:3000");
  assert.equal(toUrl("https://a.dev/x y"), null);
  assert.equal(toUrl("chrome://extensions"), "chrome://extensions");
  assert.equal(toUrl("how to pin a tab"), null);
  assert.equal(toUrl("tiptap"), null);
  assert.equal(toUrl("node.js"), "https://node.js");
});

test("a site name beats a word buried in a title", () => {
  const byHost = score("git", "Pull requests", "https://github.com/pulls");
  const byTitleStart = score("git", "Git cheat sheet", "https://example.com");
  const buried = score("git", "My digital notes", "https://example.com");
  assert.ok(byHost > byTitleStart && byTitleStart > buried && buried > 0);
  assert.equal(score("zzz", "Pull requests", "https://github.com"), 0);
  assert.equal(hostOf("https://www.example.com/x"), "example.com");
});

test("only idle, unpinned, silent, background tabs are archived", () => {
  const hour = 3600 * 1000;
  const now = 100 * hour;
  const tab = (id, extra = {}) => ({ id, url: "https://x.dev", pinned: false, active: false, audible: false, lastAccessed: now - 13 * hour, ...extra });
  const stale = staleTabs(
    [
      tab(1),
      tab(2, { lastAccessed: now - 11 * hour }),
      tab(3, { pinned: true }),
      tab(4, { active: true }),
      tab(5, { audible: true }),
      tab(6),
      tab(7, { url: "chrome-extension://me/bar.html" }),
      tab(8, { lastAccessed: undefined }),
    ],
    { linkedIds: new Set([6]), limitMs: 12 * hour, now, isOurs: (url) => url.startsWith("chrome-extension://me/") },
  );
  assert.deepEqual(stale.map((t) => t.id), [1]);
});

test("tabs that were already open at install get a fresh start, and unsavable pages are left alone", () => {
  const hour = 3600 * 1000;
  const now = 100 * hour;
  const old = (id, url = "https://x.dev") => ({ id, url, pinned: false, active: false, audible: false, lastAccessed: now - 400 * hour });
  const opts = { linkedIds: new Set(), limitMs: 12 * hour, now };
  assert.deepEqual(staleTabs([old(1)], { ...opts, since: now - hour }), [], "installed an hour ago: nothing is idle yet");
  assert.deepEqual(staleTabs([old(1)], { ...opts, since: now - 13 * hour }).map((t) => t.id), [1], "13 hours after install the old tab goes");
  assert.deepEqual(staleTabs([old(2, "file:///Users/me/report.pdf"), old(3, "chrome://settings/")], opts), [], "pages the archive cannot reopen stay");
});

test("archive days are named the way people say them", () => {
  const now = new Date(2026, 10, 16, 15).getTime();
  assert.equal(dayLabel(new Date(2026, 10, 16, 1).getTime(), now), "Today");
  assert.equal(dayLabel(new Date(2026, 10, 15, 23).getTime(), now), "Yesterday");
  assert.equal(dayLabel(new Date(2026, 10, 13, 9).getTime(), now), "3 days ago");
});
