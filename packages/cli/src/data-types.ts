/**
 * Generates typed data contracts from JsonResource subclasses.
 *
 * Scans `app/Http/Resources/` at the project root and inside every
 * `modules/<name>/` (RFC 0002), extracts the return type of `toArray()` (or an
 * explicit `interface XxxData`), and emits `data.gen.ts` exporting a `Data`
 * namespace. Copy first, reference second: a payload whose body cannot be
 * copied is emitted as an `import(...)` reference when the file exports it, a
 * fallback that cannot change output already being emitted.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { File } from '@babel/types'
import { RESOURCES_DIR, discoverResourceFiles, moduleNameFromRelPath, toPosixRelative } from './discovery'
import { isIdentifier, pascalCase, relativeImportPath, resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'
import { parseSourceFile } from './parse-cache'

export interface ResourceDefinition {
  className: string
  /**
   * `Data` namespace member this resource is emitted as, or `null` when the
   * class was discovered but nothing was emitted — see
   * {@link resolveEmittableNames}. Module resources are always qualified
   * (`modules/billing/`'s `InvoiceResource` → `Data.BillingInvoice`) so a name
   * depends only on where the class lives; qualifying only on collision would
   * rename an existing type out from under the frontend importing it.
   */
  dataName: string | null
  /**
   * Right-hand side of the emitted `export type` — a brace body copied from
   * the source, or an `import('…').Name` reference. `null` if neither.
   */
  rawType: string | null
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
   * Still fans out over `modules/<name>/` and still skips test files: the same
   * scanner with a different sub-path, not a second scanning rule.
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

  // Returned rather than logged, same contract as `generateApiClientTypes`: the
  // MCP codegen tool hands them to its caller, where a console line reaches nobody.
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
 * {@link resolveEmittableNames}'s first-wins rule is reproducible. Compared
 * bytewise, not by locale: which of two colliding resources keeps the name
 * must not vary by machine.
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
 * identifier-shaped. Contextual keywords (`any`, `string`, `await`) are absent
 * because they are legal here — verified against `tsc`, not assumed.
 */
const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'typeof', 'var', 'void', 'while', 'with',
])

/**
 * Clears the `dataName` of every definition that cannot be emitted as its own
 * `Data` member, and warns about each: one uncompilable `data.gen.ts` costs the
 * app every type in it, so a named omission is the cheaper failure.
 *
 * Cleared rather than removed, because the class still occupies its class name:
 * a response hint carries only that name, so without the tombstone
 * `buildApiClientContent` reads a surviving twin as unique and types the route
 * with the other root's payload. Unemittable means no extractable `toArray()`
 * type, a name TypeScript rejects (a module *directory* need not be an
 * identifier — `modules/2fa/` qualifies to `2faInvoice`), or a name another
 * definition claimed first (module qualification does not rule every collision
 * out: `my-module`/`my_module` share a prefix, and a root
 * `BillingInvoiceResource` collides with `modules/billing/`'s `InvoiceResource`).
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

  // Gated ahead of parseSourceFile(), a full Babel parse and the bulk of the
  // per-file cost, which every path below discards when this misses.
  const classMatch = source.match(/export\s+class\s+(\w+Resource)\s+extends\s+Resource/)
  if (!classMatch) return null

  const ast = parseSourceFile(source, filePath)
  const imports = collectTypeImports(ast, source).map((statement) =>
    rewriteImportStatement(statement, dirname(filePath), outputDirectory),
  )
  const declaredTypes = collectTopLevelTypeDeclarations(ast)

  const className = classMatch[1]
  const baseName = className.replace(/Resource$/, '')
  const module = moduleNameFromRelPath(relPath)
  // Qualification rule: see ResourceDefinition.dataName.
  const dataName = module ? `${pascalCase(module)}${baseName}` : baseName
  const common = { className, dataName, imports, module, filePath: relPath }

  // A declaration that cannot be copied may still be referencable. The file's
  // type imports are dropped on that path: the reference resolves inside the
  // resource's own module, and two roots' same-named imports must not collide
  // in the shared import block.
  const resolveUnreadable = (
    read: Extract<ObjectTypeRead, { kind: 'unreadable' }>,
    warningPrefix: string,
  ): ResourceDefinition => {
    const reference = readTypeReference(declaredTypes, read.typeName, filePath, outputDirectory)
    if (reference.rawType !== null) {
      return { ...common, imports: [], rawType: reference.rawType }
    }
    warnings.push(warningPrefix + describeUnreadable(read, reference.exportWouldFix))
    return { ...common, rawType: null }
  }

  // Everything is matched against the mask: a commented-out draft of the very
  // interface being looked for is the ordinary case, and a regex over the raw
  // file cannot tell it from the real one.
  const masked = maskCommentsAndStrings(source)

  // Strategy 1: an interface named after the class.
  const named = readObjectType(source, masked, `${baseName}(?:Resource)?Data`)
  if (named.kind === 'body') {
    return { ...common, rawType: named.body }
  }

  // Strategy 2: an explicit return type on toArray().
  const returnTypeMatch = masked.match(/toArray\s*\(\s*\)\s*:\s*(\w+(?:Data)?)\s*\{/)
  if (returnTypeMatch) {
    const typeName = returnTypeMatch[1]
    const annotated = readObjectType(source, masked, typeName)
    if (annotated.kind === 'body') {
      return { ...common, rawType: annotated.body }
    }

    if (annotated.kind === 'unreadable') {
      return resolveUnreadable(
        annotated,
        `Resource ${className} (${relPath}) annotates toArray(): ${typeName} and `,
      )
    }

    // A declaration that is simply elsewhere is a different fix from one that
    // is right here in a form that cannot be copied, so say which.
    warnings.push(
      `Resource ${className} (${relPath}) annotates toArray(): ${typeName}, but no `
      + `interface or type ${typeName} is declared in that file — omitted from data.gen.ts. `
      + "Only the resource's own source is read, so move the declaration into it.",
    )
    return { ...common, rawType: null }
  }

  // An unannotated `toArray()` whose payload interface is right there but
  // unreadable is a different sentence again.
  if (named.kind === 'unreadable') {
    return resolveUnreadable(named, `Resource ${className} (${relPath}) `)
  }

  // Nothing recognised described the payload. Still reported with no type, so
  // the class keeps claiming its name against a same-named twin. An annotation
  // in a shape Strategy 2 does not read (`Types.PostPayload`, `PostData<string>`)
  // gets its own sentence: telling that author they wrote none sends them to
  // add a second one.
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
 * The third case is why this is not `string | null`: guessing a brace body for
 * it hands the frontend a type that compiles and lies, where refusing costs one
 * `Data` member. An unreadable declaration the file *exports* is not even lost —
 * the caller falls back to an import-type reference ({@link readTypeReference}).
 */
type ObjectTypeRead =
  | { kind: 'body'; body: string }
  | { kind: 'none' }
  | { kind: 'unreadable'; typeName: string; reason: string; fix?: string }

/**
 * The body of `interface <name> { … }` / `type <name> = { … }`, declared
 * anywhere in `source`.
 *
 * `masked` is {@link maskCommentsAndStrings} of the same string: everything is
 * *matched* against it and *sliced* from `source`. `namePattern` is spliced
 * into a regex, so a caller may pass alternatives. The opening brace must be
 * found by the pattern, not by searching forward for the next `{`: a
 * `type PostData = string` would otherwise hand back the class body below it.
 */
function readObjectType(source: string, masked: string, namePattern: string): ObjectTypeRead {
  const declaration = new RegExp(
    // Anchored to column 0: a declaration nested in a namespace or a function
    // body merely shares the name. `[^{;]*` steps over a heritage clause, with
    // `;` bounding it so an aliasless declaration cannot run into a later
    // statement's brace. `declare` is admitted so this reader and
    // collectTopLevelTypeDeclarations() agree on what counts as declared.
    `^(?:export\\s+)?(?:declare\\s+)?(?:interface|type)\\s+(${namePattern})\\b\\s*(?:(=)\\s*|(extends[^{;]*))?\\{`,
    'mu',
  )
  const match = declaration.exec(masked)
  if (!match) {
    // Declared, but with no copyable body. Distinguishing this from "not
    // declared here" is what lets the caller say which of the two it is.
    const anyDeclaration = new RegExp(
      `^(?:export\\s+)?(?:declare\\s+)?(?:interface|type)\\s+(${namePattern})\\b(\\s*<)?`,
      'mu',
    ).exec(masked)
    if (!anyDeclaration) return { kind: 'none' }

    return {
      kind: 'unreadable',
      typeName: anyDeclaration[1],
      // A generic *is* an object type; `{ id: T }` copied out of its
      // declaration is what does not compile.
      reason: anyDeclaration[2]
        ? 'takes type parameters, which have no meaning once the body is copied out'
        : 'is not a plain object type',
    }
  }

  const [, typeName, isAlias, heritage] = match

  // An `extends Record<string, { … }>` puts a brace in front of the real one,
  // and the heritage pattern stops at the first; unbalanced angle brackets are
  // what gives that away. `=>` is stripped so a function type's arrow does not
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
  if (end === null) {
    // Distinct from "not an object type": the shape is right and the file is
    // truncated. Telling the author to rewrite the type sends them past it.
    return {
      kind: 'unreadable',
      typeName,
      reason: 'opens a body that is never closed',
      fix: 'Close it.',
    }
  }

  // Declaration merging: TypeScript unions every block, this reads one. Same
  // anchor as above, since only top-level declarations merge with each other.
  const declarations = masked.match(
    new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:interface|type)\\s+${typeName}\\b`, 'gmu'),
  )
  if (declarations && declarations.length > 1) {
    return {
      kind: 'unreadable',
      typeName,
      reason: 'is declared more than once, and only one of the blocks would be copied',
    }
  }

  // A type alias's right-hand side runs to the end of the statement, so a body
  // followed by `&`/`|`, a conditional `extends`, or `[` is only its first
  // term. An interface always ends at its brace, so this cannot apply to one.
  if (isAlias) {
    const rest = masked.slice(end)
    if (/^\s*[&|[]/u.test(rest) || /^\s*extends\b/u.test(rest)) {
      return {
        kind: 'unreadable',
        typeName,
        reason: 'uses its object body as one operand of a larger type, not as the type itself',
      }
    }
  }

  return { kind: 'body', body: source.slice(openIndex, end) }
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * The half of an unreadable-declaration warning that does not name the
 * Resource. `exportWouldFix` says the declaration only missed the reference
 * fallback for being unexported — a one-word fix the default advice never
 * mentions.
 */
function describeUnreadable(
  read: { typeName: string; reason: string; fix?: string },
  exportWouldFix: boolean,
): string {
  const inline = `a single non-generic \`interface ${read.typeName} { … }\` or `
    + `\`type ${read.typeName} = { … }\` with its members inline.`
  const fix = read.fix
    ?? (exportWouldFix
      ? `Export ${read.typeName} so data.gen.ts can reference the declaration itself, or write it as ${inline}`
      : `Write ${read.typeName} as ${inline}`)

  return `declares ${read.typeName} in that file, but it ${read.reason} — omitted from `
    + `data.gen.ts. ${fix}`
}

/**
 * Index just past the `}` closing the `{` at `openIndex`, by counting depth,
 * or `null` for an unterminated body. Depth, not a delimiter: ending a body at
 * the first `\n}` is neither necessary (a nested property) nor sufficient (a
 * one-line declaration, which then swallows the class below it). Takes the
 * masked source, so no brace it counts is inside a comment or a string.
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
 * `patch-helpers.ts` masks for its own matching and deliberately does not share
 * this: it keeps the quotes so a masked `'A', 'B'` still splits into two
 * entries, and it is a write path where the divergences here (blanked quotes,
 * an unterminated quote stopping at the newline) would change what gets patched.
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
    // otherwise be read as this one's closing delimiter.
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

/**
 * Outcome of trying to emit a payload type as an import-type reference.
 *
 * The gate is exportedness proven from the AST: a reference to an unexported
 * name is a TS2694 that takes the whole artifact out of compilation, and the
 * `export` keyword on the declaration line is not the test (`export type { X }`
 * exports without one). `exportWouldFix` is true only when exporting is all
 * that stands in the way, so the warning can say "export it".
 */
type TypeReferenceRead =
  | { rawType: string }
  | { rawType: null; exportWouldFix: boolean }

interface TypeDeclarationInfo {
  /** Name the declaration is exported under, or `null` when it is not exported. */
  exportedName: string | null
  /** True when *any* declaration of this name takes type parameters. */
  generic: boolean
}

/**
 * Every top-level `interface`/`type` declaration in the file, keyed by local
 * name. Local declarations only: an `export … from` re-export forwards a
 * declaration whose genericity this parse cannot see.
 */
function collectTopLevelTypeDeclarations(ast: File | null): Map<string, TypeDeclarationInfo> {
  const declarations = new Map<string, TypeDeclarationInfo>()
  if (!ast) return declarations

  for (const node of ast.program.body) {
    const exported = node.type === 'ExportNamedDeclaration'
    const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node
    if (declaration?.type !== 'TSTypeAliasDeclaration' && declaration?.type !== 'TSInterfaceDeclaration') {
      continue
    }
    // Declaration merging: one generic block makes the merged type generic,
    // and one exported block exports it.
    const info = declarations.get(declaration.id.name) ?? { exportedName: null, generic: false }
    info.generic ||= declaration.typeParameters != null
    if (exported) info.exportedName ??= declaration.id.name
    declarations.set(declaration.id.name, info)
  }

  // Export lists in a second pass, so a list above its declaration still finds
  // it. Only identifier names are recorded (a dotted reference cannot spell
  // `export { X as 'wire name' }`); skipping the rest keeps a plainly-named
  // specifier of the same declaration in play whatever the list order.
  for (const node of ast.program.body) {
    if (node.type !== 'ExportNamedDeclaration' || node.declaration || node.source) continue
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ExportSpecifier') continue
      const info = declarations.get(specifier.local.name)
      if (!info) continue
      const exported = specifier.exported.type === 'Identifier'
        ? specifier.exported.name
        : specifier.exported.value
      if (!isIdentifier(exported)) continue
      info.exportedName ??= exported
    }
  }

  return declarations
}

/**
 * An `import('…').Name` reference to `typeName`'s own declaration, for a
 * payload {@link readObjectType} declared unreadable.
 *
 * A generic stays refused even when exported: a reference would have to pass
 * type arguments this has nowhere to get.
 */
function readTypeReference(
  declared: Map<string, TypeDeclarationInfo>,
  typeName: string,
  filePath: string,
  outputDirectory: string,
): TypeReferenceRead {
  const info = declared.get(typeName)
  if (!info || info.generic) return { rawType: null, exportWouldFix: false }

  const specifier = importTypeSpecifier(filePath, outputDirectory)
  if (specifier === null) return { rawType: null, exportWouldFix: false }
  if (info.exportedName === null) return { rawType: null, exportWouldFix: true }

  return { rawType: `import('${specifier}').${info.exportedName}` }
}

/**
 * Module specifier for an import-type reference from `data.gen.ts` to
 * `filePath`, or `null` for a file an extensionless specifier does not resolve
 * to. Extensionless is what this repo's generators choose; the `.js` suffixes
 * in generated imports are author-written statements copied verbatim. The
 * `.d.ts` guard sits here because this is the site that slices: stripping only
 * `.ts` from one would silently emit a specifier ending in `.d`.
 */
function importTypeSpecifier(filePath: string, outputDirectory: string): string | null {
  if (!filePath.endsWith('.ts') || filePath.endsWith('.d.ts')) return null
  return relativeImportPath(join(outputDirectory, 'data.gen.ts'), filePath.slice(0, -'.ts'.length))
}

function collectTypeImports(ast: File | null, source: string): string[] {
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
