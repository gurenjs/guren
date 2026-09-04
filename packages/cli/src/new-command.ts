import { spawn } from 'node:child_process'
import { defineCommand } from './define-command'

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
 * A thin forwarder to `create-guren-app`, so the transport is `ctx.rawArgs`
 * and the child parses with its own declarations. The `args` block below is
 * documentation for `guren new --help` only, kept in sync with
 * `packages/create-app/src/cli.ts` by hand. Do not reintroduce a parsed-arg
 * translation table: citty parses an undeclared string flag as boolean `true`
 * and leaks its value into `args._`, which is how `guren new app --db
 * postgres` silently scaffolded a SQLite app.
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
        // Not enumerated here: create-guren-app owns the list. A copy here is
        // how `blog` stayed advertised after it was dropped from that registry.
        description: 'Application blueprint to scaffold (see `create-guren-app --help`).',
      },
      db: {
        type: 'string',
        description: 'Database driver (sqlite, postgres, mysql)',
      },
      install: {
        type: 'boolean',
        description: 'Install dependencies after scaffolding (default: true)',
      },
      git: {
        type: 'boolean',
        description: 'Initialize a git repository and create an initial commit (prompted when interactive, off otherwise)',
      },
    },
    async run(ctx) {
      await runCreateApp(['x', 'create-guren-app', ...ctx.rawArgs])
    },
  })
}

export const newCommand = createNewCommand()
