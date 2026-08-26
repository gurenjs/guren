---
"@guren/server": patch
---

Follow `NextContinuationToken` in `S3Driver.files()`, `directories()`, and `allFiles()`. A single ListObjectsV2 request returns at most 1000 entries, so listings beyond one page were silently truncated — `deleteDirectory()` left objects behind on large directories, and callers treating the listing as complete missed everything past the first page. A truncated page without an advancing token now throws instead of returning an incomplete listing. `deleteMany()` splits deletes into the 1000-key batches DeleteObjects accepts, and root listings on a disk with a `prefix` no longer send a doubled-slash `Prefix` that matches nothing.
