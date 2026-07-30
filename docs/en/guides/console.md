# Console Commands

Console commands let you run application code from a terminal — backfills, one-off maintenance, reports — with the same models, services, and container your HTTP handlers use.

A command is a class. A kernel collects those classes and dispatches one of them based on `argv`. Your app owns both, so nothing runs until you register it.

> Not to be confused with `bunx guren console`, the framework's interactive REPL. That is documented in the [CLI reference](./cli.md#interactive-repl). This guide covers commands *your application* defines.

## Defining a Command

Generate one with the CLI:

```bash
bunx guren make:command SendDigest
```

That writes `app/Console/Commands/SendDigestCommand.ts`:

```ts
import { Command } from '@guren/core'

export default class SendDigestCommand extends Command {
  static signature = 'send-digest'
  static description = 'Command description'

  async handle(): Promise<void> {
    this.info('Done!')
  }
}
```

Two statics and one method are all a command needs:

- `static signature` — the command's name plus its arguments and options (see below).
- `static description` — the one-line summary shown by `list` and `help`.
- `handle()` — the work. Return nothing (or `0`) for success, or a non-zero number to set the exit code. An uncaught exception is reported via `this.error()` and exits `1`.

Pass `--command` to choose the invocation name instead of accepting the kebab-cased default:

```bash
bunx guren make:command SendDigest --command reports:digest
```

## Signature Syntax

```ts
static signature = 'users:create {email} {name?} {--admin} {--role=member}'
```

| Token | Meaning |
|-------|---------|
| `{name}` | Required argument |
| `{name?}` | Optional argument |
| `{name=default}` | Argument with a default value |
| `{name*}` | Array argument — consumes the rest, must come last |
| `{--flag}` | Boolean option, `false` when absent |
| `{--opt=}` | Option that takes a value |
| `{--opt=default}` | Option with a default value |
| `{-o\|--opt}` | Option with a short alias |
| `{--opt=*}` | Option that may be repeated |

Each token must be a single whitespace-free `{...}` group. Anything else in the signature string is ignored, so a stray space inside the braces silently drops that argument.

Read the parsed values inside `handle()`:

```ts
async handle(): Promise<number | void> {
  const email = this.argument('email')
  const isAdmin = this.option<boolean>('admin')
  const role = this.option('role', 'member')

  if (!email) {
    this.error('An email address is required.')
    return 1
  }
}
```

`argument()` returns `undefined` for a required argument the caller omitted — the parser does not reject it for you, so validate what you require. Boolean options are always defined (`false` when the flag is absent).

## Output

Commands write through `this.output`, with shorthands on the class:

```ts
this.info('Starting the backfill')     // INFO  …
this.success('Backfill complete')      // DONE  …
this.warn('3 rows were skipped')       // WARN  …
this.error('Could not reach the API')  // ERROR … (stderr)
this.line('plain, unprefixed text')
this.newLine()

this.table(['ID', 'Email'], rows)
```

For long-running work, `withProgress()` renders a progress bar as it iterates:

```ts
await this.withProgress(users, async (user) => {
  await sendDigest(user)
})
```

## Prompting

When a command is run by a human, it can ask questions:

```ts
const name = await this.ask('Project name?', 'my-app')
const proceed = await this.confirm('Drop the staging database?')
const env = await this.choice('Target environment', ['staging', 'production'])
const token = await this.secret('API token')
```

These read from stdin, so guard them behind a `--force`-style option if the command also runs unattended (in CI or on a schedule).

## Registering Commands

Nothing scans `app/Console/Commands` for you. A generated command is dead code until a kernel registers it — deliberately, so that deployments never depend on filesystem globbing.

Scaffolded apps ship `src/console.ts` for exactly this:

```ts
import { ConsoleKernel } from '@guren/core'
import SendDigestCommand from '../app/Console/Commands/SendDigestCommand.js'
import app from './app.js'

export const kernel = new ConsoleKernel({ container: app.container })

kernel.registerMany([SendDigestCommand])
```

Passing `app.container` lets commands resolve services with `this.resolve()`. `register(OneCommand)` is equivalent for a single class.

If your project predates this file, create it yourself — the export must be named `kernel`, since the deployment recipes import it by that name.

## Running Commands

`bin/console.ts` boots the application, then hands `argv` to the kernel:

```ts
import { ready } from '../src/main.js'
import { kernel } from '../src/console.js'

await ready

process.exit(await kernel.handle(process.argv.slice(2)))
```

Scaffolded apps expose it as a `console` script:

```bash
bun run console send-digest
bun run console users:create ada@example.com --admin
```

The kernel handles three names on its own, so discovery needs no code of your own:

```bash
bun run console list              # every registered command, as a table
bun run console                   # every registered command, grouped by namespace
bun run console help users:create # usage, arguments, and options for one command
```

An unrecognised name exits `1` and suggests the closest matches.

Note that `bin/console.ts` boots the application before dispatching, so even
`list` pays that cost — and in a development app with migrations, boot also runs
your seeders. Reach for `list` and `help` freely in development; on a deployed
environment, remember the invocation is a full boot.

`kernel.handle()` resolves to the exit code rather than terminating the process, which is what makes it testable:

```ts
import { beforeEach, expect, test } from 'bun:test'
import { BufferedOutput } from '@guren/core'
import { kernel } from '../src/console'

let output: BufferedOutput

// `setOutput()` replaces the kernel's output with no restore path, and the
// kernel is a module singleton — install a fresh buffer per test so one
// test's output never lands in another's assertions.
beforeEach(() => {
  output = new BufferedOutput()
  kernel.setOutput(output)
})

test('send-digest reports how many digests went out', async () => {
  expect(await kernel.handle(['send-digest'])).toBe(0)
  expect(output.contains('Done!')).toBe(true)
})
```

## Calling One Command From Another

`this.call()` runs another registered command and returns its exit code:

```ts
async handle(): Promise<number | void> {
  const code = await this.call('cache:clear')

  if (code !== 0) {
    this.error('Could not clear the cache; aborting.')
    return code
  }
}
```

This requires the calling command to have been dispatched through a kernel — `this.call()` throws when a command is instantiated directly.

## Modules

Commands scaffolded with `--module` land under `modules/<name>/app/Console/Commands/`. There is no per-module console kernel, so register them in the same root `src/console.ts` — but export them from the module's `index.ts` first. Importing the command file directly reaches into the module's internals, which `bunx guren check --arch` reports as a failure:

```ts
// modules/billing/index.ts
export { default as InvoiceCommand } from './app/Console/Commands/InvoiceCommand.js'
```

```ts
// src/console.ts
import { InvoiceCommand } from '../modules/billing/index.js'

kernel.registerMany([InvoiceCommand])
```

## Running in Deployed Environments

Where the kernel runs depends on the platform:

- **A long-lived server or container** — run `bun run console <command>` inside it, the same way you would locally. This is also how you drive commands from a container-based scheduler or cron entry.
- **Serverless** — export a dedicated handler that feeds the kernel and deploy it as its own function. See the [serverless guide](./serverless.md) for the `createConsoleHandler(kernel)` adapter and how to invoke it.

Commands that touch the database need the application booted first, which is why `bin/console.ts` awaits `ready` before dispatching. Skipping the boot leaves models unconfigured and every query fails.

For work that should run *on a timer* rather than on demand, see the [task scheduling guide](./scheduling.md) — a scheduler can invoke commands, and the two subsystems are separate on purpose.
