/**
 * Extracts Props type declarations from React page components using Babel AST.
 *
 * Supports:
 * 1. `interface Props { ... }` or `type Props = { ... }`
 * 2. Default export function's first parameter type annotation
 */
import { readFile } from 'node:fs/promises'
import { parse } from '@babel/parser'

export interface ExtractedPageProps {
  pageId: string
  rawType: string | null
  imports: string[]
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
  const result: ExtractedPageProps = { pageId, rawType: null, imports: [] }

  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    })
  } catch {
    return result
  }

  // Collect type-only imports
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration' && node.importKind === 'type') {
      result.imports.push(source.slice(node.start!, node.end!))
    }
    if (node.type === 'ImportDeclaration' && node.importKind === 'value') {
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
      result.imports.push(`import type { ${imported} } from '${node.source.value}'`)
    }
  }

  // Strategy 1: `interface Props` / `type Props` / `export interface Props` / `export type Props`
  for (const node of ast.program.body) {
    if (node.type === 'TSInterfaceDeclaration' && node.id.name === 'Props') {
      result.rawType = source.slice(node.body.start!, node.body.end!)
      return result
    }
    if (node.type === 'TSTypeAliasDeclaration' && node.id.name === 'Props') {
      result.rawType = source.slice(node.typeAnnotation.start!, node.typeAnnotation.end!)
      return result
    }
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const decl = node.declaration
      if (decl.type === 'TSInterfaceDeclaration' && decl.id.name === 'Props') {
        result.rawType = source.slice(decl.body.start!, decl.body.end!)
        return result
      }
      if (decl.type === 'TSTypeAliasDeclaration' && decl.id.name === 'Props') {
        result.rawType = source.slice(decl.typeAnnotation.start!, decl.typeAnnotation.end!)
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
      return result
    }
  }

  return result
}
