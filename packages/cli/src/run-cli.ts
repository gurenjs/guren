import { consola } from 'consola'
import { runCommand, showUsage } from 'citty'
import type { CommandDef } from 'citty'

type AnyCommandDef = CommandDef<any>

async function resolveValue<T>(input: T | (() => T | Promise<T>)): Promise<T> {
  return typeof input === 'function' ? await (input as () => T | Promise<T>)() : await input
}

async function resolveSubCommand(
  cmd: AnyCommandDef,
  rawArgs: string[],
  parent?: AnyCommandDef,
): Promise<[AnyCommandDef, AnyCommandDef | undefined]> {
  const subCommands = await resolveValue(cmd.subCommands)
  if (subCommands && Object.keys(subCommands).length > 0) {
    const index = rawArgs.findIndex((arg) => !arg.startsWith('-'))
    const name = rawArgs[index]
    const declared = name !== undefined && Object.prototype.hasOwnProperty.call(subCommands, name)
    const subCommand = declared ? await resolveValue(subCommands[name]) : undefined
    if (subCommand) {
      return resolveSubCommand(subCommand, rawArgs.slice(index + 1), cmd)
    }
  }
  return [cmd, parent]
}

/**
 * Raised by a command whose arguments cannot be dispatched, so `runCli` reports
 * it the way it reports citty's own dispatch failures: usage, then the message,
 * exit code 1.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

function isUsageError(error: unknown): error is Error {
  // citty raises `CLIError` for its own dispatch failures but does not export
  // the class; commands raise `UsageError` for the same class of failure.
  return error instanceof UsageError || (error instanceof Error && error.name === 'CLIError')
}

/**
 * Stands in for citty's `runMain`, which reports a thrown error twice and exits the
 * process itself; this returns the exit code instead. Upgrading citty does not remove the
 * need: 0.2.x still calls `process.exit()` from inside `runMain` and reports through
 * `console.error`, bypassing consola's log level. `resolveValue`/`resolveSubCommand`
 * mirror unexported citty 0.1.6 internals; `tests/bin-error-output.test.ts` covers them.
 */
export async function runCli(cmd: AnyCommandDef, rawArgs: string[]): Promise<number> {
  const usage = async (): Promise<void> => {
    await showUsage(...(await resolveSubCommand(cmd, rawArgs)))
  }

  const failWithUsage = async (message: string): Promise<number> => {
    await usage()
    consola.error(message)
    return 1
  }

  try {
    if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
      await usage()
      return 0
    }

    if (rawArgs.length === 1 && rawArgs[0] === '--version') {
      const meta = await resolveValue(cmd.meta)
      if (!meta?.version) {
        return failWithUsage('No version specified')
      }
      // Plain stdout, like every command that prints a payload rather than a diagnostic.
      // consola's non-TTY reporter would prefix the level (`[log] 2.6.1`), and a
      // configured log level can drop the line entirely.
      console.log(meta.version)
      return 0
    }

    await runCommand(cmd, { rawArgs })
    return 0
  } catch (error) {
    if (isUsageError(error)) {
      return failWithUsage(error.message)
    }
    // Non-Error throwables (Bun's ResolveMessage, for one) render as an
    // empty object when handed to consola directly, hiding the message.
    consola.error(error instanceof Error ? error : String(error))
    return 1
  }
}
