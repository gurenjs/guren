---
'@guren/server': minor
'create-guren-app': patch
'@guren/cli': minor
---

Console commands are wired up automatically, and `guren check` reports the ones that are not.

`make:command` wrote a class and printed the registration step for the user to
perform by hand. Forgetting it left dead code with no signal — the same bug the
console entrypoint was added to fix, recurring once per generated command.

`make:command` now performs that wiring: a project-level command is imported
and appended to `kernel.registerMany([...])` in `src/console.ts`, and
`bunx guren check` warns about any command class a console entrypoint never
uses outside its imports.

`defineModule()` gains a `commands` field alongside `routes` and `providers`,
so a module's commands reach the root kernel through its public surface:

```ts
// modules/billing/index.ts — make:command --module billing writes this
export const billingModule = defineModule({ name: 'billing', commands: [InvoiceCommand] })

// src/console.ts — add once per module
kernel.registerMany(billingModule.commands)
```

Previously the only route was re-exporting the command from the module's
`index.ts`, because importing it directly from `src/console.ts` reaches into
module internals and fails `guren check --arch`.

`guren context` now lists console commands, which were invisible to it before.
