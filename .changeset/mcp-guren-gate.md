---
'@guren/server': minor
---

`guren_gate` MCP tool

The development MCP endpoint exposes `guren gate` as `guren_gate`, with
`changed` and `deps` arguments and the per-stage report as its result; `ok`
is the verdict, and the result is marked as an error when a stage fails. On a
`@guren/cli` older than `guren gate` the tool says so instead of throwing.
