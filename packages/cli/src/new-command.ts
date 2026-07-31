import { spawn } from 'node:child_process'
import { defineCommand } from 'citty'

export type CommandRunner = (args: string[]) => Promise<void>

async function runBunCommand(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath || 'bun', args, {
      stdio: 'inherit',
      env: process.env,
    })

    child.on('error', (error) => {
      rejectPromise(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
      } else {
        rejectPromise(new Error(`bun ${args.join(' ')} exited with code ${code}`))
      }
    })
  })
}

/**
 * `guren new` is a thin forwarder to `create-guren-app`, so the transport is
 * `ctx.rawArgs` — citty hands over exactly the argv that followed the
 * subcommand name, which the child then parses with its own declarations.
 *
 * The `args` block below exists **only** so `guren new --help` stays useful
 * (`runCli` intercepts `--help` before `run()` is ever reached). citty still
 * parses it on the way in; `run()` just ignores the result. Do not reintroduce
 * a parsed-arg translation table: an undeclared string flag does not merely get
 * dropped by citty, it parses as boolean `true` and leaks its value into
 * `args._` — which is how `guren new app --db postgres` silently scaffolded a
 * SQLite app.
 *
 * Keep these declarations in sync with `packages/create-app/src/cli.ts` by
 * hand; they are documentation, and only the child enforces them.
 */
export function createNewCommand(runCreateApp: CommandRunner = runBunCommand) {
  return defineCommand({
    meta: {
      name: 'new',
      description: 'Scaffold a new Guren application via create-guren-app.',
    },
    args: {
      target: {
        type: 'positional',
        description: 'Directory to create the application in',
        default: '.',
      },
      force: {
        type: 'boolean',
        alias: 'f',
        description: 'Overwrite existing files in the target directory',
      },
      mode: {
        type: 'string',
        description: 'Rendering mode to scaffold (spa or ssr)',
      },
      auth: {
        type: 'boolean',
        description: 'Include authentication scaffolding',
      },
      blueprint: {
        type: 'string',
        description: 'Starter blueprint to scaffold (default, api, blog, worker)',
      },
      db: {
        type: 'string',
        description: 'Database driver (sqlite, postgres, mysql)',
      },
      install: {
        type: 'boolean',
        description: 'Install dependencies after scaffolding (default: true)',
      },
    },
    async run(ctx) {
      await runCreateApp(['x', 'create-guren-app', ...ctx.rawArgs])
    },
  })
}

export const newCommand = createNewCommand()
