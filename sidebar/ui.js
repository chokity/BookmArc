/* Sidebar UI helpers: context menu and in-sidebar dialogs. */
import { h } from "../shared/dom.js";

export { h, letterFor, setIcon, syncChildren } from "../shared/dom.js";

/* ---------- Context menu ---------- */

const menuEl = document.getElementById("menu");

function hideMenu() {
  menuEl.hidden = true;
  menuEl.replaceChildren();
}

function menuNodes(items, after) {
  return items.flatMap((item) => {
    if (item === "-") return [h("hr")];
    if (item.submenu) {
      // The sidebar is too narrow for a submenu beside the menu, so it folds
      // open inside it: the items appear indented below their parent.
      const group = h("div", { className: "submenu", role: "group", hidden: true }, menuNodes(item.submenu, after));
      const head = h(
        "button",
        {
          className: "has-sub",
          disabled: !!item.disabled,
          "aria-expanded": "false",
          onclick: () => {
            group.hidden = !group.hidden;
            head.setAttribute("aria-expanded", String(!group.hidden));
            if (!group.hidden) group.querySelector("button:not(:disabled)")?.focus();
            fitMenu();
          },
        },
        h("span", {}, item.label),
        h("span", { className: "sub-arrow", "aria-hidden": "true" }, "›")
      );
      return [head, group];
    }
    return [
      h(
        "button",
        {
          className: item.danger ? "danger" : "",
          disabled: !!item.disabled,
          onclick: async () => {
            hideMenu();
            try {
              await item.run();
            } finally {
              after();
            }
          },
        },
        item.label
      ),
    ];
  });
}

/** Keep the menu on screen (again after a submenu folds open and it grows). */
function fitMenu() {
  const { left, top, width, height } = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(4, Math.min(left, innerWidth - width - 4))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(top, innerHeight - height - 4))}px`;
}

/**
 * items: [{label, run, danger?, disabled?} | {label, submenu: items} | "-"];
 * `after` runs once an item finishes.
 */
export function showMenu(items, x, y, after = () => {}) {
  menuEl.replaceChildren(...menuNodes(items, after));
  menuEl.hidden = false;
  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
  fitMenu();
  menuEl.querySelector("button:not(:disabled)")?.focus();
}

document.addEventListener("mousedown", (e) => {
  if (!menuEl.hidden && !menuEl.contains(e.target)) hideMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideMenu();
});
window.addEventListener("blur", hideMenu);

/* ---------- Modal dialog ---------- */

const dialogEl = document.getElementById("dialog");

/** Show `form` in the modal. Resolves with whatever `close(value)` is called with. */
export function openDialog(build) {
  hideMenu();
  return new Promise((resolve) => {
    const close = (value) => {
      dialogEl.hidden = true;
      dialogEl.replaceChildren();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    dialogEl.replaceChildren(build(close));
    dialogEl.hidden = false;
    (dialogEl.querySelector("[autofocus]") || dialogEl.querySelector("input, select, button"))?.focus();
  });
}

dialogEl.addEventListener("mousedown", (e) => {
  if (e.target === dialogEl) dialogEl.querySelector("[data-cancel]")?.click();
});

/* ---------- Emoji picker ---------- */

const QUICK_EMOJIS = ["📁", "🏠", "💼", "⭐", "❤️", "🔥", "📚", "💻", "🎨", "🎵", "🎮", "🛒", "✈️", "🧪", "📈", "🎬", "🍳", "🌱", "💡", "🚀", "☕", "📷", "🔧", "📰"];

let emojiGroups = null; // [{g: group, e: [[emoji, "name keywords"]]}], loaded on first search

/**
 * Quick choices, plus a search over all emoji by name and keyword.
 * Calls onPick(emoji) for a click, or for Enter in the search (the first match).
 */
function emojiPicker(current, onPick) {
  const grid = h("div", { className: "emoji-grid" });
  const button = (e, text) =>
    h("button", { type: "button", className: `emoji${current === e ? " selected" : ""}`, title: text || "", onclick: () => onPick(e) }, e);
  const quick = () => {
    // Keep a custom emoji visible among the quick choices.
    const list = current && !QUICK_EMOJIS.includes(current) ? [current, ...QUICK_EMOJIS] : QUICK_EMOJIS;
    grid.replaceChildren(...list.map((e) => button(e)));
  };
  const search = h("input", {
    type: "search",
    className: "emoji-search",
    placeholder: "Search all emoji",
    autocomplete: "off",
    spellcheck: false,
    oninput: async () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return quick();
      emojiGroups ??= await fetch(browser.runtime.getURL("shared/emoji.json")).then((r) => r.json());
      // An emoji named after the search comes first ("rocket": 🚀 before 🧑‍🚀), then
      // words that start a keyword: "book" finds 📖 before 💻 ("notebook").
      const starts = ([, text]) =>
        (text.startsWith(words[0]) ? words.length + 1 : 0) + words.filter((w) => ` ${text}`.includes(` ${w}`)).length;
      const hits = emojiGroups
        .flatMap((g) => g.e)
        .filter(([, text]) => words.every((w) => text.includes(w)))
        .sort((a, b) => starts(b) - starts(a));
      grid.replaceChildren(
        ...(hits.length
          ? hits.slice(0, 120).map(([e, text]) => button(e, text.split(" ").slice(0, 3).join(" ")))
          : [h("div", { className: "picker-empty" }, "No emoji found")])
      );
    },
    onkeydown: (e) => {
      // Enter picks the first match instead of submitting the form.
      if (e.key !== "Enter") return;
      e.preventDefault();
      grid.querySelector(".emoji")?.click();
    },
  });
  quick();
  return h("div", { className: "emoji-picker" }, search, grid);
}

/** "Change Icon" dialog: resolves with the picked emoji, "" to remove the icon, or null if cancelled. */
export function pickIcon(current) {
  return openDialog((close) =>
    h(
      "form",
      { className: "dialog-card", onsubmit: (e) => e.preventDefault() },
      h("h2", {}, "Change Icon"),
      emojiPicker(current, close),
      h(
        "div",
        { className: "actions" },
        current && h("button", { type: "button", className: "reset", onclick: () => close("") }, "Remove Icon"),
        h("button", { type: "button", dataset: { cancel: "" }, onclick: () => close(null) }, "Cancel")
      )
    )
  );
}

/* ---------- Inline rename ---------- */

/**
 * Swap `title` for a text field in place. Enter or leaving the field saves,
 * Escape cancels; onDone(name | null) gets the trimmed text, or null when cancelled.
 */
export function inlineRename(title, current, onDone) {
  const input = h("input", { className: "rename", value: current, spellcheck: false });
  // Selecting text in the field must not drag the row.
  const row = title.closest("[draggable=true]");
  if (row) row.draggable = false;
  title.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    input.replaceWith(title);
    if (row) row.draggable = true;
    onDone(save ? input.value.trim() : null);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  // Clicks in the field must not open, fold or drag the row under it.
  for (const type of ["mousedown", "click", "dblclick"]) input.addEventListener(type, (e) => e.stopPropagation());
}
