---
'@guren/server': patch
---

Disposing a nested `container.fake(key, …)` puts back the fake it replaced. Before, it removed the key, so the outer fake stopped applying while it was still in scope and `make(key)` returned the real binding.
