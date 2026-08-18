#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineCommand, showUsage, type CommandDef } from 'citty'
import { consola } from 'consola'
import { builtinSubCommands } from './commands'
import { discoverPluginCommands, createPluginCommandProxy } from './plugin-commands'
import { runCli, UsageError } from './run-cli'

// CLI commands declared by installed plugins (gurenPlugin.commands).
// Discovery only reads package.json files; a plugin's entry module is
// imported lazily when one of its commands is invoked (or renders its own
// usage), never for the root --help listing.
const pluginSubCommands: Record<string, CommandDef> = {}
try {
  const discovered = await discoverPluginCommands(
    process.cwd(),
    new Set(Object.keys(builtinSubCommands)),
  )
  for (const command of discovered) {
    pluginSubCommands[command.name] = createPluginCommandProxy(command)
  }
} catch (error) {
  consola.warn(`Failed to discover plugin commands: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * This package's own version, for `guren --version`. Read from the manifest
 * rather than written here as a literal, which would drift at every
 * `changeset version`.
 *
 * `../package.json` is this package's root from either layout: built output
 * puts `bin.js` directly in `dist/`, and running from source puts `bin.ts`
 * directly in `src/` — the same idiom `agent-harness.ts` uses to find
 * `templates/`.
 *
 * Returns `undefined` rather than throwing: this module is evaluated for
 * every command, so an unreadable manifest must cost only `--version` (which
 * falls back to the usage-plus-error path in `runCli`) and not take
 * `make:model` down with it.
 */
function readOwnVersion(): string | undefined {
  try {
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

const main = defineCommand({
  meta: {
    name: 'guren',
    description: 'Guren framework CLI utilities.',
    version: readOwnVersion(),
  },
  args: {
    help: {
      type: 'boolean',
      alias: 'h',
      description: 'Show this help message',
    },
  },
  // Null-prototype so a name like `valueOf` or `constructor` can never
  // resolve to an inherited Object member. citty's own dispatch indexes this
  // map unguarded and would otherwise invoke the inherited value as a command.
  subCommands: Object.assign(Object.create(null), builtinSubCommands, pluginSubCommands),
  async run(ctx) {
    if (ctx.args.help || ctx.rawArgs.length === 0) {
      await showUsage(ctx.cmd)
      return
    }

    // citty dispatches on the first non-flag argument, not on rawArgs[0], and
    // calls this handler again once that subcommand returns. Read the name the
    // same way so a flag in front of it (`guren --zzz model:list`) does not
    // look like a command of its own. A name citty does not have never reaches
    // here — it throws `Unknown command` before running anything — so the only
    // state left to report is flags with no command at all.
    const commandName = ctx.rawArgs.find((arg) => !arg.startsWith('-'))
    const subCommands = ctx.cmd.subCommands ?? {}
    if (commandName && Object.prototype.hasOwnProperty.call(subCommands, commandName)) {
      return
    }

    throw new UsageError('No command specified.')
  },
})

const exitCode = await runCli(main, process.argv.slice(2))
if (exitCode !== 0) {
  process.exit(exitCode)
}
