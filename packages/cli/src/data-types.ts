/**
 * Generates typed data contracts from JsonResource subclasses.
 *
 * Scans `app/Http/Resources/*.ts` for classes extending `Resource`,
 * extracts the return type of `toArray()` (or an explicit `interface XxxData`),
 * and emits a `data.gen.ts` file that exports a `Data` namespace.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { writeGeneratedFile, type WriterOptions } from './utils'
import { parseSourceFile } from './parse-cache'

export interface ResourceDefinition {
  /** Class name (e.g. 'PostResource') */
  className: string
  /** Data type name (e.g. 'Post') */
  dataName: string
  /** Raw TypeScript type body for toArray() return */
  rawType: string
  /** Type imports required by this data type */
  imports: string[]
}

export interface GenerateDataTypesOptions extends WriterOptions {
  appRoot?: string
  resourcesDir?: string
  outputFile?: string
}

const DEFAULT_RESOURCES_DIR = 'app/Http/Resources'
const DEFAULT_OUTPUT_FILE = '.guren/data.gen.ts'

export async function generateDataTypes(
  options: GenerateDataTypesOptions = {},
): Promise<{ outputPath: string; definitions: ResourceDefinition[] }> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const resourcesDir = resolve(appRoot, options.resourcesDir ?? DEFAULT_RESOURCES_DIR)
  const outputFile = resolve(appRoot, options.outputFile ?? DEFAULT_OUTPUT_FILE)
  const outputDirectory = dirname(outputFile)

  let definitions: ResourceDefinition[]
  try {
    definitions = await collectResourceDefinitions(resourcesDir, outputDirectory)
  } catch {
    definitions = []
  }

  const module = buildDataModuleContent(definitions, {
    source: relative(appRoot, resourcesDir) || DEFAULT_RESOURCES_DIR,
  })

  const relativeTarget = relative(process.cwd(), outputFile) || outputFile
  const outputPath = await writeGeneratedFile(relativeTarget, module, { force: options.force })

  return { outputPath, definitions }
}

export function buildDataModuleContent(
  definitions: ResourceDefinition[],
  context: { source: string },
): string {
  const sorted = definitions.slice().sort((a, b) => a.dataName.localeCompare(b.dataName))
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

async function collectResourceDefinitions(
  directory: string,
  outputDirectory: string,
): Promise<ResourceDefinition[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const definitions: ResourceDefinition[] = []

  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith('.ts')) continue
    const filePath = resolve(directory, entry.name)
    const extracted = await extractResourceType(filePath, outputDirectory)
    if (extracted) definitions.push(extracted)
  }

  return definitions
}

async function extractResourceType(
  filePath: string,
  outputDirectory: string,
): Promise<ResourceDefinition | null> {
  const source = await readFile(filePath, 'utf-8')
  const imports = collectTypeImports(source).map((statement) =>
    rewriteImportStatement(statement, dirname(filePath), outputDirectory),
  )

  // Match class name: `export class PostResource extends Resource<...>`
  const classMatch = source.match(/export\s+class\s+(\w+Resource)\s+extends\s+Resource/)
  if (!classMatch) return null

  const className = classMatch[1]
  const dataName = className.replace(/Resource$/, '')

  // Strategy 1: Explicit exported interface `export interface PostResourceData { ... }`
  const interfaceMatch = source.match(
    new RegExp(`export\\s+interface\\s+${dataName}(?:Resource)?Data\\s+(\\{[\\s\\S]*?\\n\\})`),
  )
  if (interfaceMatch) {
    return { className, dataName, rawType: interfaceMatch[1], imports }
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
      return { className, dataName, rawType: typeDefMatch[1], imports }
    }
  }

  return null
}

function collectTypeImports(source: string): string[] {
  const ast = parseSourceFile(source)
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
