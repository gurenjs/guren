import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { escapeRegExp } from './utils'

export interface PatchResult {
  modified: boolean
  reason?: string
}

/**
 * File contents, or `null` when the file does not exist — the one condition
 * every patch below reports as `'File not found'` rather than throwing.
 */
async function readFileOrNull(absolutePath: string): Promise<string | null> {
  try {
    return await readFile(absolutePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/**
 * Whether `index` falls inside a `//` line comment. These patches match by
 * regex, so a commented-out example of the very call they look for — a
 * disabled `// kernel.registerMany([Foo])`, say — would otherwise be edited
 * in place of the real one, leaving the file "patched" but unchanged in
 * behavior.
 */
function isInLineComment(content: string, index: number): boolean {
  const lineStart = content.lastIndexOf('\n', index) + 1
  const commentStart = content.slice(lineStart, index).indexOf('//')
  return commentStart !== -1
}

/**
 * Finds the first match of `pattern` that is not inside a line comment.
 */
function matchOutsideComments(content: string, pattern: RegExp): RegExpExecArray | null {
  const scanner = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)

  for (let match = scanner.exec(content); match !== null; match = scanner.exec(content)) {
    if (!isInLineComment(content, match.index)) return match
  }

  return null
}

/**
 * Entries of an array literal's interior, e.g. `'A, B'` -> `['A', 'B']`, or
 * `null` when the interior carries a comment. Splitting on commas and
 * re-joining on one line would fold a trailing `// keep this` over the rest
 * of the statement, so an array a human has annotated is left for them to
 * edit rather than silently mangled.
 *
 * Shared so that "is this entry already present" means the same thing for
 * every array a patch edits.
 */
function parseArrayEntries(inner: string): string[] | null {
  if (inner.includes('//') || inner.includes('/*')) return null

  return inner
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
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
  const content = await readFileOrNull(absolutePath)

  if (content === null) {
    return { modified: false, reason: 'File not found' }
  }

  const normalizedImport = importStatement.trim()
  const importPattern = escapeRegExp(normalizedImport)
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

    if (trimmed.startsWith('import ') || trimmed.startsWith('import{') || trimmed.startsWith("import'") || trimmed.startsWith('import"')) {
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
  /**
   * Custom "already registered" check over the existing array entries.
   * Defaults to exact-match against `providerName`; factory registrations
   * pass a prefix check so a configured call like `vercelPlugin({ ... })`
   * counts as registered.
   */
  isRegistered?: (entries: string[]) => boolean,
): Promise<PatchResult> {
  const absolutePath = resolve(process.cwd(), filePath)
  const content = await readFileOrNull(absolutePath)

  if (content === null) {
    return { modified: false, reason: 'File not found' }
  }

  // Find the providers array and add the provider
  const providersArrayPattern = /providers:\s*\[([\s\S]*?)\]/
  const match = content.match(providersArrayPattern)

  if (!match) {
    return { modified: false, reason: 'Could not find providers array' }
  }

  const providersContent = match[1]
  const providers = parseArrayEntries(providersContent)

  if (providers === null) {
    return { modified: false, reason: 'Providers array contains comments' }
  }

  const alreadyRegistered = isRegistered
    ? isRegistered(providers)
    : providers.some(p => p === providerName)
  if (alreadyRegistered) {
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
 * Index range of the `{ ... }` options object passed to `callName(` — the
 * span every "edit an option of this call" patch works within, so that a
 * `key:` belonging to some other call in the same file is never touched.
 * Returns the failure `reason` as a string when the call or its object
 * cannot be located.
 */
function findCallOptionsSpan(
  content: string,
  callName: string,
): { start: number; end: number } | string {
  const callPattern = new RegExp(`\\b${escapeRegExp(callName)}\\(\\s*\\{`)
  const match = matchOutsideComments(content, callPattern)

  if (!match) {
    return `Could not find a ${callName}({ ... }) call`
  }

  const start = match.index + match[0].length - 1
  let depth = 0

  for (let i = start; i < content.length; i++) {
    const char = content[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return { start, end: i }
    }
  }

  return `Could not parse ${callName} options object`
}

/**
 * Adds an entry to an arbitrary array-valued option of a single-object-
 * argument call (e.g. `modules: [...]` in `createApp({ ... })`, or
 * `commands: [...]` in `defineModule({ ... })`), creating the option (via
 * `addCreateAppOption`) if it isn't present at all yet. Generalizes
 * `addProvider`'s array-editing logic to a caller-supplied `key` instead of
 * the hardcoded `providers:`.
 *
 * The search is scoped to `callName`'s own options object, so a same-named
 * key on an unrelated call in the file is left alone.
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
  callName = 'createApp',
): Promise<PatchResult> {
  const absolutePath = resolve(process.cwd(), filePath)
  const content = await readFileOrNull(absolutePath)

  if (content === null) {
    return { modified: false, reason: 'File not found' }
  }

  const span = findCallOptionsSpan(content, callName)

  if (typeof span === 'string') {
    return { modified: false, reason: span }
  }

  const optionsSource = content.slice(span.start, span.end + 1)
  const arrayPattern = new RegExp(`${escapeRegExp(key)}:\\s*\\[([\\s\\S]*?)\\]`)
  const match = optionsSource.match(arrayPattern)

  if (!match) {
    return addCreateAppOption(filePath, key, `[${valueSource}]`, callName)
  }

  const entries = parseArrayEntries(match[1])

  if (entries === null) {
    return { modified: false, reason: `${key} array contains comments` }
  }

  if (entries.some((entry) => entry === valueSource)) {
    return { modified: false, reason: 'Already present' }
  }

  entries.push(valueSource)
  const updatedOptions = optionsSource.replace(arrayPattern, `${key}: [${entries.join(', ')}]`)
  const updatedContent = content.slice(0, span.start) + updatedOptions + content.slice(span.end + 1)

  await writeFile(absolutePath, updatedContent, 'utf8')
  return { modified: true }
}

/**
 * Adds an entry to an array literal passed straight to a method call, e.g.
 * the `kernel.registerMany([...])` in a project's `src/console.ts`. The
 * receiver is matched loosely (any identifier or member expression, or none)
 * so a kernel bound to a name other than `kernel` still gets patched.
 *
 * Only a call whose argument is an array *literal* matches, which is what
 * makes this safe in a console entrypoint that also contains
 * `kernel.registerMany(billingModule.commands)` — that form is skipped
 * rather than mangled.
 */
export async function addToArrayArgument(
  filePath: string,
  methodName: string,
  valueSource: string,
): Promise<PatchResult> {
  const absolutePath = resolve(process.cwd(), filePath)
  const content = await readFileOrNull(absolutePath)

  if (content === null) {
    return { modified: false, reason: 'File not found' }
  }

  const callPattern = new RegExp(
    `(?:[\\w$]+(?:\\.[\\w$]+)*\\.)?${escapeRegExp(methodName)}\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`,
  )
  const match = matchOutsideComments(content, callPattern)

  if (!match) {
    return { modified: false, reason: `Could not find a ${methodName}([ ... ]) call` }
  }

  const entries = parseArrayEntries(match[1])

  if (entries === null) {
    return { modified: false, reason: `${methodName}() array contains comments` }
  }

  if (entries.some((entry) => entry === valueSource)) {
    return { modified: false, reason: 'Already present' }
  }

  entries.push(valueSource)
  const replacement = match[0].replace(/\[[\s\S]*\]/, `[${entries.join(', ')}]`)
  const updatedContent
    = content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length)

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
    const importPattern = escapeRegExp(normalizedImport)
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
 *
 * `callName` selects which single-object-argument call to edit — the default
 * targets `createApp({ ... })`; `'defineModule'` targets a module's
 * `modules/<name>/index.ts` descriptor.
 */
export async function addCreateAppOption(
  filePath: string,
  key: string,
  valueSource: string,
  callName = 'createApp',
): Promise<PatchResult> {
  const absolutePath = resolve(process.cwd(), filePath)
  const content = await readFileOrNull(absolutePath)

  if (content === null) {
    return { modified: false, reason: 'File not found' }
  }

  const span = findCallOptionsSpan(content, callName)

  if (typeof span === 'string') {
    return { modified: false, reason: span }
  }

  const { start: openBraceIndex, end: closeBraceIndex } = span
  const optionsSource = content.slice(openBraceIndex, closeBraceIndex + 1)
  const keyPattern = new RegExp(`(^|[{,]\\s*)${escapeRegExp(key)}\\s*:`, 'm')
  if (keyPattern.test(optionsSource)) {
    return { modified: false, reason: 'Option already set' }
  }

  const insertion = `\n  ${key}: ${valueSource},`
  const updated =
    content.slice(0, openBraceIndex + 1) + insertion + content.slice(openBraceIndex + 1)

  await writeFile(absolutePath, updated, 'utf8')
  return { modified: true }
}
