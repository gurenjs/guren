---
'@guren/cli': minor
---

Add `guren change:evidence --base <sha> --head <sha>`, what CI runs in place of the bare gate (RFC 0040 §4). It runs `guren gate --deps`, judges the change as `change:lane` does, and writes `evidence.json`, a compact `record.json` and an `evidence.md` job summary into `.guren/evidence/` or `-o <dir>`. It fails exactly when the gate fails; a file it cannot write is reported and changes no exit code. What it could not establish is recorded as a hold: a failed gate, a checkout that is not at `--head` or has uncommitted changes, committed files the gate's codegen rewrote, a change it could not read (a shallow clone) or that holds no commit, and, in this version, the plan evidence while any plan is open and the browser evidence of a change to a page, a routes file or a translation catalog. A change is eligible for low only when its floor is low and nothing holds it.
