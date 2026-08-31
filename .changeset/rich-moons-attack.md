---
"@guren/cli": minor
"@guren/testing": minor
---

Add `guren tool:call` and `TestApp.agent()` for invoking agent tools (RFC 0016 §6)

`guren tool:call <name> --input '{"title":"x"}'` boots the application and
invokes one agent tool through the framework's own dispatch contract — the same
derivation, request building and response mapping an MCP client's call goes
through, so there is no CLI-only code path to drift. Its tools come from the
booted app's route graph rather than a routes file, so a tool it can name is a
tool it can reach. `--as user:42` authenticates the call (development only: it
sets `GUREN_TESTING=1` for the process, and says so), `--preflight` asks for a
verdict instead of an execution, and `--json` emits a machine-readable result.
A call that comes back as an error result exits non-zero.

`@guren/testing` gains `app.agent()`: `call(name, input, { as, preflight })`
returns a result carrying `assertOk`, `assertStatus`, `assertDenied` and
`assertStructured<T>()`, chainable on the pending call like every other
`TestApp` request, plus `tools()` for the derived catalog. Calls inherit the
app's standing headers, so `(await app.withCsrf()).agent()` composes.
`TestApp.fromFetch()` and `fromWorkers()` carry no route graph and say which
constructor to use instead of reporting an empty tool list.
