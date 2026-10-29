/* Shared data layer for the background page, the sidebar and the command bar.
 *
 * The pinned tabs are Firefox's bookmarks toolbar, both ways: the sidebar reads
 * them from there and writes every change back as bookmark operations.
 *
 * storage.local
 *   favorites        [{id, url, title}]
 *   theme            {tint?, intensity?, text?}   tint: #rrggbb; intensity: how much of it
 *                    the background takes (%); text: "dark" | "light" (unset: the system's)
 *   bookmarkMap      {bookmarkId: {id, open?, icon?, color?}}   the item id a bookmark stands for (so
 *                    tabs stay bound), plus what bookmarks have no room for: a folder's open state,
 *                    emoji and background color
 *   faviconCache     {itemId: url}               last favicon seen for a favorite / pinned item
 * storage.session (survives background restarts, not browser restarts)
 *   bindings:<tabId> itemId                      the favorite / pinned item a tab belongs to
 *
 * Pinned items, as the sidebar sees them: a flat, ordered list of
 *   {id, url, title, name?, parent?} | {id, type: "folder", name, open, icon?, color?, parent?}
 * where `parent` is the id of the folder an entry is in.
 */

const FAV_KEY = "favorites";
const THEME_KEY = "theme";
const BM_MAP = "bookmarkMap";
const ICON_KEY = "faviconCache";
const BIND_KEY = "bindings";
const TOOLBAR_ID = "toolbar_____";

// Without a theme of its own the sidebar is this color, all over (no tint of the base).
const DEFAULT_COLOR = "#f3dddb"; // what Arc draws for its #f3dedb theme
const DEFAULT_INTENSITY = 100;
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || "");

export const uid = () => crypto.randomUUID();

/** The color the theme paints in. */
export const themeColor = (theme) => (isHex(theme?.tint) ? theme.tint : DEFAULT_COLOR);

export const MAX_INTENSITY = 100;

/**
 * How strongly the color tints the background (%), or null for the CSS default.
 * The default color covers it fully; a color of one's own starts at the CSS default.
 */
export const themeIntensity = (theme) => {
  if (Number.isFinite(theme?.intensity)) return Math.min(MAX_INTENSITY, Math.max(0, theme.intensity));
  return isHex(theme?.tint) ? null : DEFAULT_INTENSITY;
};

/** Firefox's new-tab pages, plus the add-on's own (new-tab page, command bar). */
export const isNewTabUrl = (url) =>
  url === "about:newtab" || url === "about:home" || /^moz-extension:\/\/[^/]+\/(newtab|palette)\//.test(url || "");

// ---------- Favorites, theme, favicons ----------

export async function getFavorites() {
  const { [FAV_KEY]: favorites } = await browser.storage.local.get(FAV_KEY);
  return favorites || [];
}

export const saveFavorites = (favorites) => browser.storage.local.set({ [FAV_KEY]: favorites });

export async function getTheme() {
  const { [THEME_KEY]: theme } = await browser.storage.local.get(THEME_KEY);
  return theme || {};
}

export const saveTheme = (theme) => browser.storage.local.set({ [THEME_KEY]: theme });

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

/** The bookmarks toolbar as a flat pins list; bookmarks seen for the first time get item ids. */
export async function getPins() {
  const [root] = await browser.bookmarks.getSubTree(await bookmarksBarId()).catch(() => []);
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

/** Make the bookmarks toolbar match `pins`: create, update, move and remove. */
async function writeBookmarks(pins) {
  const folderId = await bookmarksBarId();
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

export function savePins(pins) {
  const write = bookmarkWrites.then(() => writeBookmarks(pins));
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
 * Tabs and items already bound stay as they are. Runs on install, browser
 * start and whenever a sidebar opens.
 */
export async function adoptAll() {
  const [favorites, pins, bindings] = await Promise.all([getFavorites(), getPins(), getBindings()]);
  const tabs = (await browser.tabs.query({ windowType: "normal" })).filter((t) => !bindings[t.id] && t.url);
  const items = [...favorites, ...pins.filter((p) => p.type !== "folder")];
  const bound = new Set(Object.values(bindings));
  const passes = [(url) => url, (url) => matchKey(url, true), (url) => matchKey(url, false)];
  for (const key of passes) {
    for (const item of items) {
      if (bound.has(item.id)) continue;
      const want = key(item.url);
      if (!want) continue;
      // The tab used most recently wins when several show the same page.
      const tab = tabs
        .filter((t) => key(t.url) === want)
        .reduce((a, b) => (a && (a.lastAccessed || 0) >= (b.lastAccessed || 0) ? a : b), null);
      if (!tab) continue;
      bound.add(item.id);
      tabs.splice(tabs.indexOf(tab), 1);
      await bind(tab.id, item.id);
    }
  }
}

/** Blank pages the add-on swaps or cancels shouldn't clog Cmd/Ctrl+Shift+T. */
export async function forgetBlankClosedTabs() {
  const closed = await browser.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []);
  for (const entry of closed) {
    if (!entry.tab || !isNewTabUrl(entry.tab.url)) continue;
    await browser.sessions.forgetClosedTab(entry.tab.windowId, entry.tab.sessionId).catch(() => {});
  }
}
