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
    definitions = await collectResourceDefinitions(appRoot, files, outputDirectory)
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
): Promise<ResourceDefinition[]> {
  const ordered = files
    .map((file) => ({ file, relPath: toPosixRelative(appRoot, file) }))
    .sort((left, right) => (left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0))

  const definitions: ResourceDefinition[] = []
  for (const { file, relPath } of ordered) {
    const extracted = await extractResourceType(file, outputDirectory, relPath)
    if (extracted) definitions.push(extracted)
  }

  return definitions
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
 * - No `toArray()` type could be extracted (`rawType === null`). Silent, as it
 *   has always been: the shapes this recognises are a documented subset.
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

  // Strategy 1: Explicit exported interface `export interface PostResourceData { ... }`
  const interfaceMatch = source.match(
    new RegExp(`export\\s+interface\\s+${baseName}(?:Resource)?Data\\s+(\\{[\\s\\S]*?\\n\\})`),
  )
  if (interfaceMatch) {
    return { ...common, rawType: interfaceMatch[1] }
  }

  // Strategy 2: Explicit return type on toArray(): `toArray(): SomeType {`
  const returnTypeMatch = source.match(/toArray\s*\(\s*\)\s*:\s*(\w+(?:Data)?)\s*\{/)
  if (returnTypeMatch) {
    const typeName = returnTypeMatch[1]
    // Find the type/interface definition in the same file
    const typeDefMatch = source.match(
      new RegExp(`(?:export\\s+)?(?:interface|type)\\s+${typeName}\\s*(?:=\\s*|extends[^{]*)(\\{[\\s\\S]*?\\n\\})`),
    )
    if (typeDefMatch) {
      return { ...common, rawType: typeDefMatch[1] }
    }
  }

  // The class is a Resource but none of the recognised shapes described its
  // payload. Reported anyway, with no type: it still claims its class name,
  // which is what stops a same-named twin elsewhere from resolving a hint.
  return { ...common, rawType: null }
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
