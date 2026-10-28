/* global ArcFox */
import { h, setIcon, syncChildren, showMenu, hideMenu, openDialog } from "./ui.js";
import { createAddressBar } from "./address.js";
import { createSpacesBar } from "./spaces.js";

const TAB_MIME = "application/x-arcfox-tab";
const ITEM_MIME = "application/x-arcfox-item";

const $ = (id) => document.getElementById(id);
const els = {
  favorites: $("favorites"),
  spaceHead: $("space-head"),
  spaceIcon: $("space-icon"),
  spaceName: $("space-name"),
  pinned: $("pinned"),
  today: $("today"),
  newTab: $("new-tab"),
  clear: $("clear"),
};

let themeDraft = null; // {tint, intensity} previewed by the theme dialog

const state = {
  windowId: null,
  private: false,
  spaceId: null,
  spaces: [],
  favorites: [], // this space's favorites (its container's list)
  favKey: "favorites",
  pins: [], // pinned items of the current space
  icons: {},
  bound: new Map(), // itemId -> tab
  tabItem: new Map(), // tabId -> itemId
  tabSpace: new Map(), // tabId -> spaceId
  badges: new Map(), // tabId -> badges other extensions put on it
  tabs: [], // this window, sorted by index
};

const TODAY_FLOW = "todayFlow"; // storage.local: true = open tabs follow the whole pinned list (not docked)
const PINNED_HEIGHT = "pinnedHeight"; // storage.local: px the pinned list may take while docked (unset: half the sidebar)

const tileEls = new Map();
const pinEls = new Map();
const tabEls = new Map();
let dragging = false;

const space = () => state.spaces.find((s) => s.id === state.spaceId);
const activeTab = () => state.tabs.find((t) => t.active) || null;
const tabById = (id) => state.tabs.find((t) => t.id === id);

function spaceOf(tab) {
  const s = state.tabSpace.get(tab.id);
  return s && state.spaces.some((x) => x.id === s) ? s : state.spaceId;
}

const PALETTE_URL = browser.runtime.getURL("palette/palette.html");

/** The command bar already open in this space, if any. */
function openCommandBar() {
  return state.tabs.find(
    (t) => !t.hidden && t.url?.startsWith(PALETTE_URL) && (state.private || spaceOf(t) === state.spaceId)
  );
}

function newTabInSpace(url) {
  // One command bar at a time: a second Cmd+T just goes back to it.
  if (!url) {
    const open = openCommandBar();
    if (open) return browser.tabs.update(open.id, { active: true });
  }
  // New tabs open at the top of the space's list, like Arc.
  const create = state.private
    ? browser.tabs.create({ windowId: state.windowId, active: true, ...(url ? { url } : {}) })
    : ArcFox.topIndexOfSpace(state.windowId, state.spaceId).then((index) =>
        ArcFox.createTabInSpace(state.windowId, space(), { url, index })
      );
  return create.then((tab) => {
    schedule(true);
    return tab;
  });
}

/* ---------- Refresh scheduling ---------- */

let scanDirty = true;
let frame = 0;
let running = false;
let again = false;

function schedule(scan = false) {
  if (scan) scanDirty = true;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    refresh();
  });
}

async function refresh() {
  if (state.windowId === null) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      const scan = scanDirty;
      scanDirty = false;
      const t0 = performance.now();
      // Pruning pings other extensions and waits for their answers, which is
      // nobody's idea of a tab list: let it run on its own. Dropping a stale
      // provider writes to session storage, which schedules another refresh.
      ArcFox.pruneProviders().catch(() => {});
      const [st, icons, allTabs, prefs, badges] = await Promise.all([
        ArcFox.getState(),
        ArcFox.getIconCache(),
        browser.tabs.query({}).then((tabs) => tabs.filter((t) => !removedTabs.has(t.id))),
        browser.storage.local.get(PINS_COLLAPSED),
        ArcFox.getBadges(),
      ]);
      const tData = performance.now();
      state.badges = badges;
      collapsed = prefs[PINS_COLLAPSED] || {};
      if (scan) {
        const result = await ArcFox.scanTabs(allTabs, st);
        state.tabItem = result.tabItem;
        state.tabSpace = result.tabSpace;
      }
      state.spaceId = state.private ? null : await ArcFox.getWindowSpace(state.windowId, st);
      state.spaces = st.spaces;
      // Favorites of this space's container (Arc: per profile).
      state.favKey = ArcFox.favKey(st.spaces.find((x) => x.id === state.spaceId));
      state.favorites = state.private ? [] : st.favLists.get(state.favKey) || [];
      state.pins = state.private ? [] : st.pins.get(state.spaceId) || [];
      state.icons = icons;

      const itemIds = new Set([...st.favorites, ...[...st.pins.values()].flat()].map((i) => i.id));
      const byId = new Map(allTabs.map((t) => [t.id, t]));
      state.bound = new Map();
      for (const [tabId, itemId] of state.tabItem) {
        const tab = byId.get(tabId);
        if (tab && itemIds.has(itemId)) state.bound.set(itemId, tab);
        else state.tabItem.delete(tabId);
      }
      for (const tabId of state.tabSpace.keys()) if (!byId.has(tabId)) state.tabSpace.delete(tabId);
      state.tabs = allTabs.filter((t) => t.windowId === state.windowId).sort((a, b) => a.index - b.index);
      const tScan = performance.now();
      if (!dragging && !renaming) render();
      // A refresh the eye can catch is a bug; say which part took the time.
      const end = performance.now();
      if (end - t0 > 50) {
        const ms = (a, b) => Math.round(b - a);
        console.debug(
          `Arc: refresh ${ms(t0, end)}ms over ${allTabs.length} tabs ` +
            `(data ${ms(t0, tData)}, bindings ${ms(tData, tScan)}, render ${ms(tScan, end)})`
        );
      }
    } while (again);
  } finally {
    running = false;
  }
}

/* ---------- Rendering ---------- */

function render() {
  document.body.classList.remove("booting");
  if (state.private) return renderPrivate();
  const sp = space();
  // While the theme dialog is open it paints its own preview.
  if (!themeDraft) ArcFox.paintSpace(sp);
  els.spaceIcon.textContent = sp?.icon || "";
  els.spaceIcon.hidden = !sp?.icon;
  els.spaceHead.classList.toggle("has-icon", !!sp?.icon);
  els.spaceName.textContent = sp?.name || "";

  applyCollapsed();
  renderFavorites();
  renderPinned();
  renderToday();
  applySelection();
  spacesBar.render(state);
  address.update(activeTab());

  const tab = activeTab();
  $("back").disabled = !tab;
  $("forward").disabled = !tab;
}

function renderFavorites() {
  const activeId = activeTab()?.id;
  const nodes = state.favorites.map((fav) => {
    let el = tileEls.get(fav.id);
    if (!el) {
      el = h("button", { className: "tile", draggable: true, dataset: { item: fav.id } }, h("span", { className: "icon" }));
      tileEls.set(fav.id, el);
    }
    const tab = state.bound.get(fav.id);
    el.classList.toggle("open", !!tab);
    el.classList.toggle("active", !!tab && tab.id === activeId);
    el.title = tab?.title || fav.title;
    setIcon(el.firstChild, tab?.favIconUrl || state.icons[fav.id] || fav.icon, fav.url);
    return el;
  });
  prune(tileEls, state.favorites.map((f) => f.id));
  const empty = nodes.length === 0;
  els.favorites.classList.toggle("empty", empty);
  // No favorites yet: the zone stays hidden and only shows up while a tab is dragged.
  els.favorites.classList.toggle("collapsed", empty);
  syncChildren(els.favorites, empty ? favHint : nodes);
}

const SVG_NS = "http://www.w3.org/2000/svg";

const closeIcon = () => lucide(LUCIDE.x);

/** favicon, mute, title, badges, close: the parts fillRow() updates. */
const rowParts = () => [
  h("span", { className: "favicon" }),
  h("button", { className: "icon-btn audio" }),
  h("span", { className: "badges start" }),
  h("span", { className: "title" }),
  h("span", { className: "badges" }),
  h("button", { className: "icon-btn close", title: "Close tab" }, closeIcon()),
];

function makeRow(dataset) {
  return h("li", { className: "tab", draggable: true, dataset }, ...rowParts());
}

/** Firefox split view: one row, one half per tab (like Arc). */
function makeSplitRow() {
  return h("li", { className: "tab split" });
}

function fillRow(el, tab, { title, url, icon }) {
  const [favicon, audio, startBadgesEl, titleEl, badgesEl] = el.children;
  el.classList.toggle("active", !!tab?.active);
  el.classList.toggle("discarded", !!tab?.discarded);
  el.classList.toggle("loading", tab?.status === "loading" && !tab.discarded);
  if (titleEl.textContent !== title) titleEl.textContent = title;
  el.title = url ? `${title}\n${url}` : title;
  setIcon(favicon, icon, url);
  const muted = !!tab?.mutedInfo?.muted;
  audio.hidden = !(tab?.audible || muted);
  const want = muted ? "off" : "on";
  if (audio.dataset.state !== want) {
    audio.dataset.state = want;
    audio.replaceChildren(lucide(muted ? LUCIDE.volumeOff : LUCIDE.volume));
  }
  audio.title = muted ? "Unmute tab" : "Mute tab";
  const badges = (tab && state.badges.get(tab.id)) || [];
  fillBadges(startBadgesEl, badges.filter((b) => b.position === "start"));
  fillBadges(badgesEl, badges.filter((b) => b.position !== "start"));
}

/** Badges other extensions set on a tab (see "Tab badges" in background.js). */
function fillBadges(el, badges) {
  const key = JSON.stringify(badges);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren(
    ...badges.map((b) => {
      const icon = LUCIDE[b.icon];
      const className = ["badge", icon && "icon", b.pulse && "pulse"].filter(Boolean).join(" ");
      const style = b.color ? { "--badge": b.color } : undefined;
      return h("span", { className, title: b.title, style, "aria-label": b.label || b.title }, icon ? lucide(icon) : b.label);
    })
  );
}

/** Lucide icons: 24-grid, 2px round strokes. https://lucide.dev (ISC) */
const LUCIDE = {
  volume:
    "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM16 9a5 5 0 0 1 0 6m3.364 3.364a9 9 0 0 0 0-12.728",
  volumeOff:
    "M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298zm5.5 9.798l5-5m-5 0l5 5",
  x: "M18 6L6 18M6 6l12 12",
  // Badge icons other extensions can pick (see BADGE_ICONS in shared/store.js).
  bot: "M12 8V4H8M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM2 14h2M20 14h2M15 13v2M9 13v2",
  sparkles:
    "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594zM20 2v4M22 4h-4M2 20a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
};

function lucide(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

// Lucide's "pin" and "pin-off" (ISC license), joined into one path each.
const PIN = "M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z";
const PIN_OFF =
  "M12 17v5M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89M2 2l20 20M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11";

/**
 * The divider's pin. Docked (default): the pinned list scrolls on its own so
 * the open tabs keep their place in view. Not docked: they sit below the
 * whole pinned list and the sidebar scrolls.
 */
function applyTodayFlow(flow) {
  document.body.classList.toggle("today-flow", flow);
  const btn = $("dock-today");
  btn.replaceChildren(lucide(flow ? PIN_OFF : PIN));
  btn.title = flow ? "Keep open tabs in view (pinned tabs scroll on their own)" : "Let open tabs follow all pinned tabs";
  btn.setAttribute("aria-pressed", String(!flow));
}

applyTodayFlow(false);
browser.storage.local.get(TODAY_FLOW).then((r) => applyTodayFlow(!!r[TODAY_FLOW]));
$("dock-today").addEventListener("click", () => {
  const flow = !document.body.classList.contains("today-flow");
  applyTodayFlow(flow);
  browser.storage.local.set({ [TODAY_FLOW]: flow });
});

/* ---------- Dragging the divider ---------- */

function applyPinnedHeight(px) {
  if (Number.isFinite(px)) document.documentElement.style.setProperty("--pinned-height", `${px}px`);
  else document.documentElement.style.removeProperty("--pinned-height");
}

browser.storage.local.get(PINNED_HEIGHT).then((r) => applyPinnedHeight(r[PINNED_HEIGHT]));

/**
 * While docked, dragging the divider moves where the pinned list ends (it
 * scrolls on its own above). It stops at the list's full length and leaves
 * room for a few open tabs. Double-click: back to the default.
 */
{
  const row = document.querySelector(".divider-row");
  const canResize = () => !document.body.classList.contains("today-flow") && !document.body.classList.contains("pins-collapsed");
  row.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button") || !canResize()) return;
    e.preventDefault();
    const pinned = els.pinned;
    const startY = e.clientY;
    const startH = pinned.getBoundingClientRect().height;
    const most = () => Math.min(pinned.scrollHeight, document.querySelector(".scroll").clientHeight - 120);
    let height = startH;
    row.setPointerCapture(e.pointerId);
    row.classList.add("resizing");
    const move = (ev) => {
      height = Math.round(Math.max(40, Math.min(most(), startH + ev.clientY - startY)));
      applyPinnedHeight(height);
    };
    const end = () => {
      row.classList.remove("resizing");
      row.removeEventListener("pointermove", move);
      row.removeEventListener("pointerup", end);
      row.removeEventListener("pointercancel", end);
      if (height !== startH) browser.storage.local.set({ [PINNED_HEIGHT]: height });
    };
    row.addEventListener("pointermove", move);
    row.addEventListener("pointerup", end);
    row.addEventListener("pointercancel", end);
  });
  row.addEventListener("dblclick", (e) => {
    if (e.target.closest("button") || !canResize()) return;
    applyPinnedHeight(undefined);
    browser.storage.local.remove(PINNED_HEIGHT);
  });
}

// Lucide's "folder" and "folder-open" (ISC license, like the icons above),
// plus fill shapes under the outline for Arc's tinted look.
const FOLDER_CLOSED =
  "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";
const FOLDER_OPEN =
  "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2";
const FOLDER_OPEN_BACK =
  "M2 18V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2H9.24a2 2 0 0 0-1.74 1.1L6 14Z";
const FOLDER_OPEN_FRONT =
  "M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2Z";

/** Arc-style folder icon: Lucide's outline over a tint of the same color. */
function folderSvg(open) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const fills = open ? [[FOLDER_OPEN_BACK, "0.12"], [FOLDER_OPEN_FRONT, "0.3"]] : [[FOLDER_CLOSED, "0.2"]];
  for (const [d, opacity] of fills) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "currentColor");
    path.setAttribute("fill-opacity", opacity);
    svg.append(path);
  }
  svg.append(lucide(open ? FOLDER_OPEN : FOLDER_CLOSED).firstChild);
  return svg;
}

/** Indent a pinned row by its folder depth (0 = top level). */
function setLevel(el, parent, depth) {
  el.dataset.parent = parent || "";
  el.dataset.depth = String(depth);
  el.classList.toggle("child", depth > 0);
  el.style.setProperty("--depth", depth);
}

/** The pinned item's tab is on another page than the one that was pinned. */
const isMoved = (item, tab) => !!tab && ArcFox.isFavoritable(tab.url) && tab.url !== item.url;

function pinRow(item, parent, depth) {
  let el = pinEls.get(item.id);
  if (!el || el.classList.contains("folder")) {
    el = makeRow({ item: item.id });
    el.classList.add("item");
    pinEls.set(item.id, el);
  }
  el.dataset.sel = `i:${item.id}`;
  setLevel(el, parent, depth);
  const tab = state.bound.get(item.id);
  el.classList.toggle("open", !!tab);
  // Like Arc: once the tab has left the pinned page, the row reads "<icon> / <name>",
  // and clicking the icon goes back to the pinned page. The name stays as it was.
  const moved = isMoved(item, tab);
  el.classList.toggle("moved", moved);
  // Arc shows the user's name or the saved title for pinned items; fall back to the live tab title.
  fillRow(el, tab, {
    title: item.name || item.title || tab?.title || item.url,
    url: tab?.url || item.url,
    icon: tab?.favIconUrl || state.icons[item.id] || item.icon,
  });
  el.querySelector(".favicon").title = moved ? `Back to ${item.name || item.title || item.url}` : "";
  return el;
}

function folderRow(folder, parent, depth) {
  let el = pinEls.get(folder.id);
  if (!el || !el.classList.contains("folder")) {
    el = h(
      "li",
      { className: "tab folder", draggable: true, dataset: { item: folder.id } },
      h("span", { className: "favicon folder-icon" }),
      h("span", { className: "title" }),
      h("span", { className: "folder-count" })
    );
    pinEls.set(folder.id, el);
  }
  el.dataset.sel = `i:${folder.id}`;
  setLevel(el, parent, depth);
  el.classList.toggle("expanded", !!folder.open);
  const icon = el.querySelector(".folder-icon");
  const shape = folder.icon ? `emoji:${folder.icon}` : folder.open ? "open" : "closed";
  if (icon.dataset.shape !== shape) {
    icon.dataset.shape = shape;
    if (folder.icon) icon.replaceChildren(h("span", { className: "folder-emoji" }, folder.icon));
    else icon.replaceChildren(folderSvg(folder.open));
  }
  const title = el.querySelector(".title");
  if (title && title.textContent !== folder.name) title.textContent = folder.name;
  el.title = folder.name;
  // Collapsed: how many of its pins (at any depth) have an open tab.
  const inside = folder.open ? new Set() : ArcFox.descendantIds(state.pins, folder.id);
  const openTabs = [...inside].filter((id) => state.bound.has(id)).length;
  const count = el.querySelector(".folder-count");
  count.textContent = openTabs ? String(openTabs) : "";
  count.hidden = !openTabs;
  count.title = openTabs ? `${plural(openTabs, "open tab")} in this folder` : "";
  return el;
}

function renderPinned() {
  const folderIds = new Set(state.pins.filter(ArcFox.isFolder).map((f) => f.id));
  const nodes = [];
  const seen = new Set(); // guards against a parent loop in damaged data
  const add = (item, parent, depth) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    if (!ArcFox.isFolder(item)) return nodes.push(pinRow(item, parent, depth));
    nodes.push(folderRow(item, parent, depth));
    if (item.open) for (const child of state.pins) if (child.parent === item.id) add(child, item.id, depth + 1);
  };
  // Items whose folder is gone show at the top level.
  for (const item of state.pins) if (!item.parent || !folderIds.has(item.parent)) add(item, "", 0);
  prune(pinEls, state.pins.map((i) => i.id));
  syncChildren(els.pinned, nodes);
  if (pendingRename && pinEls.has(pendingRename)) {
    const id = pendingRename;
    pendingRename = null;
    startRename(id);
  }
}

// splitViewId is -1 (tabs.SPLIT_VIEW_ID_NONE) when the tab isn't in a Firefox split view.
/**
 * A blank "New Tab": Firefox/Arc new-tab pages, the command bar, or an
 * about:blank tab that isn't on its way somewhere — a tab opened from a link
 * starts blank too, and that one should show as loading, not as "New Tab".
 */
const isBlankTab = (tab) =>
  ArcFox.isNewTabUrl(tab.url) || ((!tab.url || tab.url === "about:blank") && tab.status !== "loading");

const inSplit = (tab) => tab.splitViewId !== undefined && tab.splitViewId !== -1;

// Firefox clears favIconUrl while a tab navigates, which would swap the icon
// for a letter tile and back on every load. Keep the last one for as long as
// the tab stays on the same site.
const lastIcon = new Map(); // tabId -> { icon, origin }

function iconFor(tab) {
  let origin = "";
  try {
    origin = new URL(tab.url || "").origin;
  } catch {
    // about:, blank, or a URL Firefox hasn't reported yet
  }
  if (tab.favIconUrl) {
    lastIcon.set(tab.id, { icon: tab.favIconUrl, origin });
    return tab.favIconUrl;
  }
  const kept = lastIcon.get(tab.id);
  if (kept && (kept.origin === origin || !origin)) return kept.icon;
  lastIcon.delete(tab.id);
  return null;
}

function tabEl(tab, make) {
  let el = tabEls.get(tab.id);
  if (!el || el.matches("li") !== (make === makeRow)) {
    el = make === makeRow ? makeRow({ tab: tab.id }) : h("span", { className: "half", draggable: true, dataset: { tab: tab.id } }, ...rowParts());
    tabEls.set(tab.id, el);
  }
  el.dataset.sel = `t:${tab.id}`;
  // Blank tabs (Cmd+T, command bar) look like the "+ New Tab" row — unless the
  // command bar has just sent one somewhere.
  const pending = pendingNav.get(tab.id);
  const blank = !pending && isBlankTab(tab);
  el.classList.toggle("blank", blank);
  const loadingTitle = tab.status === "loading" ? "Loading…" : tab.url;
  const title = blank ? "New Tab" : pending?.label || tab.title || loadingTitle;
  fillRow(el, tab, { title, url: pending ? "" : tab.url, icon: pending ? null : iconFor(tab) });
  if (blank) el.classList.remove("loading"); // a blank row never spins
  if (pending) el.classList.add("loading"); // ...but a tab on its way does
  if (blank) {
    const box = el.querySelector(".favicon");
    if (box.dataset.src !== "plus") {
      box.dataset.src = "plus";
      box.replaceChildren(h("span", { className: "plus" }, "+"));
    }
  }
  return el;
}

/** A blank tab (the command bar, a new-tab page) that "+ New Tab" stands for instead of a row of its own. */
const isNewTabRow = (tab) => !pendingNav.has(tab.id) && !inSplit(tab) && isBlankTab(tab);

function renderToday() {
  const inSpace = state.tabs.filter(
    (t) =>
      !state.tabItem.has(t.id) &&
      !doomedTabs.has(t.id) &&
      (preSwapTabs.has(t.id) || state.private || spaceOf(t) === state.spaceId)
  );
  // Like Arc, a new tab has no row until it goes somewhere: "+ New Tab" shows
  // as the active row while it's open.
  const tabs = inSpace.filter((t) => !isNewTabRow(t));
  els.newTab.classList.toggle("active", inSpace.some((t) => t.active && isNewTabRow(t)));
  // A tab Firefox just made sits at the end of its list and has no space yet;
  // draw it where Arc is about to put it so the row never moves.
  tabs.sort((a, b) => (preSwapTabs.has(b.id) ? 1 : 0) - (preSwapTabs.has(a.id) ? 1 : 0));
  const all = tabs;
  // A lone blank tab has nothing to close into: no ✕ on it.
  els.today.classList.toggle("only-blank", all.length === 1 && isBlankTab(all[0]));
  const nodes = [];
  const splitKeys = new Set();
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const next = tabs[i + 1];
    if (inSplit(tab) && next && next.splitViewId === tab.splitViewId) {
      const key = `split:${tab.splitViewId}`;
      splitKeys.add(key);
      let row = tabEls.get(key);
      if (!row) tabEls.set(key, (row = makeSplitRow()));
      // Drops before/after the row use its first/last tab.
      row.dataset.tab = tab.id;
      row.dataset.lastTab = next.id;
      row.classList.toggle("active", tab.active || next.active);
      syncChildren(row, [tabEl(tab, null), tabEl(next, null)]);
      nodes.push(row);
      i++;
    } else {
      nodes.push(tabEl(tab, makeRow));
    }
  }
  prune(tabEls, [...state.tabs.map((t) => t.id), ...splitKeys]);
  syncChildren(els.today, nodes);
}

function prune(map, keep) {
  const ids = new Set(keep);
  for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
}

const favHint = [h("span", { className: "fav-drop-text" }, "Drop to add to Favorites")];

/** Private window: just the tab list (Arc's Incognito sidebar). */
function renderPrivate() {
  document.body.classList.remove("booting");
  document.documentElement.style.setProperty("--space", ArcFox.COLORS.purple);
  document.documentElement.style.removeProperty("--tint");
  delete document.documentElement.dataset.text;
  els.spaceName.textContent = "Private window";
  els.spaceIcon.hidden = true;
  els.spaceHead.classList.remove("has-icon");
  renderToday();
  applySelection();
  address.update(activeTab());
  $("back").disabled = !activeTab();
  $("forward").disabled = !activeTab();
}

/* ---------- Modules ---------- */

const address = createAddressBar({
  windowId: () => state.windowId,
  activeTab,
  newTab: newTabInSpace,
  container: () => space()?.container || null,
});

const spacesBar = createSpacesBar({
  el: $("spaces"),
  windowId: () => state.windowId,
  spaceId: () => state.spaceId,
  refresh: () => schedule(true),
  accepts: (e) => e.dataTransfer.types.includes(TAB_MIME) || e.dataTransfer.types.includes(ITEM_MIME),
  onDrop: async (spaceId, dt) => {
    const itemId = dt.getData(ITEM_MIME);
    if (itemId) await ArcFox.moveItem(itemId, ArcFox.pinKey(spaceId));
    else {
      const data = readTabData(dt);
      if (data) await ArcFox.moveTabToSpace(data.tabId, spaceId);
    }
    schedule(true);
  },
});

/* ---------- Toolbar ---------- */

$("back").addEventListener("click", () => activeTab() && browser.tabs.goBack(activeTab().id).catch(() => {}));
$("forward").addEventListener("click", () => activeTab() && browser.tabs.goForward(activeTab().id).catch(() => {}));
$("reload").addEventListener("click", (e) => {
  const tab = activeTab();
  if (tab) browser.tabs.reload(tab.id, { bypassCache: e.shiftKey });
});

/** Close a tab; closing the last one of this space leaves a blank tab, so the window stays. */
async function closeTab(tabId) {
  const rest = state.tabs.filter((t) => t.id !== tabId && spaceOf(t) === state.spaceId);
  if (!rest.length) await newTabInSpace();
  await browser.tabs.remove(tabId);
}

/* ---------- Selection (Shift/Cmd-click), like Arc ---------- */

const selection = new Set(); // "i:<itemId>" (pinned items, folders) / "t:<tabId>" (tabs)
let anchor = null;
let pendingRename = null;
const isMac = navigator.platform.startsWith("Mac");

function applySelection() {
  for (const el of document.querySelectorAll("[data-sel]")) el.classList.toggle("selected", selection.has(el.dataset.sel));
}

function clearSelection() {
  if (!selection.size) return;
  selection.clear();
  applySelection();
}

/** Shift = range, Cmd (Ctrl elsewhere) = toggle. Returns true if the click was a selection click. */
function handleSelectClick(e, el) {
  const toggle = isMac ? e.metaKey : e.ctrlKey;
  if (!el?.dataset.sel || !(e.shiftKey || toggle)) {
    clearSelection();
    if (el?.dataset.sel) anchor = el.dataset.sel;
    return false;
  }
  e.preventDefault();
  const key = el.dataset.sel;
  if (e.shiftKey) {
    const keys = [...document.querySelectorAll("#pinned [data-sel], #today [data-sel]")].map((x) => x.dataset.sel);
    const start = anchor ?? (activeTab() && `t:${activeTab().id}`);
    const a = keys.indexOf(start);
    const b = keys.indexOf(key);
    selection.clear();
    if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selection.add(keys[i]);
    else selection.add(key);
  } else {
    if (selection.has(key)) selection.delete(key);
    else selection.add(key);
    anchor = key;
  }
  applySelection();
  return true;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") clearSelection();
});

const pinById = (id) => state.pins.find((i) => i.id === id);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Arc's menu for several selected rows. */
function selectionMenu() {
  const keys = [...selection];
  const pickedIds = keys.filter((k) => k.startsWith("i:")).map((k) => k.slice(2)).filter((id) => pinById(id));
  const itemIds = pickedIds.filter((id) => !ArcFox.isFolder(pinById(id)));
  const tabIds = keys.filter((k) => k.startsWith("t:")).map((k) => Number(k.slice(2))).filter((id) => tabById(id));
  const links = [...itemIds.map((id) => state.bound.get(id)?.url || pinById(id)?.url), ...tabIds.map((id) => tabById(id).url)].filter(Boolean);
  const openTabs = [...itemIds.map((id) => state.bound.get(id)?.id).filter(Boolean), ...tabIds];
  const n = pickedIds.length + tabIds.length;
  return [
    links.length && { label: "Copy Links", run: () => navigator.clipboard.writeText(links.join("\n")) },
    "-",
    n && {
      label: `New Folder with ${plural(n, "Item")}`,
      run: async () => {
        const folder = await ArcFox.createFolder(state.spaceId, { itemIds: pickedIds, tabIds });
        clearSelection();
        pendingRename = folder.id;
      },
    },
    openTabs.length && { label: `Close ${plural(openTabs.length, "Tab")}`, run: () => browser.tabs.remove(openTabs).then(clearSelection) },
    itemIds.length && {
      label: itemIds.length === 1 ? "Remove Pin" : "Remove Pins",
      danger: true,
      run: async () => {
        for (const id of itemIds) await ArcFox.removeItem(id, state.spaceId);
        clearSelection();
      },
    },
  ].filter(Boolean);
}

function folderMenu(folder) {
  const inside = ArcFox.descendantIds(state.pins, folder.id);
  const children = state.pins.filter((i) => i.parent === folder.id);
  const items = state.pins.filter((i) => inside.has(i.id) && !ArcFox.isFolder(i));
  return [
    { label: "Rename…", run: () => startRename(folder.id) },
    { label: "Change Icon…", run: () => changeFolderIcon(folder) },
    items.length && {
      label: `Open ${plural(items.length, "Tab")}`,
      run: async () => {
        for (const item of items) await ArcFox.openItem(item.id, state.windowId);
      },
    },
    { label: folder.open ? "Collapse" : "Expand", run: () => toggleFolder(folder) },
    {
      label: "New Nested Folder",
      run: async () => {
        if (!folder.open) await toggleFolder(folder);
        pendingRename = (await ArcFox.createFolder(state.spaceId, { parent: folder.id })).id;
      },
    },
    folder.parent && {
      label: "Remove from Folder",
      run: () => ArcFox.moveItem(folder.id, ArcFox.pinKey(state.spaceId), folder.parent, { parent: pinById(folder.parent)?.parent || null }),
    },
    "-",
    children.length && { label: "Ungroup", run: () => ArcFox.deleteFolder(folder.id, { keepItems: true }) },
    { label: inside.size ? "Delete Folder and Pins" : "Delete Folder", danger: true, run: () => ArcFox.deleteFolder(folder.id, { keepItems: false }) },
  ].filter(Boolean);
}

const FOLDER_EMOJIS = ["📁", "⭐", "❤️", "🔥", "💼", "🏠", "📚", "💻", "🎨", "🎵", "🎮", "🛒", "✈️", "🧪", "📈", "🎬", "🍳", "🌱", "💡", "🚀", "☕", "📷", "🔧", "📰"];

/** The first emoji (one grapheme) of `text`, or "" if it doesn't start with one. */
function firstEmoji(text) {
  const first = [...new Intl.Segmenter().segment(text.trim())][0]?.segment || "";
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(first) ? first : "";
}

/** "Change Icon" dialog: resolves with the picked emoji, "" to remove the icon, or null if cancelled. */
function pickIcon(current) {
  return openDialog((close) => {
    const field = h("input", {
      className: "emoji-input",
      value: current || "",
      placeholder: "🙂",
      spellcheck: false,
    });
    return h(
      "form",
      {
        className: "dialog-card",
        onsubmit: (e) => {
          e.preventDefault();
          close(firstEmoji(field.value));
        },
      },
      h("h2", {}, "Change Icon"),
      h(
        "div",
        { className: "emoji-grid" },
        FOLDER_EMOJIS.map((e) =>
          h("button", { type: "button", className: `emoji${current === e ? " selected" : ""}`, onclick: () => close(e) }, e)
        )
      ),
      h("label", { className: "field" }, `Other emoji (${isMac ? "⌃⌘Space" : "Win+."} opens the emoji picker)`, field),
      h(
        "div",
        { className: "actions" },
        current && h("button", { type: "button", className: "reset", onclick: () => close("") }, "Remove Icon"),
        h("button", { type: "button", dataset: { cancel: "" }, onclick: () => close(null) }, "Cancel"),
        h("button", { type: "submit", className: "primary" }, "Save")
      )
    );
  });
}

/** Pick an emoji for a folder (shown instead of the folder icon), or remove it. */
async function changeFolderIcon(folder) {
  const icon = await pickIcon(folder.icon);
  if (icon === null || icon === (folder.icon || "")) return;
  await ArcFox.updateFolder(folder.id, { icon });
}

/** Pick the space's emoji (header and space bar), or remove it. */
async function changeSpaceIcon() {
  const sp = space();
  if (!sp) return;
  const icon = await pickIcon(sp.icon);
  if (icon === null || icon === (sp.icon || "")) return;
  await ArcFox.saveSpace({ id: sp.id, icon });
}

function toggleFolder(folder) {
  folder.open = !folder.open; // instant feedback, then persist
  renderPinned();
  applySelection();
  return ArcFox.updateFolder(folder.id, { open: folder.open });
}

let renaming = false;

/** Inline rename of a pinned row: a folder's name, or the title a pinned item shows. */
function startRename(itemId) {
  const el = pinEls.get(itemId);
  const item = pinById(itemId);
  const title = el?.querySelector(".title");
  if (!title || !item) return;
  const isFolder = ArcFox.isFolder(item);
  const current = isFolder ? item.name : title.textContent;
  renaming = true;
  const input = h("input", { className: "rename", value: current, spellcheck: false });
  title.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    renaming = false;
    const name = input.value.trim();
    input.replaceWith(title);
    if (save && isFolder && name && name !== current) {
      title.textContent = name;
      await ArcFox.updateFolder(itemId, { name });
    } else if (save && !isFolder && name !== current) {
      // Empty: back to the page's own title.
      if (name) title.textContent = name;
      await ArcFox.renameItem(itemId, name);
    }
    schedule(true);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
}

/** What this sidebar shows, in the shape ArcFox.findItem() expects. */
const localState = () => ({
  favLists: new Map([[state.favKey, state.favorites]]),
  pins: new Map([[state.spaceId, state.pins]]),
});

/* ---------- Item menus ---------- */

function itemMenu(itemId) {
  const found = ArcFox.findItem(localState(), itemId);
  if (!found) return [];
  const { item } = found;
  const isFav = ArcFox.isFavKey(found.key);
  const tab = state.bound.get(itemId);
  const moved = tab && tab.url !== item.url;
  return [
    { label: tab ? "Go to Tab" : "Open", run: () => ArcFox.openItem(itemId, state.windowId) },
    { label: "Open in New Tab", run: () => newTabInSpace(item.url) },
    moved && { label: "Back to Saved URL", run: () => ArcFox.resetItem(itemId) },
    moved && ArcFox.isFavoritable(tab.url) && { label: "Save Current URL", run: () => ArcFox.saveCurrentUrl(itemId) },
    !isFav && { label: "Rename…", run: () => startRename(itemId) },
    { label: "Copy Link", run: () => navigator.clipboard.writeText(item.url) },
    "-",
    isFav
      ? { label: "Pin in This Space", run: () => ArcFox.moveItem(itemId, ArcFox.pinKey(state.spaceId)) }
      : { label: "Move to Favorites", run: () => ArcFox.moveItem(itemId, state.favKey) },
    !isFav && {
      label: "New Folder with This Item",
      run: async () => {
        const folder = await ArcFox.createFolder(state.spaceId, { itemIds: [itemId] });
        pendingRename = folder.id;
      },
    },
    !isFav && item.parent && {
      label: "Remove from Folder",
      run: () => ArcFox.moveItem(itemId, ArcFox.pinKey(state.spaceId), item.parent, { parent: pinById(item.parent)?.parent || null }),
    },
    tab && { label: "Close Tab", run: () => browser.tabs.remove(tab.id) },
    isFav
      ? { label: "Remove from Favorites", danger: true, run: () => ArcFox.removeItem(itemId, state.spaceId) }
      : { label: "Unpin", danger: true, run: () => ArcFox.removeItem(itemId, state.spaceId) },
  ].filter(Boolean);
}

/* ---------- Clicks ---------- */

els.favorites.addEventListener("click", (e) => {
  const tile = e.target.closest(".tile");
  if (tile) {
    ArcFox.openItem(tile.dataset.item, state.windowId).then(
      () => schedule(true),
      (err) => console.error("Arc: opening the favorite failed", err)
    );
  }
});

for (const zone of [els.favorites, els.pinned]) {
  zone.addEventListener("contextmenu", (e) => {
    const el = e.target.closest("[data-item]");
    if (!el) return;
    e.preventDefault();
    let items;
    if (el.dataset.sel && selection.has(el.dataset.sel) && selection.size > 1) items = selectionMenu();
    else if (ArcFox.isFolder(pinById(el.dataset.item))) items = folderMenu(pinById(el.dataset.item));
    else items = itemMenu(el.dataset.item);
    showMenu(items, e.clientX, e.clientY, () => schedule(true));
  });
}

/* ---------- Space header: collapse pinned, space menu ---------- */

/* ---------- Sizing (font, row height, spacing, indent, folder icon) ---------- */

const SIZING_KEY = "sidebarSizing"; // storage.local: {font, height, gap, indent, icon} in px, all sidebars
const SIZING = [
  // [key, label, CSS variable, min, max, Arc's value (the default, as in sidebar.css)]
  ["font", "Font Size", "--row-font", 11, 18, 14],
  ["height", "Row Height", "--row-height", 26, 48, 36],
  ["gap", "Row Spacing", "--row-gap", 0, 14, 5],
  ["indent", "Folder Indent", "--indent", 6, 32, 16],
  ["icon", "Folder Icon Size", "--folder-icon", 12, 26, 18],
];

/** Put sizes ({key: px}) on the page; missing keys fall back to sidebar.css. */
function applySizing(sizing = {}) {
  for (const [key, , prop, min, max] of SIZING) {
    const v = Number(sizing[key]);
    if (Number.isFinite(v)) document.documentElement.style.setProperty(prop, `${Math.min(max, Math.max(min, v))}px`);
    else document.documentElement.style.removeProperty(prop);
  }
}

let sizing = {};
browser.storage.local.get(SIZING_KEY).then((r) => applySizing((sizing = r[SIZING_KEY] || {})));

/** "Sizing" dialog: a slider per size, previewed live; Save keeps it for every sidebar. */
async function editSizing() {
  const draft = Object.fromEntries(SIZING.map(([key, , , , , def]) => [key, sizing[key] ?? def]));
  const result = await openDialog((close) =>
    h(
      "form",
      { className: "dialog-card sizing-card", onsubmit: (e) => (e.preventDefault(), close("save")) },
      h("h2", {}, "Sizing"),
      SIZING.map(([key, label, , min, max]) => {
        const value = h("span", { className: "range-value" }, `${draft[key]}px`);
        const range = h("input", {
          type: "range",
          min,
          max,
          step: key === "font" ? 0.5 : 1,
          value: draft[key],
          oninput: (e) => {
            draft[key] = Number(e.target.value);
            value.textContent = `${draft[key]}px`;
            applySizing(draft);
          },
        });
        return h("label", { className: "field" }, h("span", { className: "range-head" }, label, value), range);
      }),
      h(
        "div",
        { className: "actions" },
        h("button", { type: "button", className: "reset", onclick: () => close("reset") }, "Arc Defaults"),
        h("button", { type: "button", dataset: { cancel: "" }, onclick: () => close(null) }, "Cancel"),
        h("button", { type: "submit", className: "primary" }, "Save")
      )
    )
  );
  if (result === "save") sizing = draft;
  else if (result === "reset") sizing = {};
  applySizing(sizing);
  if (result) await browser.storage.local.set({ [SIZING_KEY]: sizing });
}

const PINS_COLLAPSED = "pinnedCollapsed"; // storage.local: {spaceId: true}
let collapsed = {};

function applyCollapsed() {
  const isCollapsed = !!collapsed[state.spaceId];
  document.body.classList.toggle("pins-collapsed", isCollapsed);
  els.spaceHead.setAttribute("aria-expanded", String(!isCollapsed));
}

async function toggleCollapsed() {
  collapsed = { ...collapsed, [state.spaceId]: !collapsed[state.spaceId] };
  applyCollapsed();
  await browser.storage.local.set({ [PINS_COLLAPSED]: collapsed });
}

els.spaceHead.addEventListener("click", (e) => {
  if (e.target.closest("#space-more, .rename")) return;
  toggleCollapsed();
});

// Double-click the space name: rename it.
els.spaceHead.addEventListener("dblclick", (e) => {
  if (e.target.closest("#space-name")) startSpaceRename();
});

/** Inline rename of the space, in its header. Also renames the space's container. */
function startSpaceRename() {
  const sp = space();
  const title = els.spaceName;
  if (!sp || state.private || !title.isConnected) return;
  renaming = true;
  const input = h("input", { className: "rename", value: sp.name, spellcheck: false });
  title.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    renaming = false;
    const name = input.value.trim();
    input.replaceWith(title);
    if (save && name && name !== sp.name) {
      title.textContent = name;
      await ArcFox.saveSpace({ id: sp.id, name });
    }
    schedule(true);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
}

$("space-more").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(spaceMenu(), r.left, r.bottom + 4, () => schedule(true));
});

// Right-click the space name: same menu.
els.spaceHead.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  showMenu(spaceMenu(), e.clientX, e.clientY, () => schedule(true));
});

/** Theme dialog: the space's color (Firefox's color picker) and how strongly it tints the sidebar. */
async function editThemeColor() {
  const sp = space();
  if (!sp) return;
  ArcFox.paintSpace({ ...sp, intensity: null }); // read the default intensity for this text color
  const defaultIntensity = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tint")) || 16;
  themeDraft = { tint: ArcFox.spaceColor(sp), intensity: ArcFox.spaceIntensity(sp) ?? defaultIntensity };
  const preview = () => ArcFox.paintSpace({ ...sp, ...themeDraft });
  preview();
  const result = await openDialog((close) => {
    const setTint = (hex) => {
      themeDraft.tint = hex.toLowerCase();
      color.value = themeDraft.tint;
      hexField.value = themeDraft.tint;
      preview();
    };
    const color = h("input", { type: "color", value: themeDraft.tint, oninput: (e) => setTint(e.target.value) });
    // Exact color as a hex code; taken once it's a complete #rrggbb.
    const hexField = h("input", {
      className: "hex-input",
      value: themeDraft.tint,
      spellcheck: false,
      maxLength: 7,
      oninput: (e) => {
        const hex = e.target.value.trim().replace(/^#?/, "#");
        if (/^#[0-9a-f]{6}$/i.test(hex)) {
          themeDraft.tint = hex.toLowerCase();
          color.value = themeDraft.tint;
          preview();
        }
      },
      onblur: () => (hexField.value = themeDraft.tint),
    });
    const value = h("span", { className: "range-value" }, `${Math.round(themeDraft.intensity)}%`);
    const range = h("input", {
      type: "range",
      min: 0,
      max: ArcFox.MAX_INTENSITY,
      step: 1,
      value: themeDraft.intensity,
      oninput: (e) => {
        themeDraft.intensity = Number(e.target.value);
        value.textContent = `${themeDraft.intensity}%`;
        preview();
      },
    });
    return h(
      "form",
      { className: "dialog-card theme-card", onsubmit: (e) => (e.preventDefault(), close("save")) },
      h("h2", {}, "Theme Color"),
      h("label", { className: "field" }, "Color", h("span", { className: "row" }, color, hexField)),
      h("label", { className: "field" }, h("span", { className: "range-head" }, "Intensity", value), range),
      h(
        "div",
        { className: "actions" },
        (sp.tint || ArcFox.spaceIntensity(sp) !== null || sp.text) &&
          h("button", { type: "button", className: "reset", onclick: () => close("reset") }, "Reset"),
        h("button", { type: "button", dataset: { cancel: "" }, onclick: () => close(null) }, "Cancel"),
        h("button", { type: "submit", className: "primary" }, "Save")
      )
    );
  });
  const draft = themeDraft;
  themeDraft = null;
  if (result === "save") await ArcFox.saveSpace({ id: sp.id, tint: draft.tint, intensity: draft.intensity });
  else if (result === "reset") await ArcFox.saveSpace({ id: sp.id, tint: "", intensity: null, text: null });
  ArcFox.paintSpace(space());
}

/* ---------- Export pinned tabs as bookmarks ---------- */

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * The space's pinned tabs and folders as a bookmarks file (the Netscape
 * format every browser imports), inside one folder named after the space.
 */
function bookmarksHtml(sp, pins) {
  const added = Math.floor(Date.now() / 1000);
  const folderIds = new Set(pins.filter(ArcFox.isFolder).map((f) => f.id));
  const seen = new Set();
  const lines = [];
  const pad = (depth) => "    ".repeat(depth);
  const add = (item, depth) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    if (!ArcFox.isFolder(item)) {
      const title = item.name || item.title || item.url;
      lines.push(`${pad(depth)}<DT><A HREF="${escapeHtml(item.url)}" ADD_DATE="${added}">${escapeHtml(title)}</A>`);
      return;
    }
    lines.push(`${pad(depth)}<DT><H3 ADD_DATE="${added}">${escapeHtml(item.name)}</H3>`, `${pad(depth)}<DL><p>`);
    for (const child of pins) if (child.parent === item.id) add(child, depth + 1);
    lines.push(`${pad(depth)}</DL><p>`);
  };
  for (const item of pins) if (!item.parent || !folderIds.has(item.parent)) add(item, 2);
  return [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file. -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
    `    <DT><H3 ADD_DATE="${added}">${escapeHtml(sp.name)}</H3>`,
    "    <DL><p>",
    ...lines,
    "    </DL><p>",
    "</DL><p>",
    "",
  ].join("\n");
}

/** Save the space's pinned tabs as "<space> Bookmarks.html". */
function exportBookmarks() {
  const sp = space();
  if (!sp) return;
  const blob = new Blob([bookmarksHtml(sp, state.pins)], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const name = `${sp.name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Space"} Bookmarks.html`;
  const link = h("a", { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Read a bookmarks file (the Netscape format browsers export): nested
 * <DL> lists, a folder is <DT><H3> followed by its <DL>, a bookmark <DT><A>.
 */
function parseBookmarks(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (dl) => {
    const out = [];
    for (const dt of dl.querySelectorAll(":scope > dt, :scope > p > dt")) {
      const link = dt.querySelector(":scope > a");
      const head = dt.querySelector(":scope > h3");
      if (link) out.push({ type: "tab", url: link.getAttribute("href") || "", title: link.textContent.trim() });
      else if (head) {
        // The folder's list sits inside its <dt>, or right after it in older files.
        const list = dt.querySelector(":scope > dl") || (dt.nextElementSibling?.tagName === "DL" ? dt.nextElementSibling : null);
        out.push({ type: "folder", name: head.textContent.trim(), children: list ? walk(list) : [] });
      }
    }
    return out;
  };
  const root = doc.querySelector("dl");
  let tree = root ? walk(root) : [];
  // A file holding a single folder (like Arc's own export, named after the
  // space) brings its contents, not the wrapper.
  while (tree.length === 1 && tree[0].type === "folder") tree = tree[0].children;
  return tree;
}

/** Bookmarks (web addresses only, as importPins keeps them) and folders in a tree. */
function countBookmarks(tree) {
  let pins = 0;
  let folders = 0;
  for (const x of tree) {
    if (x.type === "tab") {
      if (ArcFox.isFavoritable(x.url)) pins++;
      continue;
    }
    const inside = countBookmarks(x.children);
    pins += inside.pins;
    folders += 1 + inside.folders;
  }
  return { pins, folders };
}

/** Pick a bookmarks .html file and pin its bookmarks in this space, folders and all. */
function importBookmarks() {
  const sp = space();
  if (!sp) return;
  // Opened straight from the menu click: Firefox only shows the file picker on a user action.
  const input = h("input", { type: "file", accept: ".html,.htm,text/html", hidden: true });
  document.body.append(input);
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    const tree = parseBookmarks(await file.text());
    const { pins, folders } = countBookmarks(tree);
    const ok = await openDialog((close) =>
      h(
        "form",
        { className: "dialog-card", onsubmit: (e) => (e.preventDefault(), close(pins > 0)) },
        h("h2", {}, "Import Bookmarks"),
        h(
          "p",
          { className: "hint" },
          pins
            ? `Pin ${plural(pins, "bookmark")}${folders ? ` in ${plural(folders, "folder")}` : ""} from “${file.name}” in “${sp.name}”?`
            : `“${file.name}” has no bookmarks to import.`
        ),
        h(
          "div",
          { className: "actions" },
          h("button", { type: "button", dataset: { cancel: "" }, onclick: () => close(false) }, pins ? "Cancel" : "OK"),
          pins > 0 && h("button", { type: "submit", className: "primary" }, "Import")
        )
      )
    );
    if (ok) await ArcFox.importPins(sp.id, tree);
  });
  input.click();
}

/** The text color a space shows now: its own choice, else the system's. */
const spaceText = (sp) => sp?.text || (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");

function spaceMenu() {
  const sp = space();
  const text = spaceText(sp);
  return [
    sp && !state.private && { label: "Change Space Icon…", run: changeSpaceIcon },
    sp && !state.private && { label: "Rename Space…", run: startSpaceRename },
    { label: "Edit Theme Color…", run: editThemeColor },
    { label: "Sizing…", run: editSizing },
    sp && {
      label: text === "light" ? "Use Dark Text" : "Use Light Text",
      run: () => ArcFox.saveSpace({ id: sp.id, text: text === "light" ? "dark" : "light" }),
    },
    "-",
    {
      label: "New Folder",
      run: async () => {
        pendingRename = (await ArcFox.createFolder(state.spaceId)).id;
      },
    },
    "-",
    sp &&
      !state.private && {
        label: "Bookmarks",
        submenu: [
          { label: "Import Bookmarks…", run: importBookmarks },
          { label: "Export as Bookmarks…", run: exportBookmarks, disabled: !state.pins.length },
        ],
      },
    { label: "Import from Arc…", run: () => newTabInSpace(browser.runtime.getURL("import/import.html")) },
  ].filter(Boolean);
}

els.pinned.addEventListener("click", (e) => {
  const row = e.target.closest(".tab");
  if (!row || handleSelectClick(e, row)) return;
  const folder = pinById(row.dataset.item);
  if (ArcFox.isFolder(folder)) {
    toggleFolder(folder);
    return;
  }
  const tab = state.bound.get(row.dataset.item);
  if (e.target.closest(".close")) {
    if (tab) closeTab(tab.id);
  } else if (row.classList.contains("moved") && e.target.closest(".favicon")) {
    // The icon of a tab that moved on: back to the pinned page.
    const itemId = row.dataset.item;
    ArcFox.openItem(itemId, state.windowId)
      .then(() => ArcFox.resetItem(itemId))
      .then(
        () => schedule(true),
        (err) => console.error("Arc: going back to the pinned page failed", err)
      );
  } else if (e.target.closest(".audio")) {
    if (tab) browser.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
  } else {
    ArcFox.openItem(row.dataset.item, state.windowId).then(
      () => schedule(true),
      (err) => console.error("Arc: opening the pinned item failed", err)
    );
  }
});

// Double-click a folder's or pinned item's title: rename it.
els.pinned.addEventListener("dblclick", (e) => {
  const row = e.target.closest(".tab");
  if (row && e.target.closest(".title")) startRename(row.dataset.item);
});

els.pinned.addEventListener("auxclick", (e) => {
  const row = e.target.closest(".tab");
  const tab = row && state.bound.get(row.dataset.item);
  if (tab && e.button === 1) closeTab(tab.id);
});

els.today.addEventListener("click", (e) => {
  const row = e.target.closest("[data-tab]:not(.split)");
  if (handleSelectClick(e, row)) return;
  const tab = row && tabById(Number(row.dataset.tab));
  if (!tab) return;
  if (e.target.closest(".close")) closeTab(tab.id);
  else if (e.target.closest(".audio")) browser.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
  else browser.tabs.update(tab.id, { active: true });
});

els.today.addEventListener("auxclick", (e) => {
  const row = e.target.closest("[data-tab]:not(.split)");
  if (row && e.button === 1) closeTab(Number(row.dataset.tab));
});

// Arc's tab menu items ("Add to Favorites / Pin / Move to Space"). Firefox
// only shows extension items here, not its own tab menu.
els.today.addEventListener("contextmenu", (e) => {
  const row = e.target.closest("[data-tab]:not(.split)");
  if (!row) return;
  if (selection.has(row.dataset.sel) && selection.size > 1) {
    e.preventDefault();
    showMenu(selectionMenu(), e.clientX, e.clientY, () => schedule(true));
    return;
  }
  browser.menus.overrideContext({ context: "tab", tabId: Number(row.dataset.tab) });
});

document.addEventListener("mousedown", (e) => {
  if (e.button === 1 && e.target.closest(".tab")) e.preventDefault(); // no autoscroll
});

els.today.addEventListener("dblclick", (e) => {
  if (!e.target.closest(".tab")) newTabInSpace();
});

// New Tab opens Arc's command bar in a new tab (see palette/).
els.newTab.addEventListener("click", () => newTabInSpace());

els.clear.addEventListener("click", async () => {
  const ids = state.tabs
    .filter((t) => !state.tabItem.has(t.id) && spaceOf(t) === state.spaceId)
    .map((t) => t.id);
  if (!ids.length) return;
  // Keep the space (and window) alive with a fresh tab.
  await newTabInSpace();
  await browser.tabs.remove(ids);
});

/* ---------- Drag and drop ---------- */

function clearDropMarks() {
  for (const el of document.querySelectorAll(".drop-before, .drop-after, .drop-into, .drag-over")) {
    el.classList.remove("drop-before", "drop-after", "drop-into", "drag-over");
    delete el.dataset.dropDepth;
    el.style.removeProperty("--drop-depth");
  }
}

const accepts = (e) => e.dataTransfer.types.includes(ITEM_MIME) || e.dataTransfer.types.includes(TAB_MIME);

function readTabData(dt) {
  try {
    return JSON.parse(dt.getData(TAB_MIME));
  } catch {
    return null;
  }
}

let dragKind = null; // "item" | "folder" | "tab" for drags started in this sidebar
let dragItemId = null; // the pinned item / folder being dragged, if any

document.addEventListener("dragstart", (e) => {
  const itemEl = e.target.closest?.("[data-item]");
  dragKind = itemEl ? (itemEl.classList.contains("folder") ? "folder" : "item") : "tab";
  dragItemId = itemEl?.dataset.item || null;
  const row = e.target.closest?.("[data-tab]");
  if (itemEl) {
    const tab = state.bound.get(itemEl.dataset.item);
    const found = ArcFox.findItem(localState(), itemEl.dataset.item);
    e.dataTransfer.setData(ITEM_MIME, itemEl.dataset.item);
    if (found) e.dataTransfer.setData("text/uri-list", tab?.url || found.item.url);
    itemEl.classList.add("dragging");
  } else if (row) {
    const tab = tabById(Number(row.dataset.tab));
    e.dataTransfer.setData(TAB_MIME, JSON.stringify({ tabId: Number(row.dataset.tab) }));
    if (tab) e.dataTransfer.setData("text/uri-list", tab.url);
    row.classList.add("dragging");
  } else {
    return;
  }
  e.dataTransfer.effectAllowed = "move";
  dragging = true;
  hideMenu();
});

// Show drop zones (e.g. a hidden favorites area) while an ArcFox drag is over this sidebar.
document.addEventListener("dragenter", (e) => {
  if (accepts(e)) document.body.classList.add("drag-active");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("drag-active");
});
document.addEventListener("drop", () => document.body.classList.remove("drag-active"));

/**
 * A tab dragged out of the browser window and dropped on the desktop becomes
 * its own window, the way dragging a tab off Firefox's tab strip does. The
 * drop landed nowhere (dropEffect "none") and the pointer is outside the
 * window's bounds, which windows.get() reports in screen coordinates — the
 * same ones a drag event carries.
 */
async function detachIfDroppedOutside(e, tabId) {
  if (e.dataTransfer?.dropEffect !== "none") return; // something took the drop
  const win = await browser.windows.get(state.windowId).catch(() => null);
  if (!win || win.state === "fullscreen") return;
  const inside =
    e.screenX >= win.left && e.screenX <= win.left + win.width && e.screenY >= win.top && e.screenY <= win.top + win.height;
  if (inside) return;
  // Esc cancels a drag with the pointer wherever it was; a real drop has moved.
  if (e.screenX === 0 && e.screenY === 0) return;
  await browser.windows.create({ tabId }).catch((err) => console.error("Arc: detaching the tab failed", err));
}

document.addEventListener("dragend", (e) => {
  const row = e.target.closest?.("[data-tab]");
  const tabId = dragKind === "tab" && row ? Number(row.dataset.tab) : null;
  if (tabId !== null) detachIfDroppedOutside(e, tabId);
  dragKind = null;
  dragItemId = null;
  document.body.classList.remove("drag-active");
  dragging = false;
  for (const el of document.querySelectorAll(".dragging")) el.classList.remove("dragging");
  clearDropMarks();
  schedule(true);
});

function onZoneLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) clearDropMarks();
}

/** Mark the row under the pointer as drop-before/after; returns nothing. */
function markRow(e, zone, fallback) {
  clearDropMarks();
  const row = e.target.closest(".tab");
  if (row && zone.contains(row)) {
    const r = row.getBoundingClientRect();
    row.classList.add(e.clientY > r.top + r.height / 2 ? "drop-after" : "drop-before");
  } else if (zone.lastElementChild && zone.tagName === "UL") {
    zone.lastElementChild.classList.add("drop-after");
  } else {
    fallback.classList.add("drag-over");
  }
}

/** Where a drop into the pinned list goes: {before, parent} (folders aware). */
/**
 * A drop after the last row of a folder can land on any level from that row's
 * down to the next row's (top level after the last row): the pointer's x
 * picks it, one level per indent step, and below the list it's the outermost.
 * Stored on the row as data-drop-depth, which also indents the drop line.
 */
function pickDropDepth(e) {
  const mark = els.pinned.querySelector(".drop-after");
  if (!mark) return;
  const depth = Number(mark.dataset.depth || 0);
  const next = mark.nextElementSibling;
  const nextDepth = next ? Number(next.dataset.depth || 0) : 0;
  if (nextDepth >= depth) return; // nothing to climb out of here
  let level = nextDepth;
  if (e.target.closest(".tab") === mark) {
    const indent = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--indent")) || 16;
    const x = e.clientX - mark.getBoundingClientRect().left - 10;
    level = Math.min(depth, Math.max(nextDepth, Math.round(x / indent)));
  }
  mark.dataset.dropDepth = String(level);
  mark.style.setProperty("--drop-depth", level);
}

function pinnedDropTarget() {
  const into = els.pinned.querySelector(".drop-into");
  if (into) return { before: null, parent: into.dataset.item };
  const mark = els.pinned.querySelector(".drop-before, .drop-after");
  if (!mark) return { before: null, parent: null };
  const parent = mark.dataset.parent || null;
  if (mark.classList.contains("drop-before")) return { before: mark.dataset.item, parent };
  const depth = Number(mark.dataset.depth || 0);
  const dropDepth = Number(mark.dataset.dropDepth ?? depth);
  if (dropDepth < depth) {
    // After the last row of a folder, further left: after the folder `depth - dropDepth`
    // levels up, in that folder's own parent.
    let outer = pinById(mark.dataset.item);
    for (let i = dropDepth; i < depth && outer; i++) outer = pinById(outer.parent);
    if (!outer) return { before: null, parent: null };
    const outerParent = outer.parent || null;
    const next = mark.nextElementSibling;
    const sameLevel = next && Number(next.dataset.depth || 0) === dropDepth && (next.dataset.parent || null) === outerParent;
    return { before: sameLevel ? next.dataset.item : null, parent: outerParent };
  }
  // After: the next row at the same level (skipping an open folder's contents).
  let next = mark.nextElementSibling;
  while (next && Number(next.dataset.depth || 0) > depth) next = next.nextElementSibling;
  const sameLevel = next && (next.dataset.parent || null) === parent;
  return { before: sameLevel ? next.dataset.item : null, parent };
}

// Favorites grid.
els.favorites.addEventListener("dragover", (e) => {
  if (!accepts(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  clearDropMarks();
  const tile = e.target.closest(".tile");
  if (tile) {
    const r = tile.getBoundingClientRect();
    const target = e.clientX > r.left + r.width / 2 ? tile.nextElementSibling : tile;
    if (target) target.classList.add("drop-before");
    else els.favorites.classList.add("drag-over");
  } else {
    els.favorites.classList.add("drag-over");
  }
});
els.favorites.addEventListener("dragleave", onZoneLeave);
els.favorites.addEventListener("drop", async (e) => {
  e.preventDefault();
  const before = els.favorites.querySelector(".tile.drop-before")?.dataset.item || null;
  clearDropMarks();
  const itemId = e.dataTransfer.getData(ITEM_MIME);
  if (itemId) await ArcFox.moveItem(itemId, state.favKey, before);
  else {
    const data = readTabData(e.dataTransfer);
    const tab = data && (await browser.tabs.get(data.tabId).catch(() => null));
    if (tab) await ArcFox.addItem(state.favKey, tab, before);
  }
  schedule(true);
});

// Pinned list (and the space header above it).
for (const zone of [els.pinned, els.spaceHead]) {
  zone.addEventListener("dragover", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (zone === els.spaceHead) {
      clearDropMarks();
      els.spaceHead.classList.add("drag-over");
    } else {
      markRow(e, els.pinned, els.spaceHead);
      pickDropDepth(e);
      // Middle of a folder row: drop into the folder (not a folder into itself or its own subfolders).
      const row = e.target.closest(".tab.folder");
      const own =
        row && dragKind === "folder" && (row.dataset.item === dragItemId || ArcFox.descendantIds(state.pins, dragItemId).has(row.dataset.item));
      if (row && !own) {
        const r = row.getBoundingClientRect();
        if (Math.abs(e.clientY - (r.top + r.height / 2)) < r.height * 0.3) {
          clearDropMarks();
          row.classList.add("drop-into");
        }
      }
    }
  });
  zone.addEventListener("dragleave", onZoneLeave);
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    const { before, parent } =
      zone === els.pinned ? pinnedDropTarget() : { before: state.pins[0]?.id || null, parent: null };
    clearDropMarks();
    const key = ArcFox.pinKey(state.spaceId);
    const itemId = e.dataTransfer.getData(ITEM_MIME);
    if (itemId) await ArcFox.moveItem(itemId, key, before, { parent });
    else {
      const data = readTabData(e.dataTransfer);
      const tab = data && (await browser.tabs.get(data.tabId).catch(() => null));
      if (tab) await ArcFox.addItem(key, tab, before, { parent });
    }
    schedule(true);
  });
}

// Today list: reorder tabs, or drag an item out to make it a normal tab.
for (const zone of [els.today, els.newTab]) {
  zone.addEventListener("dragover", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    markRow(e, els.today, els.today);
  });
  zone.addEventListener("dragleave", onZoneLeave);
  zone.addEventListener("drop", onTodayDrop);
}

// The strip above the list (divider, "New Tab · Clear") is part of the list for
// dropping: the mark sits on the first row, and a drop there moves the tab to
// the top. Without this the mark stays on screen while the pointer is over a
// strip that accepts nothing, and the drop is silently refused.
document.querySelector(".divider-row")?.addEventListener("dragover", (e) => {
  if (!accepts(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  clearDropMarks();
  els.today.firstElementChild?.classList.add("drop-before");
});
document.querySelector(".divider-row")?.addEventListener("dragleave", onZoneLeave);
document.querySelector(".divider-row")?.addEventListener("drop", onTodayDrop);

async function onTodayDrop(e) {
  e.preventDefault();
  const mark = els.today.querySelector(".drop-before, .drop-after");
  const after = !!mark?.classList.contains("drop-after");
  const targetId = mark ? Number(after ? mark.dataset.lastTab || mark.dataset.tab : mark.dataset.tab) : null;
  clearDropMarks();

  let tabId = null;
  const itemId = e.dataTransfer.getData(ITEM_MIME);
  if (itemId) {
    const st = await ArcFox.getState();
    const found = ArcFox.findItem(st, itemId);
    const tab = await ArcFox.removeItem(itemId, state.spaceId);
    if (tab) tabId = tab.id;
    else if (found) tabId = (await newTabInSpace(found.item.url)).id;
  } else {
    tabId = readTabData(e.dataTransfer)?.tabId ?? null;
  }
  if (tabId === null) return;

  try {
    const fresh = await browser.tabs.query({ windowId: state.windowId });
    const cur = await browser.tabs.get(tabId);
    const target = targetId !== null && fresh.find((t) => t.id === targetId);
    let index = target ? target.index + (after ? 1 : 0) : fresh.length;
    if (cur.windowId === state.windowId && cur.index < index) index -= 1;
    if (cur.windowId !== state.windowId || cur.index !== index) {
      await browser.tabs.move(tabId, { windowId: state.windowId, index });
    }
    // Tab dragged in from another window's sidebar joins this space.
    if (cur.windowId !== state.windowId) await ArcFox.setTabSpace(tabId, state.spaceId);
  } catch (err) {
    console.error("ArcFox: tab drop failed", err);
  }
  schedule(true);
}

/* ---------- Live updates ---------- */

// The command bar tells the sidebar where a tab is headed the moment Enter is
// pressed: Firefox only reports the new URL once the page commits, which is a
// slow beat to wait for on a cold connection.
const pendingNav = new Map(); // tabId -> { label, at }

function noteNavigation(tabId, label) {
  pendingNav.set(tabId, { label, at: Date.now() });
  setTimeout(() => {
    if (pendingNav.get(tabId)?.at <= Date.now() - 30000) {
      pendingNav.delete(tabId);
      schedule();
    }
  }, 30000);
  schedule();
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "arcfox:changed") schedule(true);
  if (msg?.type === "arcfox:navigating" && msg.tabId !== undefined) noteNavigation(msg.tabId, msg.label);
  if (msg?.type === "arcfox:focus-address" && msg.windowId === state.windowId) {
    browser.storage.session.remove("focusAddress");
    address.focus();
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && ArcFox.BADGES_KEY in changes) schedule();
  if (area !== "local") return;
  const keys = Object.keys(changes);
  // Sizing or the divider's pin changed in another window's sidebar.
  if (keys.includes(SIZING_KEY)) applySizing((sizing = changes[SIZING_KEY].newValue || {}));
  if (keys.includes(TODAY_FLOW)) applyTodayFlow(!!changes[TODAY_FLOW].newValue);
  if (keys.includes(PINNED_HEIGHT)) applyPinnedHeight(changes[PINNED_HEIGHT].newValue);
  const data = keys.some((k) => k === ArcFox.SPACES_KEY || k.startsWith(ArcFox.FAV_KEY) || k.startsWith(ArcFox.PIN_PREFIX));
  if (data) schedule(true);
  else if (keys.includes(ArcFox.ICON_KEY)) schedule();
});

// Firefox creates its blank tab at the end of the list; Arc replaces it with a
// command-bar tab at the top a moment later. Draw it at the top from the start.
const preSwapTabs = new Set();
// Tabs Arc is about to throw away: a Cmd+T while the command bar is open.
const doomedTabs = new Set();

browser.tabs.onCreated.addListener((tab) => {
  // A fresh Cmd+T tab often reports about:blank before its page loads.
  if (tab.openerTabId === undefined && (ArcFox.isFirefoxNewTab(tab.url) || !tab.url || tab.url === "about:blank")) {
    const set = openCommandBar() ? doomedTabs : preSwapTabs;
    set.add(tab.id);
    setTimeout(() => {
      set.delete(tab.id);
      schedule();
    }, 1500);
  }
  schedule(true);
  // Background tags new tabs with a space shortly after creation.
  setTimeout(() => schedule(true), 400);
});

// Right after onRemoved, tabs.query() can still return the closing tab; keep
// it out of the list until Firefox has really dropped it.
const removedTabs = new Set();

browser.tabs.onRemoved.addListener((tabId) => {
  preSwapTabs.delete(tabId);
  doomedTabs.delete(tabId);
  pendingNav.delete(tabId);
  lastIcon.delete(tabId);
  removedTabs.add(tabId);
  setTimeout(() => removedTabs.delete(tabId), 5000);
  state.tabItem.delete(tabId);
  state.tabSpace.delete(tabId);
  // Drop the row now rather than after the refresh below: the page is already
  // gone, and the refresh has storage reads and a tabs.query to get through
  // first, which is long enough to see.
  if (state.windowId !== null && state.tabs.some((t) => t.id === tabId)) {
    state.tabs = state.tabs.filter((t) => t.id !== tabId);
    for (const [itemId, tab] of state.bound) if (tab.id === tabId) state.bound.delete(itemId);
    render();
  }
  schedule();
});
browser.tabs.onUpdated.addListener((tabId, changes) => {
  // The page committed (or went somewhere else): the guess isn't needed.
  if (changes.url !== undefined && !ArcFox.isNewTabUrl(changes.url)) pendingNav.delete(tabId);
  schedule();
}, {
  properties: ["title", "status", "favIconUrl", "pinned", "discarded", "audible", "mutedInfo", "url", "hidden", "splitViewId"],
});
for (const ev of ["onActivated", "onMoved", "onAttached", "onDetached"]) {
  browser.tabs[ev].addListener(() => schedule(ev !== "onMoved"));
}

/** Hold a port so the background page stays awake while the sidebar is open. */
function keepBackgroundAwake() {
  const port = browser.runtime.connect({ name: "arcsidebar:sidebar" });
  // Only an extension reload drops the port; reconnect once it is back.
  port.onDisconnect.addListener(() => setTimeout(keepBackgroundAwake, 1000));
}

(async () => {
  keepBackgroundAwake();
  const win = await browser.windows.getCurrent();
  state.windowId = win.id;
  // Private windows show tabs only — no favorites, pins, folders or spaces.
  state.private = win.incognito;
  document.body.classList.toggle("private", state.private);
  await refresh();
  const { focusAddress } = await browser.storage.session.get("focusAddress");
  if (focusAddress === state.windowId) {
    browser.storage.session.remove("focusAddress");
    address.focus();
  }
})();
