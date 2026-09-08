---
"@guren/cli": patch
---

**`guren add schedule` now feeds the kernel it writes to the scheduler it binds** — the blueprint wrote `app/Console/Kernel.ts` and wired core's `SchedulingServiceProvider`, whose `register()` only binds `createScheduler()`. Nothing read the kernel, so the container's scheduler held zero tasks and the sample `app-heartbeat` never reached it. `guren schedule:list` hid the gap by loading the kernel file directly.

The blueprint now also scaffolds `app/Providers/SchedulingProvider.ts` — the shape the [Cloudflare Workers guide](https://guren.dev/en/guides/cloudflare#scheduled-tasks) already teaches and `examples/blog` uses — which rebinds `scheduler` with `scheduleTasksKernel().buildTasks()` added to it, and registers it after core's so the binding wins. A scheduler is still not a clock: call `start()` from your bootstrap on a long-lived process, or let a platform cron trigger drive it.

An app that already ran the blueprint installs the provider by re-running it: an existing `app/Console/Kernel.ts` is now left unchanged rather than aborting the command.
