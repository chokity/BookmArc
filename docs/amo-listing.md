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
Your Firefox bookmarks as an Arc-style sidebar: the bookmarks toolbar as pinned tabs with folders and colors, favorites, your open tabs and a command bar.
```

## Description

```markdown
BookmArc is one sidebar, nothing more: your bookmarks toolbar as pinned tabs, with folders, favorites and your open tabs below. A bookmark opens in its own tab, and clicking it again goes back to that same tab instead of opening another one. No spaces, no extra accounts: one list, the bookmarks you already have.

**Pinned tabs are your bookmarks toolbar**

- Pinning, renaming, moving and unpinning in the sidebar change the bookmarks, and changes made in Firefox show up in the sidebar at once.
- Folders, nested as deep as you like, each with an emoji and a background color.
- A collapsed folder keeps its open tabs in view.
- Open tabs are matched to their bookmarks by address.

**Everything else in the sidebar**

- **Favorites** at the top: drag a tab there.
- **Search** through bookmarks and tabs: start typing anywhere in the sidebar.
- **Open tabs** below the bookmarks; split views show as one row.
- **Status bar** with the number of open tabs and **Close All**.
- Multi-select with Shift- and Cmd/Ctrl-click, menus for tabs, bookmarks and folders.
- A theme color of your own, light or dark text, and adjustable sizes.
- Tabs idle for 45 minutes are unloaded to save memory.

**Command bar**

- `Cmd/Ctrl+T` opens it in a new tab: search, enter an address or switch to an open tab. `Tab` on a site searches inside that site.
- `Cmd/Ctrl+L` opens it with the current tab's address selected; what you pick loads in that tab.

**The full Arc-style layout (optional)**

Extensions can't hide Firefox's tab strip. A small setup script adds a `userChrome.css` to your Firefox profile that hides it, shows the page as a card with a rounded corner next to the sidebar, and frees `Cmd/Ctrl+T`, `Cmd/Ctrl+W` and `Cmd/Ctrl+L` for the add-on. The add-on works without it, too. Setup, step by step: [github.com/chokity/BookmArc](https://github.com/chokity/BookmArc#install)

**Limits**

Firefox doesn't let extensions draw over a page, so the command bar is a tab of its own. `about:` pages open from Firefox's own address bar.

Your bookmarks stay Firefox bookmarks (synced by Firefox Sync if you use it). Favorites, theme and folder colors are stored locally. BookmArc collects no data.

Not affiliated with or endorsed by The Browser Company. “Arc” is their browser; BookmArc is an independent extension that brings its sidebar ideas to Firefox.
```

## Other fields

- **Categories:** Tabs; Bookmarks
- **License:** MIT
- **Homepage:** https://github.com/chokity/BookmArc
- **Support site:** https://github.com/chokity/BookmArc/issues (Developer Hub only: not in the metadata file)
- **Screenshots:** `docs/BookmArc_screenshot_L.png`
