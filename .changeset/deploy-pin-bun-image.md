---
'@guren/cli': minor
---

`guren deploy` now pins the Dockerfile's images to the Bun release running the command and to the digest of that tag's multi-platform image on Docker Hub, for example `oven/bun:1.4.4@sha256:…` and `oven/bun:1.4.4-slim@sha256:…`, instead of the floating `oven/bun:1` and `oven/bun:1-slim`. A rebuild gets the same runtime even after the tag is pushed again. When Docker Hub cannot be reached, the exact tag is written without a digest and the command warns; when Docker Hub has no image for the running release (a canary build, or one published moments ago), or the command does not run under Bun, it writes the floating tags and warns. Run `guren deploy --force` again after upgrading Bun to move the pin.
