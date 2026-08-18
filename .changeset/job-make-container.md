---
"@guren/server": patch
---

Publish the application container so `Job.make()` works

`Job.make()` and the exported `resolve()` read the process-wide container that
`setContainer()` fills in, but nothing in the framework ever called it. Every
job that resolved a service — `this.make('mail')` inside `handle()`, the way a
controller resolves one — therefore threw `Container not initialized. Call
setContainer() first.` the moment a driver ran it, whether that was `SyncDriver`
in-process or the worker behind `guren queue:work`.

`Application` now publishes its own container, so anything reaching for the
global finds the app's bindings.

It publishes at construction rather than in `boot()`: `guren queue:work`
bootstraps the app only far enough to read the queue driver, and an entry that
merely exports the application — with no `ready` or `bootstrap` export — is
accepted there and never booted. A job dispatched from module scope is in the
same position. Bindings a service provider registers still only exist after
`boot()`, as before; construction publishes the container, not its contents.

Publishing is the constructor's last step, so an application that fails to
build leaves the previous one's container in place instead of replacing it with
a half-built one. Otherwise the most recently constructed application wins,
which is what `bun --hot` needs — a reloaded entry replaces the stale container
rather than being ignored.
