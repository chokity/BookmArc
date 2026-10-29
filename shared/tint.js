/* Paints the theme before the page draws. The real colors come from storage
   (async), so without this every page would flash the default color first.
   The side panel and the command bar keep this cache fresh (theme.js); it lives
   in the extension's own origin, shared by all of its pages. */
(() => {
  try {
    const root = document.documentElement;
    const color = localStorage.getItem("theme:color");
    if (color) root.style.setProperty("--space", color);
    const intensity = localStorage.getItem("theme:intensity");
    if (intensity) root.style.setProperty("--tint", intensity);
    const text = localStorage.getItem("theme:text");
    if (text) root.dataset.text = text;
    const bg = localStorage.getItem("theme:bg");
    if (bg) root.style.setProperty("--bg", bg);
  } catch {
    // private window or blocked storage: the default color is fine
  }
})();
