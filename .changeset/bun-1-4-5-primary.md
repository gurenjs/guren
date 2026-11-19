---
'@guren/cli': patch
---

Guren is now tested on Bun 1.4.5 as its primary runtime; Bun 1.4.4 keeps a non-blocking CI lane and the 1.4.2 lane is dropped. Bun 1.4.5 fixes GHSA-p268-p2w7-qr8x, a use-after-free in the bundled HTTP/3 header decoder that affects 1.3.14 through 1.4.4, and `guren audit` fails on those releases until you upgrade Bun and run `guren deploy` again to rewrite the Dockerfile's image pins. `guren doctor` and `guren upgrade` still judge against Bun 1.4.0.
