---
"@guren/cli": minor
---

Add `--stop-when-empty` to `queue:work`

The CLI guide documented `bunx guren queue:work --stop-when-empty`, but the
command never declared the flag. An undeclared flag is ignored without an error,
so the worker kept polling. The flag now exits the worker once the queues it
watches are empty. Unlike `--once`, it does not stop after the first job.
