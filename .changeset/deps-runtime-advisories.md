---
'@guren/cli': minor
---

`guren audit` checks the Bun versions an app runs on against the advisories in the `oven-sh/bun` repository, which `bun audit` does not read. It matches the running Bun, `engines.bun`, `packageManager` and the `oven/bun` images in the root Dockerfiles. A version inside an advisory's range is a `deps:runtime:<GHSA>` finding naming the patched release, an image without an exact version and a digest is a `deps:runtime-unpinned` warning, and a request that fails is `deps:runtime-scan` rather than a clean result. `--deps-baseline` counts these advisories and fails when the check could not run. `guren deps:exposure` lists the same versions under `runtime`. Set `GITHUB_TOKEN` in CI to lift GitHub's 60-requests-an-hour limit.
