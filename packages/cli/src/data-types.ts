/**
 * Generates typed data contracts from JsonResource subclasses.
 *
 * Scans `app/Http/Resources/` — at the project root and inside every
 * `modules/<name>/` (RFC 0002) — for classes extending `Resource`, extracts
 * the return type of `toArray()` (or an explicit `interface XxxData`), and
 * emits a `data.gen.ts` file that exports a `Data` namespace.
 */
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { RESOURCES_DIR, discoverResourceFiles, moduleNameFromRelPath, toPosixRelative } from './discovery'
import { isIdentifier, pascalCase, resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'
import { parseSourceFile } from './parse-cache'

export interface ResourceDefinition {
  /** Class name (e.g. 'PostResource') */
  className: string
  /**
   * `Data` namespace member this resource is emitted as (e.g. 'Post'), or
   * `null` when the class was discovered but nothing was emitted for it —
   * see {@link resolveEmittableNames}.
   *
   * Module resources are qualified with their module — `modules/billing/`'s
   * `InvoiceResource` becomes `Data.BillingInvoice` — so that a name depends
   * only on where the class lives. Qualifying only on collision would be
   * prettier and unstable: adding a second `InvoiceResource` elsewhere would
   * rename an existing type out from under the frontend importing it.
   */
  dataName: string | null
  /** Raw TypeScript type body for toArray() return — `null` if none was found. */
  rawType: string | null
  /** Type imports required by this data type */
  imports: string[]
  /** Module (`modules/<name>/`) the class lives in — `null` at the project root. */
  module: string | null
  /** Source file, POSIX-relative to the app root. */
  filePath: string
}

export interface GenerateDataTypesOptions extends WriterOptions {
  appRoot?: string
  /**
   * Scan this sub-directory of each app root instead of `app/Http/Resources`.
   * An escape hatch for a non-conventional layout; it still fans out over
   * `modules/<name>/` and still skips test files, because it is the same
   * scanner with a different sub-path rather than a second scanning rule.
   */
  resourcesDir?: string
  outputFile?: string
}

const DEFAULT_OUTPUT_FILE = '.guren/data.gen.ts'

export async function generateDataTypes(
  options: GenerateDataTypesOptions = {},
): Promise<{ outputPath: string; definitions: ResourceDefinition[]; warnings: string[] }> {
  const appRoot = resolveAppRoot(options)
  const outputFile = resolve(appRoot, options.outputFile ?? DEFAULT_OUTPUT_FILE)
  const outputDirectory = dirname(outputFile)

  // Returned rather than logged, same contract as `generateApiClientTypes`:
  // `guren codegen` prints them, and the MCP codegen tool hands them to the
  // agent that asked for the run, where a console line would reach nobody.
  const warnings: string[] = []

  const resourcesDir = options.resourcesDir ?? RESOURCES_DIR

  let definitions: ResourceDefinition[]
  try {
    const files = await discoverResourceFiles(appRoot, resourcesDir)
    const collected = await collectResourceDefinitions(appRoot, files, outputDirectory)
    definitions = collected.definitions
    warnings.push(...collected.warnings)
  } catch {
    definitions = []
  }

  resolveEmittableNames(definitions, warnings)

  const module = buildDataModuleContent(definitions, {
    source: `${resourcesDir} (and modules/*/${resourcesDir})`,
  })

  const outputPath = await writeGeneratedFileIn(appRoot, outputFile, module, { force: options.force })

  return { outputPath, definitions, warnings }
}

export function buildDataModuleContent(
  definitions: ResourceDefinition[],
  context: { source: string },
): string {
  // `dataName === null` is a class that was discovered but not emitted; it
  // stays in `definitions` so hint resolution can see the name is claimed.
  const sorted = definitions
    .filter((d): d is ResourceDefinition & { dataName: string; rawType: string } => d.dataName !== null)
    .sort((a, b) => a.dataName.localeCompare(b.dataName))
  const imports = Array.from(new Set(sorted.flatMap((definition) => definition.imports)))
    .sort((left, right) => left.localeCompare(right))
  const importsBlock = imports.length > 0 ? `${imports.join('\n')}\n\n` : ''

  const typeEntries = sorted
    .map((def) => `  export type ${def.dataName} = ${def.rawType}`)
    .join('\n\n')

  return `// Generated from ${context.source} — DO NOT EDIT
// Run \`guren codegen\` to regenerate.

${importsBlock}\
/**
 * Auto-extracted data types from Resource classes.
 * Import these in your frontend to get typed API responses.
 */
export namespace Data {
${typeEntries || '  // No resources found'}
}
`
}

/**
 * Parses every discovered Resource file, ordered by app-root-relative path so
 * that {@link resolveEmittableNames}'s first-wins rule is reproducible rather
 * than dependent on the order the filesystem reported. Compared bytewise, not
 * by locale: the order decides which of two colliding resources keeps the
 * name, and that verdict must not vary by machine.
 */
async function collectResourceDefinitions(
  appRoot: string,
  files: string[],
  outputDirectory: string,
): Promise<{ definitions: ResourceDefinition[]; warnings: string[] }> {
  const ordered = files
    .map((file) => ({ file, relPath: toPosixRelative(appRoot, file) }))
    .sort((left, right) => (left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0))

  const definitions: ResourceDefinition[] = []
  const warnings: string[] = []
  for (const { file, relPath } of ordered) {
    const extracted = await extractResourceType(file, outputDirectory, relPath, warnings)
    if (extracted) definitions.push(extracted)
  }

  return { definitions, warnings }
}

/**
 * Words TypeScript rejects as a type alias name even though they are
 * identifier-shaped, so `export type default = …` never reaches the file.
 * Contextual keywords (`any`, `string`, `await`) are absent because they are
 * legal here — verified against `tsc`, not assumed.
 */
const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'typeof', 'var', 'void', 'while', 'with',
])

/**
 * Clears the `dataName` of every definition that cannot be emitted as its own
 * `Data` member, and warns about each. One uncompilable `data.gen.ts` costs the
 * app every type in it, so a named omission is the cheaper failure.
 *
 * Cleared rather than removed: a discovered-but-unemitted class still occupies
 * its class name, and `buildApiClientContent` has to be able to tell "no such
 * Resource" from "that Resource exists but has no type" — a response hint
 * carries only the class name, so without the tombstone the surviving twin
 * would look unique and type the route with the other root's payload.
 *
 * Three ways to be unemittable:
 *
 * - No `toArray()` type could be extracted (`rawType === null`). Warned about
 *   by {@link extractResourceType}, the only place that knows *which*
 *   recognised shape the file missed and so what to tell the author to change.
 * - The name is one TypeScript will not accept. A class name is always an
 *   identifier, but a module directory name is not — `modules/2fa/` qualifies
 *   to `2faInvoice` — and neither is safe from reserved words.
 * - Another definition claimed the name first. Module qualification rules out
 *   the collision that motivates the fan-out (root `PostResource` vs
 *   `modules/blog/`'s) but not every one: two module directories differing
 *   only in separator (`my-module`, `my_module`) qualify to the same prefix,
 *   and a root `BillingInvoiceResource` collides with `modules/billing/`'s
 *   `InvoiceResource`.
 */
function resolveEmittableNames(definitions: ResourceDefinition[], warnings: string[]): void {
  const claimed = new Map<string, ResourceDefinition>()

  for (const definition of definitions) {
    const { dataName } = definition
    if (dataName === null || definition.rawType === null) {
      definition.dataName = null
      continue
    }

    if (!isIdentifier(dataName) || RESERVED_WORDS.has(dataName)) {
      warnings.push(
        `Resource ${definition.className} (${definition.filePath}) would be emitted as `
        + `"${dataName}", which TypeScript will not accept as a type name — omitted from `
        + 'data.gen.ts.'
        + (definition.module ? ` Rename the modules/${definition.module}/ directory.` : ''),
      )
      definition.dataName = null
      continue
    }

    const existing = claimed.get(dataName)
    if (existing) {
      warnings.push(
        `Resource ${definition.className} (${definition.filePath}) generates the same `
        + `Data type name "${dataName}" as ${existing.className} (${existing.filePath}) — `
        + `the first wins and ${definition.filePath} is omitted from data.gen.ts. `
        + 'Rename one of them.',
      )
      definition.dataName = null
      continue
    }

    claimed.set(dataName, definition)
  }
}

async function extractResourceType(
  filePath: string,
  outputDirectory: string,
  relPath: string,
  warnings: string[],
): Promise<ResourceDefinition | null> {
  const source = await readFile(filePath, 'utf-8')

  // Match class name: `export class PostResource extends Resource<...>`.
  // Gated ahead of collectTypeImports(), which is a full Babel parse and the
  // bulk of the per-file cost: every path below discards the imports when this
  // misses, and the scan now covers modules/*/ too.
  const classMatch = source.match(/export\s+class\s+(\w+Resource)\s+extends\s+Resource/)
  if (!classMatch) return null

  const imports = collectTypeImports(source, filePath).map((statement) =>
    rewriteImportStatement(statement, dirname(filePath), outputDirectory),
  )

  const className = classMatch[1]
  const baseName = className.replace(/Resource$/, '')
  const module = moduleNameFromRelPath(relPath)
  // Qualified with the module so the emitted name depends only on where the
  // class lives — see ResourceDefinition.dataName.
  const dataName = module ? `${pascalCase(module)}${baseName}` : baseName
  const common = { className, dataName, imports, module, filePath: relPath }
  // Comments and string literals are blanked out before anything is matched
  // against the source. Both routinely carry text that looks like a
  // declaration or an unbalanced brace and is neither — a commented-out draft
  // of the very interface being looked for is the ordinary case — and a regex
  // reading the raw file cannot tell the difference.
  const masked = maskCommentsAndStrings(source)

  // Strategy 1: an interface named after the class, `interface PostResourceData { ... }`
  const named = readObjectType(source, masked, `${baseName}(?:Resource)?Data`)
  if (named.kind === 'body') {
    return { ...common, rawType: named.body }
  }

  // Strategy 2: Explicit return type on toArray(): `toArray(): SomeType {`
  const returnTypeMatch = masked.match(/toArray\s*\(\s*\)\s*:\s*(\w+(?:Data)?)\s*\{/)
  if (returnTypeMatch) {
    const typeName = returnTypeMatch[1]
    const annotated = readObjectType(source, masked, typeName)
    if (annotated.kind === 'body') {
      return { ...common, rawType: annotated.body }
    }

    // The annotation names a type this file does not hand over. Which of the
    // two reasons it is decides what the author has to change, so say which:
    // a declaration that is simply elsewhere is a different fix from one that
    // is right here in a form that cannot be copied.
    warnings.push(
      annotated.kind === 'unreadable'
        ? `Resource ${className} (${relPath}) annotates toArray(): ${typeName} and `
          + describeUnreadable(annotated)
        : `Resource ${className} (${relPath}) annotates toArray(): ${typeName}, but no `
          + `interface or type ${typeName} is declared in that file — omitted from data.gen.ts. `
          + "Only the resource's own source is read, so move the declaration into it.",
    )
    return { ...common, rawType: null }
  }

  // An unannotated `toArray()` whose payload interface is right there but
  // unreadable is a different sentence again, and the one Strategy 1 alone can
  // reach.
  if (named.kind === 'unreadable') {
    warnings.push(`Resource ${className} (${relPath}) ${describeUnreadable(named)}`)
    return { ...common, rawType: null }
  }

  // Nothing recognised described the payload. Reported anyway, with no type:
  // the class still claims its name, which is what stops a same-named twin
  // elsewhere from resolving a response hint to this one's payload.
  //
  // An annotation in a shape Strategy 2 does not read — `Types.PostPayload`,
  // `PostData<string>` — is a different sentence from no annotation at all.
  // Telling an author who wrote one that they wrote none sends them to add a
  // second, which is how the silence this replaces wasted time in the first
  // place.
  const looseAnnotation = masked.match(/toArray\s*\(\s*\)\s*:\s*([^{;\n]+?)\s*\{/u)
  // Quoted from the source rather than the mask, so a string literal type
  // inside the annotation reads back as the author wrote it.
  const annotationStart = looseAnnotation
    ? looseAnnotation.index! + looseAnnotation[0].indexOf(looseAnnotation[1])
    : -1
  warnings.push(
    looseAnnotation
      ? `Resource ${className} (${relPath}) annotates toArray(): `
        + `${source.slice(annotationStart, annotationStart + looseAnnotation[1].length)}, which `
        + 'is not a shape data.gen.ts can be built from — omitted. Name a plain interface or '
        + 'type declared in the same file.'
      : `Resource ${className} (${relPath}) has no toArray() return type to extract — omitted `
        + `from data.gen.ts. Declare \`export interface ${baseName}ResourceData { … }\` in that `
        + `file and annotate \`toArray(): ${baseName}ResourceData\`.`,
  )
  return { ...common, rawType: null }
}

/**
 * What the file declares under `namePattern`: a copyable object body, nothing
 * at all, or a declaration that exists but cannot be copied.
 *
 * The third case is why this is not just `string | null`. Every shape in it
 * used to yield *some* brace body — the wrong one — which is worse than
 * yielding none: the frontend gets a type that compiles and lies. Refusing
 * costs one `Data` member; guessing costs the trust in all of them.
 */
type ObjectTypeRead =
  | { kind: 'body'; body: string }
  | { kind: 'none' }
  | { kind: 'unreadable'; typeName: string; reason: string }

/**
 * The body of `interface <name> { … }` / `type <name> = { … }`, declared
 * anywhere in `source`.
 *
 * `masked` is {@link maskCommentsAndStrings} of the same string: everything is
 * *matched* against it and *sliced* from `source`, so offsets stay usable
 * while text that only looks like code cannot be found.
 *
 * `namePattern` is spliced into a regex, so a caller may pass alternatives
 * (`Post(?:Resource)?Data`) rather than probing one spelling at a time.
 *
 * The brace that opens the body has to be found by the pattern rather than by
 * searching forward for the next `{`: a `type PostData = string` followed by
 * the class declaration would otherwise hand back the class body.
 */
function readObjectType(source: string, masked: string, namePattern: string): ObjectTypeRead {
  const declaration = new RegExp(
    // `[^{;]*` for the heritage clause, so `extends Record<string, unknown>`
    // is stepped over; `;` bounds it so an aliasless declaration cannot run
    // into a later statement's brace.
    `(?:export\\s+)?(?:interface|type)\\s+(${namePattern})\\b\\s*(?:(=)\\s*|(extends[^{;]*))?\\{`,
    'u',
  )
  const match = declaration.exec(masked)
  if (!match) {
    // Declared, but not in a form with a body this can copy — `type X = string`,
    // an intersection, a generic. Distinguishing this from "not declared here"
    // is what lets the caller say which of the two it is.
    const anyDeclaration = new RegExp(`(?:interface|type)\\s+(${namePattern})\\b(\\s*<)?`, 'u')
      .exec(masked)
    if (!anyDeclaration) return { kind: 'none' }

    return {
      kind: 'unreadable',
      typeName: anyDeclaration[1],
      // A generic *is* an object type, so saying it is not one sends the
      // author to rewrite the shape rather than the one thing in the way.
      // `{ id: T }` copied out of its declaration does not compile.
      reason: anyDeclaration[2]
        ? 'takes type parameters, which have no meaning once the body is copied out'
        : 'is not a plain object type',
    }
  }

  const [, typeName, isAlias, heritage] = match

  // An `extends` clause holding an object type — `extends Record<string, { … }>`
  // — puts a brace in front of the real one, and the heritage pattern stops at
  // the first. Unbalanced angle brackets are what gives that away: the clause
  // was cut mid-generic. `=>` is stripped so a function type's arrow does not
  // read as a closing one.
  if (heritage) {
    const brackets = heritage.replace(/=>/gu, '')
    if (countOccurrences(brackets, '<') !== countOccurrences(brackets, '>')) {
      return {
        kind: 'unreadable',
        typeName,
        reason: 'has an `extends` clause containing an object type, which cannot be told apart '
          + 'from the body itself',
      }
    }
  }

  const openIndex = match.index + match[0].length - 1
  const end = findBodyEnd(masked, openIndex)
  if (end === null) return { kind: 'unreadable', typeName, reason: 'is not a plain object type' }

  // Declaration merging: TypeScript unions every block, this reads one.
  const declarations = masked.match(new RegExp(`(?:interface|type)\\s+${typeName}\\b`, 'gu'))
  if (declarations && declarations.length > 1) {
    return {
      kind: 'unreadable',
      typeName,
      reason: 'is declared more than once, and only one of the blocks would be copied',
    }
  }

  // A type alias's right-hand side runs to the end of the statement, so a body
  // followed by `&`, `|` or a conditional `extends` is only its first term. An
  // interface always ends at its brace, so this cannot apply to one.
  if (isAlias) {
    const rest = masked.slice(end)
    if (/^\s*[&|]/u.test(rest) || /^\s*extends\b/u.test(rest)) {
      return {
        kind: 'unreadable',
        typeName,
        reason: 'composes other types, and only its first object body would be copied',
      }
    }
  }

  return { kind: 'body', body: source.slice(openIndex, end) }
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** The half of an unreadable-declaration warning that does not name the Resource. */
function describeUnreadable(read: { typeName: string; reason: string }): string {
  return `declares ${read.typeName} in that file, but it ${read.reason} — omitted from `
    + `data.gen.ts. Write ${read.typeName} as a single non-generic `
    + `\`interface ${read.typeName} { … }\` or \`type ${read.typeName} = { … }\` with its `
    + 'members inline.'
}

/**
 * Index just past the `}` closing the `{` at `openIndex`, by counting depth,
 * or `null` for an unterminated body.
 *
 * Depth, not a delimiter: the predecessor regexes ended a body at the first
 * `\n}`, which is neither necessary nor sufficient. A one-line
 * `interface PostResourceData { id: number }` ran past its own closing brace
 * and swallowed the class declaration below it — emitting a `data.gen.ts`
 * that did not compile, the one failure mode dropping a definition exists to
 * avoid — while a legitimately nested property forced a shape the convention
 * never promised.
 *
 * Takes the masked source, so no brace it counts is inside a comment or a
 * string.
 */
function findBodyEnd(masked: string, openIndex: number): number | null {
  let depth = 0

  for (let index = openIndex; index < masked.length; index += 1) {
    const char = masked[index]
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }

  return null
}

/**
 * `source` with the contents of comments and string literals replaced by
 * spaces, newlines and length preserved so every index still addresses the
 * same character in the original.
 *
 * Everything this module matches runs against the result: a declaration
 * inside a comment is not a declaration, and a brace inside a string is not
 * structure. Neither is exotic — a commented-out draft of an interface, or a
 * string literal type like `marker: '}'`, is ordinary code that a regex over
 * the raw file reads as the real thing.
 *
 * `patch-helpers.ts` masks for its own matching too, and deliberately does not
 * share this: it keeps the quotes so a masked `'A', 'B'` still splits into two
 * entries, and it is a write path that edits an app's own files, where the
 * divergences here (blanked quotes, an unterminated quote stopping at the
 * newline) would change what gets patched.
 */
function maskCommentsAndStrings(source: string): string {
  // Split on UTF-16 units so an index into `chars` is an index into `source`.
  const chars = source.split('')
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to && index < chars.length; index += 1) {
      if (chars[index] !== '\n') chars[index] = ' '
    }
  }

  let index = 0
  while (index < source.length) {
    const char = source[index]

    if (char === '/' && source[index + 1] === '/') {
      const lineEnd = source.indexOf('\n', index)
      const stop = lineEnd === -1 ? source.length : lineEnd
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2)
      const stop = commentEnd === -1 ? source.length : commentEnd + 2
      blank(index, stop)
      index = stop
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      index = maskStringLiteral(source, index, blank)
      continue
    }

    index += 1
  }

  return chars.join('')
}

/** Blanks the string literal opening at `openIndex`; returns the index past it. */
function maskStringLiteral(
  source: string,
  openIndex: number,
  blank: (from: number, to: number) => void,
): number {
  const quote = source[openIndex]
  let index = openIndex + 1

  while (index < source.length) {
    const char = source[index]

    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) {
      index += 1
      break
    }
    // Only a template literal spans lines. Stopping at the newline keeps a
    // lone apostrophe in prose from swallowing the rest of the file.
    if (quote !== '`' && char === '\n') break
    // A template's `${ … }` can hold another template, whose backtick would
    // otherwise be read as this one's closing delimiter — which truncates the
    // body being read, silently and mid-property.
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      index = maskTemplateExpression(source, index + 1, blank)
      continue
    }

    index += 1
  }

  blank(openIndex, index)
  return index
}

/** Index just past the `}` closing the template expression opening at `openIndex`. */
function maskTemplateExpression(
  source: string,
  openIndex: number,
  blank: (from: number, to: number) => void,
): number {
  let depth = 0
  let index = openIndex

  while (index < source.length) {
    const char = source[index]

    if (char === "'" || char === '"' || char === '`') {
      index = maskStringLiteral(source, index, blank)
      continue
    }
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }

    index += 1
  }

  return source.length
}

function collectTypeImports(source: string, filePath: string): string[] {
  const ast = parseSourceFile(source, filePath)
  if (!ast) return []

  const imports: string[] = []
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration' && node.importKind === 'type') {
      imports.push(source.slice(node.start!, node.end!))
      continue
    }
    if (node.type !== 'ImportDeclaration' || node.importKind !== 'value') continue
    const typeSpecifiers = node.specifiers.filter(
      (s): s is Extract<typeof s, { type: 'ImportSpecifier' }> =>
        s.type === 'ImportSpecifier' && s.importKind === 'type',
    )
    if (typeSpecifiers.length === 0) continue

    const imported = typeSpecifiers
      .map((specifier) => {
        const importedName = specifier.imported.type === 'Identifier'
          ? specifier.imported.name
          : specifier.imported.value
        const localName = specifier.local.name
        return importedName === localName ? importedName : `${importedName} as ${localName}`
      })
      .join(', ')
    if (!imported) continue
    imports.push(`import type { ${imported} } from '${node.source.value}'`)
  }

  return imports
}

function rewriteImportStatement(statement: string, sourceDirectory: string, outputDirectory: string): string {
  const match = statement.match(/from\s+['"]([^'"]+)['"]/u)
  if (!match) return statement

  const [, importPath] = match
  if (!importPath.startsWith('.')) return statement

  const absoluteImportPath = resolve(sourceDirectory, importPath)
  const relativeImportPath = relative(outputDirectory, absoluteImportPath).replace(/\\/gu, '/')
  const normalizedPath =
    relativeImportPath.startsWith('.') ? relativeImportPath : `./${relativeImportPath}`

  return statement.replace(importPath, normalizedPath)
}
