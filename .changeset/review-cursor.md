---
'@guren/cli': minor
---

`guren add review` and `guren change:policy` now cover the Cursor target (RFC 0040 §7). For an app whose agent harness includes Cursor, `add review` writes `APPROVAL_POLICY.md`, which Cursor's PR Routing & Approval reads (approve only a pull request whose Change evidence reads `eligible for low`), and `change:policy` keeps `.cursor/BUGBOT.md`, which Bugbot includes on every review, with the same generated block as `REVIEW.md`; past what fits under Bugbot's 30,000 characters the block keeps what is always read by a person and points at `REVIEW.md` for the tables. `--check` judges both files. `change:lane` reads any `BUGBOT.md`, `APPROVAL_POLICY.md` or `.cursor/approval-policies/` change as a gate input (`high`).
