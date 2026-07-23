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
  let inMultilineImport = false
  let braceDepth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    const braceDelta = (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)

    if (inMultilineImport) {
      lastImportIndex = i
      braceDepth += braceDelta
      if (braceDepth <= 0) {
        inMultilineImport = false
      }
      continue
    }

    if (trimmed.startsWith('import ') || trimmed.startsWith('import{')) {
      lastImportIndex = i
      braceDepth = braceDelta
      if (braceDepth > 0) {
        inMultilineImport = true
      }
    } else if (lastImportIndex >= 0 && trimmed.length > 0 && !trimmed.startsWith('//')) {
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
 * Adds an entry to an arbitrary array-valued `createApp({ ... })` option
 * (e.g. `modules: [...]`), creating the option (via `addCreateAppOption`)
 * if it isn't present at all yet. Generalizes `addProvider`'s array-editing
 * logic to a caller-supplied `key` instead of the hardcoded `providers:`.
 *
 * `addProvider` is kept as its own independent implementation rather than
 * delegating here, to avoid changing its existing behavior (it fails with
 * `'Could not find providers array'` when the array is absent, rather than
 * creating one) for its existing callers.
 */
export async function addToArrayOption(
  filePath: string,
  key: string,
  valueSource: string,
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

  const arrayPattern = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`)
  const match = content.match(arrayPattern)

  if (!match) {
    return addCreateAppOption(filePath, key, `[${valueSource}]`)
  }

  const entries = match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  if (entries.some((entry) => entry === valueSource)) {
    return { modified: false, reason: 'Already present' }
  }

  entries.push(valueSource)
  const updatedContent = content.replace(arrayPattern, `${key}: [${entries.join(', ')}]`)

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

/**
 * Ensures that a set of named Drizzle imports are present in file content.
 * Merges into an existing `@guren/orm/drizzle` import or prepends a new one.
 * Returns the (possibly updated) content string.
 */
export function ensureDrizzleImports(content: string, needed: string[]): string {
  // Check only import lines for existing identifiers, not the entire file content
  const importLines = content.split('\n').filter((line) => line.trimStart().startsWith('import '))
  const importContent = importLines.join('\n')

  const missing = needed.filter(
    (name) => !new RegExp(`\\b${name}\\b`).test(importContent),
  )

  if (missing.length === 0) {
    return content
  }

  const existingDrizzleImport = /import\s*\{([^}]+)\}\s*from\s*['"]@guren\/orm\/drizzle['"]/
  const match = content.match(existingDrizzleImport)

  if (match) {
    const existingNames = match[1].split(',').map((s) => s.trim()).filter(Boolean)
    const allNames = [...new Set([...existingNames, ...missing])].sort()
    return content.replace(existingDrizzleImport, `import { ${allNames.join(', ')} } from '@guren/orm/drizzle'`)
  }

  return `import { ${missing.sort().join(', ')} } from '@guren/orm/drizzle'\n${content}`
}

export function ensureSqliteImports(content: string, needed: string[]): string {
  const importLines = content.split('\n').filter((line) => line.trimStart().startsWith('import '))
  const importContent = importLines.join('\n')

  const missing = needed.filter(
    (name) => !new RegExp(`\\b${name}\\b`).test(importContent),
  )

  if (missing.length === 0) {
    return content
  }

  const existingSqliteImport = /import\s*\{([^}]+)\}\s*from\s*['"]drizzle-orm\/sqlite-core['"]/
  const match = content.match(existingSqliteImport)

  if (match) {
    const existingNames = match[1].split(',').map((s) => s.trim()).filter(Boolean)
    const allNames = [...new Set([...existingNames, ...missing])].sort()
    return content.replace(existingSqliteImport, `import { ${allNames.join(', ')} } from 'drizzle-orm/sqlite-core'`)
  }

  return `import { ${missing.sort().join(', ')} } from 'drizzle-orm/sqlite-core'\n${content}`
}

export function ensureMysqlImports(content: string, needed: string[]): string {
  const importLines = content.split('\n').filter((line) => line.trimStart().startsWith('import '))
  const importContent = importLines.join('\n')

  const missing = needed.filter(
    (name) => !new RegExp(`\\b${name}\\b`).test(importContent),
  )

  if (missing.length === 0) {
    return content
  }

  const existingMysqlImport = /import\s*\{([^}]+)\}\s*from\s*['"]drizzle-orm\/mysql-core['"]/
  const match = content.match(existingMysqlImport)

  if (match) {
    const existingNames = match[1].split(',').map((s) => s.trim()).filter(Boolean)
    const allNames = [...new Set([...existingNames, ...missing])].sort()
    return content.replace(existingMysqlImport, `import { ${allNames.join(', ')} } from 'drizzle-orm/mysql-core'`)
  }

  return `import { ${missing.sort().join(', ')} } from 'drizzle-orm/mysql-core'\n${content}`
}

/**
 * Adds a top-level option to the createApp({ ... }) call in a file.
 * The value is inserted verbatim, e.g. addCreateAppOption(path, 'auth', '{}').
 */
export async function addCreateAppOption(
  filePath: string,
  key: string,
  valueSource: string,
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

  const createAppPattern = /createApp\(\s*\{/
  const match = content.match(createAppPattern)

  if (!match || match.index === undefined) {
    return { modified: false, reason: 'Could not find a createApp({ ... }) call' }
  }

  // Scan the createApp options object for an existing top-level `key:`
  const openBraceIndex = match.index + match[0].length - 1
  let depth = 0
  let closeBraceIndex = -1
  for (let i = openBraceIndex; i < content.length; i++) {
    const char = content[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) {
        closeBraceIndex = i
        break
      }
    }
  }

  if (closeBraceIndex === -1) {
    return { modified: false, reason: 'Could not parse createApp options object' }
  }

  const optionsSource = content.slice(openBraceIndex, closeBraceIndex + 1)
  const keyPattern = new RegExp(`(^|[{,]\\s*)${key}\\s*:`, 'm')
  if (keyPattern.test(optionsSource)) {
    return { modified: false, reason: 'Option already set' }
  }

  const insertion = `\n  ${key}: ${valueSource},`
  const updated =
    content.slice(0, openBraceIndex + 1) + insertion + content.slice(openBraceIndex + 1)

  await writeFile(absolutePath, updated, 'utf8')
  return { modified: true }
}
