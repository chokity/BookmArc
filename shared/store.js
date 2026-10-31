/* Shared data layer for the background page, the sidebar and the command bar.
 *
 * The pinned tabs are Firefox's bookmarks toolbar (or the folder a space picked),
 * both ways: the sidebar reads them from there and writes every change back as
 * bookmark operations.
 *
 * storage.local
 *   favorites        [{id, url, title, space?}]   space: the cookieStoreId of the space it's in
 *                    (unset, or a container that's gone: the first space)
 *   theme            {tint?, text?}   tint: #rrggbb, covering the whole background;
 *                    text: "dark" | "light" (unset: whichever reads on the color).
 *                    An intensity from before is ignored.
 *   bookmarkMap      {bookmarkId: {id, open?, icon?, color?}}   the item id a bookmark stands for (so
 *                    tabs stay bound), plus what bookmarks have no room for: a folder's open state,
 *                    emoji and background color
 *   faviconCache     {itemId: url}               last favicon seen for a favorite / pinned item
 *   tabStrip         true = Firefox's tab strip shows (userChrome.css hides it otherwise)
 *   themes           {cookieStoreId: theme}       each space's own theme (as `theme` above, which
 *                    the first space takes over)
 *   pinRoots         {cookieStoreId | "none": bookmarkId}   the bookmarks folder a space shows as
 *                    its pinned tabs ("none": windows without spaces); unset: the bookmarks toolbar
 *   spaceEngines     {cookieStoreId: engine name} the search engine a space's command bar
 *                    searches with; unset: Firefox's default
 * storage.session (survives background restarts, not browser restarts)
 *   bindings:<tabId> itemId                      the favorite / pinned item a tab belongs to
 *   space:<windowId> cookieStoreId               the window's space (kept across restarts by
 *                    sessions.setWindowValue, mirrored here so pages see it change)
 *   tabSpace:<tabId> cookieStoreId               the space of a tab without a container (kept by
 *                    sessions.setTabValue as {space, keep})
 *   closedTabs       [{url, title, space, windowId, at}]   tabs closed, newest first, with the
 *                    space they were in (Firefox's closed tabs don't keep their container)
 *
 * Spaces are Firefox's containers (managed in Multi-Account Containers): a tab
 * belongs to the space of its container. A tab without one (a Firefox page,
 * or one open from before spaces) belongs to the space it was given.
 *
 * Pinned items, as the sidebar sees them: a flat, ordered list of
 *   {id, url, title, name?, parent?} | {id, type: "folder", name, open, icon?, color?, parent?}
 * where `parent` is the id of the folder an entry is in.
 */

const FAV_KEY = "favorites";
const THEME_KEY = "theme";
const THEMES_KEY = "themes";
const ROOTS_KEY = "pinRoots";
const BM_MAP = "bookmarkMap";
const ICON_KEY = "faviconCache";
const BIND_KEY = "bindings";
export const TAB_STRIP_KEY = "tabStrip";
export const COLOR_FIREFOX_KEY = "colorFirefox";
export const MINI_PLAYER_KEY = "miniPlayer";
const TOOLBAR_ID = "toolbar_____";

// Without a theme of its own the sidebar is this color. Any color covers the background fully.
const DEFAULT_COLOR = "#f3dddb"; // what Arc draws for its #f3dedb theme
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || "");

export const uid = () => crypto.randomUUID();

/** The color the theme paints in. */
export const themeColor = (theme) => (isHex(theme?.tint) ? theme.tint : DEFAULT_COLOR);

/** How strongly the color tints the background (%): always fully. */
export const themeIntensity = () => 100;

/** Firefox's new-tab pages, plus the add-on's own (new-tab page, command bar). */
export const isNewTabUrl = (url) =>
  url === "about:newtab" || url === "about:home" || /^moz-extension:\/\/[^/]+\/(newtab|palette)\//.test(url || "");

// ---------- Favorites, theme, favicons ----------

export async function getFavorites() {
  const { [FAV_KEY]: favorites } = await browser.storage.local.get(FAV_KEY);
  return favorites || [];
}

export const saveFavorites = (favorites) => browser.storage.local.set({ [FAV_KEY]: favorites });

/** The favorite's space: its own, else (from before spaces, or its container is gone) the first one. */
const favoriteSpace = (fav, spaces) => (spaces.some((s) => s.id === fav.space) ? fav.space : spaces[0]?.id);

/** The favorites a space shows. No space (a private window, containers off): all of them. */
export const favoritesOf = (favorites, space, spaces) =>
  space && spaces?.length ? favorites.filter((f) => favoriteSpace(f, spaces) === space.id) : favorites;

/**
 * A space's theme (no space: the one theme of a window without spaces). A
 * space without one of its own starts on its container's color; the first
 * space takes over the theme from before spaces.
 */
export async function getTheme(space = null) {
  const { [THEME_KEY]: theme, [THEMES_KEY]: themes } = await browser.storage.local.get([THEME_KEY, THEMES_KEY]);
  if (!space) return theme || {};
  if (themes?.[space.id]) return themes[space.id];
  if (space.first && theme && Object.keys(theme).length) return theme;
  return isHex(space.colorCode) ? { tint: space.colorCode.toLowerCase() } : {};
}

export async function saveTheme(theme, space = null) {
  if (!space) return browser.storage.local.set({ [THEME_KEY]: theme });
  const { [THEMES_KEY]: themes } = await browser.storage.local.get(THEMES_KEY);
  const next = { ...themes, [space.id]: theme };
  // null: back to the container's color.
  if (!theme) delete next[space.id];
  await browser.storage.local.set({ [THEMES_KEY]: next });
}

export async function getTabStrip() {
  const { [TAB_STRIP_KEY]: show } = await browser.storage.local.get(TAB_STRIP_KEY);
  return !!show;
}

export const saveTabStrip = (show) => browser.storage.local.set({ [TAB_STRIP_KEY]: !!show });

/** Firefox's own window takes the sidebar's colors (on unless turned off). */
export const saveColorFirefox = (on) => browser.storage.local.set({ [COLOR_FIREFOX_KEY]: !!on });

/** The tabs playing sound show over the status bar (on unless turned off). */
export const saveMiniPlayer = (on) => browser.storage.local.set({ [MINI_PLAYER_KEY]: !!on });

/** Firefox gives extensions no favicon of a page that isn't open: the last one seen is kept. */
export async function getIconCache() {
  const { [ICON_KEY]: cache } = await browser.storage.local.get(ICON_KEY);
  return cache && typeof cache === "object" ? cache : {};
}

export async function cacheIcon(itemId, url) {
  if (!itemId || !url || !/^(https?:|data:image\/)/i.test(url)) return;
  const cache = await getIconCache();
  if (cache[itemId] === url) return;
  cache[itemId] = url;
  await browser.storage.local.set({ [ICON_KEY]: cache });
}

// ---------- Pinned items = the bookmarks toolbar ----------

async function getBmMap() {
  const { [BM_MAP]: map } = await browser.storage.local.get(BM_MAP);
  return map || {};
}

/** The bookmarks toolbar's folder id. */
async function bookmarksBarId() {
  const [toolbar] = await browser.bookmarks.get(TOOLBAR_ID).catch(() => []);
  if (toolbar) return toolbar.id;
  const [root] = await browser.bookmarks.getTree();
  return root.children[0].id;
}

/**
 * What the sidebar leaves out of the toolbar, and never moves or deletes:
 * separators, and Firefox's smart bookmarks (place: queries like "Most Visited").
 */
const isHidden = (node) => node.type === "separator" || /^place:/i.test(node.url || "");

const rootKey = (space) => space?.id || "none";

/** The bookmarks folder a space's pinned tabs are: the one it picked (while it exists), else the toolbar. */
export async function getPinRoot(space = null) {
  const { [ROOTS_KEY]: roots } = await browser.storage.local.get(ROOTS_KEY);
  const picked = roots?.[rootKey(space)];
  if (picked) {
    const [node] = await browser.bookmarks.get(picked).catch(() => []);
    if (node && !node.url && node.type !== "separator") return node.id;
  }
  return bookmarksBarId();
}

/** Pick a space's bookmarks folder; null: back to the toolbar. */
export async function savePinRoot(space, folderId) {
  const { [ROOTS_KEY]: roots } = await browser.storage.local.get(ROOTS_KEY);
  const next = { ...roots, [rootKey(space)]: folderId };
  if (!folderId) delete next[rootKey(space)];
  await browser.storage.local.set({ [ROOTS_KEY]: next });
}

/** A bookmarks folder (default: the toolbar) as a flat pins list; bookmarks seen for the first time get item ids. */
export async function getPins(rootId = null) {
  const [root] = await browser.bookmarks.getSubTree(rootId || (await bookmarksBarId())).catch(() => []);
  if (!root) return [];
  const map = await getBmMap();
  let added = false;
  const out = [];
  const walk = (node, parent) => {
    for (const child of node.children || []) {
      if (isHidden(child)) continue;
      if (!map[child.id]) {
        // Derived from the bookmark, not random: two pages meeting a new bookmark
        // at the same moment (the sidebar's first load and its binding of open
        // tabs) must give it the same id, or a tab ends up bound to the loser.
        map[child.id] = { id: `bm:${child.id}` };
        added = true;
      }
      const meta = map[child.id];
      const at = parent ? { parent } : {};
      if (child.url) out.push({ id: meta.id, url: child.url, title: child.title || child.url, ...at });
      else {
        out.push({
          id: meta.id,
          type: "folder",
          name: child.title || "Folder",
          open: !!meta.open,
          ...(meta.icon ? { icon: meta.icon } : {}),
          ...(meta.color ? { color: meta.color } : {}),
          ...at,
        });
        walk(child, meta.id);
      }
    }
  };
  walk(root, null);
  if (added) await browser.storage.local.set({ [BM_MAP]: map });
  return out;
}

/** Make a bookmarks folder (default: the toolbar) match `pins`: create, update, move and remove. */
async function writeBookmarks(pins, rootId) {
  const folderId = rootId || (await bookmarksBarId());
  const map = await getBmMap();
  const bmOf = Object.fromEntries(Object.entries(map).map(([bm, meta]) => [meta.id, bm]));
  const [root] = await browser.bookmarks.getSubTree(folderId);
  const existing = new Map(); // bookmarkId -> node, of what the sidebar shows
  const collect = (node) => {
    for (const child of node.children || []) {
      if (isHidden(child)) continue;
      existing.set(child.id, child);
      collect(child);
    }
  };
  collect(root);

  // Create and update, parents first (a folder comes before its contents in the list).
  const order = new Map(); // parent bookmark id -> [child bookmark ids], as they should be
  for (const p of pins) {
    const parentBm = p.parent ? bmOf[p.parent] : folderId;
    if (!parentBm) continue;
    const isFolder = p.type === "folder";
    const title = isFolder ? p.name : p.name || p.title || p.url;
    let bm = bmOf[p.id];
    const node = bm && existing.get(bm);
    if (!node) {
      // Not (or no longer) in the toolbar, e.g. dragged out of it in Firefox: a new bookmark.
      if (bm) delete map[bm];
      const created = await browser.bookmarks.create({ parentId: parentBm, title, ...(isFolder ? {} : { url: p.url }) });
      bm = created.id;
      bmOf[p.id] = bm;
    } else if (node.title !== title || (!isFolder && node.url !== p.url)) {
      await browser.bookmarks.update(bm, isFolder ? { title } : { title, url: p.url });
    }
    map[bm] = {
      id: p.id,
      ...(isFolder && p.open ? { open: true } : {}),
      ...(isFolder && p.icon ? { icon: p.icon } : {}),
      ...(isFolder && p.color ? { color: p.color } : {}),
    };
    if (!order.has(parentBm)) order.set(parentBm, []);
    order.get(parentBm).push(bm);
  }

  // Put every folder's children in order (and into the right folder) first. Positions
  // count the shown bookmarks only; separators and smart bookmarks keep their places.
  for (const [parentBm, wanted] of order) {
    for (const [i, bm] of wanted.entries()) {
      const children = await browser.bookmarks.getChildren(parentBm);
      const shown = children.filter((c) => !isHidden(c));
      if (shown[i]?.id === bm) continue;
      const index = shown[i] ? children.indexOf(shown[i]) : children.length;
      await browser.bookmarks.move(bm, { parentId: parentBm, index });
    }
  }

  // Then remove what's no longer pinned: after the moves, so nothing that stays
  // is inside a folder that goes. removeTree takes a folder's contents along.
  const keep = new Set(pins.map((p) => bmOf[p.id]).filter(Boolean));
  for (const [bm, node] of existing) {
    if (keep.has(bm)) continue;
    delete map[bm];
    const there = (await browser.bookmarks.get(bm).catch(() => [])).length > 0;
    if (there) await (node.url ? browser.bookmarks.remove(bm) : browser.bookmarks.removeTree(bm)).catch(() => {});
  }
  await browser.storage.local.set({ [BM_MAP]: map });
}

/** Bookmark writes one at a time: each one diffs against the toolbar as it is. */
let bookmarkWrites = Promise.resolve();

export function savePins(pins, rootId = null) {
  const write = bookmarkWrites.then(() => writeBookmarks(pins, rootId));
  bookmarkWrites = write.catch((err) => console.error("BookmArc: writing bookmarks failed", err));
  return write;
}

// ---------- Session data ----------

// One key per tab ("bind:<tabId>"), not one map: the sidebar and the background
// page write bindings at the same time (a tab opened here, another one closed
// there), and read-modify-write of a shared map let one undo the other.
const BIND_PREFIX = `${BIND_KEY}:`;

/** {tabId: itemId} of every bound tab. */
export async function getBindings() {
  const all = await browser.storage.session.get(null);
  const out = {};
  for (const [key, itemId] of Object.entries(all)) if (key.startsWith(BIND_PREFIX)) out[key.slice(BIND_PREFIX.length)] = itemId;
  return out;
}

export const bind = (tabId, itemId) => browser.storage.session.set({ [BIND_PREFIX + tabId]: itemId });
export const unbind = (tabId) => browser.storage.session.remove(BIND_PREFIX + tabId);
/** Drop every tab bound to one of `itemIds`. */
export async function unbindItems(itemIds) {
  const bindings = await getBindings();
  const keys = Object.keys(bindings).filter((tabId) => itemIds.includes(bindings[tabId]));
  if (keys.length) await browser.storage.session.remove(keys.map((tabId) => BIND_PREFIX + tabId));
}

// ---------- Spaces = containers ----------

export const NO_CONTAINER = "firefox-default";
const MAC_ID = "@testpilot-containers"; // Firefox Multi-Account Containers
const WIN_SPACE_PREFIX = "space:";
const TAB_SPACE_PREFIX = "tabSpace:";

/**
 * The spaces, in Multi-Account Containers' order: [{id (cookieStoreId), name,
 * colorCode, iconUrl, first?}]. null: containers are switched off in Firefox,
 * and windows have no spaces.
 */
export async function getSpaces() {
  if (!browser.contextualIdentities) return null;
  const all = await browser.contextualIdentities.query({}).catch(() => null);
  if (!all) return null;
  return all.map((c, i) => ({ id: c.cookieStoreId, name: c.name, colorCode: c.colorCode, iconUrl: c.iconUrl, ...(i ? {} : { first: true }) }));
}

/** The window's space (cookieStoreId), as the background page last set it. */
export async function getWindowSpace(windowId) {
  const key = WIN_SPACE_PREFIX + windowId;
  return (await browser.storage.session.get(key))[key] || null;
}

export const mirrorWindowSpace = (windowId, space) => browser.storage.session.set({ [WIN_SPACE_PREFIX + windowId]: space });
export const forgetWindowSpace = (windowId) => browser.storage.session.remove(WIN_SPACE_PREFIX + windowId);

/** {tabId: cookieStoreId} of the tabs without a container that belong to a space. */
export async function getTabSpaces() {
  const all = await browser.storage.session.get(null);
  const out = {};
  for (const [key, space] of Object.entries(all)) if (key.startsWith(TAB_SPACE_PREFIX)) out[key.slice(TAB_SPACE_PREFIX.length)] = space;
  return out;
}

export const mirrorTabSpace = (tabId, space) => browser.storage.session.set({ [TAB_SPACE_PREFIX + tabId]: space });
export const forgetTabSpace = (tabId) => browser.storage.session.remove(TAB_SPACE_PREFIX + tabId);

/** The space a tab belongs to: its container, else the one it was given (null: none yet). */
export const spaceOf = (tab, tabSpaces) =>
  tab.cookieStoreId && tab.cookieStoreId !== NO_CONTAINER && !tab.incognito ? tab.cookieStoreId : tabSpaces[tab.id] || null;

/**
 * The container Multi-Account Containers always opens `url` in ("Always open
 * in…"), if it's one of `spaces`. null without the add-on or an assignment.
 */
export async function assignedSpace(url, spaces) {
  if (!spaces?.length || !/^https?:/i.test(url || "")) return null;
  const assignment = await browser.runtime.sendMessage(MAC_ID, { method: "getAssignment", url }).catch(() => null);
  const id = assignment?.userContextId !== undefined ? `firefox-container-${assignment.userContextId}` : null;
  return spaces.some((s) => s.id === id) ? id : null;
}

// ---------- Startup ----------

/**
 * A URL for matching, `strict` or not: without "www.", the fragment and a
 * trailing slash; loose also without the query ("github.com/?locale=de" is
 * "github.com/"). "" for what isn't a web address.
 */
function matchKey(url, strict) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return "";
    const path = u.pathname.replace(/\/+$/, "");
    return u.hostname.replace(/^www\./, "").toLowerCase() + path + (strict ? u.search : "");
  } catch {
    return "";
  }
}

/**
 * Bind open tabs to the favorites and pinned items they show, one tab per item:
 * the exact URL first, then the same address give or take "www.", a trailing
 * slash or the fragment, then the same page with other query parameters.
 * An item has a tab of its own in every space (and every private window).
 * Tabs and items already bound stay as they are. Runs on install, browser
 * start and whenever a sidebar opens.
 */
export async function adoptAll() {
  const [favorites, bindings, tabSpaces, spaces] = await Promise.all([getFavorites(), getBindings(), getTabSpaces(), getSpaces()]);
  const all = await browser.tabs.query({ windowType: "normal" });
  const groupOf = (t) => (t.incognito ? `private:${t.windowId}` : spaceOf(t, tabSpaces) || NO_CONTAINER);
  const tabs = all.filter((t) => !bindings[t.id] && t.url);
  // Each space's pinned tabs are its own folder: a pinned item only takes tabs
  // of the spaces that show it. Windows without a space show the "none" one.
  const pinGroups = new Map(); // item id -> {url, groups}
  const roots = [...(spaces || []).map((space) => [space, [space.id]]), [null, [NO_CONTAINER, "private"]]];
  for (const [space, groups] of roots) {
    for (const p of await getPins(await getPinRoot(space))) {
      if (p.type === "folder") continue;
      if (!pinGroups.has(p.id)) pinGroups.set(p.id, { url: p.url, groups: new Set() });
      for (const g of groups) pinGroups.get(p.id).groups.add(g);
    }
  }
  // A favorite: its space, and every window without one.
  const favGroups = (f) => new Set([NO_CONTAINER, "private", ...(spaces?.length ? [favoriteSpace(f, spaces)] : [])]);
  const items = [
    ...favorites.map((f) => ({ id: f.id, url: f.url, groups: favGroups(f) })),
    ...[...pinGroups].map(([id, { url, groups }]) => ({ id, url, groups })),
  ];
  const shows = (item, group) => item.groups.has(group.startsWith("private:") ? "private" : group);
  // "<itemId> <group>" of the items that have a tab there.
  const bound = new Set(all.filter((t) => bindings[t.id]).map((t) => `${bindings[t.id]} ${groupOf(t)}`));
  const passes = [(url) => url, (url) => matchKey(url, true), (url) => matchKey(url, false)];
  for (const key of passes) {
    for (const item of items) {
      const want = key(item.url);
      if (!want) continue;
      const groups = new Map(); // group -> the tab used most recently that shows the item's page
      for (const t of tabs) {
        if (key(t.url) !== want) continue;
        const group = groupOf(t);
        if (!shows(item, group)) continue;
        const best = groups.get(group);
        if (!best || (t.lastAccessed || 0) > (best.lastAccessed || 0)) groups.set(group, t);
      }
      for (const [group, tab] of groups) {
        if (bound.has(`${item.id} ${group}`)) continue;
        bound.add(`${item.id} ${group}`);
        tabs.splice(tabs.indexOf(tab), 1);
        await bind(tab.id, item.id);
      }
    }
  }
}

// ---------- Per space: search engine, recently closed ----------

const ENGINES_KEY = "spaceEngines";

/** The search engine `spaceId` searches with, or null for Firefox's default. */
export async function getSpaceEngine(spaceId) {
  if (!spaceId) return null;
  const { [ENGINES_KEY]: engines = {} } = await browser.storage.local.get(ENGINES_KEY);
  return engines[spaceId] || null;
}

/** null: back to Firefox's default. */
export async function saveSpaceEngine(spaceId, name) {
  const { [ENGINES_KEY]: engines = {} } = await browser.storage.local.get(ENGINES_KEY);
  const next = { ...engines, [spaceId]: name };
  if (!name) delete next[spaceId];
  await browser.storage.local.set({ [ENGINES_KEY]: next });
}

const CLOSED_KEY = "closedTabs";
const CLOSED_MAX = 50;
let closedQueue = Promise.resolve(); // closing many tabs at once mustn't lose some of them

const editClosed = (change) =>
  (closedQueue = closedQueue
    .then(async () => {
      const { [CLOSED_KEY]: list = [] } = await browser.storage.session.get(CLOSED_KEY);
      await browser.storage.session.set({ [CLOSED_KEY]: change(list).slice(0, CLOSED_MAX) });
    })
    .catch((err) => console.error("BookmArc: noting a closed tab failed", err)));

/** Note the space a tab was closed in (null: no spaces); new-tab and blank pages aren't worth it. */
export function rememberClosed(tab, space) {
  if (!tab.url || isNewTabUrl(tab.url) || tab.url === "about:blank") return closedQueue;
  const entry = { url: tab.url, title: tab.title || tab.url, space, windowId: tab.windowId, at: Date.now() };
  return editClosed((list) => [entry, ...list]);
}

/** The tabs closed in `spaceId`, newest first (null: all of them). */
export async function closedTabsOf(spaceId) {
  const { [CLOSED_KEY]: list = [] } = await browser.storage.session.get(CLOSED_KEY);
  return spaceId ? list.filter((c) => c.space === spaceId) : list;
}

/**
 * Open a closed tab again: Firefox's own copy when it still has one (history,
 * scroll position and container come back with it), else its page anew in its space.
 */
export async function reopenClosed(closed, windowId) {
  await editClosed((list) => list.filter((c) => !(c.at === closed.at && c.url === closed.url)));
  const recent = await browser.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []);
  const near = (e) => Math.abs(e.lastModified - closed.at);
  const match = recent.filter((e) => e.tab?.url === closed.url && near(e) < 10000).sort((a, b) => near(a) - near(b))[0];
  if (match) return browser.sessions.restore(match.tab.sessionId);
  return browser.tabs.create({ windowId, url: closed.url, ...(closed.space ? { cookieStoreId: closed.space } : {}) });
}

/** Blank pages the add-on swaps or cancels shouldn't clog Cmd/Ctrl+Shift+T. */
export async function forgetBlankClosedTabs() {
  const closed = await browser.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []);
  for (const entry of closed) {
    if (!entry.tab || !isNewTabUrl(entry.tab.url)) continue;
    await browser.sessions.forgetClosedTab(entry.tab.windowId, entry.tab.sessionId).catch(() => {});
  }
}
