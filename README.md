<p align="center">
  <img src="docs/logo.png" alt="" width="128" height="128">
</p>

<h1 align="center">Arcsidebar Fork</h1>

<p align="center">An Arc-style sidebar for Firefox.</p>

Arc is being discontinued in December 2026, so I moved to Firefox and tried to rebuild my Arc setup there as closely as I could. This is a fork of [trajche/arc](https://github.com/trajche/arc), extended with what I was missing.

It's tuned to **my** needs and my setup (macOS, a light theme). Some things may not work exactly right elsewhere, for example the dark theme. Use it as it is, or fork it and adapt it to yours.

> Not affiliated with or endorsed by The Browser Company. “Arc” is their browser; this is an independent extension that brings its sidebar ideas to Firefox.

## Install

Needs **Firefox 155 or newer** (desktop).

### 1. The add-on

Download the latest `.xpi` from [Releases](https://github.com/chokity/arc/releases) and drag it into a Firefox window (or `about:addons` → ⚙ → *Install Add-on From File…*). New versions are installed the same way; your spaces, pins and favorites are kept.

If the original Arcsidebar is installed too, disable it: both would handle `⌘T` and `⌘W`.

If the sidebar doesn't show up, open it once with `⌥⇧A` / `Alt+Shift+A` or *View → Sidebar → Arc*. Firefox remembers it from then on.

### 2. The layout (`userChrome.css`)

An extension can't change Firefox's own window: hiding the tab strip and shaping the page takes a user stylesheet, `userChrome.css`, in your Firefox profile. With it:

- Firefox's **tab strip is hidden**; the sidebar lists the tabs.
- Firefox's **toolbar stays on top** (back, forward, reload, address bar, extension buttons), below the native title bar with the window buttons.
- The page sits next to the sidebar as a **card with a rounded corner and a soft shadow**, like Arc.
- The sidebar's **“Arc ×” header** is hidden.

#### Option A: setup script (recommended)

Quit Firefox (`⌘Q`), then run the script for your system. It finds the Firefox profile that has this add-on installed and adds the layout there; your own CSS and prefs in those files are kept (it only manages its own marked block).

**macOS / Linux** (Terminal)
```sh
curl -fsSL https://raw.githubusercontent.com/chokity/arc/main/extras/setup/arc-setup.txt | bash
```

**Windows** (PowerShell)
```powershell
irm https://raw.githubusercontent.com/chokity/arc/main/extras/setup/arc-setup.ps1 | iex
```

Then start Firefox. Run the script again after updating the add-on, in case the layout changed. To read the scripts first: [`arc-setup.txt`](extras/setup/arc-setup.txt), [`arc-setup.ps1`](extras/setup/arc-setup.ps1). From a clone of this repository, `bash extras/setup/arc-setup.txt` does the same.

To remove the layout again: `curl -fsSL … | bash -s -- --uninstall` on macOS/Linux, or `& ([scriptblock]::Create((irm <url>))) -Uninstall` on Windows.

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
- `customKeys.json`: clears Firefox's own *New Tab* and *Close Tab* shortcuts, so `⌘T` / `⌘W` reach the add-on. Undo in `about:keyboard`.

#### Option B: by hand

1. Open `about:support`, find **Profile Folder** and click **Open Folder** (Finder / Explorer).
2. In that folder, create a folder named `chrome` if there isn't one.
3. Save [`extras/userChrome.css`](extras/userChrome.css) into it as `chrome/userChrome.css`. If a `userChrome.css` is already there, append the contents instead of replacing it.
4. Save [`extras/user.js`](extras/user.js) into the profile folder as `user.js` (or append to an existing one). At minimum, `about:config` → `toolkit.legacyUserProfileCustomizations.stylesheets` must be `true`.
5. Restart Firefox. Changes to `userChrome.css` always need a restart.

To undo: delete (or empty) `chrome/userChrome.css` and the lines you added to `user.js`, then reset the prefs in `about:config` if you like.

## Limits

Firefox doesn't allow extensions to:

- Draw over the page. Arc's floating command bar becomes a tab here.
- Open `about:` pages (use Firefox's address bar, `⌘L` / `Ctrl+L`), create split views, or read Arc's saved logins and cookies.
- Switch browser profiles. Containers stand in for Arc profiles: separate cookies and logins, but shared history, bookmarks and extensions.
- Draw outside the sidebar: menus and submenus open inside it.

Spaces, pins and favorites are stored locally in the profile.

## Tab badges for other extensions

Other extensions can put small badges on tabs in the sidebar and add items to its tab menu, by messaging this add-on (`arc@sidebar-pliha`). See the [original README](https://github.com/trajche/arc#tab-badges-for-other-extensions) for the message format; only the add-on id differs.

## Development

```sh
npm install
npm run setup-dev   # once: creates the "arc-dev" Firefox Developer Edition profile
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
2. `npm run sign` bumps the patch version and uploads an *unlisted* build: it's signed but not listed on addons.mozilla.org. The signed `.xpi` lands in `web-ext-artifacts/`. If it times out while waiting, don't run it again (that burns the next version number); fetch the file with `node scripts/amo.mjs fetch <version> web-ext-artifacts/arc-<version>.xpi --wait-minutes 45`.

Other scripts:

- `npm run build:setup` regenerates `extras/setup/` from `extras/userChrome.css` and `extras/user.js`. Run it after changing either.
- `npm run build` packs an unsigned `.zip` (for Developer Edition / Nightly, or `about:debugging` → *Load Temporary Add-on*).

| Path | What |
|---|---|
| `background.js` | Tab lifecycle, spaces, context menus, commands |
| `shared/store.js` | Data: spaces, favorites, pinned items, nested folders, imports |
| `shared/theme.css` | Color tokens, light and dark |
| `sidebar/` | The sidebar: pinned tabs, folders, tab list, menus and dialogs, spaces footer |
| `palette/`, `newtab/` | Command bar and the new-tab page that opens it |
| `editor/` | Space editor window (emoji data in `emoji.json`) |
| `import/` | Import from Arc (`arc-parse.js` reads Arc's `StorableSidebar.json`) |
| `extras/` | `userChrome.css`, `user.js` and the generated setup scripts |
| `scripts/` | Dev tooling: setup-script generator, dev profile, reload, signing helper |

## License

[MIT](LICENSE), like the original. Icons from [Lucide](https://lucide.dev) (ISC). Emoji data from [unicode-emoji-json](https://github.com/muan/unicode-emoji-json) and [emojilib](https://github.com/muan/emojilib) (MIT, see [`editor/emoji.LICENSE.txt`](editor/emoji.LICENSE.txt)).
