/**
 * Every `bunx guren <command>` in the docs must name a command the CLI registers:
 * a builtin, or one a first-party plugin declares in `gurenPlugin.commands`.
 * An app console command (`attachments:prune`) is the usual miss: it runs
 * through `bun run console`, and `bunx guren` answers `Unknown command`.
 * Flags are not checked here; `add` and friends derive theirs per blueprint.
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
}

export interface UnknownCliCommand {
  file: string
  line: number
  command: string
  consoleCommand: boolean
}

// A trailing `:` is a placeholder (`make:<name>`, `make:*`), not a command.
const INVOCATION_RE = /\bbunx\s+guren\s+([a-z][a-z0-9-]*(?::[a-z0-9-]+)*)(:?)/gu
const CONSOLE_SIGNATURE_RE = /\bstatic\s+(?:override\s+)?signature\s*=\s*['"`]([a-z][a-z0-9:-]*)/gu
// A plugin-authoring page declares an example command in a manifest fence.
const MANIFEST_NAMES_RE = /"names"\s*:\s*\[([^\]]*)\]/gu

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

  return { registered, consoleCommands }
}

export function unknownCommandsIn(markdown: string, file: string, known: KnownCliCommands): UnknownCliCommand[] {
  const declaredHere = new Set<string>()
  for (const match of markdown.matchAll(MANIFEST_NAMES_RE)) {
    for (const quoted of match[1]!.matchAll(/"([^"]+)"/gu)) declaredHere.add(quoted[1]!)
  }

  const unknown: UnknownCliCommand[] = []
  for (const [index, text] of markdown.split('\n').entries()) {
    for (const [, command, placeholder] of text.matchAll(INVOCATION_RE)) {
      if (placeholder || known.registered.has(command!) || declaredHere.has(command!)) continue
      unknown.push({ file, line: index + 1, command: command!, consoleCommand: known.consoleCommands.has(command!) })
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

export function formatUnknownCliCommand({ file, line, command, consoleCommand }: UnknownCliCommand): string {
  const fix = consoleCommand
    ? `It is a console command the app registers: write \`bun run console ${command}\`.`
    : 'It is neither a builtin nor a command a first-party plugin declares.'
  return `${file}:${line} runs \`bunx guren ${command}\`, which the CLI does not register. ${fix}`
}
