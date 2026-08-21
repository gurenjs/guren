---
"@guren/cli": minor
---

Add a route contract check to `guren check`: a `params` schema key or a `bind` key that names a parameter its route path never declares.

Both are silent today. A required `params` key the path cannot supply makes every request to that route fail validation with a 422 before the handler runs; an optional or defaulted one never fails at all, and quietly hands the controller `undefined` or a schema default in place of a value from the URL. A `bind` key with no matching path parameter is skipped when the request is resolved, and the controller's `this.model()` then throws `No model binding found` — at request time, from a route that type-checks.

The check reads *registered* route definitions rather than the routes file's AST, because the path a route registers is the joined one (`group()` prefixes and `resource()` expansions already applied) and a params schema is usually imported from somewhere the routes file does not spell out. A required stray key reports as a failure, an omissible one as a warning, and a schema whose shape cannot be read reports as a stated skip rather than passing silently. Only the direction that is always a defect is reported: a path parameter the schema leaves out is harmless, since zod strips what it does not declare.

Plain `guren check` still sets no exit code, as it never has; `guren check --ci` gates on these results along with the rest of the suite.
