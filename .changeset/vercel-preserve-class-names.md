---
"@guren/plugin-vercel": patch
---

fix: stop the Vercel function bundle from mangling class names

The serverless function was bundled with a bare `--minify`, which enables
identifier mangling and renames every class in the graph. Guren treats class
names as durable identity, so the rename reaches data that outlives a single
deploy:

- the queue registry keys jobs on `JobClass.name` and serializes that name into
  every queued message, so a job dispatched by one build resolves to nothing
  after the next — and a message injected by name from outside the bundle never
  resolves at all
- notifications persist `notifiable.constructor.name` as their `type`, and
  `Notification.type()` returns `this.constructor.name`
- `HttpException` reports `this.constructor.name` as its `name`

The build now passes `--minify-whitespace --minify-syntax` instead, dropping
only identifier mangling. `--keep-names` is not an alternative: as of Bun
1.3.14 it is accepted and silently leaves class names mangled.

The bundle grows as a result. The ratio depends on the dependency graph —
measured at ~35% on a framework-linked entrypoint (3.33 MB → 4.51 MB), and
higher on smaller graphs. That is the cost of names that survive a redeploy.
