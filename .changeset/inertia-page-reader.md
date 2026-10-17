---
"@guren/server": minor
"@guren/testing": patch
"@guren/cli": patch
---

The Inertia initial-page element is written and read in one place, beside the engine: `initialPageElement()`, `INITIAL_PAGE_SELECTOR` and `readInitialPage()` in `@guren/server/internal/inertia-page`. `@guren/testing`'s controller mock writes its element through it, `readInertiaResponse()` and `guren browser:doctor` read through it instead of their own copies, and the doctor now reports a payload that is not JSON apart from a page that carries none. The browser-tests support template reads `window.__INERTIA_PAGE__`, which the page shell sets from the same element, and parses the element itself when a CSP kept the shell's inline script from running. A legacy `data-page` attribute now also decodes `&#39;` in `readInertiaResponse()`.
