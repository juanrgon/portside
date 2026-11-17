// Small pure helpers for links. No browser APIs here, so Node can test them.

const TRACKING = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^gbraid$/i, /^wbraid$/i, /^dclid$/i,
  /^msclkid$/i, /^mc_(cid|eid)$/i, /^igshid$/i, /^_hs(enc|mi)$/i, /^__hs/i,
  /^mkt_tok$/i, /^yclid$/i, /^twclid$/i, /^ttclid$/i, /^li_fat_id$/i,
  /^oly_(anon|enc)_id$/i, /^vero_(conv|id)$/i, /^s_cid$/i, /^_ga$/i, /^_gl$/i,
];

/** Remove tracking codes from a link. Anything that is not http(s) is returned as is. */
export function cleanUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return raw;
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING.some((re) => re.test(key))) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/** Turn typed text into a link when it looks like one. Returns null for a search. */
export function toUrl(text) {
  const t = String(text || "").trim();
  if (!t || /\s/.test(t)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (/^(chrome|about|file|view-source):/i.test(t)) return t;
  if (/^(([\w-]+\.)*localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(t)) return "http://" + t;
  if (/^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(t)) return "https://" + t;
  return null;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isWeb(url) {
  return /^https?:\/\//i.test(url || "");
}

/** Score how well `q` matches a title and link. 0 means no match. */
export function score(q, title, url) {
  const needle = q.trim().toLowerCase();
  if (!needle) return 0;
  const t = (title || "").toLowerCase();
  const h = hostOf(url || "").toLowerCase();
  const u = (url || "").toLowerCase();
  if (h.startsWith(needle)) return 100;
  if (t.startsWith(needle)) return 90;
  if (t.split(/[\s\-–|:/·]+/).some((w) => w.startsWith(needle))) return 70;
  if (h.includes(needle)) return 60;
  if (t.includes(needle)) return 50;
  if (u.includes(needle)) return 30;
  const words = needle.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w) || u.includes(w))) return 40;
  return 0;
}

/** "Today", "Yesterday", or a date, for grouping the archive. */
export function dayLabel(ms, now = Date.now()) {
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(new Date(now)) - start(new Date(ms))) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Which tabs have sat unused long enough to archive. Pinned tabs, favorites,
 * the tab in front, anything playing sound, and pages that could not be
 * reopened from a link are never archived. `since` is when the extension was
 * installed: no tab counts as idle from before that, so installing it on a
 * browser full of old tabs does not sweep them all away.
 */
export function staleTabs(tabs, { linkedIds, limitMs, now = Date.now(), since = 0, isOurs = () => false }) {
  return tabs.filter(
    (tab) =>
      !tab.pinned &&
      !tab.active &&
      !tab.audible &&
      !linkedIds.has(tab.id) &&
      !isOurs(tab.url) &&
      isWeb(tab.url) &&
      typeof tab.lastAccessed === "number" &&
      now - Math.max(tab.lastAccessed, since) > limitMs,
  );
}
