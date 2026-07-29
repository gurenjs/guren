---
"@guren/server": minor
"@guren/testing": minor
---

feat: let jobs pin their durable wire identity

Queue identity was derived entirely from the class name — registration,
dispatch, and worker lookup all keyed on `jobClass.name`. That breaks a queued
message whenever the class name changes between the write and the read: a class
renamed while a backlog drains, or a bundler that mangles identifiers. The
Vercel plugin hit the second case in production and was fixed at the bundler
level, but that fix does not reach a user running their own esbuild or rollup
over a Guren app.

Jobs may now declare a stable wire name:

```ts
export class SendWelcomeEmailJob extends Job<{ userId: string }> {
  static jobName = 'SendWelcomeEmailJob'
}
```

`registerJob()` and `Job.dispatch()` resolve the name through a new exported
`resolveJobName()` helper, which `@guren/testing`'s `FakeQueue` uses as well so
the fake keys jobs exactly as the real driver does. Jobs without a `jobName`
keep resolving by class name — this is opt-in and backward compatible.

Only an **own** `jobName` counts. Statics are inherited, so resolving through
the prototype chain would make every subclass of a pinned job claim its
parent's identity and evict it from the registry. A subclass that wants to
share the parent's wire name declares it explicitly.

### Upgrading

The framework's own jobs now declare a `jobName`, pinning their wire name
against future bundler mangling. In a normal, unmangled build this is a no-op —
the declared name already equals the class name for both `SendMailJob` and
`SendNotificationJob` — so it only matters going forward. **If a previous
deploy was bundled with identifier mangling**, those jobs were queued under the
mangled name (`a`, `t`, …) and will not resolve against the now-declared one;
drain the affected queues before upgrading.

`@guren/testing` now imports `resolveJobName` from `@guren/server`. Its
`@guren/server` peer range stays at `>=1.0.0` — tightening it would only be
satisfied once `@guren/server` itself is released at the
version shipping this feature, which breaks workspace linking against the
not-yet-released version in the meantime, and `.changeset/config.json`'s
`onlyUpdatePeerDependentsWhenOutOfRange` deliberately keeps this range wide so
routine `@guren/server` bumps don't force a spurious major on `@guren/testing`.
Pair a current `@guren/testing` with a current `@guren/server`.
