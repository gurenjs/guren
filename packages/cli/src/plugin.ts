import type { WriterOptions } from './utils'
import { assertCwdUnsupported, runCommand } from './utils'
import { appDependsOn } from './discovery'
import { PATCH_REASONS } from './patch-helpers'
import { addProviderRegistration, APP_ENTRY_CANDIDATES, resolveAppEntry } from './provider-registrar'
import {
  applyEnvEntries,
  assertEnvEntriesAllowed,
  applyPublishes,
  checkPluginCompatibility,
  readCoreVersion,
  readPluginManifest,
  type PublishResult,
} from './plugin-manifest'
import { assertSupportedOfficialVercelPlugin, installOfficialVercelPlugin, VERCEL_PLUGIN_PACKAGE } from './plugin-vercel'
import { installOfficialLambdaPlugin, LAMBDA_PLUGIN_PACKAGE } from './plugin-lambda'

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
 * Official plugins whose export is a zero-config `definePlugin()` factory, mapped to
 * the factory's export name. Not a manifest field: `guren plugin <pkg>` runs before
 * `bun add <pkg>`, so no manifest is readable yet. An installed manifest declaring
 * `provider` wins over this table.
 */
const OFFICIAL_FACTORY_PLUGINS: Record<string, string> = {
  [VERCEL_PLUGIN_PACKAGE]: 'vercelPlugin',
  '@guren/plugin-cloudflare': 'cloudflarePlugin',
  [LAMBDA_PLUGIN_PACKAGE]: 'lambdaPlugin',
}

interface OfficialPluginScaffolder {
  /** Runs before anything is installed or modified; throw to abort. */
  precheck?: () => Promise<void>
  /** Writes the plugin's project files; returns the paths it touched. */
  scaffold: (options: WriterOptions) => Promise<string[]>
}

/**
 * Official plugins that scaffold project files the manifest `publishes` mechanism
 * cannot write (it is restricted to config/, db/migrations/, and resources/).
 */
const OFFICIAL_PLUGIN_SCAFFOLDERS: Record<string, OfficialPluginScaffolder> = {
  [VERCEL_PLUGIN_PACKAGE]: {
    precheck: assertSupportedOfficialVercelPlugin,
    scaffold: installOfficialVercelPlugin,
  },
  [LAMBDA_PLUGIN_PACKAGE]: {
    scaffold: installOfficialLambdaPlugin,
  },
}

function providerIdentifierForPackage(packageName: string): string {
  const normalized = packageName.replace(/^@/u, '').replace(/[^a-zA-Z0-9]+/gu, ' ')
  const parts = normalized.split(/\s+/u).filter(Boolean)
  if (parts.length === 0) {
    throw new Error(`Invalid plugin package name: "${packageName}"`)
  }

  return `${parts.map(part => part[0].toUpperCase() + part.slice(1)).join('')}Provider`
}

/** `=== true` because a manifest this cannot read is a reason to try installing, not to abort. */
async function hasDependency(packageName: string): Promise<boolean> {
  return (await appDependsOn(process.cwd(), packageName)) === true
}

export async function installPlugin(options: InstallPluginOptions): Promise<PluginInstallMessage[]> {
  assertCwdUnsupported(options, 'guren plugin')
  const packageName = options.packageName.trim()
  if (!packageName) {
    throw new Error('Plugin package name is required.')
  }

  const scaffolder = OFFICIAL_PLUGIN_SCAFFOLDERS[packageName]
  await scaffolder?.precheck?.()

  const messages: PluginInstallMessage[] = []

  let present = await hasDependency(packageName)
  if (options.install && !present) {
    await runCommand('bun', ['add', packageName])
    present = true
    messages.push({ kind: 'installed', text: packageName })
  }

  const manifest = await readPluginManifest(packageName)

  // Validated before anything is wired or published: `applyEnvEntries` re-checks,
  // but throwing there would leave a refused manifest half-installed.
  if (manifest?.env?.length) {
    assertEnvEntriesAllowed(manifest.env)
  }

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

  // The installed manifest describes the installed version; the factory table only
  // describes the latest release, for the register-before-install flow.
  const factoryName = manifest?.provider ? undefined : OFFICIAL_FACTORY_PLUGINS[packageName]

  if (manifest && !manifest.provider && !factoryName) {
    // The manifest omits `provider` on purpose (command-only plugin, or a factory
    // needing configuration); fabricating a name would write a broken import.
    messages.push({
      kind: 'hint',
      text: `${packageName} does not declare a gurenPlugin.provider; register its export manually in createApp({ providers }).`,
    })
  } else {
    // The manifest path can only register named provider classes, so the
    // factory-call expression for official plugins is built here instead.
    const providerName = factoryName
      ?? manifest?.provider
      ?? providerIdentifierForPackage(packageName)
    const providerExpression = factoryName ? `${factoryName}()` : providerName
    const providerImport = `import { ${providerName} } from '${packageName}'`

    const appPath = await resolveAppEntry()

    if (!appPath) {
      throw new Error(`Could not find ${APP_ENTRY_CANDIDATES.join(' or ')}. Run this command inside a Guren app.`)
    }

    // Any entry invoking the factory counts as registered, including a
    // user-configured `vercelPlugin({ ... })`.
    const wiring = await addProviderRegistration(
      appPath,
      providerExpression,
      providerImport,
      factoryName ? (entries) => entries.some((entry) => entry.startsWith(`${factoryName}(`)) : undefined,
    )

    if (!wiring.registered) {
      throw wiring.provider.reason === PATCH_REASONS.providersArrayNotFound
        ? new Error(`Could not find providers array in ${appPath}. Please register the provider manually.`)
        : new Error(`Could not register ${providerName} in ${appPath}: ${wiring.provider.reason}`)
    }

    if (wiring.provider.modified || wiring.import.modified) {
      messages.push({ kind: 'updated', text: appPath })
    } else {
      messages.push({ kind: 'checked', text: `${appPath} (already registered)` })
    }
  }

  if (scaffolder) {
    messages.push(...toMessages('updated', await scaffolder.scaffold(options)))
  }

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
