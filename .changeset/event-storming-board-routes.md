---
'@guren/cli': minor
'@guren/server': minor
---

The Dev Center serves event-storming boards (RFC 0041, the routes of the second milestone). `/_guren` lists the boards under `docs/boards/`, `/_guren/boards/<slug>` shows one as the outline `guren board:show` prints, and `POST /_guren/boards/<slug>/ops` applies a list of operations to it, which is what the canvas of the next release posts to. That POST is the Dev Center's second write and the first to a tracked file: `@guren/server` mounts it behind the loopback guard, requires the request's own `Origin`, and exempts it from the CSRF token on the terms the plan feedback route has, and `@guren/cli` checks the `Origin`, the content type, the size and the operations' schema again before it writes. The board pages need both packages at this release: an older `@guren/server` does not mount them, and the Dev Center says so in place of the list.
