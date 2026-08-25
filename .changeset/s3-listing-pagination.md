---
"@guren/server": patch
---

Follow `NextContinuationToken` in `S3Driver.files()`, `directories()`, and `allFiles()`. A single ListObjectsV2 request returns at most 1000 entries, so listings beyond one page were silently truncated — `deleteDirectory()` left objects behind on large directories, and callers treating the listing as complete missed everything past the first page.
