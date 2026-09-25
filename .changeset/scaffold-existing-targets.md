---
'@guren/cli': patch
---

Scaffolding commands now check all the files they would write before writing the first one, as `guren make:feature` already did. When any already exists, the command lists them all and writes nothing. It used to stop at the first one, leaving the files before it behind, with an error that suggested `--force`, which would also overwrite your own files.

- Covered: `make:auth` / `add auth`, `add oauth`, `add admin`, `add storage`, `add attachments`, `make:module` and `deploy`. Also `add mail`, `add events`, `add queue`, `add notifications`, `add broadcasting` and `make:ai-agent`, which used to write their sample class or agent before the rest.
- The refusal names every file in the way, and marks one that a flag such as `--test` added. Single-file `make:*` commands refuse in the same words. `--force` still overwrites.
- Blueprints meant to be re-run to repair a partial install (`add session`, `add cache`, `add schedule`, `add ai`, `add prototype`, and the attachments config) still skip the files already there.
- A dangling symlink now counts as a file in the way. A path the CLI cannot check (a parent that is a file, a directory it cannot read) is reported before anything is written.
