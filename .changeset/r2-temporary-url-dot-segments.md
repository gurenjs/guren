---
'@guren/plugin-cloudflare': patch
---

`R2Driver.temporaryUrl()` refuses a path whose `..` segments resolve outside the disk (its `prefix`, or the bucket when there is none), as `LocalDriver` refuses a path escaping its root. It used to sign the collapsed URL, so `temporaryUrl('../tenant-b/invoice.pdf')` handed out a link to an object outside the prefix, or in another bucket the R2 API token can read. A path that resolves inside the disk signs the same URL as before.
