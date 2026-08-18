---
"@guren/server": patch
---

Publish the application container so `Job.make()` works

`Job.make()` and the exported `resolve()` read the process-wide container that
`setContainer()` fills in, but nothing in the framework ever called it. Every
job that resolved a service — the `this.make('mail')` pattern the `Job` JSDoc
advertises, and the mail jobs the auth scaffold generates — therefore threw
`Container not initialized. Call setContainer() first.` the moment a driver ran
it, whether that was `SyncDriver` in-process or `guren queue:work`.

`Application` now publishes its own container when it is constructed, so
anything reaching for the global finds the app's bindings.

Construction rather than `boot()` is deliberate: `guren queue:work` imports the
app entry to read the queue driver and never calls `boot()`, so a job can run
against an app that was only constructed. The most recently constructed
application wins, which is what `bun --hot` needs — a reloaded entry replaces
the stale container instead of being ignored.
