import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface PatchResult {
  modified: boolean
  reason?: string
}

/**
 * Adds an import statement to a file if not already present.
 * Inserts the import at the top of the file, after any existing imports.
 */
export async function addImport(
  filePath: string,
  importStatement: string,
): Promise<PatchResult> {
  const absolutePath = resolve(process.cwd(), filePath)
  let content: string

  try {
    content = await readFile(absolutePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { modified: false, reason: 'File not found' }
    }
    throw error
  }

  const normalizedImport = importStatement.trim()
  const importPattern = normalizedImport.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^\\s*${importPattern}\\s*$`, 'm')

  if (regex.test(content)) {
    return { modified: false, reason: 'Import already exists' }
  }

  const lines = content.split('\n')
  let insertIndex = 0
  let lastImportIndex = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('import ')) {
      lastImportIndex = i
    } else if (lastImportIndex >= 0 && line.length > 0 && !line.startsWith('//')) {
      break
    }
  }

  insertIndex = lastImportIndex >= 0 ? lastImportIndex + 1 : 0

  lines.splice(insertIndex, 0, normalizedImport)
  const updatedContent = lines.join('\n')

  await writeFile(absolutePath, updatedContent, 'utf8')
  return { modified: true }
}

/**
 * Adds a provider to the providers array in Application initialization.
 */
export async function addProvider(
  filePath: string,
  providerName: string,
): Promise<PatchResult> {
  const absolutePath = resolve(process.cwd(), filePath)
  let content: string

  try {
    content = await readFile(absolutePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { modified: false, reason: 'File not found' }
    }
    throw error
  }

  // Find the providers array and add the provider
  const providersArrayPattern = /providers:\s*\[([\s\S]*?)\]/
  const match = content.match(providersArrayPattern)

  if (!match) {
    return { modified: false, reason: 'Could not find providers array' }
  }

  const providersContent = match[1]
  const providers = providersContent
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0)

  if (providers.some(p => p === providerName)) {
    return { modified: false, reason: 'Provider already registered' }
  }

  providers.push(providerName)
  const newProvidersContent = providers.join(', ')
  const updatedContent = content.replace(
    providersArrayPattern,
    `providers: [${newProvidersContent}]`,
  )

  await writeFile(absolutePath, updatedContent, 'utf8')
  return { modified: true }
}

/**
 * Checks if a specific import statement exists in a file.
 */
export async function hasImport(filePath: string, importStatement: string): Promise<boolean> {
  const absolutePath = resolve(process.cwd(), filePath)

  try {
    const content = await readFile(absolutePath, 'utf8')
    const normalizedImport = importStatement.trim()
    const importPattern = normalizedImport.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`^\\s*${importPattern}\\s*$`, 'm')
    return regex.test(content)
  } catch {
    return false
  }
}

/**
 * Checks if AuthProvider is already registered in a file.
 */
export async function hasAuthProvider(filePath: string): Promise<boolean> {
  const absolutePath = resolve(process.cwd(), filePath)

  try {
    const content = await readFile(absolutePath, 'utf8')
    const authProviderPattern = /\bAuthProvider\b/
    return authProviderPattern.test(content)
  } catch {
    return false
  }
}
