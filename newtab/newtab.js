"use strict";
browser.runtime.sendMessage({ type: "bookmarc:newtab" }).catch(() => {});
