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
  // The address bar's color, a lighter shade of the background (the command bar's page).
  const field = fieldColor();
  if (field) root.style.setProperty("--field", field);
  else root.style.removeProperty("--field");
  try {
    localStorage.setItem("theme:color", color);
    if (intensity === null) localStorage.removeItem("theme:intensity");
    else localStorage.setItem("theme:intensity", `${intensity}%`);
    if (text) localStorage.setItem("theme:text", text);
    else localStorage.removeItem("theme:text");
    if (bg) localStorage.setItem("theme:bg", bg);
    else localStorage.removeItem("theme:bg");
    if (field) localStorage.setItem("theme:field", field);
    else localStorage.removeItem("theme:field");
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

const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v);

/** `a` mixed with `b` by `share` (0 to 1), as #rrggbb. */
function mix(a, b, share) {
  const channel = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
  return (
    "#" +
    [1, 3, 5]
      .map((i) => Math.round(channel(b, i) * share + channel(a, i) * (1 - share)).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** The background lightened as for an input field (the address bar), as #rrggbb; "" if that can't be read. */
function fieldColor() {
  const style = getComputedStyle(document.documentElement);
  const bg = style.getPropertyValue("--bg").trim() || style.getPropertyValue("--base").trim();
  const fg = style.getPropertyValue("--fg").trim();
  if (!isHex(bg) || !isHex(fg)) return "";
  return mix(bg, "#ffffff", luminance(fg) > 0.5 ? 0.08 : 0.55);
}

/**
 * Firefox's own window (title bar, toolbar, address bar, menus, its panels) in
 * the colors the page was last painted in, for browser.theme.update; null if
 * they can't be read.
 */
export function firefoxTheme() {
  const style = getComputedStyle(document.documentElement);
  const read = (name) => style.getPropertyValue(name).trim();
  const bg = read("--bg") || read("--base");
  const fg = read("--fg");
  const space = read("--space");
  const onSpace = read("--on-space");
  if (![bg, fg, space, onSpace].every(isHex)) return null;
  const dark = luminance(fg) > 0.5; // light text
  const field = fieldColor();
  const raised = mix(bg, "#ffffff", dark ? 0.14 : 0.8);
  const line = mix(bg, fg, 0.15);
  // The color as an accent that shows on the background (a light theme color is near it).
  const accent = mix(space, fg, 0.3);
  return {
    colors: {
      frame: bg,
      frame_inactive: bg,
      tab_background_text: fg,
      tab_selected: raised,
      tab_text: fg,
      tab_line: accent,
      tab_loading: accent,
      toolbar: bg,
      toolbar_text: fg,
      icons: fg,
      icons_attention: accent,
      toolbar_top_separator: bg,
      toolbar_bottom_separator: bg,
      toolbar_vertical_separator: line,
      toolbar_field: field,
      toolbar_field_text: fg,
      toolbar_field_border: field,
      toolbar_field_focus: raised,
      toolbar_field_text_focus: fg,
      toolbar_field_border_focus: accent,
      toolbar_field_highlight: space,
      toolbar_field_highlight_text: onSpace,
      popup: dark ? mix(bg, "#ffffff", 0.1) : "#ffffff",
      popup_text: fg,
      popup_border: line,
      popup_highlight: space,
      popup_highlight_text: onSpace,
      sidebar: bg,
      sidebar_text: fg,
      sidebar_border: bg,
      sidebar_highlight: space,
      sidebar_highlight_text: onSpace,
      ntp_background: bg,
      ntp_text: fg,
    },
    // Not "dark" / "light": Firefox gives that to the whole window, this panel
    // too, which then paints the next space on that base and passes it on.
    // Light and dark stay the system's; the colors above carry the theme.
    properties: { color_scheme: "system", content_color_scheme: "system" },
  };
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
