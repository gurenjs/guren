import { readdir } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { writeGeneratedFile, type WriterOptions } from './utils'
import { extractPageProps, type ExtractedPageProps } from './page-props-extractor'

export type PageDefinition = {
  id: string
  path: string
  absolutePath?: string
}

export interface GeneratePageTypesOptions extends WriterOptions {
  appRoot?: string
  pagesDir?: string
  outputFile?: string
  extractProps?: boolean
}

const DEFAULT_PAGES_DIR = 'resources/js/pages'
const DEFAULT_OUTPUT_FILE = '.guren/pages.gen.ts'
const PAGE_COMPONENT_EXTENSIONS = new Set(['.tsx', '.jsx'])

export async function generatePageTypes(
  options: GeneratePageTypesOptions = {},
): Promise<{ outputPath: string; definitions: PageDefinition[] }> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const pagesDir = resolve(appRoot, options.pagesDir ?? DEFAULT_PAGES_DIR)
  const outputFile = resolve(appRoot, options.outputFile ?? DEFAULT_OUTPUT_FILE)
  const definitions = await collectPageDefinitions(pagesDir)

  if (definitions.length === 0) {
    return { outputPath: '', definitions }
  }

  let propsMap: Map<string, ExtractedPageProps> | undefined
  if (options.extractProps !== false) {
    propsMap = new Map()
    const outputDirectory = dirname(outputFile)
    for (const def of definitions) {
      if (def.absolutePath && PAGE_COMPONENT_EXTENSIONS.has(extname(def.absolutePath))) {
        const extracted = await extractPageProps(def.absolutePath, def.id)
        if (extracted.rawType) {
          propsMap.set(def.id, {
            ...extracted,
            imports: extracted.imports.map((statement) =>
              rewriteImportStatement(statement, dirname(def.absolutePath!), outputDirectory),
            ),
          })
        }
      }
    }
  }

  const module = buildPageModuleContent(definitions, {
    source: relative(appRoot, pagesDir) || DEFAULT_PAGES_DIR,
    propsMap,
  })

  const relativeTarget = relative(process.cwd(), outputFile) || outputFile
  const outputPath = await writeGeneratedFile(relativeTarget, module, { force: options.force })

  return { outputPath, definitions }
}

interface BuildContext {
  source: string
  propsMap?: Map<string, ExtractedPageProps>
}

export function buildPageModuleContent(definitions: PageDefinition[], context: BuildContext): string {
  const sortedDefinitions = definitions
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))

  const manifestEntries = sortedDefinitions
    .map((definition) => `  '${esc(definition.id)}': '${esc(definition.path)}',`)
    .join('\n')

  const hasProps = context.propsMap && context.propsMap.size > 0
  const propsImportsBlock = hasProps ? buildTypeImportsBlock(context.propsMap!) : ''
  const propsBlock = hasProps ? buildPagePropsBlock(context.propsMap!) : ''

  const pageTree = buildPageTree(sortedDefinitions)
  const pageObject = renderPageTree(pageTree, 1, context.propsMap)

  return `// Generated from ${context.source} — DO NOT EDIT
// Run \`guren codegen\` to regenerate.

import type { PageContract, PagePropsRecord } from '@guren/inertia-client'
${propsImportsBlock}

export const pageManifest = {
${manifestEntries}
} as const

export type PageManifest = typeof pageManifest
export type PageId = keyof PageManifest
export type PagePath<TPage extends PageId = PageId> = PageManifest[TPage]

export const pageIds = Object.keys(pageManifest) as PageId[]

export function isPageId(value: string): value is PageId {
  return Object.prototype.hasOwnProperty.call(pageManifest, value)
}
${propsBlock}
function defineGeneratedPage<TId extends string, TProps extends PagePropsRecord = Record<string, never>>(
  id: TId,
  path: string,
): PageContract<TId, TProps> {
  return {
    id,
    component: id,
    path,
    props<TNextProps extends PagePropsRecord>() {
      return defineGeneratedPage(id, path) as PageContract<TId, TNextProps>
    },
  } as PageContract<TId, TProps>
}

export const pages = ${pageObject} as const
`
}

function buildPagePropsBlock(propsMap: Map<string, ExtractedPageProps>): string {
  // Collect and deduplicate local type definitions across all pages
  const allLocalTypes = new Map<string, string>()
  for (const extracted of propsMap.values()) {
    for (const typeDef of extracted.localTypes) {
      // Use the type name as key for deduplication
      const nameMatch = typeDef.match(/^(?:export\s+)?(?:type|interface)\s+([A-Za-z0-9_]+)/)
      const key = nameMatch ? nameMatch[1] : typeDef
      if (!allLocalTypes.has(key)) {
        allLocalTypes.set(key, typeDef.replace(/^export\s+/, ''))
      }
    }
  }

  const localTypesBlock = allLocalTypes.size > 0
    ? Array.from(allLocalTypes.values()).join('\n\n') + '\n'
    : ''

  const entries = Array.from(propsMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pageId, extracted]) => {
      const type = extracted.rawType
      return `  '${esc(pageId)}': ${type}`
    })
    .join('\n')

  return `
${localTypesBlock}/**
 * Auto-extracted Props types from page components.
 */
export interface PagePropsMap {
${entries}
}

export type InferPageProps<TId extends PageId> =
  TId extends keyof PagePropsMap ? PagePropsMap[TId] : Record<string, never>
`
}

function buildTypeImportsBlock(propsMap: Map<string, ExtractedPageProps>): string {
  const imports = Array.from(propsMap.values())
    .flatMap((item) => item.imports)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .filter((statement) => !statement.includes("from 'react'") && !statement.includes('from "react"'))

  // Merge imports from the same module into a single statement
  const moduleImports = new Map<string, Set<string>>()
  for (const statement of imports) {
    const moduleMatch = statement.match(/from\s+['"]([^'"]+)['"]/u)
    if (!moduleMatch) continue
    const modulePath = moduleMatch[1]
    const specifierMatch = statement.match(/\{\s*([^}]+)\s*\}/)
    if (!specifierMatch) continue
    const specifiers = specifierMatch[1].split(',').map((s) => s.trim()).filter(Boolean)

    if (!moduleImports.has(modulePath)) {
      moduleImports.set(modulePath, new Set())
    }
    for (const specifier of specifiers) {
      moduleImports.get(modulePath)!.add(specifier)
    }
  }

  const merged = Array.from(moduleImports.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([modulePath, specifiers]) => {
      const sorted = Array.from(specifiers).sort()
      return `import type { ${sorted.join(', ')} } from '${modulePath}'`
    })

  if (merged.length === 0) {
    return ''
  }

  return `${merged.join('\n')}\n`
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

async function collectPageDefinitions(
  directory: string,
  relativeDirectory = '',
): Promise<PageDefinition[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const definitions: PageDefinition[] = []

  for (const entry of entries) {
    const entryRelativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    const entryPath = resolve(directory, entry.name)

    if (entry.isDirectory()) {
      definitions.push(...await collectPageDefinitions(entryPath, entryRelativePath))
      continue
    }

    const extension = extname(entry.name)
    if (!PAGE_COMPONENT_EXTENSIONS.has(extension)) continue

    const normalized = entryRelativePath.replace(/\\/gu, '/')
    const id = normalized.slice(0, normalized.length - extension.length)

    definitions.push({ id, path: `./pages/${normalized}`, absolutePath: entryPath })
  }

  return definitions
}

// ─── Tree rendering ──────────────────────────────────────────

type PageTreeNode = {
  children: Map<string, PageTreeNode>
  page?: PageDefinition
}

function createPageTreeNode(): PageTreeNode {
  return { children: new Map() }
}

function buildPageTree(definitions: PageDefinition[]): PageTreeNode {
  const root = createPageTreeNode()
  for (const definition of definitions) {
    let current = root
    for (const segment of definition.id.split('/')) {
      const next = current.children.get(segment) ?? createPageTreeNode()
      current.children.set(segment, next)
      current = next
    }
    current.page = definition
  }
  return root
}

function renderPageTree(node: PageTreeNode, depth: number, propsMap?: Map<string, ExtractedPageProps>): string {
  const indentation = '  '.repeat(depth)
  const entries = Array.from(node.children.entries()).map(([segment, child]) => {
    return `${indentation}${renderPageNode(segment, child, depth + 1, propsMap)}`
  })
  return `{\n${entries.join(',\n')}\n${'  '.repeat(depth - 1)}}`
}

function renderPageNode(segment: string, node: PageTreeNode, depth: number, propsMap?: Map<string, ExtractedPageProps>): string {
  const key = renderObjectKey(segment)

  if (node.page && node.children.size === 0) {
    const id = node.page.id
    const extracted = propsMap?.get(id)
    const hasTypedProps = Boolean(extracted)
    const typeArgs = hasTypedProps
      ? `<'${esc(id)}', PagePropsMap['${esc(id)}']>`
      : ''
    return `${key}: defineGeneratedPage${typeArgs}('${esc(id)}', pageManifest['${esc(id)}'])`
  }

  return `${key}: ${renderPageTree(node, depth, propsMap)}`
}

function renderObjectKey(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value) ? value : `'${esc(value)}'`
}

function esc(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")
}
