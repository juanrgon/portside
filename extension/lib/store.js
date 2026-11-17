// Saved state and the one queue every change goes through.
//
// `state` lives in chrome.storage.local and survives restarts.
// `sess` lives in chrome.storage.session. It holds tab ids and group ids,
// which Chrome hands out again after every restart.

export const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
export const ARCHIVE_HOURS = [12, 24, 168, 720];
export const TEXT_SIZES = [13, 14, 15, 16, 18];
export const ARCHIVE_LIMIT = 1000;

export function uid() {
  return crypto.randomUUID().slice(0, 8);
}

function defaults() {
  const id = uid();
  return {
    version: 1,
    spaces: [{ id, name: "Home", icon: "🏠", color: "purple" }],
    activeSpaceId: id,
    favorites: [],
    pinned: [],
    folders: [],
    archive: [],
    settings: { archiveAfterHours: 12, barOnNewTab: true, textSize: 15 },
  };
}

export async function getState() {
  const { state } = await chrome.storage.local.get("state");
  if (!state || !Array.isArray(state.spaces) || !state.spaces.length) return defaults();
  const base = defaults();
  state.favorites ||= [];
  state.pinned ||= [];
  state.folders ||= [];
  state.archive ||= [];
  state.settings = { ...base.settings, ...(state.settings || {}) };
  if (!state.spaces.some((s) => s.id === state.activeSpaceId)) state.activeSpaceId = state.spaces[0].id;
  return state;
}

export async function getSess() {
  const { sess } = await chrome.storage.session.get("sess");
  return { links: {}, groups: {}, prev: {}, active: {}, ...(sess || {}) };
}

let queue = Promise.resolve();

/** Resolves once every change already under way has been saved, so a read never sees half of one. */
export function settled() {
  return queue;
}

/**
 * Run one change at a time. `fn` gets the saved state and the session state,
 * edits them in place, and both are written back if they changed.
 */
export function mutate(fn) {
  const run = queue.then(async () => {
    const state = await getState();
    const sess = await getSess();
    const before = [JSON.stringify(state), JSON.stringify(sess)];
    const { state: stored } = await chrome.storage.local.get("state");
    const result = await fn(state, sess);
    if (JSON.stringify(state) !== before[0] || !stored) await chrome.storage.local.set({ state });
    if (JSON.stringify(sess) !== before[1]) await chrome.storage.session.set({ sess });
    return result;
  });
  queue = run.catch(() => {});
  return run;
}
