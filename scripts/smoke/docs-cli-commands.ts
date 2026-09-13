/**
 * Every `bunx guren <command>` in the docs must name a command the CLI registers:
 * a builtin, or one a first-party plugin declares in `gurenPlugin.commands`.
 * An app console command (`attachments:prune`) is the usual miss: it runs
 * through `bun run console`, and `bunx guren` answers `Unknown command`.
 * Flags are checked only on builtins without subcommands, because an undeclared
 * flag is ignored without an error; `add` routes flags to its blueprints.
 */
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { builtinSubCommands } from '../../packages/cli/src/commands'
import type { GurenPluginManifest } from '../../packages/cli/src/plugin-manifest'
import { collectPackages, repoRoot } from '../workspace-packages'
import { markdownFiles } from './docs-import-sources'

export interface KnownCliCommands {
  registered: Set<string>
  /** Console commands the framework ships, for which `bun run console` is the fix. */
  consoleCommands: Set<string>
  /** Long flag names per builtin whose flags are its own to parse. */
  flags: Map<string, Set<string>>
}

export interface UnknownCliCommand {
  file: string
  line: number
  command: string
  consoleCommand: boolean
  /** Set when the command exists but does not declare this flag. */
  flag?: string
}

interface ArgDef {
  type?: string
  alias?: string | string[]
}

type Resolvable<T> = T | Promise<T> | (() => T | Promise<T>)

interface CommandDef {
  args?: Resolvable<Record<string, ArgDef>>
  subCommands?: unknown
}

// A trailing `:` is a placeholder (`make:<name>`, `make:*`), not a command.
const INVOCATION_RE = /\bbunx\s+guren\s+([a-z][a-z0-9-]*(?::[a-z0-9-]+)*)(:?)/gu
// Where this invocation's arguments end: inline code, a shell separator, a comment.
const ARGUMENTS_END_RE = /`|&&|\|\||[;|]|\s#/u
const FLAG_RE = /(?:^|\s)--([a-z][a-z0-9-]*)/gu
const CONSOLE_SIGNATURE_RE = /\bstatic\s+(?:override\s+)?signature\s*=\s*['"`]([a-z][a-z0-9:-]*)/gu
// A plugin-authoring page declares an example command in a manifest fence.
const MANIFEST_NAMES_RE = /"names"\s*:\s*\[([^\]]*)\]/gu

async function declaredFlags(def: CommandDef): Promise<Set<string>> {
  const args = await (typeof def.args === 'function' ? def.args() : def.args)
  const flags = new Set(['help', 'version'])
  for (const [name, arg] of Object.entries(args ?? {})) {
    if (arg.type === 'positional') continue
    flags.add(name)
    if (arg.type === 'boolean') flags.add(`no-${name}`)
    for (const alias of [arg.alias ?? []].flat()) flags.add(alias)
  }
  return flags
}

export async function knownCliCommands(): Promise<KnownCliCommands> {
  const registered = new Set(Object.keys(builtinSubCommands))
  const manifests = await Promise.all(
    (await collectPackages()).map(
      async (pkg) => JSON.parse(await readFile(join(pkg.dir, 'package.json'), 'utf8')) as { gurenPlugin?: GurenPluginManifest },
    ),
  )
  for (const manifest of manifests) {
    for (const name of manifest.gurenPlugin?.commands?.names ?? []) registered.add(name)
  }

  const flags = new Map<string, Set<string>>()
  for (const [name, def] of Object.entries(builtinSubCommands as Record<string, CommandDef>)) {
    if (!def.subCommands) flags.set(name, await declaredFlags(def))
  }

  const sources: string[] = []
  for await (const path of new Bun.Glob('packages/*/src/**/*.ts').scan({ cwd: repoRoot })) {
    if (!path.endsWith('.test.ts')) sources.push(join(repoRoot, path))
  }
  const consoleCommands = new Set<string>()
  await Promise.all(
    sources.map(async (path) => {
      for (const match of (await readFile(path, 'utf8')).matchAll(CONSOLE_SIGNATURE_RE)) consoleCommands.add(match[1]!)
    }),
  )

  return { registered, consoleCommands, flags }
}

export function unknownCommandsIn(markdown: string, file: string, known: KnownCliCommands): UnknownCliCommand[] {
  const declaredHere = new Set<string>()
  for (const match of markdown.matchAll(MANIFEST_NAMES_RE)) {
    for (const quoted of match[1]!.matchAll(/"([^"]+)"/gu)) declaredHere.add(quoted[1]!)
  }

  const unknown: UnknownCliCommand[] = []
  for (const [index, text] of markdown.split('\n').entries()) {
    for (const match of text.matchAll(INVOCATION_RE)) {
      const [whole, name, placeholder] = match
      const command = name!
      if (placeholder || declaredHere.has(command)) continue
      const entry = { file, line: index + 1, command, consoleCommand: known.consoleCommands.has(command) }
      if (!known.registered.has(command)) {
        unknown.push(entry)
        continue
      }

      const declared = known.flags.get(command)
      if (!declared) continue
      const rest = text.slice(match.index + whole.length)
      const args = rest.split(ARGUMENTS_END_RE)[0]!
      for (const [, flag] of args.matchAll(FLAG_RE)) {
        if (!declared.has(flag!)) unknown.push({ ...entry, flag })
      }
    }
  }
  return unknown
}

export async function auditDocsCliCommands(root: string): Promise<UnknownCliCommand[]> {
  const known = await knownCliCommands()
  const unknown: UnknownCliCommand[] = []
  for (const path of await markdownFiles(join(root, 'docs'))) {
    unknown.push(...unknownCommandsIn(await readFile(path, 'utf8'), relative(root, path), known))
  }
  return unknown
}

export function formatUnknownCliCommand({ file, line, command, consoleCommand, flag }: UnknownCliCommand): string {
  if (flag) {
    return `${file}:${line} passes \`--${flag}\` to \`bunx guren ${command}\`, which declares no such flag. The CLI ignores it without an error.`
  }
  const fix = consoleCommand
    ? `It is a console command the app registers: write \`bun run console ${command}\`.`
    : 'It is neither a builtin nor a command a first-party plugin declares.'
  return `${file}:${line} runs \`bunx guren ${command}\`, which the CLI does not register. ${fix}`
}
