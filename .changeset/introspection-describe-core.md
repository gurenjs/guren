---
'@guren/core': minor
---

Adds `describeActiveAttachmentEngine()` and `AttachmentEngine.describe()`, which report the configured attachments table, disks and delivery route without touching a disk. An engine bound in a provider's `register()` becomes the introspection manifest's `attachments` section (RFC 0026).
