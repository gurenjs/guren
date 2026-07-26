---
'@guren/orm': patch
---

Fixed the `bun --hot` connection registry truncating call-site paths that contain a space or parentheses. The stack frame naming the caller was parsed with a pattern that excluded both characters from the path, so a project under `/Users/me/My Projects` was recorded as `Projects/app/config/database.ts`.

The truncation was deterministic, so the key stayed stable across reloads and connection replacement kept working. What it cost was identity: a registry slot is keyed by driver, caller file, and connection target, so two call sites that truncate to the same path — two apps in one monorepo booted by a single dev process, pointed at one database — would share a slot, and the second would close the first's live connection. Frames are now matched by shape (`at fn (/path/file.ts:1:2)` and the bare `at /path/file.ts:1:2`) with nothing excluded from the path itself.
