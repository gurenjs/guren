---
'@guren/cli': minor
---

`guren change:lane` now audits both sides of the change and reports what the base did not have as `high` facts: `audit-fail`, `sensitive-exposure`, `csrf-exemption`, `audit-warn-changed` (a security default switched off, or a missing authorization or a force write of request data on a file the change touches) and a newly ignored finding as `audit-suppressed`. Each commit is exported to a temporary directory and audited there with the install on disk, so the command loads the application's code under the caller's environment, as `guren audit` does; `--no-audit` skips it. When a commit's lockfile is not the one installed, nothing is installed, or a package is linked from the repository itself, the audit is reported as not judged rather than as clean, and so is anything the head's audit could not read that the base's could. The text output now ends with what the result rests on without checking.
