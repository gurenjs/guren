---
"@guren/cli": patch
---

The `code-review` subagent the agent harness installs now reviews what `guren check` and `guren audit` cannot see: validation on every mutating route, a resource in front of every record, and route registration order. It ran both checkers already, but its checklist repeated framework patterns that had moved on (`Model<T>` rather than `defineModel(table)`, listeners registered somewhere other than the app's event provider) and sent the reader to `.claude/rules/coding-standards.md`, which the harness has never shipped. The `test-writer` brief loses the same class of drift: `fakeEvents` (the export is `fakeEvent`), fakes asserted by name instead of by class and never bound into the container, and a `findOrFail` assertion written with `expect(() => ...).toThrow()`, which passes whatever the model does.
