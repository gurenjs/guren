---
"web": patch
---

Serve the prerendered docs from Workers Static Assets instead of bundling them into the worker. The rendered HTML (one JSON fragment per doc), the markdown source and `llms-full.txt` are written under `public/` at build time; the Worker reads a page through its `ASSETS` binding, and `.md` URLs and `/llms-full.txt` are answered by the asset layer before the Worker runs. Only a manifest of titles and descriptions stays in the bundle, which drops from 28.6 MiB to about 7.5 MiB uncompressed and frees the ~40 MB of heap the docs strings held in every isolate.
