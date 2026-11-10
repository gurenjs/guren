---
'@guren/plugin-markdown': patch
---

Heading slugs are deduplicated in linear time. A document with many headings sharing one name no longer makes the slugger rescan every earlier suffix, which let a large Markdown body spend quadratic time in rendering.
