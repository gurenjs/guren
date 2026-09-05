/**
 * citty's `defineCommand`, wrapped so a repeated flag is worth its last value.
 *
 * citty arrays a repeated flag whatever its declared type, and every array is
 * truthy, so `Boolean(args.json)` reads `--json=false --json=false` as *on*.
 * Only the `=value` spellings can express a false, which is what lets that
 * survive casual testing. citty also registers only the *declared* arg name
 * with its parser, so `--dry-run=false` on an arg declared `dryRun` misses the
 * branch that types it and arrives as the truthy string `"false"`.
 */
import { defineCommand as defineCittyCommand } from 'citty'
import type { ArgsDef, CommandContext, CommandDef } from 'citty'

/** Positionals live in `_` and are left alone. */
export function defineCommand<T extends ArgsDef = ArgsDef>(def: CommandDef<T>): CommandDef<T> {
  const { args, setup, run } = def

  // citty awaits both hooks on one context object, so resolving a lazy `args`
  // here is free and whichever hook a command declares first sees normalized
  // flags. Both are wrapped: neither is required, and the pass is idempotent.
  const normalize = async (context: CommandContext<T>): Promise<void> => {
    const argsDef = (typeof args === 'function' ? await args() : await args) ?? {}
    normalizeParsedArgs(context.args, argsDef as ArgsDef)
  }

  const command: CommandDef<T> = { ...def }
  if (setup) {
    command.setup = async (context: CommandContext<T>) => {
      await normalize(context)
      return setup(context)
    }
  }
  if (run) {
    command.run = async (context: CommandContext<T>) => {
      await normalize(context)
      return run(context)
    }
  }

  const defined = defineCittyCommand(command)
  Object.defineProperty(defined, LAST_FLAG_WINS, { value: true })
  return defined
}

/**
 * Collapse repeated flags to their last value and type declared booleans, in
 * place. citty's `args` Proxy has no `set` or `ownKeys` trap, so the keys
 * enumerated and the assignments made here land on the record it reads through.
 * Only `"true"` and `"false"` are coerced: citty's boolean branch also pushes an
 * unrecognized value onto `_`, and moving positionals is not this rule's job.
 */
export function normalizeParsedArgs(args: Record<string, unknown>, argsDef: ArgsDef): void {
  for (const key of Object.keys(args)) {
    if (key === '_') continue
    const value = args[key]
    if (Array.isArray(value)) {
      args[key] = value.at(-1)
    }
  }

  const booleanSpellings = new Set<string>()
  const otherSpellings = new Set<string>()
  for (const [name, arg] of Object.entries(argsDef)) {
    const target = arg.type === 'boolean' ? booleanSpellings : otherSpellings
    target.add(spellingKey(name))
    for (const alias of toArray((arg as { alias?: string | string[] }).alias)) {
      target.add(spellingKey(alias))
    }
  }

  // Declared strings are left as citty leaves them: the same declared-name gap
  // yields a truthy string or a number there, not a false that reads as true.
  for (const key of Object.keys(args)) {
    if (key === '_') continue
    const spelling = spellingKey(key)
    if (!booleanSpellings.has(spelling) || otherSpellings.has(spelling)) continue
    const value = args[key]
    if (value === 'true') args[key] = true
    else if (value === 'false') args[key] = false
  }
}

/**
 * The identity a stored key and a declared name share when they spell one flag.
 * citty's Proxy resolves a name through `scule`'s camelCase/kebabCase, which this
 * package does not depend on; erasing dashes and case is looser and cannot miss a
 * spelling either produces. Two args differing only in dashes and case collide,
 * which the caller handles by skipping any spelling also declared non-boolean.
 */
function spellingKey(name: string): string {
  return name.replaceAll('-', '').toLowerCase()
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

const LAST_FLAG_WINS = Symbol('guren.cli.lastFlagWins')

/**
 * Whether a command definition went through this module's `defineCommand`.
 * `tests/define-command.test.ts` asserts it for every entry of
 * `builtinSubCommands`, which is what makes importing citty's own
 * `defineCommand` fail rather than silently opt a command out.
 */
export function normalizesRepeatedFlags(command: object): boolean {
  return (command as Record<symbol, unknown>)[LAST_FLAG_WINS] === true
}
