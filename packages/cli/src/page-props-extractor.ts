/**
 * Extracts Props type declarations from React page components using Babel AST.
 *
 * Supports:
 * 1. `interface Props { ... }` or `type Props = { ... }`
 * 2. Default export function's first parameter type annotation
 * 3. Local type/interface definitions referenced by Props (transitively)
 */
import { readFile } from 'node:fs/promises'
import { parse } from '@babel/parser'

export interface ExtractedPageProps {
  pageId: string
  rawType: string | null
  imports: string[]
  localTypes: string[]
}

export async function extractPageProps(
  filePath: string,
  pageId: string,
): Promise<ExtractedPageProps> {
  const source = await readFile(filePath, 'utf-8')
  return extractPagePropsFromSource(source, pageId)
}

export function extractPagePropsFromSource(
  source: string,
  pageId: string,
): ExtractedPageProps {
  const result: ExtractedPageProps = { pageId, rawType: null, imports: [], localTypes: [] }

  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    })
  } catch {
    return result
  }

  // Collect imported type names (to distinguish from local types)
  const importedNames = new Set<string>()

  // Collect type-only imports
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration' && node.importKind === 'type') {
      result.imports.push(source.slice(node.start!, node.end!))
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportSpecifier') {
          importedNames.add(specifier.local.name)
        }
      }
    }
    if (node.type === 'ImportDeclaration' && node.importKind === 'value') {
      const typeSpecifiers = node.specifiers.filter(
        (s): s is Extract<typeof s, { type: 'ImportSpecifier' }> =>
          s.type === 'ImportSpecifier' && s.importKind === 'type',
      )
      if (typeSpecifiers.length === 0) continue

      const imported = typeSpecifiers
        .map((specifier) => {
          importedNames.add(specifier.local.name)
          const importedName = specifier.imported.type === 'Identifier'
            ? specifier.imported.name
            : specifier.imported.value
          const localName = specifier.local.name
          return importedName === localName ? importedName : `${importedName} as ${localName}`
        })
        .join(', ')
      if (!imported) continue
      result.imports.push(`import type { ${imported} } from '${node.source.value}'`)
    }
  }

  // Collect all local type/interface definitions (excluding Props itself)
  const localTypeMap = new Map<string, string>()
  for (const node of ast.program.body) {
    if (node.type === 'TSTypeAliasDeclaration' && node.id.name !== 'Props') {
      localTypeMap.set(node.id.name, source.slice(node.start!, node.end!))
    }
    if (node.type === 'TSInterfaceDeclaration' && node.id.name !== 'Props') {
      localTypeMap.set(node.id.name, source.slice(node.start!, node.end!))
    }
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const decl = node.declaration
      if (decl.type === 'TSTypeAliasDeclaration' && decl.id.name !== 'Props') {
        localTypeMap.set(decl.id.name, source.slice(decl.start!, decl.end!))
      }
      if (decl.type === 'TSInterfaceDeclaration' && decl.id.name !== 'Props') {
        localTypeMap.set(decl.id.name, source.slice(decl.start!, decl.end!))
      }
    }
  }

  // Interfaces may extend other types (e.g. PaginatedPageProps<T>); compose
  // the heritage clauses with the body as an intersection so inherited
  // members stay part of the contract.
  function interfaceRawType(node: {
    body: { start?: number | null; end?: number | null }
    extends?: Array<{ start?: number | null; end?: number | null }> | null
  }): string {
    const body = source.slice(node.body.start!, node.body.end!)
    const heritage = (node.extends ?? [])
      .map((clause) => source.slice(clause.start!, clause.end!))
      .filter(Boolean)
    return heritage.length > 0 ? `${heritage.join(' & ')} & ${body}` : body
  }

  // Strategy 1: `interface Props` / `type Props` / `export interface Props` / `export type Props`
  for (const node of ast.program.body) {
    if (node.type === 'TSInterfaceDeclaration' && node.id.name === 'Props') {
      result.rawType = interfaceRawType(node)
      result.localTypes = collectReferencedLocalTypes(result.rawType, localTypeMap, importedNames)
      return result
    }
    if (node.type === 'TSTypeAliasDeclaration' && node.id.name === 'Props') {
      result.rawType = source.slice(node.typeAnnotation.start!, node.typeAnnotation.end!)
      result.localTypes = collectReferencedLocalTypes(result.rawType, localTypeMap, importedNames)
      return result
    }
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const decl = node.declaration
      if (decl.type === 'TSInterfaceDeclaration' && decl.id.name === 'Props') {
        result.rawType = interfaceRawType(decl)
        result.localTypes = collectReferencedLocalTypes(result.rawType, localTypeMap, importedNames)
        return result
      }
      if (decl.type === 'TSTypeAliasDeclaration' && decl.id.name === 'Props') {
        result.rawType = source.slice(decl.typeAnnotation.start!, decl.typeAnnotation.end!)
        result.localTypes = collectReferencedLocalTypes(result.rawType, localTypeMap, importedNames)
        return result
      }
    }
  }

  // Strategy 2: Default export function's first param type annotation
  for (const node of ast.program.body) {
    if (node.type !== 'ExportDefaultDeclaration') continue
    const decl = node.declaration
    if (decl.type !== 'FunctionDeclaration') continue
    const param = decl.params[0]
    if (!param) continue

    const annotation =
      param.type === 'ObjectPattern' || param.type === 'Identifier'
        ? (param as { typeAnnotation?: { type: string; typeAnnotation?: { start?: number | null; end?: number | null } } }).typeAnnotation
        : undefined

    if (annotation?.type === 'TSTypeAnnotation' && annotation.typeAnnotation?.start != null && annotation.typeAnnotation?.end != null) {
      result.rawType = source.slice(annotation.typeAnnotation.start, annotation.typeAnnotation.end)
      result.localTypes = collectReferencedLocalTypes(result.rawType, localTypeMap, importedNames)
      return result
    }
  }

  return result
}

/**
 * Finds local type/interface definitions transitively referenced from a type body string.
 * Returns the definitions in dependency order (dependencies first).
 */
function collectReferencedLocalTypes(
  typeBody: string,
  localTypeMap: Map<string, string>,
  importedNames: Set<string>,
): string[] {
  const collected = new Map<string, string>()
  const visiting = new Set<string>()

  function visit(text: string): void {
    // Match PascalCase identifiers that could be type references
    const identifiers = text.match(/\b[A-Z][A-Za-z0-9]*\b/g)
    if (!identifiers) return

    for (const name of identifiers) {
      // Skip if it's an imported type, built-in, or already collected
      if (importedNames.has(name)) continue
      if (collected.has(name)) continue
      if (visiting.has(name)) continue
      if (!localTypeMap.has(name)) continue

      visiting.add(name)
      const definition = localTypeMap.get(name)!
      // Recurse to collect transitive dependencies first
      visit(definition)
      collected.set(name, definition)
      visiting.delete(name)
    }
  }

  visit(typeBody)
  return Array.from(collected.values())
}
