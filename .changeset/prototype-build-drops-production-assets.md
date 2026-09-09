---
"@guren/server": patch
---

`vite --mode prototype` no longer ships the ordinary build's output in `dist/prototype/`: copying `public/` brought `public/assets/` (the production client bundle) along with it, and the prototype build now removes that directory from its output while keeping everything else under `public/`.
