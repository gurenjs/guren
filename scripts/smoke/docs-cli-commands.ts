/**
 * Every `bunx guren <command>` in the docs must name a command the CLI registers:
 * a builtin, or one a first-party plugin declares in `gurenPlugin.commands`.
 * An app console command (`attachments:prune`) is the usual miss: it runs
 * through `bun run console`, and `bunx guren` answers `Unknown command`.
 * Flags are not checked here; `add` and friends derive theirs per blueprint.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { builtinSubCommands } from '../../packages/cli/src/commands'

export interface UnknownCliCommand {
  file: string
  line: number
  command: string
  /** A console command the framework ships, so `bun run console` is the fix. */
  consoleCommand: boolean
}

// A trailing `:` is a placeholder (`make:<name>`, `make:*`), not a command.
const INVOCATION_RE = /\bbunx\s+guren\s+([a-z][a-z0-9-]*(?::[a-z0-9-]+)*)(:?)/gu
const CONSOLE_SIGNATURE_RE = /\bstatic\s+(?:override\s+)?signature\s*=\s*['"`]([a-z][a-z0-9:-]*)/gu
// A plugin-authoring page declares an example command in a manifest fence.
const MANIFEST_NAMES_RE = /"names"\s*:\s*\[([^\]]*)\]/gu

async function packageDirs(root: string): Promise<string[]> {
  const entries = await readdir(join(root, 'packages'), { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, 'packages', entry.name))
}

export async function registeredCliCommands(root: string): Promise<Set<string>> {
  const names = new Set(Object.keys(builtinSubCommands))
  for (const dir of await packageDirs(root)) {
    let manifest: { gurenPlugin?: { commands?: { names?: unknown } } }
    try {
      manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const declared = manifest.gurenPlugin?.commands?.names
    if (Array.isArray(declared)) {
      for (const name of declared) if (typeof name === 'string') names.add(name)
    }
  }
  return names
}

export async function frameworkConsoleCommands(root: string): Promise<Set<string>> {
  const names = new Set<string>()
  for (const dir of await packageDirs(root)) {
    let entries
    try {
      entries = await readdir(join(dir, 'src'), { recursive: true, withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      const source = await readFile(join(entry.parentPath, entry.name), 'utf8')
      for (const match of source.matchAll(CONSOLE_SIGNATURE_RE)) names.add(match[1]!)
    }
  }
  return names
}

function manifestDeclaredNames(markdown: string): Set<string> {
  const names = new Set<string>()
  for (const match of markdown.matchAll(MANIFEST_NAMES_RE)) {
    for (const quoted of match[1]!.matchAll(/"([^"]+)"/gu)) names.add(quoted[1]!)
  }
  return names
}

export async function auditDocsCliCommands(root: string, docsDir = 'docs'): Promise<UnknownCliCommand[]> {
  const registered = await registeredCliCommands(root)
  const consoleCommands = await frameworkConsoleCommands(root)
  const base = resolve(root, docsDir)
  const unknown: UnknownCliCommand[] = []

  const entries = await readdir(base, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()

  for (const path of files) {
    const markdown = await readFile(path, 'utf8')
    const declaredHere = manifestDeclaredNames(markdown)
    for (const [index, text] of markdown.split('\n').entries()) {
      for (const [, command, placeholder] of text.matchAll(INVOCATION_RE)) {
        if (placeholder || registered.has(command!) || declaredHere.has(command!)) continue
        unknown.push({
          file: relative(root, path),
          line: index + 1,
          command: command!,
          consoleCommand: consoleCommands.has(command!),
        })
      }
    }
  }
  return unknown
}

export function formatUnknownCliCommand({ file, line, command, consoleCommand }: UnknownCliCommand): string {
  const fix = consoleCommand
    ? `It is a console command the app registers: write \`bun run console ${command}\`.`
    : 'It is neither a builtin nor a command a first-party plugin declares.'
  return `${file}:${line} runs \`bunx guren ${command}\`, which the CLI does not register. ${fix}`
}
