---
'@guren/cli': patch
---

Stop `add resource` from reading an unrelated path as "these routes are already registered"

`guren add resource` skips its route registration when the app already has the
routes, and one of the two signals it looked for matched the collection slug as
a quoted-path suffix. An app with an unrelated `router.get('/admin/posts',
...)` therefore answered yes for a `Post` resource: the run reported success,
`db/schema.ts` got the `posts` table, eight files were scaffolded, and the
controller and validator imports were appended to `routes/web.ts` — but no route
group was ever registered. The two imports are then bindings nothing uses, which
stops the app compiling under `noUnusedLocals`.

The path signal is now anchored on both sides, matching the full literal the
registration emits (`'/posts'`), the way the sibling `'posts.index'` signal
already was. The imports also moved inside the guard: they exist for the group,
so a run that (correctly) skips registration — an app that hand-wired `/posts`
itself — no longer appends imports nothing uses either.

Both signals are still needed and neither is redundant. An app that hand-wired
`/posts` has none of the generated `.name()` calls, so the path literal is the
only thing left to recognise it by — anchoring any tighter than the quoted path
would register a second, conflicting set of routes over it.

One behavior change beyond the fix: an app that registers the resource under a
prefix without the literal (`router.group('/blog/posts', ...)` with no `posts.*`
route names) now gets a `/posts` group inserted rather than being skipped. That
app genuinely has no `/posts` routes, so registering them is the correct reading
— but it is a change from what the previous match did. A nested prefix that does
contain the literal (`router.group('/admin', (admin) => admin.get('/posts', ...))`)
still suppresses registration; that is the honest boundary of matching source
text rather than resolving the route table.
