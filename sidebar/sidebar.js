/* Sidebar: favorites, the bookmarks toolbar as pinned tabs (with folders) and the
   window's open tabs. All state lives in storage and bookmarks (shared/store.js)
   and in Firefox's tabs; this page only draws it. */

import { h, setIcon, syncChildren, showMenu, openDialog, pickIcon, inlineRename } from "./ui.js";
import * as store from "../shared/store.js";
import { paintTheme, themeText, firefoxTheme } from "../shared/theme.js";
import { pretty } from "../shared/suggest.js";
import { getBadges, tabMenuFor } from "../shared/badges.js";

const els = {
  favorites: document.getElementById("favorites"),
  spaceHead: document.getElementById("space-head"),
  spaceMore: document.getElementById("space-more"),
  scroll: document.querySelector(".scroll"),
  pinned: document.getElementById("pinned"),
  dividerRow: document.querySelector(".divider-row"),
  dockToday: document.getElementById("dock-today"),
  today: document.getElementById("today"),
  clear: document.getElementById("clear"),
  tabCount: document.getElementById("tab-count"),
  spaces: document.getElementById("spaces"),
  spaceTitle: document.querySelector("#space-head .space-title"),
  closeAll: document.getElementById("close-all"),
  player: document.getElementById("player"),
  newTab: document.getElementById("new-tab"),
  search: document.getElementById("search"),
  searchClear: document.getElementById("search-clear"),
};

const S = {
  windowId: null,
  incognito: false,
  closed: [], // tabs closed in this space, newest first (store.closedTabsOf)
  tabs: [], // the window's tabs in its space (all of them without spaces)
  allTabs: [], // every tab of the window
  spaces: null, // the containers, or null: no spaces (containers off, a private window)
  space: null, // the window's space (one of `spaces`)
  tabSpaces: {}, // tabId -> space, of tabs without a container
  pinRoot: null, // the bookmarks folder the pinned tabs are (the toolbar, or the space's pick)
  rootTitle: "", // its name
  favorites: [], // the space's favorites (all of them without spaces)
  allFavorites: [],
  pins: [], // the bookmarks bar
  bindings: {}, // tabId -> itemId
  theme: {},
  badges: new Map(), // tabId -> badges other extensions put on it
  icons: {}, // itemId -> last favicon seen (Firefox has none for closed pages)
};

// A command bar sent somewhere: Firefox reports the new URL only once the page
// commits, so until then the tab still looks like the (hidden) command bar.
// The bar says where it's going; show the row with that, loading.
const pendingNav = new Map(); // tabId -> label

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "bookmarc:navigating" || !Number.isInteger(msg.tabId)) return;
  pendingNav.set(msg.tabId, msg.label || "Loading…");
  setTimeout(() => pendingNav.delete(msg.tabId) && refresh(), 20000);
  refresh();
});

let themeDraft = null; // {tint} previewed by the theme dialog
let renaming = false; // a title is being edited in place: hold re-renders until it's done
let pendingRename = null; // a folder just created: rename it once its row is drawn
let query = []; // the search field's words, lowercased; empty: no search

const activeTab = () => S.tabs.find((t) => t.active);
const tabById = (id) => S.tabs.find((t) => t.id === id);
const pinById = (id) => S.pins.find((p) => p.id === id);
const tabsOf = (itemId) => S.tabs.filter((t) => S.bindings[t.id] === itemId);
/** The open tab of a favorite / pinned item: the active one, else the most recent. */
const boundTab = (itemId) =>
  tabsOf(itemId).reduce((a, b) => (a && (a.active || (a.lastAccessed || 0) >= (b.lastAccessed || 0)) ? a : b), null);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const isMac = navigator.platform.startsWith("Mac");
const isWebUrl = (url) => /^https?:\/\//i.test(url || "");

/** Tabs that stand for a favorite or a pinned item show there, not among the open tabs. */
function shownElsewhere(tab) {
  const itemId = S.bindings[tab.id];
  return !!itemId && (S.favorites.some((f) => f.id === itemId) || S.pins.some((p) => p.id === itemId));
}

/** An empty tab (Cmd+T, a fresh window): not listed, the "+" above the list stands for it. */
// A tab opened from a link starts as about:blank too: that one is loading, not empty.
const isBlank = (tab) =>
  !pendingNav.has(tab.id) &&
  (store.isNewTabUrl(tab.url) || ((!tab.url || tab.url === "about:blank") && tab.status !== "loading"));

/** "Close Empty Tabs": the window's empty tabs, which the list doesn't show. */
function closeEmptyTabsItem() {
  const empty = S.tabs.filter((t) => isBlank(t) && !t.pinned).map((t) => t.id);
  return {
    label: empty.length > 1 ? `Close ${empty.length} Empty Tabs` : empty.length ? "Close Empty Tab" : "Close Empty Tabs",
    disabled: !empty.length,
    run: () => closeTabs(empty),
  };
}

const todayTabs = () => S.tabs.filter((t) => !t.hidden && !shownElsewhere(t) && !isBlank(t));

/** The pinned item's tab is on another page than the one that was pinned. */
const isMoved = (item, tab) => !!tab && isWebUrl(tab.url) && tab.url !== item.url;

// ---------- Pins tree ----------

const isFolder = (p) => p?.type === "folder";

function parentOf(p, pins = S.pins) {
  return p.parent && pins.some((x) => x.id === p.parent && isFolder(x)) ? p.parent : null;
}

/** ids of `id` and everything inside it. */
function subtree(pins, id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of pins) if (!out.has(p.id) && out.has(parentOf(p, pins))) out.add(p.id), (grew = true);
  }
  return out;
}

/** An entry and everything inside it, in list order (copies, safe to change). */
const blockOf = (pins, id) => {
  const ids = subtree(pins, id);
  return pins.filter((p) => ids.has(p.id)).map((p) => ({ ...p }));
};

/**
 * Move `block` (an entry and its contents, in order) next to `targetId`:
 * where = "before" | "after" | "into" | "end".
 */
function placeBlock(pins, block, targetId, where) {
  const ids = new Set(block.map((p) => p.id));
  const rest = pins.filter((p) => !ids.has(p.id));
  const [head] = block;
  const target = rest.find((p) => p.id === targetId);
  if (!target || where === "end") {
    delete head.parent;
    return [...rest, ...block];
  }
  let index;
  if (where === "before") {
    head.parent = parentOf(target, rest) || undefined;
    index = rest.indexOf(target);
  } else {
    const inside = subtree(rest, target.id);
    index = rest.reduce((last, p, i) => (inside.has(p.id) ? i : last), rest.indexOf(target)) + 1;
    if (where === "into") {
      head.parent = target.id;
      target.open = true;
    } else {
      head.parent = parentOf(target, rest) || undefined;
    }
  }
  if (!head.parent) delete head.parent;
  rest.splice(index, 0, ...block);
  return rest;
}

const savePins = (pins) => store.savePins(pins, S.pinRoot);

/** Save the space's favorites as `list` (in its space); the other spaces' stay as they are. */
function saveFavorites(list) {
  const ids = new Set([...S.favorites, ...list].map((f) => f.id));
  const others = S.allFavorites.filter((f) => !ids.has(f.id));
  return store.saveFavorites([...others, ...(S.space ? list.map((f) => ({ ...f, space: S.space.id })) : list)]);
}
const updatePin = (id, change) => savePins(S.pins.map((p) => (p.id === id ? { ...p, ...change } : p)));

// ---------- Rendering ----------

const SVG = {
  close: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  more: '<circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/>',
  folder:
    '<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  folderOpen:
    '<path d="M2.5 11.5v-7a1 1 0 0 1 1-1h3l1.5 1.5h4a1 1 0 0 1 1 1V7M2.5 11.5 4.3 7.7a1 1 0 0 1 .9-.6h8.6a.6.6 0 0 1 .5.8l-1.6 3.8a1 1 0 0 1-.9.6H3.2a.7.7 0 0 1-.7-.8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
};

/** One of the icons above as an <svg> element (parsed, not innerHTML: the add-on linter flags that). */
function svg(name) {
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${SVG[name]}</svg>`, "image/svg+xml");
  return document.importNode(doc.documentElement, true);
}

/** Lucide icons: 24-grid, 2px round strokes. https://lucide.dev (ISC) */
const LUCIDE = {
  volume:
    "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM16 9a5 5 0 0 1 0 6m3.364 3.364a9 9 0 0 0 0-12.728",
  volumeOff:
    "M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298zm5.5 9.798l5-5m-5 0l5 5",
  // Badge icons other extensions can pick (see BADGE_ICONS in shared/badges.js).
  bot: "M12 8V4H8M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM2 14h2M20 14h2M15 13v2M9 13v2",
  sparkles:
    "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594zM20 2v4M22 4h-4M2 20a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
  // Lucide's "pin" and "pin-off", joined into one path each.
  pin: "M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  pinOff:
    "M12 17v5M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89M2 2l20 20M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11",
};

function lucide(d) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  el.append(path);
  return el;
}

const rows = new Map(); // "t<tabId>" | "i<itemId>" | "h<tabId>" (split half) | "s<splitViewId>" -> element
let drawn = new Set(); // the keys of this render's rows; the rest are dropped after it

function rowFor(key, build) {
  let el = rows.get(key);
  if (!el) rows.set(key, (el = build()));
  drawn.add(key);
  return el;
}

// Firefox clears favIconUrl while a tab navigates, which would swap the icon
// for a letter tile and back on every load. Keep the last one for as long as
// the tab stays on the same site.
const lastIcon = new Map(); // tabId -> { icon, origin }

function iconFor(tab) {
  if (!tab) return null;
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

/** favicon, mute, badges, title, badges, close: the parts fillRow() updates. */
const rowParts = () => [
  h("span", { className: "favicon" }),
  h("button", { className: "icon-btn audio", hidden: true }),
  h("span", { className: "badges start" }),
  h("span", { className: "title" }),
  h("span", { className: "badges" }),
  h("button", { className: "icon-btn close", title: "Close tab" }, svg("close")),
];

function fillRow(el, tab, { title, url, icon }) {
  const [favicon, audio, startBadgesEl, titleEl, badgesEl] = el.children;
  el.classList.toggle("active", !!tab?.active);
  el.classList.toggle("discarded", !!tab?.discarded);
  el.classList.toggle("loading", tab?.status === "loading" && !tab.discarded && !store.isNewTabUrl(url));
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
  const badges = (tab && S.badges.get(tab.id)) || [];
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

/** Indent a pinned row by its folder depth (0 = top level). */
function setLevel(el, depth) {
  el.dataset.depth = String(depth);
  el.classList.toggle("child", depth > 0);
  el.style.setProperty("--depth", depth);
}

function fillTab(el, tab) {
  const pending = pendingNav.get(tab.id);
  const url = pending ? "" : tab.url || "";
  const title = pending || tab.title || (tab.status === "loading" ? "Loading…" : pretty(url)) || "New Tab";
  fillRow(el, tab, { title, url, icon: pending ? null : iconFor(tab) });
  if (pending) el.classList.add("loading");
  return el;
}

function tabRow(tab) {
  return fillTab(rowFor("t" + tab.id, () => h("li", { className: "tab", draggable: true, dataset: { tab: tab.id } }, ...rowParts())), tab);
}

/** Firefox split view: one row, one half per tab (like Arc). Drops before/after it use its first/last tab. */
function splitRow(a, b) {
  const el = rowFor("s" + a.splitViewId, () => h("li", { className: "tab split" }));
  el.dataset.tab = a.id;
  el.dataset.lastTab = b.id;
  el.classList.toggle("active", a.active || b.active);
  const half = (tab) => fillTab(rowFor("h" + tab.id, () => h("span", { className: "half", draggable: true, dataset: { tab: tab.id } }, ...rowParts())), tab);
  syncChildren(el, [half(a), half(b)]);
  return el;
}

// splitViewId is -1 (tabs.SPLIT_VIEW_ID_NONE) when the tab isn't in a Firefox split view.
const inSplit = (tab) => tab.splitViewId !== undefined && tab.splitViewId !== -1;

/** The open-tab rows: a split view's two tabs share one. */
function todayRows(tabs) {
  const out = [];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const next = tabs[i + 1];
    if (inSplit(tab) && next && next.splitViewId === tab.splitViewId) {
      out.push(splitRow(tab, next));
      i++;
    } else out.push(tabRow(tab));
  }
  return out;
}

function itemRow(item, depth) {
  const el = rowFor("i" + item.id, () =>
    h("li", { className: "tab item", draggable: true, dataset: { item: item.id } }, ...rowParts())
  );
  setLevel(el, depth);
  const tab = boundTab(item.id);
  el.classList.toggle("open", !!tab);
  // Once the tab has left the pinned page, the row reads "<icon> / <name>",
  // and clicking the icon goes back to the pinned page. The name stays as it was.
  const moved = isMoved(item, tab);
  el.classList.toggle("moved", moved);
  fillRow(el, tab, {
    title: item.name || item.title || tab?.title || pretty(item.url),
    url: tab?.url || item.url,
    icon: iconFor(tab) || S.icons[item.id],
  });
  el.querySelector(".favicon").title = moved ? `Back to ${item.name || item.title || item.url}` : "";
  el.querySelector(".close").title = "Close tab (stays pinned)";
  return el;
}

/** `open`: shown open (a search opens the folders its hits are in, without saving that). */
function folderRow(folder, depth, open = folder.open) {
  const el = rowFor("i" + folder.id, () =>
    h(
      "li",
      { className: "tab folder", draggable: true, dataset: { item: folder.id } },
      h("span", { className: "folder-icon" }),
      h("span", { className: "title" }),
      h("button", { className: "icon-btn folder-more", title: "Folder options" }, svg("more"))
    )
  );
  setLevel(el, depth);
  const [icon, title] = el.children;
  const kind = folder.icon ? `emoji:${folder.icon}` : open ? "folderOpen" : "folder";
  if (icon.dataset.kind !== kind) {
    icon.dataset.kind = kind;
    icon.replaceChildren(folder.icon ? h("span", { className: "folder-emoji" }, folder.icon) : svg(kind));
  }
  el.classList.toggle("expanded", !!open);
  title.textContent = folder.name;
  el.title = folder.name;
  return el;
}

// ---------- Search ----------

/** Every word of the search is in `text` (title and URL). */
const matches = (...texts) => {
  const hay = texts.filter(Boolean).join(" ").toLowerCase();
  return query.every((w) => hay.includes(w));
};

/**
 * What a search shows of the pinned list: the hits, everything inside a folder
 * whose name is a hit, and the folders around them (shown open). null: no search.
 */
function searchHits() {
  if (!query.length) return null;
  const shown = new Set();
  for (const p of S.pins) {
    const hit = isFolder(p) ? matches(p.name) : matches(p.name, p.title, p.url);
    if (!hit) continue;
    for (const id of isFolder(p) ? subtree(S.pins, p.id) : [p.id]) shown.add(id);
    // ...and the folders it's in.
    for (let up = parentOf(p); up; up = parentOf(pinById(up))) shown.add(up);
  }
  return shown;
}

/**
 * The pinned rows on screen. Like Arc, folding something away keeps its open
 * tabs in view: a collapsed folder lists the pins inside it (at any depth) that
 * have a tab open, right below it; with "Bookmarks" folded, only those pins
 * show at all. A search shows its hits instead, folders opened.
 */
function pinnedRows() {
  const hits = searchHits();
  const out = [];
  /** The pins inside `folderId`, at any depth, that have an open tab, in list order. */
  const openInside = (folderId) => S.pins.filter((p) => !isFolder(p) && p.id !== folderId && subtree(S.pins, folderId).has(p.id) && boundTab(p.id));
  const walk = (parent, depth) => {
    for (const p of S.pins.filter((x) => parentOf(x) === parent)) {
      if (hits && !hits.has(p.id)) continue;
      if (isFolder(p)) {
        const open = hits ? true : p.open;
        out.push(folderRow(p, depth, open));
        if (open) walk(p.id, depth + 1);
        else for (const item of openInside(p.id)) out.push(itemRow(item, depth + 1));
      } else {
        out.push(itemRow(p, depth));
      }
    }
  };
  if (pinsCollapsed && !hits) {
    for (const p of S.pins) if (!isFolder(p) && boundTab(p.id)) out.push(itemRow(p, 0));
  } else walk(null, 0);
  return out;
}

/** The open tabs on screen: all of them, or the search's hits. */
const shownTodayTabs = () => (query.length ? todayTabs().filter((t) => matches(t.title, t.url)) : todayTabs());

// ---------- Folder colors ----------

/**
 * A colored folder gets a rounded area behind its row and every row shown
 * below it (its contents, or its open tabs while collapsed). The areas sit in
 * one layer under the rows, measured from them; a subfolder's own color is an
 * area inside its parent's, inset by its indent.
 */
const areaLayer = h("li", { className: "areas", role: "presentation" });

function layoutAreas() {
  const shown = [...els.pinned.querySelectorAll(".tab")];
  const areas = [];
  shown.forEach((el, i) => {
    const folder = el.classList.contains("folder") && pinById(el.dataset.item);
    if (!folder?.color) return;
    const depth = Number(el.dataset.depth || 0);
    let last = i;
    while (last + 1 < shown.length && Number(shown[last + 1].dataset.depth || 0) > depth) last++;
    const top = el.offsetTop;
    const bottom = shown[last].offsetTop + shown[last].offsetHeight;
    areas.push(
      h("span", {
        className: "area",
        style: { top: `${top}px`, height: `${bottom - top}px`, left: `calc(${depth} * var(--indent))`, "--c": folder.color },
      })
    );
  });
  areaLayer.replaceChildren(...areas);
}

// Row heights change with Sizing, fonts and the panel's width: measure again.
new ResizeObserver(() => layoutAreas()).observe(els.pinned);

const FOLDER_COLORS = ["#f6d2d8", "#fbe3cf", "#f7e7c6", "#dcebd5", "#d9eeeb", "#d6e6f2", "#e3dcf2", "#e8e0d5"];

/** "Set Color…": a swatch, a color of one's own (previewed while picking), or none. */
async function setFolderColor(folder) {
  const before = folder.color || "";
  const preview = (color) => {
    const shown = pinById(folder.id);
    if (shown) shown.color = color;
    layoutAreas();
  };
  const result = await openDialog((close) =>
    h(
      "form",
      { className: "dialog-card", onsubmit: (e) => e.preventDefault() },
      h("h2", {}, "Folder Color"),
      h(
        "div",
        { className: "color-grid" },
        FOLDER_COLORS.map((c) =>
          h("button", {
            type: "button",
            className: `color-swatch${before === c ? " selected" : ""}`,
            title: c,
            style: { "--c": c },
            onclick: () => close(c),
          })
        )
      ),
      h(
        "label",
        { className: "field" },
        "Custom color",
        h("input", {
          type: "color",
          value: before || FOLDER_COLORS[5],
          oninput: (e) => preview(e.target.value),
          onchange: (e) => close(e.target.value),
        })
      ),
      h(
        "div",
        { className: "actions" },
        before && h("button", { type: "button", className: "reset", onclick: () => close("") }, "No Color"),
        h("button", { type: "button", dataset: { cancel: "" }, onclick: () => close(null) }, "Cancel")
      )
    )
  );
  if (result === null || result === before) {
    preview(before);
    return;
  }
  await updatePin(folder.id, { color: result });
}

const tiles = new Map(); // favorite id -> <button>

/**
 * The unread count a page puts in its title: "(3) Inbox", "[3] Chat",
 * "Inbox (3) - Gmail"; "" for none. In the middle only after a name without
 * digits and up to three of them, so "iPhone 15 (2023) - Wikipedia" isn't one.
 */
function unreadCount(title = "") {
  const m = title.match(/^\s*[([](\d+\+?)[)\]]\s|^[^\d()[\]]{1,40}\((\d{1,3}\+?)\)\s+[-–—|·]/);
  const n = m?.[1] || m?.[2] || "";
  if (!n || parseInt(n, 10) === 0) return "";
  return parseInt(n, 10) > 99 ? "99+" : n;
}

function renderFavorites() {
  const nodes = S.favorites.map((fav) => {
    let el = tiles.get(fav.id);
    if (!el) {
      el = h("button", { className: "tile", draggable: true, dataset: { item: fav.id } }, h("span", { className: "icon" }), h("span", { className: "unread", hidden: true }));
      tiles.set(fav.id, el);
    }
    const tab = boundTab(fav.id);
    const unread = unreadCount(tab?.title);
    el.lastChild.hidden = !unread;
    if (el.lastChild.textContent !== unread) el.lastChild.textContent = unread;
    el.classList.toggle("open", !!tab);
    el.classList.toggle("active", !!tab?.active);
    el.title = tab?.title || fav.title;
    setIcon(el.firstChild, iconFor(tab) || S.icons[fav.id], fav.url);
    return el;
  });
  for (const id of tiles.keys()) if (!S.favorites.some((f) => f.id === id)) tiles.delete(id);
  const empty = nodes.length === 0;
  els.favorites.classList.toggle("empty", empty);
  els.favorites.classList.toggle("collapsed", empty);
  syncChildren(els.favorites, empty ? [h("span", { className: "fav-drop-text" }, "Drop here to add a favorite")] : nodes);
}

function render() {
  if (renaming) return; // refresh() runs again when the rename ends
  // While the theme dialog is open it paints its own preview.
  if (!themeDraft) {
    paintTheme(S.theme);
    paintFirefox();
  }
  const pinned = pinnedRows();
  syncChildren(els.pinned, [areaLayer, ...pinned]);
  layoutAreas();
  const today = shownTodayTabs();
  syncChildren(els.today, todayRows(today));
  document.body.classList.toggle("searching", query.length > 0);
  document.body.classList.toggle("no-hits", query.length > 0 && !pinned.length && !today.length);
  const live = new Set([...S.tabs.map((t) => "t" + t.id), ...S.pins.map((p) => "i" + p.id)]);
  for (const key of rows.keys()) if (!drawn.has(key)) rows.delete(key);
  drawn = new Set();
  for (const key of selection) if (!live.has(key)) selection.delete(key);
  applySelection();
  renderFavorites();
  renderStatus();
  renderSpaces();
  renderPlayer();
  document.body.classList.toggle("pins-collapsed", pinsCollapsed);
  document.body.classList.remove("booting");
  if (pendingRename && rows.has("i" + pendingRename)) {
    const id = pendingRename;
    pendingRename = null;
    startRename(id);
  }
}

const spaceButtons = new Map(); // space id -> <button>

/** The status bar's space icons (none without spaces), and the space's name over the pinned list. */
function renderSpaces() {
  els.spaceTitle.textContent = S.space?.name || (S.pinRoot === "toolbar_____" ? "Bookmarks" : S.rootTitle);
  els.spaceHead.title = `${S.rootTitle} · click to show or hide`;
  els.closeAll.title = S.space ? `Close all tabs in ${S.space.name}` : "Close all tabs in this window";
  els.spaces.hidden = !S.space;
  if (!S.space) return;
  const nodes = S.spaces.map((space) => {
    let el = spaceButtons.get(space.id);
    if (!el) spaceButtons.set(space.id, (el = h("button", { type: "button", className: "space-btn", dataset: { space: space.id } }, h("span", { className: "space-icon" }))));
    const active = space.id === S.space.id;
    el.classList.toggle("active", active);
    el.setAttribute("aria-pressed", String(active));
    el.title = space.name;
    el.setAttribute("aria-label", space.name);
    el.firstChild.style.setProperty("--space-icon", `url("${space.iconUrl}")`);
    el.firstChild.style.setProperty("--space-color", space.colorCode);
    return el;
  });
  for (const id of spaceButtons.keys()) if (!S.spaces.some((s) => s.id === id)) spaceButtons.delete(id);
  syncChildren(els.spaces, nodes);
}

/** The window's open tabs, as the status bar counts them: empty ones don't count, as in the list. */
const openTabs = () => S.tabs.filter((t) => !t.hidden && !isBlank(t));

/** The status bar: how many tabs the window has open. */
function renderStatus() {
  const open = openTabs();
  const pinned = open.filter(shownElsewhere).length;
  els.tabCount.textContent = plural(open.length, "tab") + (pinned ? ` · ${pinned} pinned` : "");
  if (!closeAllArmed) els.closeAll.disabled = !open.length;
}

// ---------- Mini player ----------

const PLAYER_MAX = 3;
let miniPlayer = true; // tabs playing sound show over the status bar
const playerRows = new Map(); // tab id -> row

/**
 * Tabs of this window playing sound (muted ones too), in any space, other than
 * the one in front: a row each, to mute, close or go to them.
 */
function renderPlayer() {
  const playing = miniPlayer ? S.allTabs.filter((t) => t.audible && !t.active).slice(0, PLAYER_MAX) : [];
  for (const id of playerRows.keys()) if (!playing.some((t) => t.id === id)) playerRows.delete(id);
  syncChildren(els.player, playing.map(playerRow));
  els.player.hidden = !playing.length;
}

function playerRow(tab) {
  let row = playerRows.get(tab.id);
  if (!row) {
    row = h(
      "div",
      { className: "player-row", dataset: { tab: tab.id } },
      h("span", { className: "favicon" }),
      h("span", { className: "player-text" }, h("span", { className: "player-title" }), h("span", { className: "player-sub" })),
      h("button", { type: "button", className: "icon-btn player-mute" }),
      h("button", { type: "button", className: "icon-btn close", title: "Close tab" }, svg("close"))
    );
    playerRows.set(tab.id, row);
  }
  const [favicon, text, mute] = row.children;
  setIcon(favicon, iconFor(tab), tab.url);
  const title = tab.title || pretty(tab.url);
  text.firstChild.textContent = title;
  // Where it plays: the site, and the space when it's another one.
  const space = S.space && S.spaces?.find((s) => s.id === spaceOfTab(tab));
  text.lastChild.textContent = [pretty(tab.url), space && space !== S.space && space.name].filter(Boolean).join(" · ");
  row.title = `${title}\nClick to go to the tab`;
  const muted = !!tab.mutedInfo?.muted;
  if (mute.dataset.state !== String(muted)) {
    mute.dataset.state = String(muted);
    mute.replaceChildren(lucide(muted ? LUCIDE.volumeOff : LUCIDE.volume));
  }
  mute.title = muted ? "Unmute tab" : "Mute tab";
  return row;
}

els.player.addEventListener("click", (e) => {
  const row = e.target.closest(".player-row");
  const tab = row && S.allTabs.find((t) => t.id === Number(row.dataset.tab));
  if (!tab) return;
  if (e.target.closest(".player-mute")) browser.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
  else if (e.target.closest(".close")) closeTabs([tab.id]);
  // A tab of another space takes the window there (the background page follows it).
  else browser.tabs.update(tab.id, { active: true });
});

// ---------- Loading ----------

let loading = null;
let again = false;

async function load() {
  const [allTabs, allFavorites, bindings, badges, icons, allSpaces, spaceId, tabSpaces] = await Promise.all([
    browser.tabs.query({ windowId: S.windowId }),
    store.getFavorites(),
    store.getBindings(),
    getBadges(),
    store.getIconCache(),
    S.incognito ? null : store.getSpaces(),
    store.getWindowSpace(S.windowId),
    store.getTabSpaces(),
  ]);
  const spaces = allSpaces?.length ? allSpaces : null;
  // Until the background page has given the window its space, it shows everything.
  const space = spaces?.find((s) => s.id === spaceId) || null;
  const [theme, pinRoot] = await Promise.all([store.getTheme(space), store.getPinRoot(space)]);
  const [pins, [rootNode]] = await Promise.all([store.getPins(pinRoot), browser.bookmarks.get(pinRoot).catch(() => [])]);
  const rootTitle = rootNode?.title || "Bookmarks";
  const closed = await store.closedTabsOf(space?.id || null);
  // A command bar that has arrived somewhere is an ordinary tab again.
  for (const tab of allTabs) if (pendingNav.has(tab.id) && tab.url && !store.isNewTabUrl(tab.url) && tab.url !== "about:blank") pendingNav.delete(tab.id);
  const tabs = space ? allTabs.filter((t) => spaceOfTab(t, spaces, space, tabSpaces) === space.id) : allTabs;
  const favorites = store.favoritesOf(allFavorites, space, spaces);
  // Another space: the old one's picture slides off while the new one slides in.
  const from = S.space && space && S.space.id !== space.id ? S.spaces?.findIndex((s) => s.id === S.space.id) : -1;
  const ghost = from >= 0 ? swipeGhost() : null;
  Object.assign(S, { tabs, allTabs, favorites, allFavorites, pins, bindings, theme, badges, icons, spaces, space, tabSpaces, pinRoot, rootTitle, closed });
  render();
  if (ghost) swipe(ghost, spaces.findIndex((s) => s.id === space.id) > from ? 1 : -1);
}

// ---------- Space switch animation ----------

const SWIPE_MS = 300;
let swiping = []; // the running switch's animations

/** What the panel shows above the mini player and the status bar. */
const swipeParts = () => [els.search.closest(".search"), els.favorites, els.spaceHead, els.scroll];

/**
 * A still copy of the panel above the status bar, in its colors and laid out
 * as it is, to slide off over the new space; null when motion is turned down.
 */
function swipeGhost() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  for (const animation of swiping) animation.finish();
  const body = getComputedStyle(document.body);
  const ghost = h("div", { className: "swipe-ghost", "aria-hidden": "true" });
  Object.assign(ghost.style, {
    // Down to the mini player (the same in every space) or the status bar.
    height: `${(els.player.hidden ? document.querySelector(".status-bar") : els.player).getBoundingClientRect().top}px`,
    padding: body.padding,
    gap: body.gap,
    background: body.backgroundColor,
  });
  for (const part of swipeParts()) {
    const copy = part.cloneNode(true);
    copy.style.height = `${part.offsetHeight}px`;
    copy.style.flex = "none";
    for (const el of [copy, ...copy.querySelectorAll("[id]")]) el.removeAttribute("id");
    ghost.append(copy);
  }
  document.body.append(ghost);
  // What a copy doesn't carry: the scroll position and the search text.
  ghost.querySelector(".scroll").scrollTop = els.scroll.scrollTop;
  ghost.querySelector("input").value = els.search.value;
  return ghost;
}

/** Slide `ghost` off and the new space in; `dir` 1 when it is to the right of the old one. */
function swipe(ghost, dir) {
  const timing = { duration: SWIPE_MS, easing: "cubic-bezier(0.25, 0.8, 0.25, 1)" };
  const out = ghost.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-dir * 100}%)` }], timing);
  swiping = [out, ...swipeParts().map((part) => part.animate([{ transform: `translateX(${dir * 100}%)` }, { transform: "translateX(0)" }], timing))];
  out.finished.catch(() => {}).finally(() => ghost.remove());
}

/** A tab's space; one whose space is unknown (gone, not given yet) counts as the window's, as in the background page. */
function spaceOfTab(tab, spaces = S.spaces, space = S.space, tabSpaces = S.tabSpaces) {
  const id = store.spaceOf(tab, tabSpaces);
  return spaces.some((s) => s.id === id) ? id : space.id;
}

/** Reload everything, coalescing bursts of events into one pass. (A timer, not
    requestAnimationFrame: that pauses while the panel is covered.) */
function refresh() {
  if (loading) {
    again = true;
    return;
  }
  loading = new Promise((r) => setTimeout(r, 16))
    .then(load)
    .catch((err) => console.error("BookmArc: refresh failed", err))
    .finally(() => {
      loading = null;
      if (again) {
        again = false;
        refresh();
      }
    });
}

// ---------- Actions ----------

/** New tabs open in the space's container (nothing without spaces). */
const spaceProps = () => (S.space ? { cookieStoreId: S.space.id } : {});

/** The container `url` opens in: the one Multi-Account Containers assigned it to, else the space's. */
async function containerFor(url) {
  if (!S.space) return {};
  return { cookieStoreId: (await store.assignedSpace(url, S.spaces)) || S.space.id };
}

/**
 * Open (or switch to) a favorite or pinned item, in this space. A site that
 * Multi-Account Containers assigned to another container opens in that
 * space (its tab there, if it has one), and the window follows it.
 */
async function openItem(item) {
  const tab = boundTab(item.id);
  if (tab) {
    await browser.tabs.update(tab.id, { active: true });
    return;
  }
  const props = await containerFor(item.url);
  const there =
    props.cookieStoreId && props.cookieStoreId !== S.space.id
      ? S.allTabs.find((t) => S.bindings[t.id] === item.id && t.cookieStoreId === props.cookieStoreId)
      : null;
  if (there) {
    await browser.tabs.update(there.id, { active: true });
    return;
  }
  const created = await browser.tabs.create({ windowId: S.windowId, url: item.url, active: true, ...props });
  await store.bind(created.id, item.id);
}

/** A plain tab on `url`. Firefox reports a new tab as about:blank until it starts loading;
    the background page is told so it doesn't take it for a spare Cmd+T tab. */
async function openInNewTab(url) {
  const tab = await browser.tabs.create({ windowId: S.windowId, url, active: true, ...(await containerFor(url)) });
  browser.runtime.sendMessage({ type: "keep-tab", tabId: tab.id }).catch(() => {});
  return tab;
}

const openCommandBar = () => browser.runtime.sendMessage({ type: "command-bar", windowId: S.windowId });

async function addFavorite(tab) {
  if (!tab?.url || S.favorites.some((f) => f.url === tab.url)) return;
  const fav = { id: store.uid(), url: tab.url, title: tab.title || tab.url };
  await saveFavorites([...S.favorites, fav]);
  await store.bind(tab.id, fav.id);
}

/** Pin a tab (a new bookmark in the toolbar), at `targetId`/`where` in the list. */
async function pinTab(tab, targetId = null, where = "end") {
  if (!tab?.url) return;
  const item = { id: store.uid(), url: tab.url, title: tab.title || tab.url };
  await savePins(placeBlock(S.pins, [item], targetId, where));
  await store.bind(tab.id, item.id);
}

/** Remove pinned entries (and what's inside them): their bookmarks go, their open tabs stay. */
async function unpin(itemIds) {
  const ids = new Set(itemIds.flatMap((id) => [...subtree(S.pins, id)]));
  await store.unbindItems([...ids]);
  await savePins(S.pins.filter((p) => !ids.has(p.id)));
}

async function removeFavorite(favId) {
  await store.unbindItems([favId]);
  await saveFavorites(S.favorites.filter((f) => f.id !== favId));
}

/** A pinned item becomes a favorite (same id: its open tab stays bound). */
async function pinToFavorite(item, beforeId = null) {
  const fav = { id: item.id, url: item.url, title: item.name || item.title };
  const list = S.favorites.filter((f) => f.id !== item.id);
  const at = beforeId ? list.findIndex((f) => f.id === beforeId) : -1;
  list.splice(at >= 0 ? at : list.length, 0, fav);
  await saveFavorites(list);
  await savePins(S.pins.filter((p) => p.id !== item.id));
}

/** A favorite becomes a pinned item (same id). */
async function favoriteToPin(fav, targetId = null, where = "end") {
  await saveFavorites(S.favorites.filter((f) => f.id !== fav.id));
  await savePins(placeBlock(S.pins, [{ id: fav.id, url: fav.url, title: fav.title }], targetId, where));
}

/** The tab of a favorite / pinned item back on the saved page. */
async function backToSavedUrl(item) {
  const tab = boundTab(item.id);
  if (tab) await browser.tabs.update(tab.id, { url: item.url, active: true });
}

/** Save the item tab's current page as the item's URL. */
async function saveCurrentUrl(item) {
  const tab = boundTab(item.id);
  if (!tab || !isWebUrl(tab.url)) return;
  const change = { url: tab.url, title: tab.title || tab.url };
  if (S.favorites.some((f) => f.id === item.id)) {
    await saveFavorites(S.favorites.map((f) => (f.id === item.id ? { ...f, ...change } : f)));
  } else {
    await updatePin(item.id, change);
  }
}

/** Close tabs; if that takes the one on screen, the most recent other tab takes over (or a fresh one). */
async function closeTabs(tabIds) {
  if (!tabIds.length) return;
  if (tabIds.includes(activeTab()?.id)) {
    const rest = S.tabs.filter((t) => !tabIds.includes(t.id));
    if (rest.length) {
      const last = rest.reduce((a, b) => ((b.lastAccessed || 0) > (a.lastAccessed || 0) ? b : a));
      await browser.tabs.update(last.id, { active: true });
    } else {
      await browser.tabs.create({ windowId: S.windowId, active: true, ...spaceProps() });
    }
  }
  await browser.tabs.remove(tabIds);
}

/**
 * A new folder, renamed in place right away. With entries (pinned items or
 * folders) and/or tabs, they go into it, where the first entry was.
 */
async function newFolder({ parentId = null, pinIds = [], tabs = [] } = {}) {
  const folder = { id: store.uid(), type: "folder", name: "New Folder", open: true };
  let pins = S.pins.map((p) => ({ ...p }));
  const first = pins.find((p) => pinIds.includes(p.id));
  if (first) pins = placeBlock(pins, [folder], first.id, "before");
  else pins = placeBlock(pins, [folder], parentId, parentId ? "into" : "end");
  // Only the outermost picked entries move; what's inside them comes along.
  const roots = pinIds.filter((id) => !pinIds.some((other) => other !== id && subtree(pins, other).has(id)));
  for (const id of roots) pins = placeBlock(pins, blockOf(pins, id), folder.id, "into");
  const items = tabs.filter((t) => t.url).map((t) => ({ tab: t, item: { id: store.uid(), url: t.url, title: t.title || t.url } }));
  for (const { item } of items) pins = placeBlock(pins, [item], folder.id, "into");
  pendingRename = folder.id;
  await savePins(pins);
  for (const { tab, item } of items) await store.bind(tab.id, item.id);
}

/** Take an entry out of its folder: right after that folder, one level up. */
async function removeFromFolder(itemId) {
  const entry = pinById(itemId);
  const parent = entry && parentOf(entry);
  if (parent) await savePins(placeBlock(S.pins, blockOf(S.pins, itemId), parent, "after"));
}

/** Delete a folder. keepItems: its contents move up a level ("Ungroup"); else they go too. */
async function deleteFolder(folderId, { keepItems }) {
  const folder = pinById(folderId);
  if (!keepItems) return unpin([folderId]);
  const pins = S.pins
    .filter((p) => p.id !== folderId)
    .map((p) => (p.parent === folderId ? { ...p, parent: folder.parent } : p));
  for (const p of pins) if (!p.parent) delete p.parent;
  await savePins(pins);
}

/** Open every pinned item inside a folder that isn't open yet. */
async function openFolderItems(folderId) {
  const items = S.pins.filter((p) => !isFolder(p) && subtree(S.pins, folderId).has(p.id) && p.id !== folderId);
  for (const item of items) {
    if (boundTab(item.id)) continue;
    const tab = await browser.tabs.create({ windowId: S.windowId, url: item.url, active: false, ...(await containerFor(item.url)) });
    await store.bind(tab.id, item.id);
  }
}

/** Rename a pinned row in place: the bookmark's (or bookmark folder's) name. */
function startRename(itemId) {
  const entry = pinById(itemId);
  const title = rows.get("i" + itemId)?.querySelector(".title");
  if (!entry || !title) return;
  renaming = true;
  inlineRename(title, isFolder(entry) ? entry.name : title.textContent, async (name) => {
    renaming = false;
    if (name && name !== title.textContent) await updatePin(itemId, isFolder(entry) ? { name } : { name, title: name });
    refresh();
  });
}

async function changeFolderIcon(folder) {
  const icon = await pickIcon(folder.icon);
  if (icon === null || icon === (folder.icon || "")) return;
  await updatePin(folder.id, { icon });
}

/** "Bookmarks Folder…": the bookmarks folder this space shows as its pinned tabs. */
async function chooseBookmarksFolder() {
  const [tree] = await browser.bookmarks.getTree();
  const folders = [];
  const walk = (node, depth) => {
    for (const child of node.children || []) {
      if (child.url || child.type === "separator") continue;
      folders.push({ id: child.id, title: child.title || "Folder", depth });
      walk(child, depth + 1);
    }
  };
  walk(tree, 0);
  const result = await openDialog((close) =>
    h(
      "form",
      { className: "dialog-card folder-pick-card", onsubmit: (e) => e.preventDefault() },
      h("h2", {}, S.space ? `Pinned Tabs of ${S.space.name}` : "Pinned Tabs"),
      h("p", { className: "dialog-note" }, "The bookmarks folder to show, with its folders."),
      h(
        "div",
        { className: "folder-pick" },
        folders.map((f) =>
          h(
            "button",
            {
              type: "button",
              className: `folder-pick-row${f.id === S.pinRoot ? " selected" : ""}`,
              style: { "--depth": f.depth },
              onclick: () => close(f.id),
            },
            svg("folder"),
            h("span", { className: "title" }, f.title)
          )
        )
      ),
      h(
        "div",
        { className: "actions" },
        h("button", { type: "button", className: "reset", onclick: () => close("") }, "Bookmarks Toolbar"),
        h("button", { type: "button", dataset: { cancel: "" }, onclick: () => close(null) }, "Cancel")
      )
    )
  );
  if (result === null || result === S.pinRoot) return;
  await store.savePinRoot(S.space, result || null);
}

/** Theme dialog: any color, covering the panel. */
async function editThemeColor() {
  const theme = S.theme;
  themeDraft = { tint: store.themeColor(theme) };
  const preview = () => (paintTheme({ ...theme, ...themeDraft }), paintFirefox());
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
    return h(
      "form",
      { className: "dialog-card theme-card", onsubmit: (e) => (e.preventDefault(), close("save")) },
      h("h2", {}, "Theme Color"),
      h("label", { className: "field" }, "Color", h("span", { className: "row" }, color, hexField)),
      h(
        "div",
        { className: "actions" },
        (theme.tint || theme.text) &&
          h("button", { type: "button", className: "reset", onclick: () => close("reset") }, "Reset"),
        h("button", { type: "button", dataset: { cancel: "" }, onclick: () => close(null) }, "Cancel"),
        h("button", { type: "submit", className: "primary" }, "Save")
      )
    );
  });
  const draft = themeDraft;
  themeDraft = null;
  if (result === "save") {
    const { intensity, ...rest } = theme; // from before colors always covered fully
    await store.saveTheme({ ...rest, tint: draft.tint }, S.space);
  }
  // A space goes back to its container's color.
  else if (result === "reset") await store.saveTheme(S.space ? null : {}, S.space);
  else {
    paintTheme(S.theme);
    paintFirefox();
  }
}

async function copy(text) {
  await navigator.clipboard.writeText(text).catch(() => {});
}

// ---------- Sizing (font, row height, spacing, indent, folder icon) ----------

const SIZING_KEY = "sidebarSizing"; // storage.local: {font, height, gap, indent, icon} in px, all panels
const SIZING = [
  // [key, label, CSS variable, min, max, the default (as in sidebar.css)]
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

/** "Sizing" dialog: a slider per size, previewed live; Save keeps it for every panel. */
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
        h("button", { type: "button", className: "reset", onclick: () => close("reset") }, "Defaults"),
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

// ---------- Divider: dock the open tabs, resize the pinned list ----------

const TODAY_FLOW = "todayFlow"; // storage.local: true = open tabs follow the whole pinned list
const PINNED_HEIGHT = "pinnedHeight"; // storage.local: px the pinned list may take while docked
const PINS_COLLAPSED = "pinsCollapsed"; // storage.local: the pinned list is folded away

/**
 * The divider's pin. Docked (default): the pinned list scrolls on its own so
 * the open tabs keep their place in view. Not docked: they sit below the
 * whole pinned list and the panel scrolls.
 */
function applyTodayFlow(flow) {
  document.body.classList.toggle("today-flow", flow);
  els.dockToday.replaceChildren(lucide(flow ? LUCIDE.pinOff : LUCIDE.pin));
  els.dockToday.title = flow ? "Keep open tabs in view (pinned tabs scroll on their own)" : "Let open tabs follow all pinned tabs";
  els.dockToday.setAttribute("aria-pressed", String(!flow));
}

function applyPinnedHeight(px) {
  if (Number.isFinite(px)) document.documentElement.style.setProperty("--pinned-height", `${px}px`);
  else document.documentElement.style.removeProperty("--pinned-height");
}

els.dockToday.addEventListener("click", () => {
  const flow = !document.body.classList.contains("today-flow");
  applyTodayFlow(flow);
  browser.storage.local.set({ [TODAY_FLOW]: flow });
});

/**
 * While docked, dragging the divider moves where the pinned list ends (it
 * scrolls on its own above). It stops at the list's full length and leaves
 * room for a few open tabs. Double-click: back to the default.
 */
{
  const row = els.dividerRow;
  const canResize = () => !document.body.classList.contains("today-flow") && !document.body.classList.contains("pins-collapsed");
  row.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button") || !canResize()) return;
    e.preventDefault();
    const pinned = els.pinned;
    const startY = e.clientY;
    const startH = pinned.getBoundingClientRect().height;
    const most = () => Math.min(pinned.scrollHeight, els.scroll.clientHeight - 120);
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

let pinsCollapsed = false;
let tabStrip = false; // Firefox's tab strip shows (needs BookmArc's userChrome.css)
let colorFirefox = true; // Firefox's own window takes the panel's colors
let firefoxColors; // what Firefox was last given (JSON), so a repaint in the same colors isn't sent again

/**
 * Firefox's window (title bar, toolbar, address bar, menus) in the panel's
 * colors, or back to Firefox's own theme. Private windows keep Firefox's
 * private look.
 */
function paintFirefox() {
  if (S.windowId === null || S.incognito) return;
  const theme = colorFirefox ? firefoxTheme() : null;
  const key = JSON.stringify(theme);
  if (key === firefoxColors) return;
  firefoxColors = key;
  if (theme) browser.theme.update(S.windowId, theme).catch(() => {});
  else browser.theme.reset(S.windowId).catch(() => {});
}

// The system going light / dark repaints the panel (theme.js); Firefox follows.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => paintFirefox());

// Layout preferences shared by every window's panel.
browser.storage.local.get([SIZING_KEY, TODAY_FLOW, PINNED_HEIGHT, PINS_COLLAPSED, store.TAB_STRIP_KEY, store.COLOR_FIREFOX_KEY, store.MINI_PLAYER_KEY]).then((r) => {
  applySizing((sizing = r[SIZING_KEY] || {}));
  applyTodayFlow(!!r[TODAY_FLOW]);
  applyPinnedHeight(r[PINNED_HEIGHT]);
  pinsCollapsed = !!r[PINS_COLLAPSED];
  tabStrip = !!r[store.TAB_STRIP_KEY];
  colorFirefox = r[store.COLOR_FIREFOX_KEY] !== false;
  miniPlayer = r[store.MINI_PLAYER_KEY] !== false;
  // Before the first load there's nothing to draw yet; load() picks the flag up.
  if (!document.body.classList.contains("booting")) render();
});
applyTodayFlow(false);

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (SIZING_KEY in changes) applySizing((sizing = changes[SIZING_KEY].newValue || {}));
  if (TODAY_FLOW in changes) applyTodayFlow(!!changes[TODAY_FLOW].newValue);
  if (PINNED_HEIGHT in changes) applyPinnedHeight(changes[PINNED_HEIGHT].newValue);
  if (store.TAB_STRIP_KEY in changes) tabStrip = !!changes[store.TAB_STRIP_KEY].newValue;
  if (store.MINI_PLAYER_KEY in changes) {
    miniPlayer = changes[store.MINI_PLAYER_KEY].newValue !== false;
    renderPlayer();
  }
  if (store.COLOR_FIREFOX_KEY in changes) {
    colorFirefox = changes[store.COLOR_FIREFOX_KEY].newValue !== false;
    paintFirefox();
  }
  if (PINS_COLLAPSED in changes) {
    pinsCollapsed = !!changes[PINS_COLLAPSED].newValue;
    render();
  }
});

// ---------- Selection (Shift / Cmd-click) ----------

const selection = new Set(); // "i<itemId>" (pinned items, folders) / "t<tabId>" (tabs), as in `rows`
let anchor = null;

const keyOf = (row) => (row.dataset.item ? "i" + row.dataset.item : "t" + row.dataset.tab);

function applySelection() {
  for (const el of rows.values()) if (!el.classList.contains("split")) el.classList.toggle("selected", selection.has(keyOf(el)));
}

/** The row (or split half) an event is on: a pinned item / folder, or a tab. */
const rowAt = (target) => target.closest?.(".half[data-tab], .tab[data-item], .tab[data-tab]:not(.split)");

function clearSelection() {
  if (!selection.size) return;
  selection.clear();
  anchor = null;
  applySelection();
}

/** Shift = range, Cmd (Ctrl elsewhere) = toggle. Returns true if the click was a selection click. */
function handleSelectClick(e, row) {
  const toggle = isMac ? e.metaKey : e.ctrlKey;
  if (!row || (!e.shiftKey && !toggle)) {
    clearSelection();
    return false;
  }
  const key = keyOf(row);
  if (e.shiftKey && anchor) {
    // The range runs over the rows on screen, pinned and open tabs alike.
    const keys = [...els.scroll.querySelectorAll(".tab[data-item], .tab[data-tab]:not(.split), .half[data-tab]")].map(keyOf);
    const a = keys.indexOf(anchor);
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

/** The menu for several selected rows. */
function selectionMenu() {
  const keys = [...selection];
  const pinIds = keys.filter((k) => k[0] === "i").map((k) => k.slice(1)).filter((id) => pinById(id));
  const itemIds = pinIds.filter((id) => !isFolder(pinById(id)));
  const tabs = keys.filter((k) => k[0] === "t").map((k) => tabById(Number(k.slice(1)))).filter(Boolean);
  const links = [...itemIds.map((id) => boundTab(id)?.url || pinById(id)?.url), ...tabs.map((t) => t.url)].filter(Boolean);
  const openTabs = [...itemIds.flatMap((id) => tabsOf(id).map((t) => t.id)), ...tabs.map((t) => t.id)];
  const n = pinIds.length + tabs.length;
  const done = (fn) => async () => {
    await fn();
    clearSelection();
  };
  return [
    links.length && { label: "Copy Links", run: done(() => copy(links.join("\n"))) },
    "-",
    n && { label: `New Folder with ${plural(n, "Item")}`, run: done(() => newFolder({ pinIds, tabs })) },
    moveToSpaceItem(openTabs),
    openTabs.length && { label: `Close ${plural(openTabs.length, "Tab")}`, run: done(() => closeTabs(openTabs)) },
    pinIds.length && {
      label: pinIds.length === 1 ? "Remove Pin" : "Remove Pins",
      danger: true,
      run: done(() => unpin(pinIds)),
    },
  ].filter(Boolean);
}

// ---------- Context menus ----------

/** "Move to Space ▸": the other spaces; the tabs open again in that container. null without other spaces. */
function moveToSpaceItem(tabIds) {
  if (!S.space || S.spaces.length < 2 || !tabIds.length) return null;
  return {
    label: "Move to Space",
    submenu: S.spaces
      .filter((s) => s.id !== S.space.id)
      .map((s) => ({ label: s.name, run: () => browser.runtime.sendMessage({ type: "space:move", tabIds, space: s.id }) })),
  };
}

/** A space icon's menu: how the panel looks, the search engine its command bar uses; close the window's tabs in that space. */
async function spaceMenu(space) {
  const tabs = S.allTabs.filter((t) => !t.pinned && spaceOfTab(t) === space.id).map((t) => t.id);
  const [engines, chosen] = await Promise.all([browser.search.get().catch(() => []), store.getSpaceEngine(space.id)]);
  const current = engines.some((e) => e.name === chosen) ? chosen : null;
  const pick = (name) => store.saveSpaceEngine(space.id, name);
  return [
    ...lookItems(space.id === S.space?.id),
    "-",
    engines.length && {
      label: `Search with ${current || "Firefox's Default"}`,
      submenu: [
        { label: `${current ? "" : "✓ "}Firefox's Default`, run: () => pick(null) },
        "-",
        ...engines.map((e) => ({ label: `${e.name === current ? "✓ " : ""}${e.name}`, run: () => pick(e.name) })),
      ],
    },
    "-",
    {
      label: tabs.length ? `Close ${plural(tabs.length, "Tab")} in ${space.name}` : `No Tabs in ${space.name}`,
      danger: !!tabs.length,
      disabled: !tabs.length,
      run: () => (space.id === S.space.id ? closeTabs(tabs) : browser.tabs.remove(tabs)),
    },
  ].filter(Boolean);
}

/** The tabs closed last in this space, to open again (also Cmd/Ctrl+Shift+T). */
function recentlyClosedItem() {
  const closed = S.closed.slice(0, 10);
  if (!closed.length) return { label: "Recently Closed", disabled: true };
  return { label: "Recently Closed", submenu: closed.map((c) => ({ label: c.title, run: () => store.reopenClosed(c, S.windowId) })) };
}

async function tabMenu(tab) {
  const list = todayTabs();
  const at = list.findIndex((t) => t.id === tab.id);
  const above = list.slice(0, Math.max(0, at));
  const below = list.slice(at + 1);
  const muted = !!tab.mutedInfo?.muted;
  // Items other extensions added (e.g. "Let AI agents control this tab").
  const extra = await tabMenuFor(tab.id).catch(() => []);
  return [
    { label: "Pin", run: () => pinTab(tab) },
    { label: "Add to Favorites", run: () => addFavorite(tab) },
    { label: "New Folder with This Tab", run: () => newFolder({ tabs: [tab] }) },
    "-",
    { label: "Duplicate", run: () => browser.tabs.duplicate(tab.id) },
    { label: "Reload", run: () => browser.tabs.reload(tab.id) },
    { label: muted ? "Unmute Tab" : "Mute Tab", run: () => browser.tabs.update(tab.id, { muted: !muted }) },
    { label: "Copy Link", run: () => copy(tab.url) },
    { label: "Open in New Window", run: () => browser.windows.create({ tabId: tab.id }) },
    moveToSpaceItem([tab.id]),
    ...(extra.length
      ? [
          "-",
          ...extra.map((item) => ({
            label: item.title,
            run: () =>
              browser.runtime.sendMessage(item.extensionId, { type: "bookmarc:menu-clicked", id: item.id, tabId: tab.id }).catch(() => {}),
          })),
        ]
      : []),
    "-",
    closeEmptyTabsItem(),
    { label: above.length ? `Close ${plural(above.length, "Tab")} Above` : "Close Tabs Above", disabled: !above.length, run: () => closeTabs(above.map((t) => t.id)) },
    { label: below.length ? `Close ${plural(below.length, "Tab")} Below` : "Close Tabs Below", disabled: !below.length, run: () => closeTabs(below.map((t) => t.id)) },
    { label: "Close Tab", danger: true, run: () => closeTabs([tab.id]) },
  ].filter(Boolean);
}

/** "Close N Open Tabs" for the tabs of `items` (a folder's pins, the favorites); null if none are open. */
function closeOpenTabsItem(items) {
  const open = items.flatMap((p) => tabsOf(p.id).map((t) => t.id));
  if (!open.length) return null;
  return { label: `Close ${open.length} Open ${open.length === 1 ? "Tab" : "Tabs"}`, run: () => closeTabs(open) };
}

/** What any open tab's menu has: duplicate, reload, mute. Nothing without a tab. */
function openTabActions(tab) {
  if (!tab) return [];
  const muted = !!tab.mutedInfo?.muted;
  return [
    "-",
    { label: "Duplicate", run: () => browser.tabs.duplicate(tab.id) },
    { label: "Reload", run: () => browser.tabs.reload(tab.id) },
    { label: muted ? "Unmute Tab" : "Mute Tab", run: () => browser.tabs.update(tab.id, { muted: !muted }) },
  ];
}

function itemMenu(item) {
  const tab = boundTab(item.id);
  const moved = tab && tab.url !== item.url;
  return [
    { label: "Open in New Tab", run: () => openInNewTab(item.url) },
    moved && { label: "Back to Saved URL", run: () => backToSavedUrl(item) },
    moved && isWebUrl(tab.url) && { label: "Save Current URL", run: () => saveCurrentUrl(item) },
    { label: "Rename", run: () => startRename(item.id) },
    { label: "Copy Link", run: () => copy(item.url) },
    ...openTabActions(tab),
    "-",
    { label: "Move to Favorites", run: () => pinToFavorite(item) },
    { label: "New Folder with This Item", run: () => newFolder({ pinIds: [item.id] }) },
    parentOf(item) && { label: "Remove from Folder", run: () => removeFromFolder(item.id) },
    tab && { label: "Close Tab", run: () => closeTabs(tabsOf(item.id).map((t) => t.id)) },
    { label: "Unpin", danger: true, run: () => unpin([item.id]) },
  ].filter(Boolean);
}

function folderMenu(folder) {
  const inside = [...subtree(S.pins, folder.id)].filter((id) => id !== folder.id);
  const items = inside.map(pinById).filter((p) => p && !isFolder(p));
  const closed = items.filter((p) => !boundTab(p.id));
  const children = S.pins.filter((p) => parentOf(p) === folder.id);
  return [
    { label: "Rename", run: () => startRename(folder.id) },
    { label: "Change Icon…", run: () => changeFolderIcon(folder) },
    { label: "Set Color…", run: () => setFolderColor(folder) },
    closed.length && { label: `Open ${plural(closed.length, "Tab")}`, run: () => openFolderItems(folder.id) },
    // Its pins at any depth, so every folder above an open tab offers this too.
    closeOpenTabsItem(items),
    { label: folder.open ? "Collapse" : "Expand", run: () => updatePin(folder.id, { open: !folder.open }) },
    { label: "New Nested Folder", run: () => newFolder({ parentId: folder.id }) },
    parentOf(folder) && { label: "Remove from Folder", run: () => removeFromFolder(folder.id) },
    "-",
    children.length && { label: "Ungroup", run: () => deleteFolder(folder.id, { keepItems: true }) },
    {
      label: inside.length ? "Delete Folder and Pins" : "Delete Folder",
      danger: true,
      run: () => deleteFolder(folder.id, { keepItems: false }),
    },
  ].filter(Boolean);
}

function favoriteMenu(fav) {
  const tab = boundTab(fav.id);
  const moved = tab && tab.url !== fav.url;
  return [
    { label: "Open in New Tab", run: () => openInNewTab(fav.url) },
    moved && { label: "Back to Saved URL", run: () => backToSavedUrl(fav) },
    moved && isWebUrl(tab.url) && { label: "Save Current URL", run: () => saveCurrentUrl(fav) },
    { label: "Copy Link", run: () => copy(fav.url) },
    ...openTabActions(tab),
    "-",
    { label: "Pin", run: () => favoriteToPin(fav) },
    tab && { label: "Close Tab", run: () => closeTabs(tabsOf(fav.id).map((t) => t.id)) },
    closeOpenTabsItem(S.favorites),
    { label: "Remove from Favorites", danger: true, run: () => removeFavorite(fav.id) },
  ].filter(Boolean);
}

/**
 * How the panel looks: in the space icon's menu, or in the header's without
 * spaces (no icons then). The theme items only for the space shown, whose
 * colors the dialog previews.
 */
function lookItems(withTheme) {
  const text = themeText(S.theme);
  return [
    withTheme && { label: "Edit Theme Color…", run: editThemeColor },
    withTheme && { label: text === "light" ? "Use Dark Text" : "Use Light Text", run: () => store.saveTheme({ ...S.theme, text: text === "light" ? "dark" : "light" }, S.space) },
    { label: "Sizing…", run: editSizing },
    { label: tabStrip ? "Hide Firefox Tab Bar" : "Show Firefox Tab Bar", run: () => store.saveTabStrip(!tabStrip) },
  ].filter(Boolean);
}

/** The header's menu: the panel's own settings. */
function optionsMenu() {
  return [
    { label: "New Folder", run: () => newFolder() },
    // Every pinned tab that's open, in any folder.
    closeOpenTabsItem(S.pins.filter((p) => !isFolder(p))),
    closeEmptyTabsItem(),
    recentlyClosedItem(),
    "-",
    { label: "Bookmarks Folder…", run: chooseBookmarksFolder },
    ...(S.space ? [] : lookItems(true)),
    { label: colorFirefox ? "Keep Firefox's Own Colors" : "Color Firefox Too", run: () => store.saveColorFirefox(!colorFirefox) },
    { label: miniPlayer ? "Hide Mini Player" : "Show Mini Player", run: () => store.saveMiniPlayer(!miniPlayer) },
  ].filter(Boolean);
}

document.addEventListener("contextmenu", async (e) => {
  if (e.target.closest("input")) return;
  e.preventDefault();
  const spaceBtn = e.target.closest(".space-btn");
  if (spaceBtn) {
    const space = S.spaces?.find((s) => s.id === spaceBtn.dataset.space);
    if (space) showMenu(await spaceMenu(space), e.clientX, e.clientY);
    return;
  }
  const row = rowAt(e.target);
  if (row && selection.has(keyOf(row)) && selection.size > 1) {
    showMenu(selectionMenu(), e.clientX, e.clientY);
    return;
  }
  const tabEl = row?.dataset.tab ? row : null;
  const itemEl = e.target.closest("[data-item]");
  let items = null;
  if (tabEl) {
    const tab = tabById(Number(tabEl.dataset.tab));
    if (tab) items = await tabMenu(tab);
  } else if (itemEl?.classList.contains("tile")) {
    const fav = S.favorites.find((f) => f.id === itemEl.dataset.item);
    if (fav) items = favoriteMenu(fav);
  } else if (itemEl) {
    const entry = pinById(itemEl.dataset.item);
    if (entry) items = isFolder(entry) ? folderMenu(entry) : itemMenu(entry);
  } else if (e.target.closest("#space-head, #pinned, #today, .scroll")) items = optionsMenu();
  if (items) showMenu(items, e.clientX, e.clientY);
});

// ---------- Clicks ----------

els.scroll.addEventListener("click", (e) => {
  const more = e.target.closest(".folder-more");
  if (more) {
    const folder = pinById(more.closest(".tab").dataset.item);
    const r = more.getBoundingClientRect();
    if (folder) showMenu(folderMenu(folder), r.left, r.bottom + 4);
    return;
  }
  const row = rowAt(e.target);
  if (handleSelectClick(e, row) || !row) return;
  if (row.dataset.tab) {
    const tab = tabById(Number(row.dataset.tab));
    if (!tab) return;
    if (e.target.closest(".close")) closeTabs([tab.id]);
    else if (e.target.closest(".audio")) browser.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
    else browser.tabs.update(tab.id, { active: true });
    return;
  }
  const entry = pinById(row.dataset.item);
  if (!entry) return;
  const tab = boundTab(entry.id);
  if (isFolder(entry)) updatePin(entry.id, { open: !entry.open });
  else if (e.target.closest(".close")) closeTabs(tabsOf(entry.id).map((t) => t.id));
  else if (e.target.closest(".audio") && tab) browser.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
  // The icon of a tab that moved on: back to the pinned page.
  else if (row.classList.contains("moved") && e.target.closest(".favicon")) backToSavedUrl(entry);
  else openItem(entry);
});

// Middle-click closes a tab (a pinned item stays).
els.scroll.addEventListener("auxclick", (e) => {
  if (e.button !== 1) return;
  const tabEl = e.target.closest(".half[data-tab], .tab[data-tab]:not(.split)");
  const itemEl = e.target.closest(".tab.item[data-item]");
  if (tabEl) closeTabs([Number(tabEl.dataset.tab)]);
  else if (itemEl) closeTabs(tabsOf(itemEl.dataset.item).map((t) => t.id));
});

document.addEventListener("mousedown", (e) => {
  if (e.button === 1 && e.target.closest(".tab")) e.preventDefault(); // no autoscroll
});

// Double-click the empty space below the open tabs: a new tab (the command bar).
els.today.addEventListener("dblclick", (e) => {
  if (!e.target.closest(".tab")) openCommandBar();
});

els.favorites.addEventListener("click", (e) => {
  const fav = S.favorites.find((f) => f.id === e.target.closest(".tile")?.dataset.item);
  if (fav) openItem(fav);
});

els.spaceMore.addEventListener("click", (e) => {
  e.stopPropagation();
  const r = els.spaceMore.getBoundingClientRect();
  showMenu(optionsMenu(), r.left, r.bottom + 4);
});

// Double-click a folder's or pinned item's title: rename it.
els.pinned.addEventListener("dblclick", (e) => {
  const row = e.target.closest(".tab[data-item]");
  if (row && e.target.closest(".title")) startRename(row.dataset.item);
});

// The header folds the pinned list away (remembered for every window).
els.spaceHead.addEventListener("click", () => {
  pinsCollapsed = !pinsCollapsed;
  render();
  browser.storage.local.set({ [PINS_COLLAPSED]: pinsCollapsed });
});

// Empty tabs aren't listed, but they go too.
els.clear.addEventListener("click", () => closeTabs(S.tabs.filter((t) => !shownElsewhere(t) && !t.pinned).map((t) => t.id)));

// "Close All" in the status bar: every tab, pinned ones too. The first click
// only arms it ("Close 12?"); a second one within a few seconds closes them.
let closeAllArmed = null;

function disarmCloseAll() {
  clearTimeout(closeAllArmed);
  closeAllArmed = null;
  els.closeAll.classList.remove("armed");
  els.closeAll.textContent = "Close All";
  renderStatus();
}

els.closeAll.addEventListener("click", async () => {
  // Empty tabs go too, though they aren't counted: the fresh one below replaces them.
  const ids = S.tabs.filter((t) => !t.hidden).map((t) => t.id);
  if (!openTabs().length) return;
  if (!closeAllArmed) {
    els.closeAll.classList.add("armed");
    els.closeAll.textContent = `Close ${openTabs().length}?`;
    closeAllArmed = setTimeout(disarmCloseAll, 3000);
    return;
  }
  disarmCloseAll();
  // A fresh tab first: closing the last one would close the window.
  await browser.tabs.create({ windowId: S.windowId, active: true, ...spaceProps() });
  await browser.tabs.remove(ids);
});
els.closeAll.addEventListener("blur", () => closeAllArmed && disarmCloseAll());

// A space icon: the window goes there (the background page switches, hides and shows).
els.spaces.addEventListener("click", (e) => {
  const id = e.target.closest(".space-btn")?.dataset.space;
  if (id && id !== S.space?.id) browser.runtime.sendMessage({ type: "space:switch", windowId: S.windowId, space: id });
});

/* "New Tab" opens the command bar (the service worker owns it). */
els.newTab.addEventListener("click", openCommandBar);

// ---------- Search field ----------

// The "×" in the field: shown while there's text, empties it.
els.searchClear.addEventListener("click", () => {
  els.search.value = "";
  els.search.dispatchEvent(new Event("input"));
  els.search.focus();
});

els.search.addEventListener("input", () => {
  els.searchClear.hidden = !els.search.value;
  query = els.search.value.toLowerCase().split(/\s+/).filter(Boolean);
  clearSelection();
  render();
});

els.search.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    els.search.value = "";
    els.search.dispatchEvent(new Event("input"));
    els.search.blur();
  } else if (e.key === "Enter" && query.length) {
    // The first hit that isn't a folder: a pinned item, else an open tab.
    e.preventDefault();
    const row = els.scroll.querySelector(".tab.item[data-item], #today .tab[data-tab]");
    if (row?.dataset.item) openItem(pinById(row.dataset.item));
    else if (row) browser.tabs.update(Number(row.dataset.tab), { active: true });
  }
});

// Typing in the panel (outside a field) goes into the search; Cmd/Ctrl+F focuses it.
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea") || !document.getElementById("dialog").hidden) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    els.search.focus();
    els.search.select();
  } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && e.key !== " ") {
    els.search.focus();
  }
});

// ---------- Drag and drop ----------

let drag = null; // { kind: "tab" | "pin" | "fav", id }

document.addEventListener("dragstart", (e) => {
  const tabEl = e.target.closest?.(".half[data-tab], .tab[data-tab]:not(.split)");
  const itemEl = e.target.closest?.("[data-item]");
  if (tabEl) drag = { kind: "tab", id: Number(tabEl.dataset.tab) };
  else if (itemEl) drag = { kind: itemEl.classList.contains("tile") ? "fav" : "pin", id: itemEl.dataset.item };
  else return;
  (tabEl || itemEl).classList.add("dragging");
  document.body.classList.add("drag-active");
  e.dataTransfer.effectAllowed = "move";
  const url = drag.kind === "tab" ? tabById(drag.id)?.url : [...S.pins, ...S.favorites].find((p) => p.id === drag.id)?.url;
  if (url) e.dataTransfer.setData("text/uri-list", url);
  e.dataTransfer.setData("text/plain", url || "");
});

function clearMarks() {
  for (const el of document.querySelectorAll(".drop-before, .drop-after, .drop-into, .drag-over")) {
    el.classList.remove("drop-before", "drop-after", "drop-into", "drag-over");
    el.style.removeProperty("--drop-depth");
  }
}

/** A tab dropped outside the browser window opens in a window of its own. */
async function detachIfDroppedOutside(e, tabId) {
  if (e.dataTransfer.dropEffect !== "none") return;
  // Esc cancels a drag with the pointer wherever it was; a real drop has moved.
  if (e.screenX === 0 && e.screenY === 0) return;
  const win = await browser.windows.get(S.windowId).catch(() => null);
  if (!win || win.state === "fullscreen") return;
  const inside =
    e.screenX >= win.left && e.screenX <= win.left + win.width && e.screenY >= win.top && e.screenY <= win.top + win.height;
  if (inside) return;
  await browser.windows.create({ tabId }).catch((err) => console.error("BookmArc: detaching the tab failed", err));
}

document.addEventListener("dragend", (e) => {
  if (drag?.kind === "tab") detachIfDroppedOutside(e, drag.id);
  drag = null;
  document.body.classList.remove("drag-active");
  for (const el of document.querySelectorAll(".dragging")) el.classList.remove("dragging");
  clearMarks();
});

/** Where a drop over `row` lands: before / after it, or into it (folders, middle half). */
function dropPosition(row, e) {
  const r = row.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  if (row.classList.contains("folder") && y > 0.25 && y < 0.75) return "into";
  return y < 0.5 ? "before" : "after";
}

/**
 * A drop after the last row of a folder can land on any level from that row's
 * down to the next row's (top level after the last row): the pointer's x
 * picks it, one level per indent step. Returns the entry to drop after.
 */
function climbOut(row, e) {
  const depth = Number(row.dataset.depth || 0);
  const next = row.nextElementSibling;
  const nextDepth = next ? Number(next.dataset.depth || 0) : 0;
  if (nextDepth >= depth) return { targetId: row.dataset.item, level: depth };
  const indent = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--indent")) || 16;
  const x = e.clientX - row.getBoundingClientRect().left - 10;
  const level = Math.min(depth, Math.max(nextDepth, Math.round(x / indent)));
  let target = pinById(row.dataset.item);
  for (let i = level; i < depth && target; i++) target = pinById(parentOf(target));
  return { targetId: target?.id || row.dataset.item, level };
}

/** What a drop at `e` would do, or null. */
function dropTarget(e) {
  if (!drag) return null;
  // A tab dropped on another space's icon moves there.
  const spaceBtn = e.target.closest(".space-btn");
  if (spaceBtn) return drag.kind === "tab" && spaceBtn.dataset.space !== S.space?.id ? { zone: "space", el: spaceBtn, space: spaceBtn.dataset.space } : null;
  if (e.target.closest("#favorites")) {
    if (drag.kind === "pin" && isFolder(pinById(drag.id))) return null;
    const tile = e.target.closest(".tile");
    if (!tile) return { zone: "favorites", el: els.favorites, where: "end" };
    // The right half of a tile drops after it, i.e. before the next one.
    const r = tile.getBoundingClientRect();
    const target = e.clientX > r.left + r.width / 2 ? tile.nextElementSibling : tile;
    return target ? { zone: "favorites", el: target, targetId: target.dataset.item, where: "before" } : { zone: "favorites", el: els.favorites, where: "end" };
  }
  if (e.target.closest("#pinned, #space-head")) {
    const row = e.target.closest("#pinned .tab");
    if (!row) return { zone: "pinned", el: els.pinned, where: "end" };
    if (row.dataset.item === drag.id) return null;
    if (drag.kind === "pin" && subtree(S.pins, drag.id).has(row.dataset.item)) return null;
    const where = dropPosition(row, e);
    if (where === "after") {
      const { targetId, level } = climbOut(row, e);
      if (drag.kind === "pin" && subtree(S.pins, drag.id).has(targetId)) return null;
      return { zone: "pinned", el: row, targetId, where, level };
    }
    return { zone: "pinned", el: row, targetId: row.dataset.item, where };
  }
  if (e.target.closest("#today, .divider-row, #new-tab")) {
    if (drag.kind === "pin" && isFolder(pinById(drag.id))) return null;
    const row = e.target.closest("#today .tab");
    if (drag.kind === "tab" && row) {
      const where = dropPosition(row, e);
      // After a split view's row means after its second tab.
      const targetTab = Number(where === "after" && row.dataset.lastTab ? row.dataset.lastTab : row.dataset.tab);
      return { zone: "today", el: row, targetTab, where };
    }
    return { zone: "today", el: els.today };
  }
  return null;
}

const MARK = { before: "drop-before", after: "drop-after", into: "drop-into" };

document.addEventListener("dragover", (e) => {
  const target = dropTarget(e);
  clearMarks();
  if (!target) return;
  e.preventDefault();
  target.el.classList.add(MARK[target.where] || "drag-over");
  // The drop line starts at the level the drop lands on.
  if (target.level !== undefined) target.el.style.setProperty("--drop-depth", target.level);
});

document.addEventListener("drop", async (e) => {
  const target = dropTarget(e);
  const source = drag;
  clearMarks();
  if (!target || !source) return;
  e.preventDefault();
  const tab = source.kind === "tab" ? tabById(source.id) : null;
  const pin = source.kind === "pin" ? pinById(source.id) : null;
  const fav = source.kind === "fav" ? S.favorites.find((f) => f.id === source.id) : null;

  if (target.zone === "space") {
    if (tab) await browser.runtime.sendMessage({ type: "space:move", tabIds: [tab.id], space: target.space });
  } else if (target.zone === "favorites") {
    if (tab) await addFavorite(tab);
    if (pin) await pinToFavorite(pin, target.targetId);
    if (fav && target.targetId !== fav.id) {
      const rest = S.favorites.filter((f) => f.id !== fav.id);
      const at = target.targetId ? rest.findIndex((f) => f.id === target.targetId) : -1;
      rest.splice(at >= 0 ? at : rest.length, 0, fav);
      await saveFavorites(rest);
    }
  } else if (target.zone === "pinned") {
    if (tab) await pinTab(tab, target.targetId, target.where);
    if (pin) await savePins(placeBlock(S.pins, blockOf(S.pins, pin.id), target.targetId, target.where));
    if (fav) await favoriteToPin(fav, target.targetId, target.where);
  } else if (target.zone === "today") {
    if (tab && target.targetTab && target.targetTab !== tab.id) {
      const other = tabById(target.targetTab);
      const index = other.index + (target.where === "after" ? 1 : 0) - (tab.index < other.index ? 1 : 0);
      await browser.tabs.move(tab.id, { index });
    }
    if (pin) await unpin([pin.id]);
    if (fav) await removeFavorite(fav.id);
  }
});

// ---------- Startup ----------

for (const event of [
  browser.tabs.onCreated,
  browser.tabs.onRemoved,
  browser.tabs.onUpdated,
  browser.tabs.onActivated,
  browser.tabs.onMoved,
  browser.tabs.onAttached,
  browser.tabs.onDetached,
  browser.storage.onChanged,
  // The pinned tabs are the bookmarks bar: changes made in Chrome show up here.
  browser.bookmarks.onCreated,
  browser.bookmarks.onRemoved,
  browser.bookmarks.onChanged,
  browser.bookmarks.onMoved,
  // The spaces are the containers: made, renamed or deleted in Multi-Account Containers.
  browser.contextualIdentities?.onCreated,
  browser.contextualIdentities?.onUpdated,
  browser.contextualIdentities?.onRemoved,
]) {
  event?.addListener(refresh);
}

// Firefox's closed tabs don't say which space they were in: note it while the
// tab is still in the list (refresh() reloads it a moment later).
browser.tabs.onRemoved.addListener((tabId, info) => {
  if (info.windowId !== S.windowId || info.isWindowClosing) return;
  const tab = S.allTabs.find((t) => t.id === tabId);
  if (tab) store.rememberClosed(tab, S.space ? spaceOfTab(tab) : null);
});

// The background page goes to sleep when idle; holding a port keeps it awake
// (and Cmd/Ctrl+T quick) while the sidebar is open.
browser.runtime.connect({ name: "sidebar" });

// ?window=<id> shows another window's tabs: lets the sidebar be opened as a page while developing.
const ownWindow = await browser.windows.getCurrent();
S.windowId = Number(new URLSearchParams(location.search).get("window")) || ownWindow.id;
// Private windows have no containers, so no spaces.
S.incognito = (await browser.windows.get(S.windowId).catch(() => ownWindow)).incognito;
// Tabs opened before their bookmark existed (or while the extension was off) join their pinned rows.
await store.adoptAll().catch((err) => console.error("BookmArc: binding open tabs failed", err));
refresh();
