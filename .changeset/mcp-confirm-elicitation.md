---
'@guren/plugin-mcp': minor
---

The MCP endpoint asks the calling user about a `confirm` tool (RFC 0042 §2.3). On an MCP 2026-07-28 request from a client that declares form elicitation, `tools/call` answers with an `input_required` result: a form with the route's message and the redacted arguments, and a signed `requestState` naming the tool and the fingerprint of the arguments. The client repeats the call with the answer, and the action runs when the caller agreed to these exact arguments. A declined, cancelled or unticked form ends the call as a `confirmation` denial, and a retry with other arguments is asked about again.

The state is signed with a key derived from `APP_KEY` and bound to the caller, the method and the endpoint's path, so nothing is stored and any instance verifies what another minted. A state that fails verification is answered `-32602` before a handler runs. A confirmation is valid for ten minutes and is not single-use.

A `confirm` tool is refused, and stays listed, for a request on the 2025 protocol era, for a client that declares no form elicitation, and on an app with no valid `APP_KEY` (which also warns at boot). The answer comes from the client, so confirmation is a cooperating host's word that a person saw the question; a call its caller must not be able to approve stays on `approval: 'required'`.

`guren_preflight` reports `confirmation: 'required'` on an allowed verdict for such a tool: `allowed` covers the rehearsal only.
