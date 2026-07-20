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
} from './plugin-manifest'
import { assertSupportedOfficialVercelPlugin, installOfficialVercelPlugin } from './plugin-vercel'

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

  if (packageName === '@guren/plugin-vercel') {
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

  const providerName = manifest?.provider ?? providerIdentifierForPackage(packageName)
  const providerImport = `import { ${providerName} } from '${packageName}'`

  const appPath = 'src/app.ts'
  const imported = await addImport(appPath, providerImport)
  const registered = await addProvider(appPath, providerName)

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

  if (packageName === '@guren/plugin-vercel') {
    const pluginFiles = await installOfficialVercelPlugin(options)
    messages.push(...pluginFiles.map((text): PluginInstallMessage => ({ kind: 'updated', text })))
  }

  if (manifest?.publishes?.length) {
    const published = await applyPublishes(packageName, manifest.publishes, {
      force: options.force,
    })
    messages.push(...published.written.map((text): PluginInstallMessage => ({ kind: 'updated', text })))
    messages.push(...published.skipped.map((text): PluginInstallMessage => ({
      kind: 'skipped',
      text: `${text} (already exists, use --force to overwrite)`,
    })))
  }

  if (manifest?.env?.length) {
    messages.push(...(await applyEnvEntries(manifest.env)).map((text): PluginInstallMessage => ({ kind: 'updated', text })))
  }

  if (!present) {
    messages.push({ kind: 'hint', text: `Run: bun add ${packageName}` })
  }

  return messages
}
