---
'@guren/cli': patch
---

The plan commands no longer point at commands that do not exist yet. The rendered plan page tells a reviewer to hand `feedback.json` to the agent that wrote the plan, or to apply the comments by hand, and then to run `plan:render` and `plan:approve`, instead of printing a `guren plan --revise` command. `plan:next` says which elements a scaffold would generate without claiming a generator writes them, and its advice for a held step names what works today: undo the change, or edit the plan so an element already built is `existing` (or `alter`) and approve it. `plan:verify --step` no longer says `plan:render` lists step ids.

`plan:next` no longer refuses to run because of the files the plan commands write beside a plan: the page `plan:render` writes, the approvals and decision log, and a leftover temporary file of theirs.
