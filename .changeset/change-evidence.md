---
'@guren/cli': minor
---

Add `guren change:evidence --base <sha> --head <sha>`, what CI runs in place of the bare gate (RFC 0040 §4). It runs `guren gate --deps`, judges the change as `change:lane` does, and writes `evidence.json`, a compact `record.json` and an `evidence.md` job summary into `.guren/evidence/` or `-o <dir>`, whatever happens. It fails exactly when the gate fails. What it could not establish is recorded as a hold: a failed gate, a checkout that is not at `--head` or has uncommitted changes, a change it could not read (a shallow clone), and, in this version, the plan evidence of a change under an open plan and the browser evidence of a change to a page or a routes file. A change is eligible for low only when its floor is low and nothing holds it.
