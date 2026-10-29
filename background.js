/* Background page: the command bar as a tab (Cmd/Ctrl+T, Cmd/Ctrl+W), favorites
   and pins from Firefox's own menus, keeping tabs bound to favorites / pinned
   items, badges from other extensions, and unloading idle tabs. */

import {
  uid,
  isNewTabUrl,
  getFavorites,
  saveFavorites,
  getPins,
  savePins,
  getBindings,
  bind,
  unbind,
  unbindItems,
  cacheIcon,
  adoptAll,
  forgetBlankClosedTabs,
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
    browser.menus.create({ id: MENU.pin, title: "Pin to Bookmarks Toolbar", contexts: ["tab", "page"] });
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
  setTimeout(() => {
    adoptAll().catch(() => {});
    initWindows();
  }, 1500);
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
  const tab = await browser.tabs.create({ url, windowId, index: await topIndex(windowId), active: true });
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
  const bar = await browser.tabs.create({ url, windowId, index: tab.index + 1, active: true });
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

/** A visible command-bar tab in `windowId`, if one is already open. */
async function commandBarIn(windowId, ignoreTabId) {
  const known = commandBars.get(windowId);
  if (known !== undefined && known !== ignoreTabId && !leavingTabs.has(known)) {
    const tab = await browser.tabs.get(known).catch(() => null);
    // Still the command bar? Once it has been sent somewhere it is an ordinary
    // tab, and Cmd+T has to open a new command bar rather than return to it.
    if (tab && !tab.hidden && (paletteTabs.has(tab.id) || isPaletteUrl(tab.url))) return tab;
    commandBars.delete(windowId);
  }
  const tabs = await browser.tabs.query({ windowId });
  const open =
    tabs.find(
      (t) => t.id !== ignoreTabId && !leavingTabs.has(t.id) && !t.hidden && (paletteTabs.has(t.id) || isPaletteUrl(t.url))
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
  const bar = await browser.tabs.create({
    url: browser.runtime.getURL("palette/palette.html"),
    windowId: tab.windowId,
    index: await topIndex(tab.windowId), // top of the list, like Arc
    active: tab.active,
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
});

/* ---------- Firefox's own menus (page and tab): favorites and pins ---------- */

async function itemOfTab(tab) {
  const [favorites, pins, bindings] = await Promise.all([getFavorites(), getPins(), getBindings()]);
  const itemId = tab && bindings[tab.id];
  return {
    favorites,
    pins,
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
  const { favorites, pins, fav, pin } = await itemOfTab(tab);
  const item = { id: uid(), url: tab.url, title: tab.title || tab.url };
  switch (info.menuItemId) {
    case MENU.favAdd:
      if (!fav && isFavoritable(tab.url)) {
        await saveFavorites([...favorites, item]);
        await bind(tab.id, item.id);
      }
      break;
    case MENU.favRemove:
      if (fav) {
        await unbindItems([fav.id]);
        await saveFavorites(favorites.filter((f) => f.id !== fav.id));
      }
      break;
    case MENU.pin:
      if (!pin && isFavoritable(tab.url)) {
        await savePins([...pins, item]);
        await bind(tab.id, item.id);
      }
      break;
    case MENU.unpin:
      if (pin) {
        await unbindItems([pin.id]);
        await savePins(pins.filter((p) => p.id !== pin.id));
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
  if (favorites.some((f) => f.url === tab.url)) return;
  const fav = { id: uid(), url: tab.url, title: tab.title || tab.url };
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
  }
});

// Firefox suspends the background page once it falls idle, and waking it back
// up delays the first Cmd/Ctrl+T or Cmd/Ctrl+W noticeably. An open sidebar holds
// a port, which keeps the page alive for as long as the sidebar is on screen.
browser.runtime.onConnect.addListener((port) => {
  port.onDisconnect.addListener(() => {});
});

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});
