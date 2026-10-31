<p align="center">
  <img src="icons/icon.svg" alt="" width="128" height="128">
</p>

<h1 align="center">BookmArc</h1>

<p align="center">An Arc-style sidebar for Firefox: separate spaces, bookmarks as pinned tabs, favorites and a command bar.</p>

BookmArc brings Arc's sidebar to Firefox: spaces, your bookmarks as pinned tabs with folders, favorites and the open tabs below, plus a command bar. A bookmark opens in its own tab, and clicking it again goes back to that same tab instead of opening another one.

**Spaces that are really separate, like in Arc.** Every space is a Firefox container, so each one has its own cookies, logins and site data: be signed in to your work and your private accounts at the same time, each in its own space, without them seeing each other. Each space also has its own favorites, pinned bookmarks folder, theme and search engine. It works best together with [Firefox Multi-Account Containers](https://addons.mozilla.org/firefox/addon/multi-account-containers/): every container made there is a space, sites assigned to a container ("Always open in…") open in that space, and spaces are created, renamed and sorted there. Containers are built into Firefox, so spaces work without that add-on too, just as separate: you then manage them in Firefox's settings (`about:preferences#containers`), without site assignments or sorting.

<p align="center">
  <img src="docs/BookmArc_screenshot_M.png" alt="BookmArc next to a web page shown as a card: the search field, pinned bookmark folders with emoji and background colors (Work, Reading, Travel, Shopping), a collapsed folder keeping its open tab in view, the open tabs below the divider and the status bar with the tab count and Close All" width="400">
</p>

Arc is being discontinued in December 2026, so I moved to Firefox and rebuilt the part of Arc I used most. It started as a fork of [trajche/arc](https://github.com/trajche/arc).

> Not affiliated with or endorsed by The Browser Company. “Arc” is their browser; this is an independent extension that brings its sidebar ideas to Firefox.

## Install

Needs **Firefox 155 or newer** (desktop).

### 1. The add-on

Download the latest `.xpi` from [Releases](https://github.com/chokity/BookmArc/releases) and drag it into a Firefox window (or `about:addons` → ⚙ → *Install Add-on From File…*). New versions are installed the same way; your favorites and settings are kept.

Recommended: install [Firefox Multi-Account Containers](https://addons.mozilla.org/firefox/addon/multi-account-containers/) as well, to create and sort spaces and assign sites to them (see [Features](#features)).

If the original Arcsidebar is installed too, disable it: both would handle `⌘T` and `⌘W`.

If the sidebar doesn't show up, open it once with `⌥⇧A` / `Alt+Shift+A` or *View → Sidebar → BookmArc*. Firefox remembers it from then on.

### 2. The layout (`userChrome.css`)

An extension can't change Firefox's own window: hiding the tab strip and shaping the page takes a user stylesheet, `userChrome.css`, in your Firefox profile. With it:

- Firefox's **tab strip is hidden**; the sidebar lists the tabs. *Show Firefox Tab Bar* in a space icon's menu (right-click; without spaces the menu above the pinned tabs) brings it back.
- Firefox's **toolbar stays on top** (back, forward, reload, address bar, extension buttons), below the native title bar with the window buttons.
- The page sits next to the sidebar as a **card with a rounded corner and a soft shadow**, like Arc.
- The sidebar's **“BookmArc ×” header** is hidden.

#### Option A: setup script (recommended)

Quit Firefox (`⌘Q`), then run the script for your system. It finds the Firefox profile that has this add-on installed (also one outside Firefox's usual folder, through `profiles.ini`) and adds the layout there; your own CSS and prefs in those files are kept (it only manages its own marked block).

**macOS / Linux** (Terminal)
```sh
curl -fsSL https://raw.githubusercontent.com/chokity/BookmArc/main/extras/setup/bookmarc-setup.txt | bash
```

**Windows** (PowerShell)
```powershell
irm https://raw.githubusercontent.com/chokity/BookmArc/main/extras/setup/bookmarc-setup.ps1 | iex
```

If macOS answers "Operation not permitted", give your terminal app Full Disk Access (System Settings → Privacy & Security), open a new terminal window and run it again.

Then start Firefox. Run the script again after updating the add-on, in case the layout changed. To read the scripts first: [`bookmarc-setup.txt`](extras/setup/bookmarc-setup.txt), [`bookmarc-setup.ps1`](extras/setup/bookmarc-setup.ps1). From a clone of this repository, `bash extras/setup/bookmarc-setup.txt` does the same.

To remove the layout again, see [Removing the layout](#removing-the-layout).

What the script changes in the profile:

- `chrome/userChrome.css`: the layout above (from [`extras/userChrome.css`](extras/userChrome.css)).
- `user.js` (from [`extras/user.js`](extras/user.js)):
  - turns `userChrome.css` on (`toolkit.legacyUserProfileCustomizations.stylesheets`)
  - horizontal tabs (`sidebar.verticalTabs = false`; their strip is hidden anyway)
  - the native title bar (`browser.tabs.inTitlebar = 0`), which holds the window buttons once the tab strip is gone
  - keeps the window open when its last tab closes
  - restores the session, including the open sidebar
  - turns on Picture-in-Picture when switching away from a playing video, like Arc
- `prefs.js`: opens the sidebar once on a profile that has never shown it.
- `customKeys.json`: clears Firefox's own *New Tab*, *Close Tab* and address-bar (`⌘L`) shortcuts, so `⌘T` / `⌘W` / `⌘L` reach the add-on. Undo in `about:keyboard`.

#### Option B: by hand

1. Open `about:support`, find **Profile Folder** and click **Open Folder** (Finder / Explorer).
2. In that folder, create a folder named `chrome` if there isn't one.
3. Save [`extras/userChrome.css`](extras/userChrome.css) into it as `chrome/userChrome.css`. If a `userChrome.css` is already there, append the contents instead of replacing it.
4. Save [`extras/user.js`](extras/user.js) into the profile folder as `user.js` (or append to an existing one). At minimum, `about:config` → `toolkit.legacyUserProfileCustomizations.stylesheets` must be `true`.
5. Restart Firefox. Changes to `userChrome.css` always need a restart.

To undo, see [Removing the layout](#removing-the-layout).

#### Removing the layout

Quit Firefox (`⌘Q`), then run the setup script with the uninstall option:

**macOS / Linux** (Terminal)
```sh
curl -fsSL https://raw.githubusercontent.com/chokity/BookmArc/main/extras/setup/bookmarc-setup.txt | bash -s -- --uninstall
```

**Windows** (PowerShell)
```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/chokity/BookmArc/main/extras/setup/bookmarc-setup.ps1))) -Uninstall
```

It removes BookmArc's marked blocks from `chrome/userChrome.css` and `user.js` (your own CSS and prefs stay) and gives Firefox its `⌘T`, `⌘W` and `⌘L` shortcuts back in `customKeys.json`. Then start Firefox again: the tab strip is back, the page no longer sits on a card.

The prefs `user.js` had set stay as they are until you change them, because Firefox has already copied them into its own settings. To reset them, open `about:config`, search for each one and click the reset arrow (↺):

- `toolkit.legacyUserProfileCustomizations.stylesheets` (turns `userChrome.css` on; only reset it if you have no `userChrome.css` of your own)
- `sidebar.verticalTabs`
- `browser.tabs.inTitlebar`
- `browser.tabs.closeWindowWithLastTab`
- `media.videocontrols.picture-in-picture.enabled`
- `media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled`
- `browser.startup.page` (restore the previous session)

**Installed by hand (option B)?** Delete BookmArc's part from `chrome/userChrome.css` (the whole file if it was the only content) and the lines you added to `user.js`, reset the prefs above and restart Firefox.

Removing the add-on itself (`about:addons` → BookmArc → *Remove*) doesn't touch the layout: remove the layout too, or Firefox keeps hiding its tab strip with no sidebar to replace it.

## Features

- **Pinned tabs = a bookmarks folder** (the bookmarks toolbar by default, one folder per space), both ways: pinning, renaming, moving and unpinning in the sidebar change the bookmarks (unpinning deletes one), and changes made in Firefox show up in the sidebar. Folders included; their emoji, color and open/closed state are kept by the add-on. Separators and smart bookmarks ("Most Visited") are left out of the sidebar and never touched. A closed pinned tab keeps its place; once its tab has left the pinned page the row reads "icon / name", and the icon goes back.
- **Open tabs are matched to bookmarks and favorites** by address (exact, then without `www.`, the fragment or a trailing slash, then without the query), on start and whenever the sidebar opens.
- **Search** at the top: shows only the bookmarks (and tabs) whose title or address has every word typed, with their folders opened just for the search. `Enter` opens the first hit, `Esc` clears; typing anywhere in the sidebar or `⌘F` starts a search.
- **Folding**: a closed folder keeps its open tabs in view below it; folding "Bookmarks" away leaves only the open ones.
- **Folders**: "…" on a folder's row (or right-click) for Rename, Change Icon (emoji with search), **Set Color…** (a colored area behind the folder and what's shown below it), Open / Close its tabs, nested folders, Ungroup, Delete.
- **Favorites**: drag a tab or a pinned item to the top; drag tiles to reorder.
- **Open tabs** below the divider; empty tabs (new-tab pages, the command bar) aren't listed, and "Close Empty Tabs" closes them. Split views show as one row.
- **Spaces = containers**: every container of [Firefox Multi-Account Containers](https://addons.mozilla.org/firefox/addon/multi-account-containers/) is a space, with its name, color and icon. The icons sit in the status bar: a click (or `Alt+1` … `Alt+4`) takes the window there, the sidebar sliding over to it as in Arc, and it shows only that space's tabs (the others are hidden, also from `Ctrl+Tab`). Each space has its own favorites; they and the pinned tabs open in the space's container, so a page can be open once per space, each with its own login (favorites from before spaces are in the first space). New tabs open in the space's container; a web page that opens without one (a link from another app) moves there before it loads, and a site assigned to a container in Multi-Account Containers ("Always open in…") opens in that space. A tab of another space that comes forward takes the window along. Right-click a tab for **Move to Space**. Each window has its own space, each space its own theme (starting on the container's color) and its own **bookmarks folder** for the pinned tabs: *Bookmarks Folder…* in the menu above them (⋯ or right-click) picks any folder, the toolbar is the default. Containers are made, renamed, sorted and deleted in Multi-Account Containers. Private windows have no spaces.
  Multi-Account Containers is optional: containers are built into Firefox, which turns them on for BookmArc. Without the add-on, manage them in Firefox's settings (`about:preferences#containers`: add, rename, color, icon, delete; no sorting, the spaces keep Firefox's order), and there are no site assignments, so everything opens in the window's space. With containers switched off, BookmArc works as one sidebar without spaces; with none left, it makes a "Personal" one.
- **Status bar** at the bottom: how many tabs the space has open, the spaces, and **Close All** to close every tab in the space (a second click confirms).
- **Multi-select** with `⇧`-click and `⌘`-click, then right-click: copy links, new folder with the items, close tabs, remove pins.
- **Menus** on tabs, pinned items, folders and favorites: duplicate, reload, mute, back to saved URL / save current URL, close tabs above/below, …; "Add to Favorites" and "Pin to BookmArc" also in Firefox's own page menu.
- **Unread counts on favorites**: a page that puts its count in the title ("(3) Inbox", "Inbox (3) - Gmail", "[3] Chat") shows it as a badge on its favorite.
- **Per space**: drag a tab onto another space's icon to move it there; right-click a space's icon to pick the search engine its command bar searches with; `Cmd/Ctrl+Shift+T` and *Recently Closed* in the menu above the pinned tabs reopen the tabs closed in that space (Firefox's own history, scroll position and container come back when it still has them).
- **Mini player**: tabs playing sound (in any space of the window, but not the one in front) show over the status bar, with the site and space; click to go there, or mute and close them right there. *Hide Mini Player* in the menu above the pinned tabs turns it off.
- **Theme**: `#f3dddb` by default, or any color (it always covers the whole sidebar), light or dark text, and **Sizing** (font, row height, spacing, folder indent and icon): right-click the current space's icon (without spaces: right-click the header above the pinned tabs). Firefox's own window (title bar, toolbar, address bar, menus) takes the theme too, per window and so per space; *Keep Firefox's Own Colors* in the menu above the pinned tabs turns it off. Private windows keep Firefox's private look.
- **Command bar**: `⌘T`, the "+" above the open tabs, or a double-click below them. `Tab` on a site searches inside it. `⌘L` / `Ctrl+L` opens it with the current tab's address selected, like Arc: what you pick loads in that tab.
- **Memory**: tabs idle for 45 minutes are unloaded.

## Limits

Firefox doesn't allow extensions to:

- Draw over the page. Arc's floating command bar becomes a tab here.
- Open `about:` pages (click Firefox's address bar) or create split views.
- Draw outside the sidebar: menus and submenus open inside it.
- Give the sidebar's theme to Firefox's own panels (bookmarks, history) while Firefox keeps its own colors: `userChrome.css` then paints them in the default color.

Spaces hide the other spaces' tabs, so Multi-Account Containers' own *Hide this container* has no effect alongside them. Tabs open from before spaces (and Firefox's own pages, which can't have a container) stay without one, in the space of their window.

Pinned tabs are your bookmarks (synced by Firefox Sync if it's on). Favorites, theme, sizing and the folders' emoji, colors and open state are stored locally in the profile.

## Tab badges for other extensions

Other extensions can put small badges on tabs in the sidebar and add items to its tab menu, by messaging this add-on (`bookmarc@pliha`). See the comment above `onMessageExternal` in `background.js`, or the [original README](https://github.com/trajche/arc#tab-badges-for-other-extensions). Since 0.7.1 the message types are named `bookmarc:` instead of `arcsidebar:`, and the add-on ID is `bookmarc@pliha` instead of `arc@sidebar-pliha`.

## Development

```sh
npm install
npm run setup-dev   # once: creates the "bookmarc-dev" Firefox Developer Edition profile
npm run dev         # start Developer Edition with that profile (macOS)
npm run reload      # reload the add-on in place after changing code
npm run lint
```

The dev profile loads the add-on unsigned, straight from this folder, and links `extras/userChrome.css` into the profile. Code changes need `npm run reload`; `userChrome.css` changes need a Developer Edition restart. The striped address bar with a robot icon in that window is Firefox marking remote control, which `npm run reload` uses.

Release Firefox only runs signed add-ons. To sign your own build without publishing it:

1. Create API keys at [addons.mozilla.org → Developer Hub → API Keys](https://addons.mozilla.org/developers/addon/api/key/) and put them in `.env` (git-ignored):
   ```sh
   WEB_EXT_API_KEY=user:…
   WEB_EXT_API_SECRET=…
   ```
2. `npm run sign` bumps the patch version and uploads an *unlisted* build: it's signed but not listed on addons.mozilla.org. The signed `.xpi` lands in `web-ext-artifacts/`. If it times out while waiting, don't run it again (that burns the next version number); fetch the file with `node scripts/amo.mjs fetch <version> web-ext-artifacts/bookmarc-<version>.xpi --wait-minutes 45`.

Other scripts:

- `npm run build:setup` regenerates `extras/setup/` from `extras/userChrome.css` and `extras/user.js`. Run it after changing either.
- `npm run sign:listed` signs a *listed* build instead: it goes to addons.mozilla.org for review and is published there, with the page text from [`docs/amo-metadata.json`](docs/amo-metadata.json) (the same text for the Developer Hub is in [`docs/amo-listing.md`](docs/amo-listing.md)). Firefox then keeps installed copies up to date itself. `./sign.sh minor --listed` bumps the minor version instead.
- `npm run build` packs an unsigned `.zip` (for Developer Edition / Nightly, or `about:debugging` → *Load Temporary Add-on*).

| Path | What |
|---|---|
| `background.js` | Command bar tabs (`⌘T` / `⌘L` / `⌘W`), Firefox's menus, binding tabs, badges, unloading idle tabs |
| `shared/store.js` | Data: favorites, the bookmarks toolbar as pinned items, theme, tab bindings |
| `shared/theme.js`, `theme.css`, `tint.js` | Theme colors, light and dark |
| `shared/` | Also badges, suggestions, DOM helpers and the emoji data |
| `sidebar/` | The sidebar: search, favorites, pinned tabs and folders, tab list, menus and dialogs |
| `palette/`, `newtab/` | Command bar and the new-tab page that opens it |
| `extras/` | `userChrome.css`, `user.js` and the generated setup scripts |
| `scripts/` | Dev tooling: setup-script generator, dev profile, reload, signing helper |

## License

[MIT](LICENSE), like the original. Icons from [Lucide](https://lucide.dev) (ISC). Emoji data from [unicode-emoji-json](https://github.com/muan/unicode-emoji-json) and [emojilib](https://github.com/muan/emojilib) (MIT, see [`shared/emoji.LICENSE.txt`](shared/emoji.LICENSE.txt)).
