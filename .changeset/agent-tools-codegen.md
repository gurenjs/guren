---
"@guren/cli": minor
---

Generate the agent tool manifest, and inspect it from the CLI (RFC 0016 PR-1b).

- `guren codegen` writes `.guren/agents.gen.ts` for apps whose routes declare `.agent()` metadata, between the data types and the API client. Every tool is derived through `deriveAgentTools()` — the same call a protocol adapter makes — so the manifest and a live server cannot disagree about a tool's name, schemas, or exposure. What codegen adds is the half only the CLI can see: a route's `resource` hint carries a Resource *class name*, so the payload type behind it is appended to the tool description and emitted as a `Data.*` reference in `AgentToolOutputTypes`. Apps with no agent routes get no file, and a previously generated one is removed.
- `guren tool:list` prints the tools an app exposes (method, path, MCP/WebMCP exposure, ability, annotations); `guren tool:inspect <name>` shows one tool's full derivation. Both derive live from the route graph rather than reading the manifest, so a stale or absent one cannot answer for what an agent would see. `--json` on either.
- `guren check` and `guren doctor` account for `.guren/agents.gen.ts` conditionally, and in both directions: the manifest is expected when the derivation yields at least one tool, and a file left behind after the last `.agent()` was removed is reported as stale rather than passing green. Both findings name `guren codegen`, which is the command that resolves either — so the remedy always clears the state it was printed for.
