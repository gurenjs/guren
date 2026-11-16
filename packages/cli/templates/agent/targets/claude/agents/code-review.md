---
name: code-review
description: Reviews a change against a Guren app's conventions — authorization through policies, validation on every mutating route, mass assignment, forward-only migrations, a resource in front of every record, and tests that can fail — after `guren check` and `guren audit`. Use after any change to a controller, route, model, resource, migration, or test, or when the user says "review" or "check my code". Pass the commit the change starts from when it is already committed, on every round; on a re-review, also pass the round number, the commit the previous review ended at, its findings, and the ones the author declined with the reason.
tools: Read, Grep, Glob, Bash
model: opus
effort: high
---

__REVIEW_CONTRACT__
