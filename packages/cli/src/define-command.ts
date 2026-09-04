import { defineCommand as defineCittyCommand } from 'citty'
import type { ArgsDef, CommandContext, CommandDef } from 'citty'

/**
 * citty's `defineCommand`, with one rule added: a repeated flag is worth its
 * last value.
 *
 * citty types every `string` arg as `string` and every `boolean` arg as
 * `boolean`, then hands back an array when the flag is passed twice — a lie no
 * compiler catches, and one that surfaces differently at every place the value
 * is then read. Measured on this bin before the rule existed, three shapes
 * crashed: `make:migration --name a --name b` inside `makeMigration()` on
 * `options.name?.trim is not a function`, `context --entity User --entity User`
 * on `entityName.toLowerCase is not a function`, and `context --app . --app .`
 * inside `resolve()` on `The "paths[0]" property must be of type string, got
 * array`.
 *
 * The quiet ones are the reason the rule lives here rather than at each read:
 * `make:migration --schema a.ts --schema b.ts` comma-joined them into a path
 * nothing can open and still exited 0; `context --module app --module app`
 * exited 1 blaming a module named `app,app`; and for booleans, every array is
 * truthy, so `Boolean(args.json)` — which reads as safe — turned
 * `--json=false --json=false` into *on*. Only the `=value` spellings can
 * express a false, so a bare `--json --json` never showed it, which is what let
 * the defect survive casual testing. A per-command helper fixed four commands
 * and left the other fifty reading raw; this wrapper is what makes the rule
 * impossible to bypass, and `tests/define-command.test.ts` gates every built-in
 * command on having gone through it.
 *
 * Positionals live in `_` and are left alone.
 */
export function defineCommand<T extends ArgsDef = ArgsDef>(def: CommandDef<T>): CommandDef<T> {
  const { args, setup, run } = def

  // citty runs `setup` before `run` on the same context object, so whichever
  // hook a command declares first sees normalized flags. Both are wrapped
  // because neither is required and the normalization is idempotent. citty
  // awaits both hooks, so resolving a lazy `args` here is free.
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
 * Collapse every repeated flag on a parsed citty `args` object to its last
 * value, in place, and give declared booleans the type citty gave only their
 * declared spelling.
 *
 * citty hands `run` a Proxy whose `get` falls back from `dryRun` to `dry-run`
 * and back; it has no `set` or `ownKeys` trap, so the keys enumerated and the
 * assignments made here land on the underlying record — the one the Proxy
 * reads through.
 *
 * The second half exists because citty registers only the *declared* name as a
 * boolean with its parser (`parseOptions.boolean.push(arg.name)`). An arg
 * declared `dryRun` and spelled `--dry-run` therefore misses the branch that
 * turns `"false"` into `false`, and arrives as the *string* `"false"` — which
 * is truthy, so last-wins would not hold for the spelling this CLI actually
 * documents. Only the two literals are coerced: citty's own boolean branch
 * does more than that (it pushes an unrecognized value onto `_` and keeps the
 * flag `true`), and replicating that here would move positionals around rather
 * than fix a type.
 *
 * Declared *strings* are deliberately left as citty leaves them. The same
 * declared-name gap applies, but the values it produces are already truthy
 * strings or numbers rather than a false that reads as true, and every string
 * flag the CLI narrowed by hand before this wrapper is single-word or
 * kebab-declared, so citty types all of them natively.
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
 * The identity a stored key and a declared name share when they are two
 * spellings of one flag.
 *
 * citty's Proxy resolves a declared name through its own `camelCase` and
 * `kebabCase` (from `scule`), which this package does not depend on. Erasing
 * dashes and case instead is looser than reimplementing them and cannot miss a
 * spelling either of them would produce; the cost is that two args whose names
 * differ only in dashes and case would collide, which the caller above handles
 * by declining to coerce any spelling that is also declared as a non-boolean.
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
 * `tests/define-command.test.ts` asserts it for every built-in command, which
 * is what turns "import from `./define-command`, not from `citty`" from a
 * convention into a gate.
 */
export function normalizesRepeatedFlags(command: object): boolean {
  return (command as Record<symbol, unknown>)[LAST_FLAG_WINS] === true
}
