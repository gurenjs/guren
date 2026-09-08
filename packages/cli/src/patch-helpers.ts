import { readFile, writeFile } from 'node:fs/promises'
import { consola } from 'consola'
import { readIfExists } from './discovery'
import { parseSourceFile } from './parse-cache'
import { resolve } from 'node:path'
import { escapeRegExp } from './utils'

export interface PatchResult {
  modified: boolean
  reason?: string
}

/**
 * The reason vocabulary the patchers below return. Consumers branch on these
 * to tell "already done" from "could not do it" — defined once so a reworded
 * reason cannot silently turn a consumer's no-op path into its failure path.
 */
export const PATCH_REASONS = {
  fileNotFound: 'File not found',
  importAlreadyExists: 'Import already exists',
  providersArrayNotFound: 'Could not find providers array',
  providerAlreadyRegistered: 'Provider already registered',
  alreadyPresent: 'Already present',
  optionAlreadySet: 'Option already set',
} as const

/**
 * `source` with comment and string contents blanked character for character, so
 * every index still lines up with the original; these patches find their edit
 * site by regex, and text that merely looks like code misleads both ways.
 * `data-types.ts` masks for itself: it blanks the quotes too, which
 * `parseArrayEntries` below cannot have — it needs `'A', 'B'` to stay two entries.
 */
function maskNonCode(source: string): string {
  const mask = source.split('')
  let i = 0

  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]

    // Comments are blanked whole, delimiters included, so that nothing inside
    // one can ever read as the last code token on a line.
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') mask[i++] = ' '
      continue
    }

    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      while (i < stop) mask[i++] = ' '
      continue
    }

    // String and template bodies are blanked but their quotes are kept, so a
    // string entry still ends where the code ends.
    if (char === '"' || char === "'" || char === '`') {
      i++
      while (i < source.length && source[i] !== char) {
        if (source[i] === '\\') mask[i++] = ' '
        mask[i++] = ' '
      }
      i++
      continue
    }

    i++
  }

  return mask.join('')
}

/**
 * First match of `pattern` landing in real code. Indices refer to `content`;
 * read spans out of `content`, never out of the blanked mask.
 */
function matchInCode(content: string, pattern: RegExp): RegExpExecArray | null {
  return new RegExp(pattern.source, 'g').exec(maskNonCode(content))
}

/**
 * Counts depth over the masked source, so nesting is respected and a bracket
 * inside a string or comment does not shift the result.
 */
export function findClosingDelimiter(content: string, openIndex: number, open: string, close: string): number {
  const masked = maskNonCode(content)
  let depth = 0

  for (let i = openIndex; i < masked.length; i++) {
    if (masked[i] === open) depth++
    else if (masked[i] === close) {
      depth--
      if (depth === 0) return i
    }
  }

  return -1
}

/** The closer each opener `parseArrayEntries` tracks expects to see. */
const ARRAY_ENTRY_CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/**
 * One entry of an array literal, in both the forms its readers need. Masking
 * preserves length, so one pair of offsets indexes the masked copy and `inner`
 * alike. Two entries can share a `code` and differ in `source`: `'/mcp'` and
 * `'/api'` blank to the same run, so only `source` may answer "is this the
 * value the caller asked for".
 */
interface ArrayEntry {
  /** Masked and trimmed: string and comment contents blanked. */
  code: string
  /** The same span, verbatim out of `inner`. */
  source: string
}

/**
 * Entries of an array literal's interior, split at depth 0 only. Masked first,
 * so a name in a comment is not mistaken for an entry, and so an entry's own
 * trailing comment trims away with its whitespace.
 * Regex literals are not masked; an unmatched closer stops the split there.
 */
function parseArrayEntries(inner: string): ArrayEntry[] {
  const masked = maskNonCode(inner)
  const closers: string[] = []
  const bounds: number[] = [0]

  for (let i = 0; i < masked.length; i++) {
    const char = masked[i]
    const closer = ARRAY_ENTRY_CLOSERS[char]

    if (closer !== undefined) {
      closers.push(closer)
    } else if (char === ')' || char === ']' || char === '}') {
      if (closers.pop() !== char) break
    } else if (char === ',' && closers.length === 0) {
      bounds.push(i, i + 1)
    }
  }

  bounds.push(masked.length)

  const entries: ArrayEntry[] = []
  for (let i = 0; i < bounds.length; i += 2) {
    const span = masked.slice(bounds[i], bounds[i + 1])
    const code = span.trim()
    if (code.length === 0) continue
    const from = bounds[i] + (span.length - span.trimStart().length)
    entries.push({ code, source: inner.slice(from, from + code.length) })
  }

  return entries
}

/**
 * The existing text is preserved verbatim rather than re-joined from parsed
 * entries: re-joining collapses a multi-line array onto one line and folds any
 * trailing comment over the rest of the statement.
 */
function appendArrayEntry(arrayInterior: string, valueSource: string): string {
  // Length of the interior up to its last code character: everything after it
  // is whitespace or a trailing comment, and the new entry has to go before
  // that or it lands inside the comment.
  const codeLength = maskNonCode(arrayInterior).trimEnd().length
  const code = arrayInterior.slice(0, codeLength)
  const trailing = arrayInterior.slice(codeLength)

  if (code.trim() === '') return `${valueSource}${trailing}`
  return code.endsWith(',') ? `${code} ${valueSource},${trailing}` : `${code}, ${valueSource}${trailing}`
}

/**
 * Whether every value binding `importStatement` asks for is already imported from the
 * same module: {@link insertImport}'s literal-line test only knows the statement this
 * package writes, so a *merged* import reads as absent and gets a duplicate. AST-based, since
 * regex got five cases wrong (import in a comment or template literal, `type`-only, `X as
 * wanted`, a comment between braces, one spanning two imports); unparseable answers `false`.
 */
function namedBindingsAlreadyImported(content: string, importStatement: string): boolean {
  const requested = parseNamedImport(importStatement)
  if (!requested || requested.bindings.length === 0) return false

  const ast = parseSourceFile(content)
  if (!ast) return false

  const bound = new Set<string>()
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration') continue
    if (statement.source.value !== requested.source) continue
    // A type-only import binds no value, so it cannot satisfy a value import.
    if (statement.importKind === 'type') continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue
      if (specifier.importKind === 'type') continue
      // Both halves must match: `Router as wanted` binds the wanted name to
      // the wrong symbol, so skipping the insert leaves the call invoking it.
      const imported = specifierName(specifier.imported)
      if (imported === specifier.local.name) bound.add(imported)
    }
  }

  return requested.bindings.every((binding) => bound.has(binding))
}

/** The name an import specifier refers to — `import { "a-b" as c }` is legal. */
function specifierName(node: { type: string; name?: string; value?: string }): string {
  return node.type === 'Identifier' ? (node.name ?? '') : (node.value ?? '')
}

/**
 * The bindings and module of a plain named import, or `null` for any other
 * form. The statement is first-party literal text from this file's callers.
 */
function parseNamedImport(statement: string): { bindings: string[]; source: string } | null {
  const ast = parseSourceFile(statement)
  const declaration = ast?.program.body[0]
  if (!declaration || declaration.type !== 'ImportDeclaration') return null
  if (declaration.importKind === 'type') return null

  const bindings: string[] = []
  for (const specifier of declaration.specifiers) {
    // A default or namespace import is a different question, so decline the
    // whole statement rather than half of it.
    if (specifier.type !== 'ImportSpecifier') return null
    if (specifier.importKind === 'type') return null
    const imported = specifierName(specifier.imported)
    if (imported !== specifier.local.name) return null
    bindings.push(imported)
  }

  return { bindings, source: declaration.source.value }
}

/**
 * `null` when the import is already there. Split out from `addImport` so a
 * patch that also edits the body applies both in one write — a second
 * file-level pass can leave an import behind when the body edit fails.
 */
export function insertImport(content: string, importStatement: string): string | null {
  const normalizedImport = importStatement.trim()
  const importPattern = escapeRegExp(normalizedImport)
  const regex = new RegExp(`^\\s*${importPattern}\\s*$`, 'm')

  if (regex.test(content)) {
    return null
  }

  if (namedBindingsAlreadyImported(content, normalizedImport)) {
    return null
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
  return lines.join('\n')
}

/** Adds an import after the file's existing ones, unless already present. */
export async function addImport(
  filePath: string,
  importStatement: string,
): Promise<PatchResult> {
  const absolutePath = resolve(process.cwd(), filePath)
  const content = await readIfExists(process.cwd(), filePath)

  if (content === null) {
    return { modified: false, reason: PATCH_REASONS.fileNotFound }
  }

  const updatedContent = insertImport(content, importStatement)

  if (updatedContent === null) {
    return { modified: false, reason: PATCH_REASONS.importAlreadyExists }
  }

  await writeFile(absolutePath, updatedContent, 'utf8')
  return { modified: true }
}

/**
 * The in-memory counterpart of `PatchResult`, for patches whose "nothing to
 * do" and "cannot do it" outcomes are more than one bit.
 */
export type InsertResult = { content: string; reason?: undefined } | { content?: undefined; reason: string }

/**
 * Pure, and split out for the same reason as `insertImport`: a caller adding
 * the provider's import too applies both here and writes once, so a failure
 * cannot leave half the pair on disk. Splices into the array's own span rather
 * than re-joining `parseArrayEntries` output, which writes the mask back and
 * blanked an unrelated `mcpPlugin({ path: '/mcp' })` to `'    '`.
 */
export function insertProvider(
  content: string,
  providerName: string,
  /**
   * Defaults to exact-match against `providerName`; factory registrations pass
   * a prefix check so `vercelPlugin({ ... })` counts as registered. Entries
   * arrive masked, so a predicate must not test text holding a string literal.
   */
  isRegistered?: (entries: string[]) => boolean,
): InsertResult {
  const match = matchInCode(content, /providers:\s*\[/)

  if (!match) {
    return { reason: PATCH_REASONS.providersArrayNotFound }
  }

  // Depth-counted rather than matched to the first `]`, which a nested array
  // or an object argument holding one ends early.
  const open = match.index + match[0].length - 1
  const close = findClosingDelimiter(content, open, '[', ']')

  if (close === -1) {
    return { reason: PATCH_REASONS.providersArrayNotFound }
  }

  const interior = content.slice(open + 1, close)
  const providers = parseArrayEntries(interior)

  const alreadyRegistered = isRegistered
    ? isRegistered(providers.map((entry) => entry.code))
    : providers.some((entry) => entry.source === providerName)
  if (alreadyRegistered) {
    return { reason: PATCH_REASONS.providerAlreadyRegistered }
  }

  return {
    content: content.slice(0, open + 1) + appendArrayEntry(interior, providerName) + content.slice(close),
  }
}

/** Adds a provider to the `providers` array in the app's createApp() call. */
export async function addProvider(
  filePath: string,
  providerName: string,
  isRegistered?: (entries: string[]) => boolean,
): Promise<PatchResult> {
  const absolutePath = resolve(process.cwd(), filePath)
  const content = await readIfExists(process.cwd(), filePath)

  if (content === null) {
    return { modified: false, reason: PATCH_REASONS.fileNotFound }
  }

  const inserted = insertProvider(content, providerName, isRegistered)

  if (inserted.content === undefined) {
    return { modified: false, reason: inserted.reason }
  }

  await writeFile(absolutePath, inserted.content, 'utf8')
  return { modified: true }
}

/**
 * The span every "edit an option of this call" patch works within, so a `key:`
 * belonging to another call in the same file is never touched. Returns the
 * failure `reason` as a string when the call cannot be located.
 */
function findCallOptionsSpan(
  content: string,
  callName: string,
): { start: number; end: number } | string {
  const callPattern = new RegExp(`\\b${escapeRegExp(callName)}\\(\\s*\\{`)
  const match = matchInCode(content, callPattern)

  if (!match) {
    return `Could not find a ${callName}({ ... }) call`
  }

  const start = match.index + match[0].length - 1
  const end = findClosingDelimiter(content, start, '{', '}')

  return end === -1 ? `Could not parse ${callName} options object` : { start, end }
}

/**
 * Adds an entry to an array-valued option of a single-object-argument call
 * (`modules: [...]` in `createApp`, `commands: [...]` in `defineModule`),
 * creating the option when absent and scoped to `callName`'s own object.
 * `addProvider` stays a separate implementation rather than delegating here,
 * so its existing callers keep its failure-when-absent behaviour.
 */
export async function addToArrayOption(
  filePath: string,
  key: string,
  valueSource: string,
  callName = 'createApp',
): Promise<PatchResult> {
  const absolutePath = resolve(process.cwd(), filePath)
  const content = await readIfExists(process.cwd(), filePath)

  if (content === null) {
    return { modified: false, reason: PATCH_REASONS.fileNotFound }
  }

  const span = findCallOptionsSpan(content, callName)

  if (typeof span === 'string') {
    return { modified: false, reason: span }
  }

  const optionsSource = content.slice(span.start, span.end + 1)
  const keyMatch = matchInCode(optionsSource, new RegExp(`(?:^|[{,]\\s*)${escapeRegExp(key)}\\s*:\\s*\\[`))

  if (!keyMatch) {
    return addCreateAppOption(filePath, key, `[${valueSource}]`, callName)
  }

  const open = span.start + keyMatch.index + keyMatch[0].length - 1
  const close = findClosingDelimiter(content, open, '[', ']')

  if (close === -1) {
    return { modified: false, reason: `Could not parse the ${key} array` }
  }

  const interior = content.slice(open + 1, close)

  if (parseArrayEntries(interior).some((entry) => entry.source === valueSource)) {
    return { modified: false, reason: PATCH_REASONS.alreadyPresent }
  }

  const updatedContent
    = content.slice(0, open + 1) + appendArrayEntry(interior, valueSource) + content.slice(close)

  await writeFile(absolutePath, updatedContent, 'utf8')
  return { modified: true }
}

/**
 * Adds an entry to an array literal passed straight to a method call, such as
 * `kernel.registerMany([...])`. The receiver is matched loosely, so a kernel
 * bound to another name still gets patched, but only an array *literal*
 * argument matches — `registerMany(billingModule.commands)` is skipped rather
 * than mangled.
 */
export async function addToArrayArgument(
  filePath: string,
  methodName: string,
  valueSource: string,
): Promise<PatchResult> {
  const absolutePath = resolve(process.cwd(), filePath)
  const content = await readIfExists(process.cwd(), filePath)

  if (content === null) {
    return { modified: false, reason: PATCH_REASONS.fileNotFound }
  }

  const updatedContent = insertArrayArgument(content, methodName, valueSource)

  if (updatedContent === null) {
    return { modified: false, reason: `Could not find a ${methodName}([ ... ]) call` }
  }

  if (updatedContent === content) {
    return { modified: false, reason: PATCH_REASONS.alreadyPresent }
  }

  await writeFile(absolutePath, updatedContent, 'utf8')
  return { modified: true }
}

/**
 * The pure half of {@link addToArrayArgument}: `null` when the call is not
 * there or its array cannot be parsed, the content unchanged when the value
 * already is. Callers applying more than one patch write once from here.
 */
export function insertArrayArgument(content: string, methodName: string, valueSource: string): string | null {
  // The leading lookbehind is what keeps `unregisterMany([])` from matching
  // on its `registerMany` suffix when the optional receiver group is absent.
  const callPattern = new RegExp(
    `(?<![\\w$])(?:[\\w$]+(?:\\.[\\w$]+)*\\.)?${escapeRegExp(methodName)}\\s*\\(\\s*\\[`,
  )
  const match = matchInCode(content, callPattern)
  if (!match) {
    return null
  }

  const open = match.index + match[0].length - 1
  const close = findClosingDelimiter(content, open, '[', ']')
  if (close === -1) {
    return null
  }

  const interior = content.slice(open + 1, close)
  if (parseArrayEntries(interior).some((entry) => entry.source === valueSource)) {
    return content
  }

  return content.slice(0, open + 1) + appendArrayEntry(interior, valueSource) + content.slice(close)
}

/** Whether the exact import statement already exists in a file. */
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

/** Whether AuthProvider is already registered in a file. */
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

import { findSchemaAggregate, type SchemaDialect } from './schema-parser'
export type { SchemaDialect }

/**
 * The barrel each dialect's schema imports its column builders from: a signal
 * for `detectSchemaDialect`, and where `ensure*Imports` merges new builders.
 */
export const DIALECT_BARRELS = {
  sqlite: '@guren/orm/drizzle/sqlite',
  pg: '@guren/orm/drizzle/pg',
  mysql: '@guren/orm/drizzle/mysql',
} as const satisfies Record<SchemaDialect, string>

/**
 * The dialect an app's `db/schema.ts` is written in. Every column-appending
 * patcher must agree: drizzle's table builders accept a foreign dialect's column
 * builders, so two patchers disagreeing fails silently. A whole-file content
 * sniff rather than the parser's per-table resolution, because patchers call it
 * mid-write and a schema with no tables still needs an answer — hence the `pg` fallback.
 */
export function detectSchemaDialect(content: string): SchemaDialect {
  if (
    content.includes('sqliteTable') ||
    content.includes('drizzle-orm/sqlite-core') ||
    content.includes(DIALECT_BARRELS.sqlite)
  ) {
    return 'sqlite'
  }
  if (
    content.includes('mysqlTable') ||
    content.includes('drizzle-orm/mysql-core') ||
    content.includes(DIALECT_BARRELS.mysql)
  ) {
    return 'mysql'
  }
  return 'pg'
}

/**
 * `SeederContext` alone is PostgreSQL-shaped, so an unannotated seeder in a
 * MySQL or SQLite app rejects its own schema.
 */
export const seederContextTypes = {
  sqlite: 'SqliteSeederContext',
  pg: 'PostgresSeederContext',
  mysql: 'MySqlSeederContext',
} as const satisfies Record<SchemaDialect, string>

/** An app with no `db/schema.ts` yet reads as PostgreSQL, like an empty one. */
export async function readSchemaDialect(cwd: string = process.cwd()): Promise<SchemaDialect> {
  return detectSchemaDialect((await readIfExists(cwd, 'db/schema.ts')) ?? '')
}

/**
 * Merges `needed` into the first `import { ... } from '<specifier>'`, or prepends
 * one. Three limits inherited from the dialect-specific patchers: the
 * already-imported check is **not** module-scoped (a name in scope from any module
 * counts); only the plain named form merges, so `import type`, default and namespace
 * imports get a second line; and `needed` must be plain identifiers, used unescaped in a `\b` pattern.
 */
export function ensureNamedImports(content: string, specifier: string, needed: string[]): string {
  const importContent = content
    .split('\n')
    .filter((line) => line.trimStart().startsWith('import '))
    .join('\n')

  const missing = needed.filter((name) => !new RegExp(`\\b${name}\\b`).test(importContent))

  if (missing.length === 0) {
    return content
  }

  const existingImport = new RegExp(
    `import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${escapeRegExp(specifier)}['"]`,
  )
  const match = content.match(existingImport)
  const existingNames = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : []
  const names = [...new Set([...existingNames, ...missing])].sort()
  const importLine = `import { ${names.join(', ')} } from '${specifier}'`

  // A function replacer, not a replacement string: `$&`/`$1` in the merged
  // names would otherwise be expanded instead of inserted literally.
  return match ? content.replace(existingImport, () => importLine) : `${importLine}\n${content}`
}

// Pre-barrel apps keep their `@guren/orm/drizzle` / `drizzle-orm/<dialect>-core`
// imports: those resolve to the same drizzle-orm copy as the barrels (see
// drizzle-pins.ts), so the mixed specifiers a patch leaves behind are safe.

export function ensurePgImports(content: string, needed: string[]): string {
  return ensureNamedImports(content, DIALECT_BARRELS.pg, needed)
}

export function ensureSqliteImports(content: string, needed: string[]): string {
  return ensureNamedImports(content, DIALECT_BARRELS.sqlite, needed)
}

export function ensureMysqlImports(content: string, needed: string[]): string {
  return ensureNamedImports(content, DIALECT_BARRELS.mysql, needed)
}

/**
 * Adds a top-level option to a single-object-argument call, its value inserted
 * verbatim. `callName` defaults to `createApp`; `'defineModule'` targets a
 * module's `modules/<name>/index.ts` descriptor.
 */
export async function addCreateAppOption(
  filePath: string,
  key: string,
  valueSource: string,
  callName = 'createApp',
): Promise<PatchResult> {
  const absolutePath = resolve(process.cwd(), filePath)
  const content = await readIfExists(process.cwd(), filePath)

  if (content === null) {
    return { modified: false, reason: PATCH_REASONS.fileNotFound }
  }

  const span = findCallOptionsSpan(content, callName)

  if (typeof span === 'string') {
    return { modified: false, reason: span }
  }

  const { start: openBraceIndex, end: closeBraceIndex } = span
  const optionsSource = content.slice(openBraceIndex, closeBraceIndex + 1)
  const keyPattern = new RegExp(`(^|[{,]\\s*)${escapeRegExp(key)}\\s*:`, 'm')
  if (keyPattern.test(optionsSource)) {
    return { modified: false, reason: PATCH_REASONS.optionAlreadySet }
  }

  const insertion = `\n  ${key}: ${valueSource},`
  const updated =
    content.slice(0, openBraceIndex + 1) + insertion + content.slice(openBraceIndex + 1)

  await writeFile(absolutePath, updated, 'utf8')
  return { modified: true }
}

interface AggregateSplice {
  /** Where the new table's declaration goes: ahead of the aggregate that names it. */
  declarationOffset: number
  /** Null when the aggregate already lists the table. */
  key: { offset: number; text: string } | null
}

/**
 * The offset a statement starts at, taking the comment lines written directly above it.
 * A text rule rather than Babel's `leadingComments`: Babel hands the *previous*
 * statement's end-of-line comment to this node as a leading one, and its start is a
 * column mid-line — splicing there emits two statements on one line, which without
 * semicolons does not parse. Walking whole lines cannot produce a mid-line offset.
 */
function statementStart(source: string, offset: number): number {
  let lineStart = lineStartAt(source, offset)

  while (lineStart > 0) {
    const previous = lineStartAt(source, lineStart - 1)
    const text = source.slice(previous, lineStart - 1).trim()
    if (!text.startsWith('//') && !text.startsWith('/*') && !text.startsWith('*')) break
    lineStart = previous
  }

  return lineStart
}

/**
 * Where `name`'s declaration and its aggregate key go, from the one aggregate reading in
 * `schema-parser.ts`, for an aggregate the file itself identifies. `name` is passed as the
 * extra key so a re-run over a file that already declares the table still recognizes the
 * object listing it.
 */
function planAggregateSplice(source: string, name: string): AggregateSplice | null {
  const ast = parseSourceFile(source, 'db/schema.ts')
  const aggregate = ast && findSchemaAggregate(ast, name)
  // A shape match the file does not identify is not enough to edit a hand-kept object:
  // `guren check` grades the same match advisory. Null here also silences
  // `appendSchemaTable`'s stale-aggregate warning, deliberately — advising by hand the
  // edit the writer itself declined is that same guess in prose.
  if (!aggregate?.confident) return null

  const { object, statement, keys } = aggregate
  const last = object.properties[object.properties.length - 1]
  const lastStart = last.start ?? -1
  const lastEnd = last.end ?? -1
  if (lastStart < 0 || lastEnd < 0) return null

  const multiline = source.slice(object.start ?? 0, object.end ?? 0).includes('\n')
  const indent = indentOfLine(source, lastStart)
  // Past a line comment on the last entry's own line, so a note written against
  // that entry is not re-attached to the new one. Only when a comma already
  // separates the two, since one added here would land inside the comment.
  const lineEnd = source.indexOf('\n', lastEnd)
  const commented = multiline && lineEnd > 0 && /^\s*,\s*\/\//.test(source.slice(lastEnd, lineEnd))

  return {
    declarationOffset: statementStart(source, statement.start ?? 0),
    key: keys.includes(name)
      ? null
      : commented
        ? { offset: lineEnd, text: `\n${indent}${name},` }
        : { offset: lastEnd, text: `${multiline ? `,\n${indent}` : ', '}${name}` },
  }
}

/** The offset the line containing `offset` starts at. */
function lineStartAt(source: string, offset: number): number {
  return source.lastIndexOf('\n', offset - 1) + 1
}

/** The leading whitespace of the line `offset` sits on. */
function indentOfLine(source: string, offset: number): string {
  return /^[^\S\n]*/.exec(source.slice(lineStartAt(source, offset), offset))?.[0] ?? ''
}

/**
 * `source` with `block` declaring `name` added — the one rule for writing a table into a
 * `db/schema.ts`, called by every scaffolder that adds one. End of file, unless the file
 * identifies an aggregate object of its tables: then the key goes in and the declaration
 * goes *ahead* of the object, since a `const` naming a table declared further down the
 * file is a use before declaration (TS2448).
 */
export function appendTableToSchema(
  source: string,
  name: string,
  block: string,
): { source: string; aggregated: boolean } {
  const aggregate = planAggregateSplice(source, name)
  if (!aggregate) return { source: `${source.trimEnd()}\n\n${block.trim()}\n`, aggregated: false }

  // Both splices come from the one parse, applied high offset first so the earlier
  // one still addresses the source it was measured against.
  let updated = source
  if (aggregate.key) {
    updated = updated.slice(0, aggregate.key.offset) + aggregate.key.text + updated.slice(aggregate.key.offset)
  }
  return {
    source: `${updated.slice(0, aggregate.declarationOffset)}${block.trim()}\n\n${updated.slice(aggregate.declarationOffset)}`,
    aggregated: aggregate.key !== null,
  }
}

export interface AppendSchemaTableOptions {
  /** The exported binding, e.g. `sessions`. Also what the already-declared guard looks for. */
  name: string
  blocks: Record<SchemaDialect, string>
  imports: Record<SchemaDialect, (content: string) => string>
  /** A non-builder import the block needs, inserted only when absent. */
  extraImport?: string
  /** What to tell a user whose app has no db/schema.ts. */
  manualGuidance: string
}

export type AppendSchemaTableResult = 'appended' | 'already-declared' | 'no-schema'

/**
 * Append a table to `db/schema.ts` in the app's own dialect. Any *exported*
 * binding of that name counts as one the app already has: builder spellings
 * vary, and appending a second is a compile error at best and a second
 * physical table at worst.
 */
export async function appendSchemaTable(options: AppendSchemaTableOptions): Promise<AppendSchemaTableResult> {
  const { name, blocks, imports, extraImport, manualGuidance } = options
  const schemaFile = 'db/schema.ts'
  const existing = await readIfExists(process.cwd(), schemaFile)

  if (existing === null) {
    consola.warn(`No ${schemaFile} found — ${manualGuidance}`)
    return 'no-schema'
  }

  const declared = new RegExp(
    `\\bexport\\s+(?:const|let)\\s+${escapeRegExp(name)}\\b|\\bexport\\s*\\{[^}]*\\b${escapeRegExp(name)}\\b`,
  )
  if (declared.test(existing)) {
    consola.info(`${schemaFile} already declares a ${name} table — left unchanged.`)
    // Reported rather than repaired: moving a declaration this run did not write
    // is beyond what a scaffolder should do to a hand-kept file. Which advice is
    // right depends on where that declaration sits — an earlier release appended
    // it at end of file, below the aggregate, where adding the key alone is TS2448.
    const stale = planAggregateSplice(existing, name)
    if (stale?.key) {
      const declaredAt = matchInCode(existing, declared)?.index ?? 0
      const fix = declaredAt > stale.declarationOffset
        ? `add it, moving \`export const ${name}\` above the object — below it the reference is a use before declaration`
        : `add it, or ${name} stays out of \`typeof schema\``
      consola.warn(`The schema object in ${schemaFile} does not list ${name} — ${fix}.`)
    }
    return 'already-declared'
  }

  const dialect = detectSchemaDialect(existing)
  let content = imports[dialect](existing)
  // Identifier-guarded: insertImport() recognizes only the exact statement, so a
  // schema already importing the name among others would get a duplicate binding.
  if (extraImport && !content.includes(extraImport.slice(extraImport.indexOf('{') + 1, extraImport.indexOf('}')).trim())) {
    content = insertImport(content, extraImport) ?? content
  }

  const written = appendTableToSchema(content, name, blocks[dialect])
  await writeFile(resolve(process.cwd(), schemaFile), written.source, 'utf8')
  consola.info(`Added the ${name} table to ${schemaFile} (${dialect}).`)
  if (written.aggregated) {
    consola.info(`Added ${name} to the schema object in ${schemaFile}.`)
  }
  return 'appended'
}
