---
'@guren/cli': minor
---

The Dev Center's board canvas shows where each note went (RFC 0041 §3). `/_guren/boards/<slug>/status` runs `guren board:status --json` as a child and answers its report, and each linked note carries its state: in the app, planned, missing or unknown. The line under the canvas counts them, the notes that lead nowhere and the plans read. The page checks on open, on refresh, and when the window regains focus, at most once every 15 seconds. A note whose link changed since the last check shows no state until the next one.
