---
'@guren/cli': patch
---

Make `guren codegen` overwrite existing `.guren/*.gen.ts` artifacts by default. Previously, plain `bunx guren codegen` failed with "already exists. Use --force to overwrite." on any run after the first, even though create-app template scripts always pass `--force` and the generated CLAUDE.md documents plain `bunx guren codegen` as the way to regenerate manifests. `--force` is still accepted for backward compatibility but is now a no-op for this command.
