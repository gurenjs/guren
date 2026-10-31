---
name: verify-in-browser
description: Check a page or form change in a browser against a safely started instance and keep the evidence (RFC 0033), once tests pass ("check it in the browser"). Never a gate.
---

# Browser Verification Skill

Tests prove a route at the HTTP level. This skill proves what they cannot: the
page renders, the form submits where it should, the error a user would see is
on screen. Its results are evidence for the person. `plan:verify`, the Stop
hook and `guren gate` never read them, so never tell the person a plan step or
acceptance criterion is done because a browser run passed.

## 1. Read the map

```bash
bunx guren browser:map --check
```

`docs/browser/README.md` is the index; each feature's own
`docs/browser/<feature>.md` holds its routes, the Plan section (what an
approved plan expects), Charters and Gotchas. When `--check` reports a stale
map, run `bunx guren browser:map` and commit the regenerated blocks with your
change. When it reports the map incomplete, tell the person which sections it
names before going on.

## 2. Start one instance

Run this in the background for the whole session:

```bash
bunx guren browser:serve
# {"origin":"http://127.0.0.1:52817","pid":48211,"collector":"available"}
```

Wait for either that one JSON line or the command exiting; a refusal prints no
JSON. It refuses when it cannot show the database is local, under
`NODE_ENV=production`, and when the app has no `bin/serve.ts` or no
`defineDatabaseConfig()`. Each refusal says who can act on it: relay the ones
addressed to the person and wait. Never start the app another way, point it at
another database or edit `.env` yourself: the refusal exists so a session
cannot migrate or seed a database that is not theirs. When the person starts
the app and gives you its loopback origin, continue at §3 with it.

## 3. Open a run and check the instance

```bash
bunx guren browser:record --begin --url <origin> --feature <feature>
# {"run":"2026-10-16T10-42-07Z-posts"}
bunx guren browser:doctor --url <origin> --evidence <run>
```

Go on only when the doctor's result is `pass`. On `fail`, fix the server error
or the wrong page it names first. On `inconclusive`, report its reasons to the
person and go on only if they agree: an incomplete map, a collector it could
not read, or a landmark that needs a signed-in user (`auth-required`) all leave
something unchecked.

## 4. Drive each step, recorded

A step is an acceptance id from the feature's Plan section, or a charter named
by its kind (`charter-validation`). Each is recorded once; to try again, use a
new step id or a new run.

```bash
bunx guren browser:record <run> --step <id> --open
```

Drive the page with the browser tools your client already has. Never install
or register an MCP server for this.

When the app has `guren add browser-tests` (a `test:browser` script),
`GUREN_BROWSER_RUN=<run> bun run test:browser` files Playwright's report in the
run as `spec-report.json`. That run starts its own instance on port 4317, on
the same local database, and `browser:record` reads neither its report nor its
server errors: report its result to the person beside the steps, never as one.
A spec file ends in `.browser.ts`, since `bun test` collects `*.spec.ts`. Write
your own beside `tests/browser/generated/`, which `guren browser:map` rewrites.
Without that setup, write no spec files.

After changing a page, run `bun run test:browser`. A test titled `a11y …` runs
axe on a page and fails on a WCAG A or AA violation; report one with the rule
ids its message names. Fix the page rather than adding a rule to
`tests/browser/a11y.ts`, which is the person's call.

Save each screenshot under `.guren/browser/<run>/screenshots/`, then close the
step. `result` and `action` are required; the rest is what you observed, and
no other field is accepted:

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
`fail`, a window it could not read makes a `pass` `inconclusive`. It exits 1 on
anything but `pass` and has still recorded the step. Report the result it
prints, not the one you sent. Never write `run.json` yourself.

## Proof standards

- Drive the user's path. Never call a test-only endpoint or set state behind
  the page's back to make a step pass.
- Record the action and the state it led to, not only the last screen.
- Check the rows the plan expects read-only, through the app's own models,
  under the same `DATABASE_URL` and `NODE_ENV` the instance was started with
  (the `--database-url` you passed, if any), and say how you checked. The CLI
  records your account of the database; it cannot read it.
- Report a finding as observed, with the run and step that show it.

## Cleanup

End the `browser:serve` background job you started; it stops the app with it.
Never kill a process by its pid or name. If the origin still answers
afterwards, tell the person. Leave `.guren/browser/`: it is the evidence, and
git already ignores it.
