---
"@guren/cli": patch
---

**Provider registration no longer rewrites the rest of the `providers` array** — every command that registers a provider (`guren add session`, `add cache`, `add attachments`, `make:auth`, `guren plugin`, and the `guren add` blueprints) rebuilt the array by re-joining parsed entries. Those entries come from a *masked* copy of the source, where string contents are blanked character for character so a name mentioned in a comment cannot read as a registration. Joining them back therefore wrote the mask to disk: `mcpPlugin({ path: '/mcp' })` became `mcpPlugin({ path: '    ' })`, mounting the endpoint at a four-space path on an app that still boots, typechecks and passes `guren check`. The array was also flattened onto one line, and matching to the first `]` truncated an array holding a nested one — `providers: [plugin({ hosts: ['a'] })]` had the new provider spliced inside the plugin's own argument.

The insert now splices into the array's own span, the way `addToArrayOption` and `addToArrayArgument` already did: existing text is preserved verbatim, the span is found by depth-counting rather than by the first `]`, and a `providers: [` appearing only in a comment is no longer mistaken for the real one.
