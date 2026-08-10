---
'@guren/cli': patch
---

fix(cli): detect controller body accessors in `guren audit`

The A03 body-validation rule only recognized raw request reads (`this.request.json()`, `req.parseBody()`, …), so an action that read the payload through the documented controller helpers was reported as a pass ("does not consume the request body"). `this.input()`, `this.only()`, `this.except()`, `this.file()` and `this.files()` are now detected, including their generic forms — nested type arguments such as `this.input<Record<string, unknown>>('meta')` included.

An action that only calls `this.has()` still passes, since a presence check yields no unvalidated value, but its finding no longer claims the body went unread.

The accessor list is derived from a classification of `Controller`'s full public/protected surface, pinned by a test that re-parses `Controller.ts` — a new accessor added there now fails that test instead of silently defaulting to undetected. The `validateBody`/`validateBodySafe` detection is derived from the same classification, so it can no longer drift out of step with it.
