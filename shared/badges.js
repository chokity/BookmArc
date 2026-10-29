/* Tab badges and tab menu items from other extensions (see background.js).
 *
 * storage.session
 *   tabBadges        {extensionId: [{tabId, label, title, color, icon, position, pulse}]}
 *   tabMenus         {extensionId: [{id, title, tabIds, exceptTabIds}]}
 * storage.local
 *   badgeProviders   [extensionId]   extensions that set badges or menu items, told when this extension restarts
 */

const BADGES_KEY = "tabBadges";
const TAB_MENU_KEY = "tabMenus";
const BADGE_PROVIDERS_KEY = "badgeProviders";

const MAX_BADGES = 200; // per extension
const MAX_MENU_ITEMS = 5; // per extension
export const BADGE_ICONS = ["bot", "sparkles"]; // drawn by the panel (Lucide); no outside SVG

/** Plain text, trimmed to `max` characters, or "". */
const text = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) : "");
const tabIdList = (v) => (Array.isArray(v) ? v.filter(Number.isInteger).slice(0, 1000) : null);

// One write at a time: each one reads and rewrites a whole map.
let writes = Promise.resolve();
const queue = (fn) => {
  const write = writes.then(fn);
  writes = write.catch(() => {});
  return write;
};

/** Replace the badges `extensionId` shows on tabs. Only plain text, hex colors and known icon names get through. */
export const setBadges = (extensionId, badges) =>
  queue(async () => {
    const clean = (Array.isArray(badges) ? badges : [])
      .slice(0, MAX_BADGES)
      .filter((b) => Number.isInteger(b?.tabId) && (text(b.label, 12) || BADGE_ICONS.includes(b.icon)))
      .map((b) => ({
        tabId: b.tabId,
        label: text(b.label, 12),
        title: text(b.title, 120),
        color: /^#[0-9a-f]{3,8}$/i.test(b.color || "") ? b.color : "",
        icon: BADGE_ICONS.includes(b.icon) ? b.icon : "",
        position: b.position === "start" ? "start" : "end",
        pulse: b.pulse === true,
      }));
    const { [BADGES_KEY]: all = {} } = await browser.storage.session.get(BADGES_KEY);
    if (clean.length) all[extensionId] = clean;
    else delete all[extensionId];
    await browser.storage.session.set({ [BADGES_KEY]: all });
    await rememberProvider(extensionId);
  });

/** Badges by tab id, from every extension. */
export async function getBadges() {
  const { [BADGES_KEY]: all = {} } = await browser.storage.session.get(BADGES_KEY).catch(() => ({}));
  const byTab = new Map();
  for (const badges of Object.values(all)) {
    for (const b of badges) byTab.set(b.tabId, [...(byTab.get(b.tabId) || []), b]);
  }
  return byTab;
}

/** Replace the tab menu items `extensionId` adds. Titles are plain text. */
export const setTabMenu = (extensionId, items) =>
  queue(async () => {
    const clean = (Array.isArray(items) ? items : [])
      .slice(0, MAX_MENU_ITEMS)
      .filter((m) => /^[\w-]{1,64}$/.test(m?.id || "") && text(m.title, 60))
      .map((m) => ({ id: m.id, title: text(m.title, 60), tabIds: tabIdList(m.tabIds), exceptTabIds: tabIdList(m.exceptTabIds) }));
    const { [TAB_MENU_KEY]: all = {} } = await browser.storage.session.get(TAB_MENU_KEY);
    if (clean.length) all[extensionId] = clean;
    else delete all[extensionId];
    await browser.storage.session.set({ [TAB_MENU_KEY]: all });
    await rememberProvider(extensionId);
  });

/** Menu items other extensions want on `tabId`, as [{extensionId, id, title}]. */
export async function tabMenuFor(tabId) {
  const { [TAB_MENU_KEY]: all = {} } = await browser.storage.session.get(TAB_MENU_KEY).catch(() => ({}));
  const out = [];
  for (const [extensionId, items] of Object.entries(all)) {
    for (const m of items) {
      if (m.tabIds && !m.tabIds.includes(tabId)) continue;
      if (m.exceptTabIds?.includes(tabId)) continue;
      out.push({ extensionId, id: m.id, title: m.title });
    }
  }
  return out;
}

async function rememberProvider(extensionId) {
  const { [BADGE_PROVIDERS_KEY]: providers = [] } = await browser.storage.local.get(BADGE_PROVIDERS_KEY);
  if (!providers.includes(extensionId)) {
    await browser.storage.local.set({ [BADGE_PROVIDERS_KEY]: [...providers, extensionId] });
  }
}

/**
 * Drop the badges and menu items of extensions that are gone (disabled or removed): they can't
 * clear their own. A message to a missing extension fails; one that's there just ignores it.
 */
export async function pruneProviders() {
  const [{ [BADGES_KEY]: badges = {} }, { [TAB_MENU_KEY]: menus = {} }] = await Promise.all([
    browser.storage.session.get(BADGES_KEY).catch(() => ({})),
    browser.storage.session.get(TAB_MENU_KEY).catch(() => ({})),
  ]);
  const ids = new Set([...Object.keys(badges), ...Object.keys(menus)]);
  await Promise.all(
    [...ids].map((id) =>
      browser.runtime.sendMessage(id, { type: "bookmarc:ping" }).catch(() => Promise.all([setBadges(id, []), setTabMenu(id, [])]))
    )
  );
}

/** Badges and menu items live in session storage: ask the extensions that set them before to send them again. */
export async function announceToBadgeProviders() {
  const { [BADGE_PROVIDERS_KEY]: providers = [] } = await browser.storage.local.get(BADGE_PROVIDERS_KEY);
  for (const id of providers) browser.runtime.sendMessage(id, { type: "bookmarc:ready" }).catch(() => {});
}
