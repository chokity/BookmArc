/* Sidebar UI helpers: context menu and in-sidebar dialogs. */
import { h } from "./dom.js";

export { h, letterFor, setIcon, syncChildren } from "./dom.js";

/* ---------- Context menu ---------- */

const menuEl = document.getElementById("menu");

export function hideMenu() {
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
    dialogEl.querySelector("input, select, button")?.focus();
  });
}

dialogEl.addEventListener("mousedown", (e) => {
  if (e.target === dialogEl) dialogEl.querySelector("[data-cancel]")?.click();
});

export function confirmDialog(title, text, okLabel) {
  return openDialog((close) =>
    h(
      "form",
      { className: "dialog-card", onsubmit: (e) => (e.preventDefault(), close(true)) },
      h("h2", {}, title),
      h("p", { className: "hint" }, text),
      h(
        "div",
        { className: "actions" },
        h("button", { type: "button", dataset: { cancel: "" }, onclick: () => close(false) }, "Cancel"),
        h("button", { type: "submit", className: "primary danger" }, okLabel)
      )
    )
  );
}
