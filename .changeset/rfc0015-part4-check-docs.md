---
'@guren/cli': minor
---

Delivery-route wiring checks (RFC 0015 Part 4). `guren check` now flags a
`configureAttachments({ delivery })` with no `registerAttachmentRoutes()`
route in the loaded route definitions — private attachment URLs would be
minted that 404, and every delivery failure is a uniform 404 by design —
and a `serve: 'redirect'` disk whose storage config declares a driver
that can never presign (`local`, `memory`), which at serve time silently
downgrades to proxy. Both judged on positive evidence only; anything not
statically readable is skipped, never guessed. The attachments scaffold's
config comment now points at the delivery route.
