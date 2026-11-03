---
'@guren/cli': patch
---

`guren add storage` (and `guren add attachments`, when it installs storage first) adds `storage/app/` and `public/storage` to `.gitignore`, creating the file when the app has none. The `local` disk writes uploads under `./storage/app` and nothing ignored it, so `git add -A` committed private uploads; `public/storage` is the `public` disk's root and the link `guren storage:link` creates. A line already in `.gitignore` is not added again.
