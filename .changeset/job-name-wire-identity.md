---
"@guren/server": minor
"@guren/testing": minor
---

feat: let jobs and notifiables pin their durable identity

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

The framework's own jobs now declare a `jobName`, which changes two wire names:

- `SendNotificationJob` — `NotificationManager` dispatches an internal
  subclass, so its messages were previously written as
  `BoundSendNotificationJob` and are now written as `SendNotificationJob`.
- `SendMailJob` — unchanged for a normal build, where the declared name already
  equals the class name. **Not** unchanged if your previous deploy was bundled
  with identifier mangling: those messages were queued under the mangled name
  (`a`, `t`, …) and will not resolve against the declared one.

**Drain queued notifications — and queued mail, if any previous deploy mangled
identifiers — before upgrading.** Messages left under the old names will fail to
resolve.

Notifiables gained the matching escape hatch. `Notification.type` was already
overridable, but the notifiable side hardcoded `constructor.name` into the
persisted `notifiableType` column. `Notifiable` now accepts an optional
`notifiableType`, honored by both `DatabaseChannel` and
`NotificationManager.serializeNotifiable()`. The declared type is also restored
onto the notifiable that the queue worker rebuilds — that notifiable is a plain
object, so without it the type degrades to `'Object'` on the queued path.

The new property is optional, so implementors need not add anything. It is not
purely additive at the type level, though: an implementor that already has a
member called `notifiableType` which is not an optional `string` — a different
type, or a `private`/`protected` member — will stop satisfying `Notifiable` and
needs to rename it.

`@guren/testing` now imports `resolveJobName` and `resolveNotifiableType` from
`@guren/server`. Its `@guren/server` peer range stays at `>=1.0.0` — tightening
it would only be satisfied once `@guren/server` itself is released at the
version shipping this feature, which breaks workspace linking against the
not-yet-released version in the meantime, and `.changeset/config.json`'s
`onlyUpdatePeerDependentsWhenOutOfRange` deliberately keeps this range wide so
routine `@guren/server` bumps don't force a spurious major on `@guren/testing`.
Pair a current `@guren/testing` with a current `@guren/server`.
