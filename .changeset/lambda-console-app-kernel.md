---
'@guren/cli': patch
---

The Lambda console handler now dispatches the app's own console kernel.

The scaffolded `src/lambda.ts` built a second `ConsoleKernel` inline and
registered a single `db:migrate` command on it. An app therefore had two
kernels with different command sets: register five commands in `src/console.ts`,
uncomment the Lambda console export, and the deployed function still knew only
`db:migrate` — with nothing to warn you.

The scaffold now imports `kernel` from `src/console.ts`, so every command
reachable through `bun run console` is reachable on Lambda under the same name.
The `db:migrate` recipe moved to the serverless guide, since needing it at all
is specific to deploying where no CLI exists.
