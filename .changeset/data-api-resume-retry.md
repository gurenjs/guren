---
'@guren/orm': minor
'@guren/core': minor
---

`createAwsDataApiDatabase()` now retries a call the Data API cancelled because the Aurora Serverless v2 cluster was paused (`DatabaseResumingException`). A cluster with a minimum capacity of 0 ACUs pauses when idle, so the first `db:migrate`, `db:status`, seed, console command or query after a pause failed and passed on a second run. The adapter waits 1 second, doubles the wait up to 5 seconds, and rethrows the exception 60 seconds after the first try. It logs one warning per pause. No other error is retried.

The new `resumeRetry` option sets the limits or turns the retry off:

```ts
createAwsDataApiDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  resumeRetry: { timeoutMs: 20_000, maxDelayMs: 2_000 }, // or false
})
```

A `timeoutMs` that is not a finite number of 0 or more, or a `maxDelayMs` that is not a finite number above 0, throws when the factory is created.

A call that used to fail at once can now hold its caller for up to 60 seconds. Where the function timeout is shorter than that, lower `timeoutMs` or pass `resumeRetry: false` to keep the earlier behaviour. `AwsDataApiResumeRetryOptions` is exported from `@guren/core`.
