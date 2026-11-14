---
'@guren/cli': minor
---

`guren change:lane` now audits both sides of the change and reports what the base did not have as `high` facts: `audit-fail`, `sensitive-exposure`, `csrf-exemption`, `audit-warn-changed` (a security default switched off, or a missing authorization or a force write of request data on a file the change touches) and a newly ignored finding as `audit-suppressed`. Each commit is exported to a temporary directory and audited there with the install on disk, so the command loads the application's code as `guren audit` does; `--no-audit` skips it. A side whose lockfile is not the one installed, or an app with nothing installed, is reported as not judged rather than as clean.
