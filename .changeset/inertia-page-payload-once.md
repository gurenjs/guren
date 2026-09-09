---
"@guren/server": patch
---

An Inertia document now serializes the page payload once. The `<head>` carried `window.__INERTIA_PAGE__ = {…}` in full while the body already held the same JSON in the `data-page` element the client reads, so every prop shipped twice (and a server-rendered prop three times): on guren.dev's largest docs page that was 1 MB of the 2.8 MB response and a quarter of it after brotli. The global is still defined, by an inline script that reads the element with the client's own selector and guards, so anything reading `window.__INERTIA_PAGE__` keeps working. A custom SSR body that carries no `data-page` element gets the engine's element appended rather than a second copy in the head.
