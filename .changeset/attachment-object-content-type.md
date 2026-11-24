---
'@guren/core': patch
---

An attachment whose bytes are not read as an image no longer writes a client-declared type that a browser renders as a page onto the stored object. A declared HTML, XML (SVG and XHTML included) or XSL type, `multipart/x-mixed-replace`, a type a browser sniffs (`unknown/unknown`, `application/unknown`, `*/*`), a comma-separated list of types or a malformed one is written to the object as `application/octet-stream`, so on an S3 or R2 disk a public URL or a direct `temporaryUrl()` to it downloads instead of rendering in the bucket's origin. The row's `contentType`, `inspectAttachment()`'s result, the signed delivery route, the object key and every other declared type are unchanged. Objects stored before this release keep the type they were written with.
