---
'@guren/core': patch
---

Store an attached image under the extension of the format its bytes were read as. A JPEG uploaded as `photo.jfif`, or with no extension at all, was stored under that name, so a disk served by file extension answered 404 or the wrong `Content-Type` for the original while its variants worked. The row's `name` still holds the uploaded filename (a converted HEIC upload is renamed to `.jpg`, as before), and existing rows keep their paths.
