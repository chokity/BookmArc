/* Background page: the command bar as a tab (Cmd/Ctrl+T, Cmd/Ctrl+W), favorites
   and pins from Firefox's own menus, keeping tabs bound to favorites / pinned
   items, spaces (containers), badges from other extensions, and unloading idle
   tabs. */

import {
  uid,
  isNewTabUrl,
  getFavorites,
  saveFavorites,
  favoritesOf,
  getPins,
  savePins,
  getPinRoot,
  getBindings,
  bind,
  unbind,
  unbindItems,
  cacheIcon,
  adoptAll,
  forgetBlankClosedTabs,
  TAB_STRIP_KEY,
  getTabStrip,
  NO_CONTAINER,
  getSpaces,
  getWindowSpace,
  mirrorWindowSpace,
  forgetWindowSpace,
  getTabSpaces,
  mirrorTabSpace,
  forgetTabSpace,
  spaceOf,
  assignedSpace,
  closedTabsOf,
  reopenClosed,
} from "./shared/store.js";
import { setBadges, setTabMenu, pruneProviders, announceToBadgeProviders } from "./shared/badges.js";

const MENU = {
  favAdd: "bs-fav-add",
  favRemove: "bs-fav-remove",
  pin: "bs-pin",
  unpin: "bs-unpin",
};

const isFavoritable = (url) => /^https?:\/\//i.test(url || "");

/* ---------- Tab badges from other extensions ---------- */

// Other extensions can tag tabs in the sidebar, e.g. Tab Driver marks tabs an AI agent controls:
//   browser.runtime.sendMessage("bookmarc@pliha", {
//     type: "bookmarc:set-badges",
//     badges: [{ tabId, label: "AI", title: "Claude is controlling this tab", color: "#7c5cff" }],
//   });
// Optional: icon ("bot" or "sparkles", drawn instead of the label, styled like the sound icon),
// position ("start" puts it before the title, next to the sound icon; default "end", after
// the title), pulse (true blinks the badge; on an icon, a green dot blinks instead).
// Each call replaces that extension's badges; an empty list clears them. Badges last until
// Firefox restarts or this add-on updates; then it sends { type: "bookmarc:ready" } to every
// extension that set badges before, so they can send them again.
//
// They can also add items to the sidebar's tab menu (right-click on a tab):
//   browser.runtime.sendMessage("bookmarc@pliha", {
//     type: "bookmarc:set-tab-menu",
//     items: [{ id: "control", title: "Let AI agents control this tab", exceptTabIds: [12] }],
//   });
// tabIds limits an item to those tabs, exceptTabIds hides it on them. A click sends
// { type: "bookmarc:menu-clicked", id, tabId } back to that extension. Same lifetime as badges.
// Until 0.7.1 the add-on was Arcsidebar ("arc@sidebar-pliha", messages "arcsidebar:…"); extensions
// written for it need the new ID and names.
browser.runtime.onMessageExternal.addListener((msg, sender) => {
  if (!sender.id) return;
  if (msg?.type === "bookmarc:set-badges") return setBadges(sender.id, msg.badges).then(() => ({ ok: true }));
  if (msg?.type === "bookmarc:set-tab-menu") return setTabMenu(sender.id, msg.items).then(() => ({ ok: true }));
});

/* ---------- Freeing memory ----------
 * Tabs nobody has looked at for a while are discarded: the row keeps its title
 * and favicon, and the page loads again on click. */

const IDLE_MINUTES = 45; // long enough to come back to
const SWEEP_MINUTES = 5;

async function discardIdleTabs() {
  const now = Date.now();
  const tabs = await browser.tabs.query({}).catch(() => []);
  const stale = tabs.filter((tab) => {
    if (tab.active || tab.discarded || tab.incognito || tab.audible || tab.status === "loading") return false;
    if ((tab.url || "").startsWith("moz-extension:")) return false; // the add-on's own pages
    return (tab.lastAccessed || now) < now - IDLE_MINUTES * 60_000;
  });
  let done = 0;
  for (const tab of stale) {
    await browser.tabs
      .discard(tab.id)
      .then(() => done++)
      .catch(() => {});
  }
  if (stale.length) console.log(`BookmArc: unloaded ${done}/${stale.length} idle tabs`);
}

browser.alarms.create("discard-idle", { periodInMinutes: SWEEP_MINUTES });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "discard-idle") {
    discardIdleTabs();
    pruneProviders();
  }
});

/* ---------- Setup ---------- */

function createMenus() {
  browser.menus.removeAll().then(() => {
    browser.menus.create({ id: MENU.favAdd, title: "Add to Favorites", contexts: ["tab", "page"] });
    browser.menus.create({ id: MENU.favRemove, title: "Remove from Favorites", contexts: ["tab", "page"], visible: false });
    browser.menus.create({ id: MENU.pin, title: "Pin to BookmArc", contexts: ["tab", "page"] });
    browser.menus.create({ id: MENU.unpin, title: "Unpin", contexts: ["tab", "page"], visible: false });
  });
}

/** Blank tabs restored before the add-on was listening missed their hand-off to the command bar. */
async function initWindows() {
  const palette = browser.runtime.getURL("palette/");
  for (const win of await browser.windows.getAll({ populate: true, windowTypes: ["normal"] })) {
    for (const tab of win.tabs) {
      const blank = isNewTabUrl(tab.url) || tab.url === "about:blank";
      if (blank && !tab.url.startsWith(palette)) await handleNewTabPage(tab).catch(() => {});
    }
  }
}

/** Installing from an .xpi file leaves a blank tab titled with the file path; close it. */
async function closeInstallerTabs() {
  const tabs = await browser.tabs.query({ url: "about:blank" }).catch(() => []);
  const leftovers = tabs.filter((t) => /\.xpi$/i.test(t.title || ""));
  if (leftovers.length) await browser.tabs.remove(leftovers.map((t) => t.id));
}

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  createMenus();
  await initSpacesOnce();
  await adoptAll().catch(() => {});
  initWindows();
  closeInstallerTabs();
  announceToBadgeProviders();
  // First install only: what the add-on does and how to set up the layout.
  if (reason === "install") browser.tabs.create({ url: browser.runtime.getURL("welcome/welcome.html") });
});

browser.runtime.onStartup.addListener(() => {
  createMenus();
  forgetBlankClosedTabs();
  announceToBadgeProviders();
  // Give session restore a moment to put the tabs back before matching them to bookmarks.
  setTimeout(async () => {
    await initSpacesOnce();
    adoptAll().catch(() => {});
    initWindows();
  }, 1500);
});

/* ---------- Firefox's tab strip ---------- */

// userChrome.css hides the tab strip unless the window's title starts with this
// (invisible) mark: titlePreface is the one thing an extension sets on a browser
// window that the stylesheet can see (#main-window[titlepreface]).
const TAB_STRIP_MARK = "\u200B";

async function markWindow(windowId, show) {
  await browser.windows.update(windowId, { titlePreface: show ? TAB_STRIP_MARK : "" }).catch(() => {});
}

async function applyTabStrip(show) {
  for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) await markWindow(win.id, show);
}

// The mark isn't kept across restarts. Hidden is the stylesheet's default, so only
// a shown strip needs marking (an empty preface would clear another add-on's).
getTabStrip().then((show) => show && applyTabStrip(true));

browser.windows.onCreated.addListener(async (win) => {
  if (win.type === "normal" && (await getTabStrip())) markWindow(win.id, true);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && TAB_STRIP_KEY in changes) applyTabStrip(!!changes[TAB_STRIP_KEY].newValue);
});

/* ---------- Tab lifecycle ---------- */

browser.tabs.onCreated.addListener((tab) => {
  // Cmd/Ctrl+T: swap the blank tab for the command bar right away instead of
  // waiting for the new-tab page to load and report in — that page load is
  // the delay before the search field is ready.
  if (tab.openerTabId === undefined && isNewTabUrl(tab.url)) {
    handleNewTabPage(tab).catch(() => {});
    return;
  }
  // Firefox puts its own new tab at the end of the strip; pull it to the top
  // before the command bar takes its place.
  if (tab.openerTabId === undefined && tab.url === "about:blank") placeNewTab(tab).catch(() => {});
});

/**
 * A tab Firefox just made for Cmd/Ctrl+T. A second one while the command bar
 * is open goes straight back to it; otherwise pull the tab to the top of the
 * list, where the command bar will replace it.
 */
async function placeNewTab(tab) {
  // Pull it up now — a tab that appears at the bottom and jumps is worse than
  // one that was never there — but wait before throwing it away.
  await hoistNewTab(tab);
  await reuseIfStillBlank(tab);
}

// Long enough for a tab opened with an address to report it.
const BLANK_GRACE_MS = 400;

// Tabs the sidebar opened on an address ("Open in New Tab"): never spare, however
// long Firefox takes to start loading them.
const keptTabs = new Set();

// "Customize Toolbar…" opens its own about:blank tab, marked only by this icon
// (CustomizeMode.sys.mjs). It isn't spare: closing it leaves customize mode.
const isCustomizeTab = (tab) => tab.favIconUrl === "chrome://browser/skin/customize.svg";

/**
 * Firefox reports about:blank for a tab that was opened with an address until
 * the load starts, so "blank" at creation doesn't mean blank: a favorite or a
 * pinned item the sidebar had just opened would be thrown away as a redundant
 * new tab. Give the tab a moment to say where it is going, and take its binding
 * to an item as proof that it isn't spare.
 */
async function reuseIfStillBlank(tab) {
  await new Promise((r) => setTimeout(r, BLANK_GRACE_MS));
  const fresh = await browser.tabs.get(tab.id).catch(() => null);
  if (!fresh || !(fresh.url === "about:blank" || isNewTabUrl(fresh.url))) return;
  if (isCustomizeTab(fresh) || keptTabs.has(tab.id) || (await getBindings())[tab.id]) return;
  await reuseCommandBar(fresh);
}

/** The index just below the window's native pinned tabs: the top of the sidebar's list. */
async function topIndex(windowId) {
  const tabs = await browser.tabs.query({ windowId });
  return tabs.filter((t) => t.pinned).length;
}

/** Move a tab Firefox just created to the top of the list. */
async function hoistNewTab(tab) {
  const index = await topIndex(tab.windowId);
  // Only ever pull a tab up.
  if (tab.index > index) await browser.tabs.move(tab.id, { index }).catch(() => {});
}

const handledNewTabs = new Set();

/**
 * Cmd/Ctrl+T. The add-on owns the shortcut, so Firefox never opens its own
 * blank tab: either the command bar already in this window comes forward, or a
 * new one opens at the top of the list.
 */
// Two Cmd+T presses in the same moment would both find no command bar and
// both open one, so a window's opens take turns.
const opening = new Map();

function openCommandBar(windowId) {
  const after = opening.get(windowId) || Promise.resolve();
  const open = after.then(() => openBar(windowId));
  opening.set(windowId, open.catch(() => {}));
  return open;
}

async function openBar(windowId) {
  const open = await commandBarIn(windowId);
  if (open) {
    await browser.tabs.update(open.id, { active: true });
    return open;
  }
  const url = browser.runtime.getURL("palette/palette.html");
  const tab = await createTab({ url, windowId, index: await topIndex(windowId), active: true, ...(await spaceProps(windowId)) });
  paletteTabs.add(tab.id);
  commandBars.set(windowId, tab.id);
  return tab;
}

/**
 * Cmd/Ctrl+L. Like Arc: the command bar, with the current tab's address in it
 * (selected), and what's picked there loads in that tab. A blank tab gets the
 * plain command bar; in a command bar, the field's text gets selected.
 */
async function openLocationBar(windowId) {
  const [tab] = await browser.tabs.query({ active: true, windowId });
  if (tab && anyPaletteUrl(tab.url)) {
    browser.runtime.sendMessage({ type: "select-field", tabId: tab.id }).catch(() => {});
    return;
  }
  if (!tab || isNewTabUrl(tab.url) || tab.url === "about:blank") {
    await openCommandBar(windowId);
    return;
  }
  const url = browser.runtime.getURL(`palette/palette.html?edit=${tab.id}&url=${encodeURIComponent(tab.url)}`);
  const bar = await createTab({ url, windowId, index: tab.index + 1, active: true, ...(await spaceProps(windowId)) });
  // Not a spare new tab, whatever Firefox reports while it loads.
  keptTabs.add(bar.id);
  setTimeout(() => keptTabs.delete(bar.id), 10000);
}

/**
 * Cmd/Ctrl+W. The add-on owns the shortcut so the last tab can stay a command
 * bar: closing it would only make Firefox open a blank tab in its place.
 */
async function closeActiveTab() {
  // One populated window instead of three queries: every round trip to the
  // parent process is delay the user feels before the tab goes away.
  const win = await browser.windows.getLastFocused({ populate: true }).catch(() => null);
  if (!win) return;
  if (win.type !== "normal") {
    await browser.windows.remove(win.id).catch(() => {});
    return;
  }
  const windowId = win.id;
  const tab = (win.tabs || []).find((t) => t.active);
  if (!tab) return;
  const rest = win.tabs.filter((t) => t.id !== tab.id && !t.hidden && !t.pinned);
  if (!rest.length) {
    // Nothing else open: keep (or restore) the command bar instead.
    if (commandBars.get(windowId) === tab.id || isNewTabUrl(tab.url)) return;
    await openCommandBar(windowId);
  }
  await browser.tabs.remove(tab.id);
}

/** Send a redundant new tab back to the command bar that is already open. */
async function reuseCommandBar(tab) {
  const open = await commandBarIn(tab.windowId, tab.id);
  if (!open) return false;
  handledNewTabs.add(tab.id);
  await browser.tabs.remove(tab.id).catch(() => {});
  const back = await browser.tabs.get(open.id).catch(() => null);
  if (back && !back.active) await browser.tabs.update(open.id, { active: true }).catch(() => {});
  return true;
}

// Command-bar tabs by window, so a redundant Cmd+T can be undone at once
// instead of after a tabs.query round trip.
const commandBars = new Map();
// Command bars by tab id. A tab the add-on just opened reports about:blank for
// a moment, so the URL alone can't tell one: without this, a Cmd+T right after
// another would see no bar and open a second empty one.
const paletteTabs = new Set();
// Bars that have finished loading. After that, "loading" means the bar is on
// its way somewhere.
const loadedBars = new Set();
// Command bars on their way somewhere. Firefox reports a tab's new URL only
// once the page commits, so between Enter and the first paint the tab still
// looks like the command bar — and Cmd+T would return to it instead of opening
// a new one.
const leavingTabs = new Set();

const anyPaletteUrl = (url) => (url || "").startsWith(browser.runtime.getURL("palette/palette.html"));
// A bar that edits another tab's address (Cmd/Ctrl+L) isn't the window's command bar:
// Cmd+T must not come back to it.
const isEditBarUrl = (url) => anyPaletteUrl(url) && /[?&]edit=/.test(url);
const isPaletteUrl = (url) => anyPaletteUrl(url) && !isEditBarUrl(url);

function trackCommandBar(tab) {
  if (!tab || tab.id === undefined) return;
  if (isPaletteUrl(tab.url)) {
    paletteTabs.add(tab.id);
    commandBars.set(tab.windowId, tab.id);
  } else {
    forgetCommandBar(tab.id, tab.windowId);
  }
}

function forgetCommandBar(tabId, windowId) {
  paletteTabs.delete(tabId);
  loadedBars.delete(tabId);
  leavingTabs.delete(tabId);
  if (commandBars.get(windowId) === tabId) commandBars.delete(windowId);
}

function noteLeaving(tab) {
  leavingTabs.add(tab.id);
  setTimeout(() => leavingTabs.delete(tab.id), 20000);
  if (commandBars.get(tab.windowId) === tab.id) commandBars.delete(tab.windowId);
}

/** A visible command-bar tab in `windowId` (in its space), if one is already open. */
async function commandBarIn(windowId, ignoreTabId) {
  const mine = await spaceFilter(windowId);
  const known = commandBars.get(windowId);
  if (known !== undefined && known !== ignoreTabId && !leavingTabs.has(known)) {
    const tab = await browser.tabs.get(known).catch(() => null);
    // Still the command bar? Once it has been sent somewhere it is an ordinary
    // tab, and Cmd+T has to open a new command bar rather than return to it.
    if (tab && !tab.hidden && mine(tab) && (paletteTabs.has(tab.id) || isPaletteUrl(tab.url))) return tab;
    commandBars.delete(windowId);
  }
  const tabs = await browser.tabs.query({ windowId });
  const open =
    tabs.find(
      (t) => t.id !== ignoreTabId && !leavingTabs.has(t.id) && !t.hidden && mine(t) && (paletteTabs.has(t.id) || isPaletteUrl(t.url))
    ) || null;
  if (open) commandBars.set(windowId, open.id);
  return open;
}

/**
 * The new-tab page just loaded in `tab` (Cmd/Ctrl+T, a new window). Replace it
 * with a tab on the command bar: Firefox keeps keyboard focus in its (hidden)
 * URL bar for new-tab pages, but a tab opened on a real page URL gets focus in
 * the page, so the search field is ready for typing.
 */
async function handleNewTabPage(tab) {
  if (handledNewTabs.has(tab.id)) return;
  handledNewTabs.add(tab.id);
  setTimeout(() => handledNewTabs.delete(tab.id), 10000);
  // One command bar per window: a second Cmd+T returns to the open one.
  const open = await commandBarIn(tab.windowId, tab.id);
  if (open) {
    await browser.tabs.update(open.id, { active: true });
    await browser.tabs.remove(tab.id);
    return;
  }
  const bar = await createTab({
    url: browser.runtime.getURL("palette/palette.html"),
    windowId: tab.windowId,
    index: await topIndex(tab.windowId), // top of the list, like Arc
    active: tab.active,
    ...(await spaceProps(tab.windowId)),
  });
  paletteTabs.add(bar.id);
  commandBars.set(tab.windowId, bar.id);
  await browser.tabs.remove(tab.id);
}

browser.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.url !== undefined) trackCommandBar(tab);
  if (changes.status === "complete" && paletteTabs.has(tabId)) loadedBars.add(tabId);
  // A bar that has loaded and starts loading again is leaving: Firefox still
  // reports the palette's URL until the new page commits.
  if (changes.status === "loading" && loadedBars.has(tabId)) noteLeaving(tab);
});

// The favicon of a favorite / pinned item, for when its tab is closed again.
browser.tabs.onUpdated.addListener(
  async (tabId, change) => {
    const itemId = (await getBindings())[tabId];
    if (itemId) cacheIcon(itemId, change.favIconUrl);
  },
  { properties: ["favIconUrl"] }
);

// Blank pages the add-on swaps or cancels shouldn't clog Cmd/Ctrl+Shift+T.
let forgetTimer = 0;
browser.tabs.onRemoved.addListener((tabId, info) => {
  forgetCommandBar(tabId, info.windowId);
  unbind(tabId);
  clearTimeout(forgetTimer);
  forgetTimer = setTimeout(() => forgetBlankClosedTabs(), 150);
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "bookmarc:newtab" && sender.tab) handleNewTabPage(sender.tab);
  // The command bar is leaving: it stops counting as one now, not when the
  // page it opened finishes loading.
  if (msg?.type === "bookmarc:navigating" && sender.tab) noteLeaving(sender.tab);
  // The sidebar's "+" row and a double-click below its tabs.
  if (msg?.type === "command-bar") openCommandBar(msg.windowId);
  if (msg?.type === "keep-tab" && Number.isInteger(msg.tabId)) {
    keptTabs.add(msg.tabId);
    setTimeout(() => keptTabs.delete(msg.tabId), 10000);
  }
  // The sidebar's space icons and "Move to Space".
  if (msg?.type === "space:switch" && Number.isInteger(msg.windowId)) return inSpaceQueue(msg.windowId, () => switchSpace(msg.windowId, msg.space));
  if (msg?.type === "space:move" && Array.isArray(msg.tabIds)) return moveToSpace(msg.tabIds, msg.space);
});

/* ---------- Spaces ----------
 * A space is a container (Multi-Account Containers manages them, BookmArc only
 * shows them). Each window is in one space and shows its tabs; the other
 * spaces' tabs are hidden. A tab of another space that becomes active takes
 * its window there. Web pages opened without a container move into the
 * window's space before they load; tabs that can't have a container (Firefox's
 * own pages) and tabs open from before spaces are given one instead.
 */

const SPACE_VALUE = "space"; // sessions value: a window's cookieStoreId; a tab's {space, keep}

let spacesCache = null; // getSpaces(), until the containers change
const currentSpaces = () => (spacesCache ??= getSpaces().catch(() => null));

// Windows by focus, most recent first: a new window is often focused before
// its space is asked for, and takes the one of the window before it.
const focusOrder = [];
browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  const at = focusOrder.indexOf(windowId);
  if (at >= 0) focusOrder.splice(at, 1);
  focusOrder.unshift(windowId);
  focusOrder.length = Math.min(focusOrder.length, 8);
});

const lastActive = new Map(); // "<windowId> <space>" -> the tab last active there

/** A window's spaces and its current one; null in a private window or without containers. */
async function spaceContext(windowId) {
  const win = await browser.windows.get(windowId).catch(() => null);
  if (!win || win.incognito || win.type !== "normal") return null;
  const spaces = await currentSpaces();
  if (!spaces?.length) return null;
  return { spaces, space: await windowSpace(windowId, spaces) };
}

/** The window's space: as last set, else as it was before a restart, else the one of the window it came from. */
async function windowSpace(windowId, spaces) {
  const known = (id) => spaces.some((s) => s.id === id);
  let space = await getWindowSpace(windowId);
  if (known(space)) return space;
  space = await browser.sessions.getWindowValue(windowId, SPACE_VALUE).catch(() => null);
  if (!known(space)) {
    const before = focusOrder.find((id) => id !== windowId);
    const from = before !== undefined ? await getWindowSpace(before) : null;
    space = known(from) ? from : spaces[0].id;
  }
  await setWindowSpace(windowId, space);
  return space;
}

async function setWindowSpace(windowId, space) {
  await mirrorWindowSpace(windowId, space);
  await browser.sessions.setWindowValue(windowId, SPACE_VALUE, space).catch(() => {});
}

/** Give a tab without a container its space. keep: it never moves into a container (open from before spaces). */
async function markTab(tabId, space, keep = false) {
  await mirrorTabSpace(tabId, space);
  await browser.sessions.setTabValue(tabId, SPACE_VALUE, { space, keep }).catch(() => {});
}

const tabMark = (tabId) => browser.sessions.getTabValue(tabId, SPACE_VALUE).catch(() => null);

/** Which of a window's tabs are in its space; everything, without spaces. */
async function spaceFilter(windowId) {
  const ctx = await spaceContext(windowId);
  if (!ctx) return () => true;
  const marks = await getTabSpaces();
  const known = new Set(ctx.spaces.map((s) => s.id));
  return (tab) => {
    const space = spaceOf(tab, marks);
    return (known.has(space) ? space : ctx.space) === ctx.space;
  };
}

/** New tabs in a window open in its space's container. */
async function spaceProps(windowId) {
  const ctx = await spaceContext(windowId);
  return ctx ? { cookieStoreId: ctx.space } : {};
}

/** tabs.create in a container; a page that can't have one opens without it, given the space instead. */
async function createTab(props) {
  try {
    return await browser.tabs.create(props);
  } catch (err) {
    if (!props.cookieStoreId) throw err;
    const { cookieStoreId, ...rest } = props;
    const tab = await browser.tabs.create(rest);
    await markTab(tab.id, cookieStoreId);
    return tab;
  }
}

// A window's space changes one at a time: a switch and the hiding that follows
// it mustn't interleave with the next.
const spaceQueues = new Map();

function inSpaceQueue(windowId, fn) {
  const run = (spaceQueues.get(windowId) || Promise.resolve()).then(fn);
  spaceQueues.set(windowId, run.catch((err) => console.error("BookmArc: spaces", err)));
  return run;
}

/** Show the tabs of the window's space, hide the others (not the active tab, nor Firefox's pinned ones). */
async function syncVisibility(windowId) {
  if (!(await spaceContext(windowId))) return;
  const [tabs, mine] = await Promise.all([browser.tabs.query({ windowId }), spaceFilter(windowId)]);
  const show = tabs.filter((t) => t.hidden && mine(t)).map((t) => t.id);
  const hide = tabs.filter((t) => !t.hidden && !t.pinned && !t.active && !mine(t)).map((t) => t.id);
  if (show.length) await browser.tabs.show(show).catch(() => {});
  if (hide.length) await browser.tabs.hide(hide).catch((err) => console.error("BookmArc: hiding tabs failed", err));
}

/** An empty tab: Cmd+T's command bar, a new-tab page. */
const isSpare = (tab) => isNewTabUrl(tab.url) || (tab.url === "about:blank" && tab.status !== "loading");

/**
 * Take a window to another space: its last active tab there comes forward (a
 * fresh command bar in an empty space), the rest hides. Empty tabs left in the
 * space it leaves are closed: nothing was done in them.
 */
async function switchSpace(windowId, space, focusTabId = null) {
  const ctx = await spaceContext(windowId);
  if (!ctx || !ctx.spaces.some((s) => s.id === space)) return;
  const left = ctx.space;
  if (left === space && focusTabId === null) return syncVisibility(windowId);
  const leftTabs = (await browser.tabs.query({ windowId })).filter(await spaceFilter(windowId));
  await setWindowSpace(windowId, space);
  const tabs = (await browser.tabs.query({ windowId })).filter(await spaceFilter(windowId)).filter((t) => !t.pinned);
  let target = focusTabId;
  if (target === null) {
    const remembered = tabs.find((t) => t.id === lastActive.get(`${windowId} ${space}`));
    target = (remembered || tabs.reduce((a, b) => ((b.lastAccessed || 0) > (a?.lastAccessed || 0) ? b : a), null))?.id ?? null;
  }
  if (target === null) await openBar(windowId);
  else await browser.tabs.update(target, { active: true }).catch(() => {});
  await syncVisibility(windowId);
  if (left !== space) {
    const bindings = await getBindings();
    const spare = leftTabs.filter((t) => !t.pinned && isSpare(t) && !bindings[t.id] && !keptTabs.has(t.id)).map((t) => t.id);
    if (spare.length) await browser.tabs.remove(spare).catch(() => {});
  }
}

/**
 * Move tabs to another space: a web page opens again in that container (and
 * keeps its favorite / pinned item), a page that can't have one just changes
 * spaces. Moving the tab on screen brings the space's next tab forward first.
 */
async function moveToSpace(tabIds, space) {
  const [bindings, marks] = await Promise.all([getBindings(), getTabSpaces()]);
  const tabs = (await Promise.all(tabIds.map((id) => browser.tabs.get(id).catch(() => null)))).filter(
    (t) => t && !t.incognito && spaceOf(t, marks) !== space
  );
  const windows = new Set(tabs.map((t) => t.windowId));
  for (const windowId of windows) {
    const active = tabs.find((t) => t.windowId === windowId && t.active);
    if (!active) continue;
    const mine = await spaceFilter(windowId);
    const rest = (await browser.tabs.query({ windowId })).filter((t) => mine(t) && !t.pinned && !tabIds.includes(t.id));
    const next = rest.reduce((a, b) => ((b.lastAccessed || 0) > (a?.lastAccessed || 0) ? b : a), null);
    if (next) await browser.tabs.update(next.id, { active: true });
    else await openBar(windowId);
  }
  for (const tab of tabs) {
    if (!/^https?:/i.test(tab.url || "")) {
      if (!tab.cookieStoreId || tab.cookieStoreId === NO_CONTAINER) await markTab(tab.id, space);
      continue;
    }
    const fresh = await browser.tabs.create({
      url: tab.url,
      cookieStoreId: space,
      windowId: tab.windowId,
      index: tab.index + 1,
      active: false,
      ...(tab.discarded ? { discarded: true, title: tab.title } : {}),
    });
    if (bindings[tab.id]) await bind(fresh.id, bindings[tab.id]);
    await browser.tabs.remove(tab.id).catch(() => {});
  }
  for (const windowId of windows) scheduleSync(windowId);
}

/** Without a single container there would be no space: Multi-Account Containers' first one comes back. */
async function ensureSpace() {
  const spaces = await getSpaces();
  if (spaces && !spaces.length) {
    await browser.contextualIdentities.create({ name: "Personal", color: "blue", icon: "fingerprint" }).catch(() => {});
    spacesCache = null;
  }
}

/**
 * Start, install, update: every window back in its space, tabs without a
 * container given theirs (those from before spaces stay as they are, in the
 * space of their window), the rest hidden.
 */
async function initSpaces() {
  await ensureSpace();
  spacesCache = null;
  const spaces = await currentSpaces();
  if (!spaces?.length) return;
  const known = (id) => spaces.some((s) => s.id === id);
  for (const win of await browser.windows.getAll({ populate: true, windowTypes: ["normal"] })) {
    if (win.incognito) continue;
    const space = await windowSpace(win.id, spaces);
    for (const tab of win.tabs) {
      if (tab.cookieStoreId && tab.cookieStoreId !== NO_CONTAINER) continue;
      const mark = await tabMark(tab.id);
      if (known(mark?.space)) await mirrorTabSpace(tab.id, mark.space);
      else await markTab(tab.id, space, true);
    }
    // The tab on screen decides, as when it's picked.
    const active = win.tabs.find((t) => t.active);
    const activeSpace = active && spaceOf(active, await getTabSpaces());
    if (known(activeSpace) && activeSpace !== space) await setWindowSpace(win.id, activeSpace);
    scheduleSync(win.id);
  }
  await browser.storage.session.set({ [READY_KEY]: true });
}

let initing = null;
const initSpacesOnce = () =>
  (initing ??= initSpaces()
    .catch((err) => console.error("BookmArc: setting up spaces failed", err))
    .finally(() => (initing = null)));


// Session restore creates tabs by the dozen: one pass for all that arrive at once.
const syncPending = new Set();

function scheduleSync(windowId) {
  if (syncPending.has(windowId)) return;
  syncPending.add(windowId);
  inSpaceQueue(windowId, () => {
    syncPending.delete(windowId);
    return syncVisibility(windowId);
  });
}

// Until initSpaces() has run after a start, session restore is still putting
// tabs back, with their spaces arriving late: leave them to it. (storage.session:
// the background page sleeps and wakes, a browser restart clears it.)
const READY_KEY = "spacesReady";
const spacesReady = async () => !!(await browser.storage.session.get(READY_KEY))[READY_KEY];

// Enabled again in about:addons: no install or startup event comes.
spacesReady().then((ready) => ready || setTimeout(initSpacesOnce, 1500));

browser.tabs.onCreated.addListener(async (tab) => {
  if (tab.incognito || !(await spacesReady())) return;
  const ctx = await spaceContext(tab.windowId);
  if (!ctx) return;
  if (!tab.cookieStoreId || tab.cookieStoreId === NO_CONTAINER) {
    const mark = await tabMark(tab.id); // a restored tab brings its own
    if (ctx.spaces.some((s) => s.id === mark?.space)) await mirrorTabSpace(tab.id, mark.space);
    else await markTab(tab.id, ctx.space);
  }
  if (!tab.active) scheduleSync(tab.windowId);
});

browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const ctx = await spaceContext(windowId);
  if (!ctx) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  const space = tab && spaceOf(tab, await getTabSpaces());
  if (!space || !ctx.spaces.some((s) => s.id === space)) return;
  lastActive.set(`${windowId} ${space}`, tabId);
  if (space !== ctx.space) inSpaceQueue(windowId, () => switchSpace(windowId, space, tabId));
});

// A tab dragged into another window keeps its space: hidden there, or the window follows it.
browser.tabs.onAttached.addListener((tabId, { newWindowId }) => scheduleSync(newWindowId));

browser.tabs.onRemoved.addListener((tabId) => forgetTabSpace(tabId));
browser.windows.onRemoved.addListener((windowId) => forgetWindowSpace(windowId));

// Containers made, changed or deleted in Multi-Account Containers. A window
// whose space is gone goes to the first one.
browser.contextualIdentities?.onCreated.addListener(() => (spacesCache = null));
browser.contextualIdentities?.onUpdated.addListener(() => (spacesCache = null));
browser.contextualIdentities?.onRemoved.addListener(async () => {
  spacesCache = null;
  await ensureSpace();
  const spaces = await currentSpaces();
  if (!spaces?.length) return;
  for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) {
    if (win.incognito) continue;
    const space = await getWindowSpace(win.id);
    if (!spaces.some((s) => s.id === space)) inSpaceQueue(win.id, () => switchSpace(win.id, spaces[0].id));
  }
});

/* Web pages opening without a container (a link from another app, a tab
   restored from before…) open again in their space's container before they
   load, as Multi-Account Containers does. Sites it has assigned to a container
   are left to it. POST requests stay: opening them again would lose the form. */

const containing = new Set(); // tabs being opened again in a container

browser.webRequest.onBeforeRequest.addListener(containRequest, { urls: ["<all_urls>"], types: ["main_frame"] }, ["blocking"]);

async function containRequest(details) {
  if (details.tabId < 0 || details.incognito || details.method !== "GET") return {};
  if (details.cookieStoreId && details.cookieStoreId !== NO_CONTAINER) return {};
  if (!/^https?:/i.test(details.url)) return {};
  if (containing.has(details.tabId)) return { cancel: true };
  if (!(await spacesReady())) return {};
  const tab = await browser.tabs.get(details.tabId).catch(() => null);
  if (!tab || tab.incognito) return {};
  const ctx = await spaceContext(tab.windowId);
  if (!ctx) return {};
  const mark = await tabMark(tab.id);
  if (mark?.keep) return {};
  if (await assignedSpace(details.url, ctx.spaces)) return {};
  const space = ctx.spaces.some((s) => s.id === mark?.space) ? mark.space : ctx.space;
  containing.add(tab.id);
  reopenInSpace(tab, details.url, space)
    .catch((err) => console.error("BookmArc: opening the page in its container failed", err))
    .finally(() => containing.delete(tab.id));
  return { cancel: true };
}

async function reopenInSpace(tab, url, space) {
  const itemId = (await getBindings())[tab.id];
  const fresh = await browser.tabs.create({
    url,
    cookieStoreId: space,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active,
    ...(tab.openerTabId !== undefined ? { openerTabId: tab.openerTabId } : {}),
  });
  keptTabs.add(fresh.id);
  setTimeout(() => keptTabs.delete(fresh.id), 10000);
  if (itemId) await bind(fresh.id, itemId);
  handledNewTabs.add(tab.id);
  await browser.tabs.remove(tab.id).catch(() => {});
}

/* ---------- Firefox's own menus (page and tab): favorites and pins ---------- */

/** The space a tab is in ({spaces, space}; space null: a private window, no containers). */
async function spaceOfTabIn(tab) {
  const spaces = await currentSpaces();
  if (tab.incognito || !spaces?.length) return { spaces, space: null };
  const id = spaceOf(tab, await getTabSpaces()) || (await getWindowSpace(tab.windowId));
  return { spaces, space: spaces.find((s) => s.id === id) || null };
}

/** The bookmarks folder a tab's space shows as its pinned tabs. */
const pinRootOf = async (tab) => getPinRoot((await spaceOfTabIn(tab)).space);

/** A new favorite for `tab`, in its space; null if that space has one for the page already. */
async function newFavorite(tab, favorites) {
  const { spaces, space } = await spaceOfTabIn(tab);
  if (favoritesOf(favorites, space, spaces).some((f) => f.url === tab.url)) return null;
  return { id: uid(), url: tab.url, title: tab.title || tab.url, ...(space ? { space: space.id } : {}) };
}

async function itemOfTab(tab) {
  const rootId = tab ? await pinRootOf(tab) : null;
  const [favorites, pins, bindings] = await Promise.all([getFavorites(), getPins(rootId), getBindings()]);
  const itemId = tab && bindings[tab.id];
  return {
    favorites,
    pins,
    rootId,
    fav: itemId ? favorites.find((f) => f.id === itemId) : null,
    pin: itemId ? pins.find((p) => p.id === itemId) : null,
  };
}

browser.menus.onShown.addListener(async (info, tab) => {
  if (!info.menuIds.includes(MENU.favAdd) || !tab) return;
  const { fav, pin } = await itemOfTab(tab);
  const ok = isFavoritable(tab.url);
  browser.menus.update(MENU.favAdd, { visible: !fav, enabled: ok });
  browser.menus.update(MENU.favRemove, { visible: !!fav });
  browser.menus.update(MENU.pin, { visible: !pin, enabled: ok });
  browser.menus.update(MENU.unpin, { visible: !!pin });
  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  const { favorites, pins, rootId, fav, pin } = await itemOfTab(tab);
  const item = { id: uid(), url: tab.url, title: tab.title || tab.url };
  switch (info.menuItemId) {
    case MENU.favAdd: {
      const added = !fav && isFavoritable(tab.url) && (await newFavorite(tab, favorites));
      if (added) {
        await saveFavorites([...favorites, added]);
        await bind(tab.id, added.id);
      }
      break;
    }
    case MENU.favRemove:
      if (fav) {
        await unbindItems([fav.id]);
        await saveFavorites(favorites.filter((f) => f.id !== fav.id));
      }
      break;
    case MENU.pin:
      if (!pin && isFavoritable(tab.url)) {
        await savePins([...pins, item], rootId);
        await bind(tab.id, item.id);
      }
      break;
    case MENU.unpin:
      if (pin) {
        await unbindItems([pin.id]);
        await savePins(pins.filter((p) => p.id !== pin.id), rootId);
      }
      break;
  }
});

/* ---------- Commands ---------- */

async function focusedWindowId() {
  return (await browser.windows.getLastFocused({ windowTypes: ["normal"] })).id;
}

async function addFavorite(tab) {
  if (!tab || !isFavoritable(tab.url)) return;
  const favorites = await getFavorites();
  const fav = await newFavorite(tab, favorites);
  if (!fav) return;
  await saveFavorites([...favorites, fav]);
  await bind(tab.id, fav.id);
}

browser.commands.onCommand.addListener(async (command) => {
  if (command === "new-tab") {
    await openCommandBar(await focusedWindowId());
  } else if (command === "open-location") {
    await openLocationBar(await focusedWindowId());
  } else if (command === "close-tab") {
    await closeActiveTab();
  } else if (command === "add-favorite") {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    await addFavorite(tab);
  } else if (command === "reopen-tab") {
    await reopenClosedTab(await focusedWindowId());
  } else if (command.startsWith("space-")) {
    // Alt+1…4: the first four spaces.
    const space = (await currentSpaces())?.[Number(command.slice("space-".length)) - 1];
    const windowId = await focusedWindowId();
    if (space) await inSpaceQueue(windowId, () => switchSpace(windowId, space.id));
  }
});

/**
 * Cmd/Ctrl+Shift+T: the tab closed last in the window's space. One the sidebar
 * didn't see closing (it wasn't open) is taken unless it's known to be another space's.
 */
async function reopenClosedTab(windowId) {
  const win = await browser.windows.get(windowId).catch(() => null);
  const spaces = win && !win.incognito ? await currentSpaces() : null;
  if (!spaces?.length) return browser.sessions.restore().catch(() => {});
  const spaceId = await windowSpace(windowId, spaces);
  const [closed] = await closedTabsOf(spaceId);
  if (closed) return reopenClosed(closed, windowId);
  const elsewhere = new Set((await closedTabsOf(null)).map((c) => c.url));
  const recent = await browser.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []);
  const entry = recent.find((e) => e.tab && !elsewhere.has(e.tab.url));
  if (entry) await browser.sessions.restore(entry.tab.sessionId);
}

// Firefox suspends the background page once it falls idle, and waking it back
// up delays the first Cmd/Ctrl+T or Cmd/Ctrl+W noticeably. An open sidebar holds
// a port, which keeps the page alive for as long as the sidebar is on screen.
browser.runtime.onConnect.addListener((port) => {
  port.onDisconnect.addListener(() => {});
});

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});
