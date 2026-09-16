---
'@guren/server': minor
'@guren/core': minor
---

Two helpers every agent surface plugin was carrying its own copy of now live beside the agent invocation pipeline:

- `resolveAgentAuditSink(config)` and the `AgentAuditConfig` type: the `audit: { file, days } | { sink }` option `mcpPlugin` and `aiPlugin` take. The file sink writes the lines `parseAuditRecord` reads back, and is loaded through a dynamic `import()`, so an app that passes its own `sink` never constructs the filesystem channel. Exported from the main entry only, not from `@guren/server/agent`.
- `createAgentCallBudget({ callsPerMinute, now, message })`: a sliding 60-second call meter, passed as the pipeline's `interpose` or called directly. It throws on a limit that is not a whole number of at least 1, since `Infinity` or `NaN` would leave the meter unmetered.
