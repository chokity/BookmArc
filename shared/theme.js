/* Painting a page in the theme's colors. Pages only (needs a document). */

import { themeColor, themeIntensity } from "./store.js";

let painted = null; // the theme last painted, repainted when the system goes light / dark

/**
 * Paint the page in the theme's colors (--space, --tint and --bg, the exact
 * background), and remember them so the next page starts in the right colors
 * (see tint.js).
 */
export function paintTheme(theme) {
  painted = theme;
  const root = document.documentElement;
  const color = themeColor(theme);
  const intensity = themeIntensity(theme);
  const text = theme?.text === "dark" || theme?.text === "light" ? theme.text : autoText(color, intensity);
  root.style.setProperty("--space", color);
  // Text on the color itself (menus, buttons, the command bar's selection): whichever reads.
  root.style.setProperty("--on-space", luminance(color) > 0.55 ? "#1d1b24" : "#ffffff");
  if (intensity === null) root.style.removeProperty("--tint");
  else root.style.setProperty("--tint", `${intensity}%`);
  if (text) root.dataset.text = text;
  else delete root.dataset.text;
  // The background, worked out here rather than by CSS color-mix(): that one
  // computes in floats and Chrome truncates when drawing, so #f3dedb at 100%
  // came out as #f2dedb.
  const bg = background(color);
  if (bg) root.style.setProperty("--bg", bg);
  else root.style.removeProperty("--bg");
  try {
    localStorage.setItem("theme:color", color);
    if (intensity === null) localStorage.removeItem("theme:intensity");
    else localStorage.setItem("theme:intensity", `${intensity}%`);
    if (text) localStorage.setItem("theme:text", text);
    else localStorage.removeItem("theme:text");
    if (bg) localStorage.setItem("theme:bg", bg);
    else localStorage.removeItem("theme:bg");
  } catch {
    // no storage here: the next page just starts on the default color
  }
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (painted) paintTheme(painted);
});

/** `color` mixed into the page's base color by --tint, as #rrggbb; "" if that can't be read. */
function background(color) {
  const style = getComputedStyle(document.documentElement);
  const base = style.getPropertyValue("--base").trim();
  const share = parseFloat(style.getPropertyValue("--tint")) / 100;
  if (!/^#[0-9a-f]{6}$/i.test(base) || !Number.isFinite(share)) return "";
  const channel = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
  return (
    "#" +
    [1, 3, 5]
      .map((i) => Math.round(channel(color, i) * share + channel(base, i) * (1 - share)).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Relative luminance of #rrggbb, 0 (black) to 1 (white). */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * No text color chosen: the system's, unless the color covers most of the
 * background; then whichever reads on it (light pink in dark mode needs dark text).
 */
const autoText = (color, intensity) => (intensity !== null && intensity >= 60 ? (luminance(color) > 0.4 ? "dark" : "light") : null);

/** The text color the theme shows now: its own choice, else what it picks for the color, else the system's. */
export const themeText = (theme) =>
  theme?.text ||
  autoText(themeColor(theme), themeIntensity(theme)) ||
  (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");
