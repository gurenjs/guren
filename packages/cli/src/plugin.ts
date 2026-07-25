import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { WriterOptions } from './utils'
import { runCommand } from './utils'
import { addImport, addProvider } from './patch-helpers'
import {
  applyEnvEntries,
  applyPublishes,
  checkPluginCompatibility,
  readCoreVersion,
  readPluginManifest,
  type PublishResult,
} from './plugin-manifest'
import { assertSupportedOfficialVercelPlugin, installOfficialVercelPlugin, VERCEL_PLUGIN_PACKAGE } from './plugin-vercel'

export interface InstallPluginOptions extends WriterOptions {
  packageName: string
  /** Run `bun add <pkg>` when the dependency is missing. Off by default. */
  install?: boolean
  /** Register the plugin even when its declared compatibility range excludes the installed core. */
  ignoreCompatibility?: boolean
}

export type PluginInstallMessageKind =
  | 'installed'
  | 'updated'
  | 'checked'
  | 'skipped'
  | 'warning'
  | 'hint'

export interface PluginInstallMessage {
  kind: PluginInstallMessageKind
  text: string
}

function toMessages(kind: PluginInstallMessageKind, texts: string[]): PluginInstallMessage[] {
  return texts.map((text) => ({ kind, text }))
}

/**
 * Official plugins whose primary export is a zero-config `definePlugin()`
 * factory rather than a provider class, mapped to the factory's export name.
 *
 * This table cannot become a manifest field: the documented flow runs
 * `guren plugin <pkg>` before `bun add <pkg>`, so no manifest is readable at
 * registration time. An installed manifest that declares `provider` (a stale
 * class-shaped release) always wins over this table.
 */
const OFFICIAL_FACTORY_PLUGINS: Record<string, string> = {
  [VERCEL_PLUGIN_PACKAGE]: 'vercelPlugin',
  '@guren/plugin-cloudflare': 'cloudflarePlugin',
}

function providerIdentifierForPackage(packageName: string): string {
  const normalized = packageName.replace(/^@/u, '').replace(/[^a-zA-Z0-9]+/gu, ' ')
  const parts = normalized.split(/\s+/u).filter(Boolean)
  if (parts.length === 0) {
    throw new Error(`Invalid plugin package name: "${packageName}"`)
  }

  return `${parts.map(part => part[0].toUpperCase() + part.slice(1)).join('')}Provider`
}

async function hasDependency(packageName: string): Promise<boolean> {
  const packageJsonPath = resolve(process.cwd(), 'package.json')
  let packageJsonRaw: string

  try {
    packageJsonRaw = await readFile(packageJsonPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }

  const packageJson = JSON.parse(packageJsonRaw) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  return Boolean(packageJson.dependencies?.[packageName] ?? packageJson.devDependencies?.[packageName])
}

export async function installPlugin(options: InstallPluginOptions): Promise<PluginInstallMessage[]> {
  const packageName = options.packageName.trim()
  if (!packageName) {
    throw new Error('Plugin package name is required.')
  }

  if (packageName === VERCEL_PLUGIN_PACKAGE) {
    await assertSupportedOfficialVercelPlugin()
  }

  const messages: PluginInstallMessage[] = []

  let present = await hasDependency(packageName)
  if (options.install && !present) {
    await runCommand('bun', ['add', packageName])
    present = true
    messages.push({ kind: 'installed', text: packageName })
  }

  const manifest = await readPluginManifest(packageName)

  if (manifest) {
    const compatibility = checkPluginCompatibility(manifest, await readCoreVersion())
    if (compatibility && !compatibility.compatible) {
      const summary =
        `${packageName} declares compatibility "${compatibility.range}" but @guren/core ` +
        `${compatibility.coreVersion} is installed.`
      if (!options.ignoreCompatibility) {
        throw new Error(`${summary} Pass --ignore-compatibility to register it anyway.`)
      }
      messages.push({ kind: 'warning', text: summary })
    }
  }

  // An installed manifest that names a provider class describes the actual
  // installed version and takes precedence over the official-factory table
  // (which describes the latest release, for the register-before-install flow).
  const factoryName = manifest?.provider ? undefined : OFFICIAL_FACTORY_PLUGINS[packageName]

  if (manifest && !manifest.provider && !factoryName) {
    // A manifest exists but intentionally omits `provider` -- e.g. a
    // command-only plugin, or a definePlugin() factory that must be called
    // with configuration. Fabricating a name here would write an import
    // that doesn't exist into src/app.ts.
    messages.push({
      kind: 'hint',
      text: `${packageName} does not declare a gurenPlugin.provider; register its export manually in createApp({ providers }).`,
    })
  } else {
    // Official plugins expose a zero-config definePlugin() factory; the
    // generic manifest path can only register named provider classes, so
    // their factory-call expression is known here instead.
    const providerName = factoryName
      ?? manifest?.provider
      ?? providerIdentifierForPackage(packageName)
    const providerExpression = factoryName ? `${factoryName}()` : providerName
    const providerImport = `import { ${providerName} } from '${packageName}'`

    const appPath = 'src/app.ts'
    const imported = await addImport(appPath, providerImport)
    // A user may already have a configured call (e.g. `vercelPlugin({ ... })`)
    // registered; any entry invoking the factory counts as registered.
    const registered = await addProvider(
      appPath,
      providerExpression,
      factoryName ? (entries) => entries.some((entry) => entry.startsWith(`${factoryName}(`)) : undefined,
    )

    if (imported.reason === 'File not found' || registered.reason === 'File not found') {
      throw new Error('src/app.ts was not found. Run this command inside a Guren app.')
    }

    if (!registered.modified && registered.reason === 'Could not find providers array') {
      throw new Error('Could not find providers array in src/app.ts. Please register the provider manually.')
    }

    if (imported.modified || registered.modified) {
      messages.push({ kind: 'updated', text: appPath })
    } else if (imported.reason === 'Import already exists' && registered.reason === 'Provider already registered') {
      messages.push({ kind: 'checked', text: `${appPath} (already registered)` })
    }
  }

  if (packageName === VERCEL_PLUGIN_PACKAGE) {
    const pluginFiles = await installOfficialVercelPlugin(options)
    messages.push(...toMessages('updated', pluginFiles))
  }

  // Independent I/O — apply publishes and env entries concurrently.
  const [published, envModified] = await Promise.all([
    manifest?.publishes?.length
      ? applyPublishes(packageName, manifest.publishes, { force: options.force })
      : Promise.resolve<PublishResult>({ written: [], skipped: [] }),
    manifest?.env?.length ? applyEnvEntries(manifest.env) : Promise.resolve<string[]>([]),
  ])

  messages.push(...toMessages('updated', published.written))
  messages.push(...published.skipped.map((text): PluginInstallMessage => ({
    kind: 'skipped',
    text: `${text} (already exists, use --force to overwrite)`,
  })))
  messages.push(...toMessages('updated', envModified))

  if (!present) {
    messages.push({ kind: 'hint', text: `Run: bun add ${packageName}` })
  }

  return messages
}
