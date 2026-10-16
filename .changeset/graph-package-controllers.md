---
"@guren/cli": patch
---

The application graph links a route handled by a framework controller (such as the attachment delivery route `registerAttachmentRoutes()` adds) to a controller node naming the package, instead of reporting `handles` as partial. `guren browser:map` lists such a route as handled outside the app, so an app using attachments gets a complete map.
