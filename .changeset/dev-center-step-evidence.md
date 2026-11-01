---
'@guren/cli': minor
'@guren/server': minor
---

Show each step's evidence on the Dev Center plan page. Every step on `/_guren/plans/<slug>` opens an **Evidence** section with the retained runtime errors on the plan routes the step touches (matched by method and path, read from the plan, never the application), its last `plan:verify` record's fingerprinted files and `work`, and the `guren browser:record` steps under `.guren/browser/` recorded for its acceptance ids or for a feature it renders, with their result, error window and screenshots. The data comes from the new read-only `/_guren/plans/<slug>/evidence`; screenshots are served from `/_guren/browser/<run>/screenshots/<sha256>`, found among the runs `.guren/browser/` lists and the digests their `run.json` records, and only while the file still has that digest. The server mounts both behind `GUREN_MCP=1` and the loopback guard. The page reads once on open and on **Refresh plan**, and runs no command.
