---
"@guren/cli": minor
---

Add `guren token:issue`, which mints an API token scoped to the agent tools an app exposes (RFC 0016 §5.1).

```
guren token:issue --name ci-agent --user 42 --tools 'posts.*' --read-only --expires 30d
```

`--tools` takes a comma-separated list of full scopes (`tool:posts.store`, `tools:read`, `tools:*`, `tools:posts.*`) or their shorthands (`posts.store`, `read`, `*`, `posts.*`). The tool list every scope is judged against is derived live from the route graph — the same `deriveAgentTools()` call `tool:list` and a running adapter make — so what the command prints is what a dispatcher will honour.

This is the issuer half of the split the scope grammar describes: a token guard must grant less on anything it cannot parse, so it ignores a malformed ability silently, while here the same entry is a typo a human is still looking at. Every refusal happens before anything is written:

- a scope the grammar cannot parse is rejected by name, showing how a shorthand was read when that differs from what was typed;
- a scope matching no current tool is rejected too — it is either a typo or a *latent grant*, a stored pattern that would activate with no further consent the moment a matching tool is added. `--allow-unmatched` accepts one deliberately and warns in exactly those terms;
- `tools:*` requires `--yes`;
- `--expires` accepts `30d` / `12h` / `45m` and refuses zero rather than minting an already-expired token. Omitting it issues a non-expiring token and warns.

`--read-only` intersects the grant with the read-only tools and stores the concrete `tool:<name>` entries it resolved to, never the pattern: the grammar has no "read-only subset of `posts.*`" form, so a concrete list is the only faithful encoding — and it is fail-closed, since a write tool later joining that family joins no stored entry. Under `--read-only` a scope resolving only to write tools is refused rather than silently dropped, `--allow-unmatched` included: concrete entries cannot activate later, so that combination could not keep the flag's promise.

A grant covering both read-only and write tools warns about the lethal-trifecta shape without refusing it. `--json` emits one machine-readable object carrying the token, the granted tools split read/write, and the warnings. The plain token is printed once and stored hashed.
