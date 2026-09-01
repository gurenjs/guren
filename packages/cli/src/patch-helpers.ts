import { readFile, writeFile } from 'node:fs/promises'
import { readIfExists } from './discovery'
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
 * A copy of `source` with the contents of comments and string literals
 * blanked out, character for character, so every index still lines up with
 * the original.
 *
 * These patches locate their edit site by regex, and text that merely *looks*
 * like code is the failure mode in both directions: a disabled
 * `// kernel.registerMany([Foo])` or a docblock example gets edited in place
 * of the real call, while a `'https://…'` earlier on the line makes a real
 * call look commented out. Matching against the mask and slicing from the
 * original settles both, and keeps brace/bracket counting from tripping over
 * a `{` inside a string.
 */
// `data-types.ts` masks for its own matching and does not share this one: it
// blanks the quotes as well and stops an unterminated `'`/`"` at the newline,
// which `parseArrayEntries` below cannot have — it counts masked entries and
// needs `'A', 'B'` to stay two of them.
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
 * First match of `pattern` that lands in real code rather than a comment or
 * a string. Indices refer to `content`; read spans out of `content`, not out
 * of the mask, which is blanked.
 */
function matchInCode(content: string, pattern: RegExp): RegExpExecArray | null {
  return new RegExp(pattern.source, 'g').exec(maskNonCode(content))
}

/**
 * Index of the delimiter closing the one at `openIndex`, or `-1`. Counts
 * depth over the masked source, so nesting is respected and a bracket inside
 * a string or comment does not shift the result.
 */
function findClosingDelimiter(content: string, openIndex: number, open: string, close: string): number {
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

/**
 * Entries of an array literal's interior, e.g. `'A, B'` -> `['A', 'B']`.
 * Comment and string text is blanked first, so a name that only appears in a
 * comment is not mistaken for an existing entry.
 */
function parseArrayEntries(inner: string): string[] {
  return maskNonCode(inner)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * `arrayInterior` with `valueSource` appended. The existing text is preserved
 * verbatim rather than re-joined from parsed entries: re-joining collapses a
 * formatted multi-line array onto one line and folds any trailing `// note`
 * over the rest of the statement.
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
 * Whether every binding `importStatement` asks for is already imported from
 * the same module, however that import is spelled.
 *
 * The literal-line test above only recognizes the exact statement this
 * package would have written, so an import that has since been *merged* —
 * `import { Router, registerAttachmentRoutes } from '@guren/core'`, which is
 * the idiomatic form and what any formatter produces — reads as absent. The
 * patch then appends a second `import { registerAttachmentRoutes } from
 * '@guren/core'` and the app stops compiling on a duplicate binding. Re-running
 * a scaffolder is supposed to repair, not break.
 *
 * Deliberately conservative: it answers only for plain named imports of the
 * same module, and only when *every* requested binding is present. A default
 * or namespace import, a different module, or a partial overlap falls through
 * to the insert, because merging into someone else's import statement is a
 * bigger edit than this function is allowed to make.
 */
function namedBindingsAlreadyImported(content: string, importStatement: string): boolean {
  const requested = parseNamedImport(importStatement)
  if (!requested) return false

  const existing = new Set<string>()
  // `[\s\S]` rather than `.` so a multi-line import block is one match.
  const pattern = new RegExp(
    `import\\s+(?:type\\s+)?\\{([\\s\\S]*?)\\}\\s*from\\s*['"]${escapeRegExp(requested.source)}['"]`,
    'g',
  )
  for (const match of content.matchAll(pattern)) {
    for (const binding of splitBindings(match[1] ?? '')) existing.add(binding)
  }

  return requested.bindings.length > 0 && requested.bindings.every((binding) => existing.has(binding))
}

/** `{ a, b as c }` from `'mod'` → bindings `['a', 'c']`; `null` for any other import form. */
function parseNamedImport(statement: string): { bindings: string[]; source: string } | null {
  const match = /^import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?$/.exec(statement)
  if (!match) return null
  return { bindings: splitBindings(match[1] ?? ''), source: match[2] ?? '' }
}

/**
 * The local names a binding list introduces. `x as y` binds `y` — the local
 * name is what can collide, and what TypeScript reports as a duplicate.
 */
function splitBindings(list: string): string[] {
  return list
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const aliased = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(entry)
      if (aliased) return aliased[1] ?? ''
      return entry.replace(/^type\s+/, '').trim()
    })
    .filter(Boolean)
}

/**
 * `content` with `importStatement` inserted after the last existing import, or
 * `null` when it is already there.
 *
 * Split out from `addImport` so a patch that also edits the body can apply both
 * in one write: the alternative is a second file-level pass that can leave an
 * import behind when the body edit is the one that failed.
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

/**
 * Adds an import statement to a file if not already present.
 * Inserts the import at the top of the file, after any existing imports.
 */
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
 * Either the patched content or the reason it could not be produced. The
 * in-memory counterpart of `PatchResult`, for patches whose "nothing to do"
 * and "cannot do it" outcomes are more than one bit — `insertImport` gets away
 * with `string | null` because it has only one.
 */
export type InsertResult = { content: string; reason?: undefined } | { content?: undefined; reason: string }

/**
 * `content` with `providerName` appended to its `providers: [ ... ]` array.
 *
 * Pure, and split out for the same reason as `insertImport`: a caller that
 * also has to add the provider's import applies both here and writes once, so
 * a failure cannot leave one half of the pair on disk. Composed with
 * `insertImport` by `addProviderRegistration`.
 *
 * The array is re-joined from its parsed entries rather than appended to in
 * place (what `appendArrayEntry` does), so a multi-line `providers` array is
 * collapsed onto one line. That is long-standing output every provider-wiring
 * test pins; it is preserved deliberately.
 */
export function insertProvider(
  content: string,
  providerName: string,
  /**
   * Custom "already registered" check over the existing array entries.
   * Defaults to exact-match against `providerName`; factory registrations
   * pass a prefix check so a configured call like `vercelPlugin({ ... })`
   * counts as registered.
   */
  isRegistered?: (entries: string[]) => boolean,
): InsertResult {
  const providersArrayPattern = /providers:\s*\[([\s\S]*?)\]/
  const match = content.match(providersArrayPattern)

  if (!match) {
    return { reason: PATCH_REASONS.providersArrayNotFound }
  }

  const providers = parseArrayEntries(match[1])

  const alreadyRegistered = isRegistered
    ? isRegistered(providers)
    : providers.some(p => p === providerName)
  if (alreadyRegistered) {
    return { reason: PATCH_REASONS.providerAlreadyRegistered }
  }

  providers.push(providerName)

  return {
    content: content.replace(providersArrayPattern, `providers: [${providers.join(', ')}]`),
  }
}

/**
 * Adds a provider to the providers array in Application initialization.
 */
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
  const match = matchInCode(content, callPattern)

  if (!match) {
    return `Could not find a ${callName}({ ... }) call`
  }

  const start = match.index + match[0].length - 1
  const end = findClosingDelimiter(content, start, '{', '}')

  return end === -1 ? `Could not parse ${callName} options object` : { start, end }
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

  if (parseArrayEntries(interior).some((entry) => entry === valueSource)) {
    return { modified: false, reason: PATCH_REASONS.alreadyPresent }
  }

  const updatedContent
    = content.slice(0, open + 1) + appendArrayEntry(interior, valueSource) + content.slice(close)

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
  const content = await readIfExists(process.cwd(), filePath)

  if (content === null) {
    return { modified: false, reason: PATCH_REASONS.fileNotFound }
  }

  // The leading lookbehind is what keeps `unregisterMany([])` from matching
  // on its `registerMany` suffix when the optional receiver group is absent.
  const callPattern = new RegExp(
    `(?<![\\w$])(?:[\\w$]+(?:\\.[\\w$]+)*\\.)?${escapeRegExp(methodName)}\\s*\\(\\s*\\[`,
  )
  const match = matchInCode(content, callPattern)

  if (!match) {
    return { modified: false, reason: `Could not find a ${methodName}([ ... ]) call` }
  }

  const open = match.index + match[0].length - 1
  const close = findClosingDelimiter(content, open, '[', ']')

  if (close === -1) {
    return { modified: false, reason: `Could not parse the ${methodName}() array` }
  }

  const interior = content.slice(open + 1, close)

  if (parseArrayEntries(interior).some((entry) => entry === valueSource)) {
    return { modified: false, reason: PATCH_REASONS.alreadyPresent }
  }

  const updatedContent
    = content.slice(0, open + 1) + appendArrayEntry(interior, valueSource) + content.slice(close)

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

import type { SchemaDialect } from './schema-parser'
export type { SchemaDialect }

/**
 * The drizzle dialect an app's `db/schema.ts` is written in. Every patcher
 * that appends columns or tables has to agree on this — `add auth` and
 * `add resource` writing different dialects into one schema is silent, since
 * drizzle's table builders accept a foreign dialect's column builders.
 *
 * Deliberately a whole-file content sniff, not the parser's per-table
 * resolution: patchers call this with content they hold mid-write, and the
 * case that matters most is a schema with no tables yet — hence the `pg`
 * fallback below, which a parse-based answer could not produce.
 */
/**
 * The `@guren/orm/drizzle/<dialect>` barrel each dialect's schema imports its
 * column builders from: a dialect signal for `detectSchemaDialect`, and the
 * module the `ensure*Imports` patchers below merge new builders into.
 */
export const DIALECT_BARRELS = {
  sqlite: '@guren/orm/drizzle/sqlite',
  pg: '@guren/orm/drizzle/pg',
  mysql: '@guren/orm/drizzle/mysql',
} as const satisfies Record<SchemaDialect, string>

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
 * The `@guren/core` seeder context type each dialect's seeders must be
 * annotated with. `SeederContext` alone is PostgreSQL-shaped, so an
 * unannotated seeder in a MySQL or SQLite app rejects its own schema.
 */
export const seederContextTypes = {
  sqlite: 'SqliteSeederContext',
  pg: 'PostgresSeederContext',
  mysql: 'MySqlSeederContext',
} as const satisfies Record<SchemaDialect, string>

/**
 * The dialect of the app's `db/schema.ts`. An app that has none yet reads as
 * PostgreSQL, the same default an empty schema yields.
 */
export async function readSchemaDialect(cwd: string = process.cwd()): Promise<SchemaDialect> {
  return detectSchemaDialect((await readIfExists(cwd, 'db/schema.ts')) ?? '')
}

/**
 * Ensures that a set of named imports from `specifier` are present in file
 * content. Merges into the first `import { ... } from '<specifier>'` or
 * prepends a new one. Returns the (possibly updated) content string.
 *
 * Three limits are inherited from the dialect-specific patchers this
 * generalizes, and callers have to know them:
 *
 * - The "already imported?" check is **not** module-scoped. A name in scope
 *   from any module counts as present, so nothing is added — see the mixed
 *   dialect case in `patch-helpers.test.ts`.
 * - Only the plain named form is merged. `import type`, default, and
 *   namespace imports of the same specifier do not match, so a second import
 *   line gets prepended alongside them.
 * - `needed` must be plain identifiers; they go into a `\b...\b` pattern
 *   unescaped.
 */
export function ensureNamedImports(content: string, specifier: string, needed: string[]): string {
  // Check only import lines for existing identifiers, not the entire file content
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

  // A function replacer, not a replacement string: `specifier` and the merged
  // names are parameters now, and `$&`/`$1` in a replacement string would be
  // expanded instead of inserted literally.
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
