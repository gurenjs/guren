---
'@guren/core': minor
---

Re-exports RFC 0026's introspection API from `@guren/server` (`isIntrospecting()`, `AppManifest` and its entry types), and adds `describeActiveAttachmentEngine()`, which reports the configured attachments table, disks and delivery route without touching a disk. An attachments engine bound in a provider's `register()` becomes the manifest's `attachments` section.
