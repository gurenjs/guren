---
"@guren/cli": minor
---

The docs viewer at `/_guren/docs` shows plans that are not closed yet (RFC 0030 §7): drafts and approved plans are listed under the counters and drawn linked to the entities they change, and a plan's panel shows each derived step with what its last `plan:verify` recorded (verified, drifted with the changed files, failed, blocked, incomplete, outdated or not run), the step `plan:next` marked and any stall, the waivers, and the next command with a copy button. It reads the plan files, approvals, decision logs and `.guren/plans/` only, never application code. A rendered plan page older than its plan is marked stale. The graph can be panned (drag the background or scroll) and zoomed (pinch, Ctrl/⌘ + scroll, the +/− buttons), and `0` fits it to the screen.
