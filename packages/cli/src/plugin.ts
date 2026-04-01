import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { WriterOptions } from './utils'
import { addImport, addProvider } from './patch-helpers'
import { assertSupportedOfficialVercelPlugin, installOfficialVercelPlugin } from './plugin-vercel'

export interface InstallPluginOptions extends WriterOptions {
  packageName: string
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

export async function installPlugin(options: InstallPluginOptions): Promise<string[]> {
  const packageName = options.packageName.trim()
  if (!packageName) {
    throw new Error('Plugin package name is required.')
  }

  if (packageName === '@guren/plugin-vercel') {
    await assertSupportedOfficialVercelPlugin()
  }

  const providerName = providerIdentifierForPackage(packageName)
  const providerImport = `import { ${providerName} } from '${packageName}'`

  const appPath = 'src/app.ts'
  const imported = await addImport(appPath, providerImport)
  const registered = await addProvider(appPath, providerName)

  if (!imported.modified && imported.reason === 'File not found') {
    throw new Error('src/app.ts was not found. Run this command inside a Guren app.')
  }


  if (!registered.modified && registered.reason === 'File not found') {
    throw new Error('src/app.ts was not found. Run this command inside a Guren app.')
  }

  if (!registered.modified && registered.reason === 'Could not find providers array') {
    throw new Error('Could not find providers array in src/app.ts. Please register the provider manually.')
  }

  const messages: string[] = []

  if (imported.modified || registered.modified) {
    messages.push(appPath)
  }

  if (!imported.modified && imported.reason === 'Import already exists' && !registered.modified && registered.reason === 'Provider already registered') {
    messages.push(`${appPath} (already registered)`)
  }

  if (packageName === '@guren/plugin-vercel') {
    const pluginFiles = await installOfficialVercelPlugin(options)
    messages.push(...pluginFiles)
  }

  if (!await hasDependency(packageName)) {
    messages.push(`Run: bun add ${packageName}`)
  }

  return messages
}
