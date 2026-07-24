---
'@guren/cli': minor
---

`guren check` now enforces architecture boundaries. Drop a `guren.arch.ts` file at the project root to define layers and disallowed cross-layer imports (or disallowed packages), and violations are reported alongside the existing route/controller/page checks. Two new flags support this for AI coding agents and large apps: `guren check --arch` runs only the architecture checks (a fast path for an edit hook), and `guren check --changed` restricts any check to files changed versus the merge base with `main`.
