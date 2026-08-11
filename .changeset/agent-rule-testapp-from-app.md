---
'@guren/cli': patch
---

Stop the agent testing rule from documenting a TestApp form that throws

The harness rule shipped `const app = TestApp.fromFetch((req) => app.fetch(req))`
as the way to wrap an existing app. The arrow is not the problem — the shadowing
is. Inside it, `app` resolves to the `const app` being declared on that same line,
which is the `TestApp`, and `TestApp` has no public `fetch`. An agent that copied
the line got `TypeError: app.fetch is not a function` at the first request, from
text that reads fine.

`TestApp.fromApp(app)` was added for this footgun and is now published, so the rule
documents it as the way to test against a real `Application`: it boots the app and
binds `fetch` itself. `fromFetch` stays for the case it actually models — an
arbitrary fetch function — with an example that does not shadow. The `(not async)`
note travels with `fromFetch`, since `fromApp` must be awaited.

Existing apps pick this up through `guren agent:sync`, which owns everything under
`.claude/rules/`.
