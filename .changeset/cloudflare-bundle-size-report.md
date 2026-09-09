---
"@guren/plugin-cloudflare": minor
---

Added `guren cloudflare:size` and `cloudflare:build --report-size`: wrangler's dry run measures the worker bundle a deploy would upload, and esbuild's metafile attributes it to its largest sources by package (an app's own files by path). The report states the uncompressed size as a share of the platform limit, which is 64 MiB on every plan since Cloudflare removed the compressed limits on 2026-09-04, and warns from half of it. The limit is held in one place with its source and the date it was confirmed. `reportBundleSize()` and the pure `parseWranglerSize()` / `attributeBundle()` / `renderBundleReport()` are exported for scripts.
