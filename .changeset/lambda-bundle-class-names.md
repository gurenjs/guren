---
'@guren/plugin-lambda': patch
---

Keep class names intact in the Lambda bundle.

`lambda:build` minified identifiers, which renamed every class in the bundle.
The framework treats class names as durable identity — `registerJob()`/
`getJob()` key the job registry on `JobClass.name`, and that same name is
serialized into each queued message and into a notification's persisted `type`.
Mangled, a job queued by one build became unresolvable after the next, and an
SQS message addressed by its real class name never resolved at all: the handler
reported a batch item failure in milliseconds with no job code ever running.
The bundle now minifies whitespace and syntax only.
