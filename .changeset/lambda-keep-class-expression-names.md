---
'@guren/plugin-lambda': patch
---

`lambda:build` keeps the names of named class and function expressions. Bun's syntax minification dropped the name of one whose body never refers to it, so `register(class SendWelcomeMailJob extends Job {})` reported `.name` as `""` in the bundled function. The bundle now sets `minify.keepNames`, which restores the source name on Bun 1.3.14 and 1.4.2. Class declarations are not affected.

Upgrade note: a class expression bound to a variable was bundled under the variable's name and now keeps its own, so `const SendMail = class SendMailJob extends Job {}` moves from `SendMail` to `SendMailJob`, which is what `bun run` already reported. If such a job, event, notification or agent is not pinned (`static jobName`, `static eventName`, a `type` getter, or `static agentName`), messages the previous deploy queued stop resolving, new database notifications get a different `type` from the stored ones, and an agent's stored conversations and queued runs stop matching. Pin it to the old name before deploying, or drain the queue first. The queue guide's "Pinning a Job's Wire Identity" section covers the job case.

`lambda:build` also warns when Bun renames an unpinned job, event, notification or agent because another module declares the same top-level class name. One of the two is then bundled as `<Name>2`, picked by import order, and no Bun option prevents it.
