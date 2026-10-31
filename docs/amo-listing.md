# addons.mozilla.org listing

Text for the add-on's page on AMO (Developer Hub → Edit Product Page). AMO doesn't
read the README. The description takes a little Markdown (bold, lists, links, code);
no headings, no images.

The same content, for `web-ext sign --channel=listed`, is in `docs/amo-metadata.json`.
Change both together.

## Name

BookmArc

## Summary

Same text as `"description"` in `manifest.json` (max. 250 characters):

```
Arc-style sidebar for Firefox: spaces from containers, each with its own logins and cookies, bookmarks as pinned tabs, favorites and a command bar.
```

## Description

```markdown
BookmArc brings Arc's sidebar to Firefox: spaces, pinned tabs, favorites and your open tabs in one sidebar, plus a command bar. A bookmark opens in its own tab, and clicking it again goes back to that same tab instead of opening another one.

**Spaces that are really separate, like in Arc**

Every space is a Firefox container, so each one has its own cookies, logins and site data: be signed in to your work and your private accounts at the same time, each in its own space, without them seeing each other. Works best together with **Firefox Multi-Account Containers** ([addons.mozilla.org/firefox/addon/multi-account-containers](https://addons.mozilla.org/firefox/addon/multi-account-containers/)):

- Every container you make there is a space, with its name, color and icon.
- Sites you assign to a container ("Always open in…") open in that space.
- Create, rename, sort and delete spaces there.

Containers are built into Firefox, so spaces work without that add-on too, just as separate: you then manage them in Firefox's settings, without site assignments or sorting.

- Switch with a click on the space's icon in the status bar or `Alt+1` … `Alt+4`; the sidebar slides over, and the window shows only that space's tabs.
- Each space has its own favorites, pinned bookmarks folder, theme color and search engine.
- New tabs open in the current space; links from other apps move into it before they load.
- Drag a tab onto a space's icon, or use *Move to Space*.
- `Cmd/Ctrl+Shift+T` reopens the tab closed last in this space.

**Pinned tabs are your bookmarks**

- Each space shows a bookmarks folder as its pinned tabs (the bookmarks toolbar by default). Pinning, renaming, moving and unpinning in the sidebar change the bookmarks, and changes made in Firefox show up at once.
- Folders, nested as deep as you like, each with an emoji and a background color.
- A collapsed folder keeps its open tabs in view.
- Open tabs are matched to their bookmarks by address.

**Everything else in the sidebar**

- **Favorites** at the top, with unread counts from the page's title (e.g. "(3) Inbox").
- **Search** through bookmarks and tabs: start typing anywhere in the sidebar.
- **Open tabs** below the bookmarks; split views show as one row.
- **Status bar** with the spaces, the number of open tabs and **Close All**.
- **Mini player** for a tab playing sound in the background: go to it, mute or close it.
- Multi-select with Shift- and Cmd/Ctrl-click, menus for tabs, bookmarks and folders.
- A theme color per space, light or dark text, adjustable sizes. Firefox's title bar, toolbar, address bar and menus take the same colors (can be turned off).
- Tabs idle for 45 minutes are unloaded to save memory.

**Command bar**

- `Cmd/Ctrl+T` opens it in a new tab: search, enter an address or switch to an open tab. `Tab` on a site searches inside that site.
- `Cmd/Ctrl+L` opens it with the current tab's address selected; what you pick loads in that tab.

**The full Arc-style layout (optional)**

Extensions can't hide Firefox's tab strip. A small setup script adds a `userChrome.css` to your Firefox profile that hides it (it can come back from the sidebar's menu), shows the page as a card with a rounded corner next to the sidebar, and frees `Cmd/Ctrl+T`, `Cmd/Ctrl+W` and `Cmd/Ctrl+L` for the add-on. The add-on works without it, too. Setup, step by step: [github.com/chokity/BookmArc](https://github.com/chokity/BookmArc#install)

The same script removes the layout again (run with `--uninstall`, on Windows `-Uninstall`) and gives Firefox its shortcuts back. Removing the add-on alone leaves the layout in place, so remove the layout too: [Removing the layout](https://github.com/chokity/BookmArc#removing-the-layout)

**Limits**

Firefox doesn't let extensions draw over a page, so the command bar is a tab of its own. `about:` pages open from Firefox's own address bar. Private windows have no spaces.

**Permissions and privacy**

Containers, hiding tabs and access to all sites are needed for spaces: to show only the current space's tabs and to move a page that opens without a container into the current space before it loads. Your bookmarks stay Firefox bookmarks (synced by Firefox Sync if you use it). Favorites, themes and folder colors are stored locally. BookmArc collects no data.

Not affiliated with or endorsed by The Browser Company. “Arc” is their browser; BookmArc is an independent extension that brings its sidebar ideas to Firefox.
```

## Other fields

- **Categories:** Tabs; Bookmarks
- **License:** MIT
- **Homepage:** https://github.com/chokity/BookmArc
- **Support site:** https://github.com/chokity/BookmArc/issues (Developer Hub only: not in the metadata file)
- **Screenshots:** `docs/BookmArc_screenshot_M.png`
