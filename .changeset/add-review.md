---
'@guren/cli': minor
---

Add `guren add review`, which installs the Change workflow (RFC 0040). `.github/workflows/change.yml` runs `guren change:evidence` on every pull request and every push to `main`: it checks out the pull request's head commit with its full history, adds the evidence to the job summary and uploads the record, and fails only when the gate does. It is for an application at the root of its repository, and refuses one below it. It also writes a pull request template that asks for the issue and the plan and asks the reviewer for one `lane:` label (the job summary asks too), and feature and defect issue templates. Each file is written once; `--force` replaces it. The command prints the `gh label create` lines for the three labels, and says so when `ci.yml` still runs the same gate.
