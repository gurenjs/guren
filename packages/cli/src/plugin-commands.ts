import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { consola } from 'consola'
import { defineCommand, runCommand as runCittyCommand } from 'citty'
import type { ArgsDef, CommandDef } from 'citty'
import { packageContentRoot, readInstalledPluginManifests, resolveInside } from './plugin-manifest'

/**
 * A CLI command contributed by an installed plugin, discovered from its
 * `gurenPlugin.commands` manifest. Discovery never imports plugin code —
 * the entry module is only loaded when the command is invoked (or when its
 * own --help needs the real argument definitions).
 */
export interface DiscoveredPluginCommand {
  name: string
  packageName: string
  /** Absolute path to the plugin's commands entry module. */
  entryPath: string
}

/**
 * Discover CLI commands declared by installed plugins via the
 * `gurenPlugin.commands` manifest field.
 *
 * Rules:
 * - Command names must contain a `:` namespace.
 * - Built-in command names (`reservedNames`) always win.
 * - A name declared by multiple plugins is dropped for all of them, with a
 *   single warning naming every declaring package.
 * - The commands entry must resolve inside the plugin's package directory.
 */
export async function discoverPluginCommands(
  cwd: string = process.cwd(),
  reservedNames: ReadonlySet<string> = new Set(),
): Promise<DiscoveredPluginCommand[]> {
  const plugins = await readInstalledPluginManifests(cwd)
  const byName = new Map<string, DiscoveredPluginCommand[]>()

  for (const { packageName, manifest } of plugins) {
    const commands = manifest.commands
    if (!commands || typeof commands.entry !== 'string' || !Array.isArray(commands.names)) {
      continue
    }

    const packageDir = resolve(cwd, 'node_modules', packageName)
    const contentRoot = await packageContentRoot(packageDir)
    const entryPath = await resolveInside(packageDir, commands.entry, contentRoot ? [contentRoot] : [])
    if (entryPath === null) {
      consola.warn(`Ignoring commands from "${packageName}": entry "${commands.entry}" escapes the package directory.`)
      continue
    }

    for (const name of commands.names) {
      if (typeof name !== 'string' || !name.includes(':')) {
        consola.warn(`Ignoring plugin command "${name}" from "${packageName}": names must be namespaced (e.g. "${packageName.split('/').pop()}:sync").`)
        continue
      }
      if (reservedNames.has(name)) {
        consola.warn(`Ignoring plugin command "${name}" from "${packageName}": it conflicts with a built-in command.`)
        continue
      }

      const declarations = byName.get(name) ?? []
      declarations.push({ name, packageName, entryPath })
      byName.set(name, declarations)
    }
  }

  const discovered: DiscoveredPluginCommand[] = []
  for (const [name, declarations] of byName) {
    if (declarations.length > 1) {
      const packages = declarations.map((declaration) => `"${declaration.packageName}"`).join(', ')
      consola.warn(`Ignoring plugin command "${name}": declared by ${packages}.`)
      continue
    }
    discovered.push(declarations[0])
  }

  return discovered
}

async function loadPluginCommand(discovered: DiscoveredPluginCommand): Promise<CommandDef> {
  const module_ = await import(pathToFileURL(discovered.entryPath).href) as {
    default?: Record<string, CommandDef>
  }
  const command = module_.default?.[discovered.name]
  if (!command) {
    throw new Error(
      `Plugin "${discovered.packageName}" does not export a command named "${discovered.name}" from its commands entry.`,
    )
  }

  return command
}

/**
 * Wrap a discovered plugin command in a lightweight citty command whose
 * metadata comes from the manifest. The plugin's entry module is imported
 * only when the command runs or renders its own usage; it must
 * default-export a record of citty command definitions keyed by command
 * name.
 */
export function createPluginCommandProxy(discovered: DiscoveredPluginCommand): CommandDef {
  return defineCommand({
    meta: {
      name: discovered.name,
      description: `Provided by ${discovered.packageName}`,
    },
    // Lazy so the root `guren --help` listing (which only resolves meta)
    // never imports plugin code, while this command's own usage shows the
    // real argument definitions.
    args: async (): Promise<ArgsDef> => {
      const command = await loadPluginCommand(discovered)
      return (typeof command.args === 'function' ? await command.args() : command.args) ?? {}
    },
    async run(context) {
      await runCittyCommand(await loadPluginCommand(discovered), { rawArgs: context.rawArgs })
    },
  })
}
