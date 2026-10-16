---
name: verify-in-browser
description: Check a change the way a user sees it, in a browser, against an instance this app starts safely, and keep the evidence (RFC 0033). Use when the user says "check it in the browser", "verify the UI", "does the page work", "bug bash", "click through it", or after a change to a page, a form or a route an Inertia page submits to, once the tests pass. Not a gate: plan:verify, the Stop hook and gate never read its results.
---

# Browser Verification Skill

Tests prove a route at the HTTP level. This skill proves what they cannot: the
page renders, the form submits where it should, the error a user would see is
on screen. Its results are evidence for the person, never a verdict any gate
reads, so never tell the person a plan step or acceptance criterion is done
because a browser run passed.

## 1. Read the map

```bash
bunx guren browser:map --check
```

`docs/browser/README.md` lists each feature, its landmark route and what an
approved plan says it should do. When `--check` reports a stale map, run
`bunx guren browser:map` and commit the regenerated blocks with your change.
When it reports the map incomplete, say which sections it names; do not
treat the features it does list as all there is.

## 2. Start one instance

Run this in the background for the whole session and keep the origin it
prints:

```bash
bunx guren browser:serve
# {"origin":"http://127.0.0.1:52817","pid":48211,"collector":"available"}
```

It refuses to start when it cannot show the database is local, or under
`NODE_ENV=production`. Report the refusal and its remedy to the person. Never
work around it by starting the app another way, pointing it at another
database, or editing `.env`: the refusal exists so a session cannot migrate or
seed a database that is not theirs. `--database-url` takes a local one when
the person gives you one.

## 3. Open a run and check the instance

```bash
bunx guren browser:record --begin --url <origin> --feature <feature>
# {"run":"2026-10-16T10-42-07Z-posts"}
bunx guren browser:doctor --url <origin> --evidence <run>
```

Go on only when the doctor's result is `pass`. On `fail`, fix the server error
or the wrong page it names first. On `inconclusive`, read its reasons: an
incomplete map, a collector it could not read, or no landmark that passed (a
`redirected` landmark usually means sign-in) are not passes.

## 4. Drive each step, recorded

For each acceptance id in the feature's Plan section, or each charter:

```bash
bunx guren browser:record <run> --step <id> --open
```

Then drive the page:

- With `@playwright/test` installed, write or run a spec under
  `tests/browser/`, using the map's labels after confirming them on the page.
- Otherwise use the browser tools your client already has. Never install or
  register an MCP server for this.

Save each screenshot under `.guren/browser/<run>/screenshots/`, then close the
step with what you saw, in this shape and no other field:

```bash
bunx guren browser:record <run> --step <id> --close --input - <<'JSON'
{
  "result": "pass",
  "action": "filled Comment with \"Nice post\" and clicked Post comment",
  "landed": { "url": "/posts/7", "component": "posts/Show" },
  "errorsShown": [],
  "database": [{ "table": "comments", "has": { "body": "Nice post" }, "found": true }],
  "screenshots": ["screenshots/01-comment-posted.png"]
}
JSON
```

The command may lower your result: a server error during the step makes it
`fail`, a window it could not read makes a `pass` `inconclusive`. Report the
result it prints, not the one you sent.

## Proof standards

- Drive the user's path. Never call a test-only endpoint or set state behind
  the page's back to make a step pass.
- Record the action and the state it led to, not only the last screen.
- Check the rows the plan expects with the app's own models, and say how you
  checked them; the CLI records your account of the database, it cannot read it.
- A finding is a bug once a spec in `tests/browser/` fails on it. Until then,
  report it as observed, with the run and step that show it.

## Cleanup

Stop the `browser:serve` you started (end the background job, or send it
SIGINT/SIGTERM); it stops the app with it. The `pid` it printed is the app's:
signal the command, not that pid. Leave `.guren/browser/`; it is the evidence,
and git already ignores it.
