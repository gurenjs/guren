/**
 * The one rule for which `commands` entry a plan may carry (RFC 0030 §8): `guren <subcommand>`
 * or `bunx guren <subcommand>`, a subcommand classified as a generator below, and arguments in a
 * character set no shell reads as syntax, naming no absolute path and no `..`. It bounds shell
 * syntax and filesystem roots, not each generator's other flags. `--x==ls` expands only under
 * zsh's opt-in magicequalsubst. `validate.ts` (§2), `plan:next` and `check --plan` judge through
 * `refusedPlanCommands()`; `tests/plan-command-allowlist.test.ts` holds the table to the registry.
 */

import type { PlanCommand } from './schema'

/** A registry command whose own subcommands are what a plan names: `add attachments`, never `add`. */
export const PLAN_COMMAND_GROUPS: ReadonlySet<string> = new Set(['add'])

const DENIALS = {
  'reads-only': 'it reads or reports and changes nothing, so a setup step running it leaves nothing to verify',
  derived: "it regenerates files derived from the code, which are stale when generated before the plan's changes; the step's verify commands run codegen",
  migration: "it generates a migration from db/schema.ts as it stands, before the plan's schema changes exist; the data step owns migrations",
  database: 'it reads or writes a database or a queue store',
  process: "it runs the application's code, its scripts or a model call rather than writing files",
  dependencies: 'it installs or upgrades packages named at run time, or scaffolds a separate application',
  environment: "it writes or prints this machine's app key, config cache or links, not application source",
  deploy: 'it writes deployment recipes, which a plan does not describe',
  plan: 'it acts on plans, and a plan does not run the commands that judge it',
  harness: 'it rewrites the agent harness (rules, skills, hooks) that governs the agent running the plan',
} as const

export type PlanCommandDenial = keyof typeof DENIALS

/**
 * Every registry command, `add`'s blueprints as `add <name>`: `generator` is allowed, anything
 * else names why not. A name missing here is refused as unclassified, and the test fails.
 */
export const PLAN_COMMAND_CLASSES: Readonly<Record<string, 'generator' | PlanCommandDenial>> = Object.assign(Object.create(null), {
  'make:controller': 'generator',
  'make:model': 'generator',
  'make:view': 'generator',
  'make:route': 'generator',
  'make:job': 'generator',
  'make:event': 'generator',
  'make:mail': 'generator',
  'make:middleware': 'generator',
  'make:policy': 'generator',
  'make:seeder': 'generator',
  'make:notification': 'generator',
  'make:provider': 'generator',
  'make:adr': 'generator',
  'make:validator': 'generator',
  'make:agent': 'generator',
  'make:ai-agent': 'generator',
  'make:module': 'generator',
  'make:channel': 'generator',
  'make:command': 'generator',
  'make:exception': 'generator',
  'make:factory': 'generator',
  'make:listener': 'generator',
  'make:resource': 'generator',
  'make:test': 'generator',
  'make:lang': 'generator',
  'make:feature': 'generator',
  'lang:publish': 'generator',
  'add admin': 'generator',
  'add attachments': 'generator',
  'add broadcasting': 'generator',
  'add cache': 'generator',
  'add events': 'generator',
  'add lint': 'generator',
  'add mail': 'generator',
  'add notifications': 'generator',
  'add queue': 'generator',
  'add resource': 'generator',
  'add prototype': 'generator',
  'add schedule': 'generator',
  'add storage': 'generator',
  // These run the app's own drizzle-kit, which imports db/schema.ts: the app tree is trusted already.
  'make:auth': 'generator',
  'add auth': 'generator',
  'add oauth': 'generator',
  'add session': 'generator',
  // As above, and `bun add` of a fixed set: the first-party plugin and the AI SDK at @guren/cli's own ranges.
  'add ai': 'generator',
  'add plugin': 'dependencies',
  'make:migration': 'migration',
  codegen: 'derived',
  'routes:types': 'derived',
  'spec:generate': 'derived',
  'openapi:generate': 'derived',
  'env:example': 'derived',
  'docs:graph': 'reads-only',
  'route:list': 'reads-only',
  'model:list': 'reads-only',
  'tool:list': 'reads-only',
  'tool:inspect': 'reads-only',
  'tool:log': 'reads-only',
  'schedule:list': 'reads-only',
  'lang:list': 'reads-only',
  context: 'reads-only',
  check: 'reads-only',
  audit: 'reads-only',
  doctor: 'reads-only',
  guidelines: 'reads-only',
  'db:migrate': 'database',
  'db:seed': 'database',
  'db:reset': 'database',
  'db:fresh': 'database',
  'db:rollback': 'database',
  'db:status': 'database',
  'queue:failed': 'database',
  'queue:retry': 'database',
  'queue:flush': 'database',
  'token:issue': 'database',
  'queue:work': 'process',
  'schedule:run': 'process',
  'tool:call': 'process',
  'tool:dev': 'process',
  'health:check': 'process',
  'ai:eval': 'process',
  console: 'process',
  dev: 'process',
  gate: 'process',
  plugin: 'dependencies',
  upgrade: 'dependencies',
  new: 'dependencies',
  'key:generate': 'environment',
  'config:cache': 'environment',
  'config:clear': 'environment',
  'config:show': 'environment',
  'storage:link': 'environment',
  deploy: 'deploy',
  'plan:render': 'plan',
  'plan:approve': 'plan',
  'plan:status': 'plan',
  'plan:verify': 'plan',
  'plan:next': 'plan',
  'plan:waive': 'plan',
  'plan:close': 'plan',
  'agent:init': 'harness',
  'agent:sync': 'harness',
})

export const PLAN_COMMAND_FORM = '`guren <subcommand> [args…]` or `bunx guren <subcommand> [args…]`'

export type PlanCommandVerdict = { allowed: true; subcommand: string; args: string[] } | { allowed: false; reason: string }

interface Word {
  text: string
  quoted: boolean
}

/** Outside quotes: letters, digits and punctuation no POSIX shell treats as syntax or a glob. */
const BARE = /^[\p{L}\p{N}\p{M}_\-.,:/=@+%]$/u
/** Inside quotes: that, a space, and `?` (a nullable `--fields` type). No `$`, backtick or `\`, which double quotes still read. */
const QUOTED = /^[\p{L}\p{N}\p{M}_\-.,:/=@+% ?]$/u
/** What `JSON.stringify` leaves raw and a terminal or a page may still act on: DEL, C1, line separators, format characters. */
const UNSAFE_IN_QUOTE = /[\u007F-\u009F\u2028\u2029\p{Cf}]/gu

function codePoint(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
}

function describeCharacter(char: string): string {
  if (char === '\n' || char === '\r') return 'a line break'
  if (/\p{C}/u.test(char)) return `the control or invisible character ${codePoint(char)}`
  if (/\p{Z}/u.test(char)) return `the space or separator ${codePoint(char)}`
  return `"${char}"`
}

/** A command as a message may quote it: JSON-escaped, and every character {@link UNSAFE_IN_QUOTE} matches as a `\u` escape too. */
export function quotePlanCommand(command: string): string {
  return JSON.stringify(command).replace(UNSAFE_IN_QUOTE, (char) => {
    const code = char.codePointAt(0)!
    return code > 0xffff ? `\\u{${code.toString(16).toUpperCase()}}` : `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
  })
}

/**
 * Splits on single spaces with `'…'` and `"…"` quoting, and reads nothing else: an escape, an
 * unbalanced quote or any character outside the sets above makes the command unreadable. The
 * other quote inside a quoted segment is literal, as the shells read it.
 */
export function tokenizePlanCommand(command: string): { words: Word[] } | { unreadable: string } {
  const words: Word[] = []
  let current: Word | undefined
  let quote: '"' | "'" | undefined
  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else if (QUOTED.test(char) || char === '"' || char === "'") current!.text += char
      else return { unreadable: `${describeCharacter(char)} inside quotes is not a character a plan command may carry` }
      continue
    }
    if (char === ' ') {
      if (current) words.push(current)
      current = undefined
    } else if (char === '"' || char === "'") {
      quote = char
      current ??= { text: '', quoted: false }
      current.quoted = true
    } else if (char === '=' && (current === undefined || current.text === '')) {
      // zsh expands a word opening with `=` to a command's path, `""=ls` included.
      return { unreadable: 'a word opening with "=" is not something a plan command may carry' }
    } else if (BARE.test(char)) {
      current ??= { text: '', quoted: false }
      current.text += char
    } else {
      return { unreadable: `${describeCharacter(char)} is not a character a plan command may carry` }
    }
  }
  if (quote !== undefined) return { unreadable: `a ${quote} quote is never closed` }
  if (current) words.push(current)
  return { words }
}

const isBare = (word: Word | undefined, text: string): boolean => word?.text === text && !word.quoted

function programLength(words: Word[]): number {
  if (isBare(words[0], 'guren')) return 1
  if (isBare(words[0], 'bunx') && isBare(words[1], 'guren')) return 2
  return 0
}

/** `lang:publish --path` and the like take a directory, so each `=`-separated part of a word is held inside the app. */
function leavesApp(arg: string): boolean {
  return arg.split('=').some((part) => part.startsWith('/') || part.split('/').includes('..'))
}

export function judgePlanCommand(command: string): PlanCommandVerdict {
  const tokens = tokenizePlanCommand(command)
  if ('unreadable' in tokens) return { allowed: false, reason: tokens.unreadable }
  const words = tokens.words
  const program = programLength(words)
  if (program === 0) return { allowed: false, reason: `it is not of the form ${PLAN_COMMAND_FORM}` }

  const name = words[program]
  if (name === undefined || name.quoted || name.text.startsWith('-')) {
    return { allowed: false, reason: `the subcommand has to follow "guren" directly and unquoted` }
  }
  let subcommand = name.text
  let rest = program + 1
  if (PLAN_COMMAND_GROUPS.has(subcommand)) {
    const member = words[rest]
    if (member === undefined || member.quoted || member.text.startsWith('-')) {
      return { allowed: false, reason: `"${subcommand}" has to be followed directly by what it adds, unquoted` }
    }
    subcommand = `${subcommand} ${member.text}`
    rest += 1
  }

  const commandClass = PLAN_COMMAND_CLASSES[subcommand]
  if (commandClass === undefined) return { allowed: false, reason: `"${subcommand}" is not a subcommand classified for plans` }
  if (commandClass !== 'generator') return { allowed: false, reason: `"${subcommand}" is not a generator: ${DENIALS[commandClass]}` }
  const args = words.slice(rest).map((word) => word.text)
  const escaping = args.find(leavesApp)
  if (escaping !== undefined) {
    return { allowed: false, reason: `the argument "${escaping}" names an absolute path or leaves the application through ".."` }
  }
  return { allowed: true, subcommand, args }
}

export interface RefusedPlanCommand {
  id: string
  /** The command as {@link quotePlanCommand} escapes it, safe to print. */
  quoted: string
  reason: string
}

export function refusedPlanCommands(commands: ReadonlyArray<Pick<PlanCommand, 'id' | 'command'>>): RefusedPlanCommand[] {
  return commands.flatMap(({ id, command }) => {
    const verdict = judgePlanCommand(command)
    return verdict.allowed ? [] : [{ id, quoted: quotePlanCommand(command), reason: verdict.reason }]
  })
}
