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
 */
export async function runCli(cmd: AnyCommandDef, rawArgs: string[]): Promise<number> {
  try {
    if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
      await showUsage(...(await resolveSubCommand(cmd, rawArgs)))
      return 0
    }

    if (rawArgs.length === 1 && rawArgs[0] === '--version') {
      const meta = await resolveValue(cmd.meta)
      if (!meta?.version) {
        await showUsage(...(await resolveSubCommand(cmd, rawArgs)))
        consola.error('No version specified')
        return 1
      }
      consola.log(meta.version)
      return 0
    }

    await runCommand(cmd, { rawArgs })
    return 0
  } catch (error) {
    if (isUsageError(error)) {
      await showUsage(...(await resolveSubCommand(cmd, rawArgs)))
      consola.error(error.message)
    } else {
      // Non-Error throwables (Bun's ResolveMessage, for one) render as an
      // empty object when handed to consola directly, hiding the message.
      consola.error(error instanceof Error ? error : String(error))
    }
    return 1
  }
}
