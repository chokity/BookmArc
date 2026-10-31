# Changelog

## 0.7.7

- **Updates come by themselves**: Firefox now checks this add-on's GitHub
  releases once a day and installs new versions, keeping your favorites and
  settings (*Check for Updates* in `about:addons` → ⚙ checks right away).
  Coming from 0.7.6, install this version by hand once.

## 0.7.6

First release of **BookmArc**, an Arc-style sidebar for Firefox.

- **Spaces from containers**: every container of Firefox Multi-Account
  Containers is a space, with its name, color and icon, shown in the status
  bar. A click or `Alt+1` … `Alt+4` switches; the window then shows only that
  space's tabs. Each space has its own favorites, pinned tabs, theme color and
  search engine; new tabs open in its container.
- **Pinned tabs are a bookmarks folder**, both ways: pinning, renaming, moving
  or unpinning in the sidebar changes the bookmarks, and changes made in
  Firefox show up at once. Each space picks its folder (the bookmarks toolbar
  by default). Folders keep their emoji and open state and can get a color.
- **Command bar** on `⌘L` / `Ctrl+L`, like Arc: search bookmarks, tabs and
  the web, or enter an address.
- **Search** at the top of the sidebar, over bookmarks and tabs.
- **Status bar** with the open tab count, Close All, and a mini player for a
  tab playing sound in the background.
- **Unread counts on favorites**, read from the page's title.
- **Recently closed, per space**: `Cmd/Ctrl+Shift+T` and a list of the last ten.
- **Firefox takes the theme**: title bar, toolbar, address bar and menus are
  painted in the space's colors (can be turned off).
- **Layout setup** (`bookmarc-setup.sh` / `bookmarc-setup.ps1`) installs the
  `userChrome.css` that hides Firefox's tab bar (it can come back from the
  menu) and frees `⌘L` for the command bar. Run with `--uninstall` /
  `-Uninstall`, it removes the layout again and gives Firefox its shortcuts
  back (see *Removing the layout* in the README).
