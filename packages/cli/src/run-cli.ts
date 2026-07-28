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

function isUsageError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'CLIError'
}

/**
 * Stands in for citty's `runMain`, which reports a thrown error twice — once
 * with its stack and once as a bare message — before exiting the process
 * itself, leaving callers no way to intervene. Returns the exit code instead
 * of exiting so the caller decides how the process ends.
 *
 * Upgrading citty does not remove the need for this wrapper: 0.2.x prints the
 * error once but still calls `process.exit()` from inside `runMain`, and it
 * reports through `console.error` rather than `consola`, which would bypass
 * the log level the rest of the CLI honours. A citty major bump is also a
 * breaking change for plugin authors, who write `CommandDef`s against it.
 *
 * `resolveValue` and `resolveSubCommand` mirror internals citty 0.1.6 does not
 * export; `tests/bin-error-output.test.ts` covers them end to end so drift on
 * an upgrade surfaces there.
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
      consola.log(meta.version)
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
