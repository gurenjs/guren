import { consola } from 'consola'
import { runCommand, showUsage } from 'citty'
import type { CommandDef } from 'citty'
import { CliError } from './cli-error'
import { runWithCommandStatus } from './command-status'
import { unknownCommandHint } from './unknown-command'

type AnyCommandDef = CommandDef<any>

/** citty's `Resolvable`, which citty does not export a resolver for. */
export async function resolveValue<T>(input: T | (() => T | Promise<T>)): Promise<T> {
  return typeof input === 'function' ? await (input as () => T | Promise<T>)() : await input
}

/** The command `rawArgs` dispatches to (the leaf), and its parent. */
export async function resolveSubCommand(
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

/** The name citty could not dispatch, and the names at that level it could have. */
async function findUnknownSubCommand(
  cmd: AnyCommandDef,
  rawArgs: string[],
): Promise<{ name: string; candidates: string[]; atRoot: boolean } | undefined> {
  let current = cmd
  let args = rawArgs
  let atRoot = true
  for (;;) {
    const subCommands = await resolveValue(current.subCommands)
    if (!subCommands || Object.keys(subCommands).length === 0) return undefined
    const index = args.findIndex((arg) => !arg.startsWith('-'))
    const name = args[index]
    if (name === undefined) return undefined
    if (!Object.prototype.hasOwnProperty.call(subCommands, name)) {
      return { name, candidates: Object.keys(subCommands), atRoot }
    }
    current = await resolveValue(subCommands[name])
    args = args.slice(index + 1)
    atRoot = false
  }
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

    return await runWithCommandStatus(() => runCommand(cmd, { rawArgs }))
  } catch (error) {
    if (isUsageError(error)) {
      const unknown =
        (error as { code?: unknown }).code === 'E_UNKNOWN_COMMAND' ? await findUnknownSubCommand(cmd, rawArgs) : undefined
      const hint = unknown && unknownCommandHint(unknown.name, unknown.candidates, unknown.atRoot)
      return failWithUsage(hint ? `${error.message}\n${hint}` : error.message)
    }
    if (error instanceof CliError) {
      consola.error(error.message)
      return 1
    }
    // Non-Error throwables (Bun's ResolveMessage, for one) render as an
    // empty object when handed to consola directly, hiding the message.
    consola.error(error instanceof Error ? error : String(error))
    return 1
  }
}
