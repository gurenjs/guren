---
'@guren/cli': minor
---

`guren check` and `guren audit` read in-process agents (RFC 0029 §8). Both are content-activated: an app with no `Agent` subclass from `@guren/plugin-ai` gets no new findings.

`guren check` fails on what would throw at `as()` or at the first tool call:

- `ai-agent-tool-underived`: a literal `appTools([...])` name that no `.agent()` route derives.
- `ai-agent-tool-unscoped`: a name the class's `static scopes` does not grant (`tool:<name>`, `tools:<prefix>.*`, `tools:read`, `tools:*`).
- `ai-agent-scope-malformed`: a `static scopes` entry outside that grammar.
- `ai-agent-audit-duplicate`: both `aiPlugin({ audit })` and `mcpPlugin({ audit })` configure a trail.

It warns (`ai-agent-plugin-missing`) when no source file calls `aiPlugin()`. A spread, a variable or a computed element in `appTools()`, and a non-literal `static scopes`, are reported as unverifiable warnings rather than passed.

`guren audit` lists every local tool an agent's `tools()` returns beside `appTools()`, under its own heading and as `aiLocalTools` in `--json`. Local tools run with no scope, policy, approval or audit line. `ai-local-tool-write` warns when a tool's `execute` writes through a Model whose table an `.agent()` route's action also uses; `// guren-audit-ignore` on the tool's line suppresses it.
