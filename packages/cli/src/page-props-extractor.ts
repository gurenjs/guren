/**
 * Extracts Props type declarations from React page components: a `Props`
 * interface or alias, else the default export's first parameter annotation,
 * plus the local types either references transitively.
 */
import { readFile } from 'node:fs/promises'
import type {
  File,
  Statement,
  TSInterfaceDeclaration,
  TSType,
  TSTypeAliasDeclaration,
  TSTypeElement,
  TSTypeReference,
} from '@babel/types'
import { memberKeyName } from './ast-walk'
import { parseSourceFile } from './parse-cache'

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
  return extractPagePropsFromSource(source, pageId, filePath)
}

export function extractPagePropsFromSource(
  source: string,
  pageId: string,
  // Pages are `.tsx`; the default only applies to direct-source callers (tests),
  // since extractPageProps passes the real path.
  filePath = 'page.tsx',
): ExtractedPageProps {
  const result: ExtractedPageProps = { pageId, rawType: null, imports: [], localTypes: [] }

  const ast = parseSourceFile(source, filePath)
  if (!ast) return result

  // Tracked so `collectReferencedLocalTypes` can exclude them.
  const importedNames = new Set<string>()

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

  // Heritage clauses compose with the body as an intersection, so members
  // inherited from e.g. PaginatedPageProps<T> stay part of the contract.
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

  const located = locatePropsType(ast)
  if (!located) return result

  result.rawType = located.kind === 'interface'
    ? interfaceRawType(located.node)
    : source.slice(located.node.start!, located.node.end!)
  result.localTypes = collectReferencedLocalTypes(result.rawType, localTypeMap, importedNames)
  return result
}

type LocatedPropsType =
  | { kind: 'interface'; node: TSInterfaceDeclaration }
  | { kind: 'type'; node: TSType }

function typeDeclaration(node: Statement): TSInterfaceDeclaration | TSTypeAliasDeclaration | undefined {
  const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node
  return declaration?.type === 'TSInterfaceDeclaration' || declaration?.type === 'TSTypeAliasDeclaration'
    ? declaration
    : undefined
}

/**
 * Where a page declares its props: the first `Props` interface or alias, exported or not,
 * else the default export function's first parameter annotation. The one rule behind the
 * raw type codegen emits and the keys a plan is compared with.
 */
function locatePropsType(ast: File): LocatedPropsType | undefined {
  for (const node of ast.program.body) {
    const declaration = typeDeclaration(node)
    if (declaration?.id.name !== 'Props') continue
    return declaration.type === 'TSInterfaceDeclaration'
      ? { kind: 'interface', node: declaration }
      : { kind: 'type', node: declaration.typeAnnotation }
  }

  for (const node of ast.program.body) {
    if (node.type !== 'ExportDefaultDeclaration' || node.declaration.type !== 'FunctionDeclaration') continue
    const param = node.declaration.params[0]
    if (param?.type !== 'ObjectPattern' && param?.type !== 'Identifier') continue
    const annotation = param.typeAnnotation
    if (annotation?.type === 'TSTypeAnnotation') return { kind: 'type', node: annotation.typeAnnotation }
  }
  return undefined
}

export interface PagePropKey {
  name: string
  optional: boolean
  /** The member's type as written, collapsed to one line; absent for an unannotated member. */
  type?: string
}

/**
 * `unreadable` is a declaration whose key set this reader cannot close (an imported type,
 * an intersection, `extends`, a generic, an index signature): it is not an empty key list,
 * and `undeclared` is not either, since a page may take its props some other way.
 */
export type PagePropKeys =
  | { status: 'keys'; keys: PagePropKey[] }
  | { status: 'unreadable'; reason: string }
  | { status: 'undeclared' }

export async function extractPagePropKeys(filePath: string): Promise<PagePropKeys> {
  return extractPagePropKeysFromSource(await readFile(filePath, 'utf-8'), filePath)
}

export function extractPagePropKeysFromSource(source: string, filePath = 'page.tsx'): PagePropKeys {
  const ast = parseSourceFile(source, filePath)
  if (!ast) return { status: 'unreadable', reason: 'the page does not parse' }

  let located = locatePropsType(ast)
  if (!located) return { status: 'undeclared' }

  const followed = new Set<string>()
  while (located.kind === 'type' && located.node.type === 'TSTypeReference') {
    const reference: TSTypeReference = located.node
    const text = source.slice(reference.start!, reference.end!)
    if (reference.typeName.type !== 'Identifier' || reference.typeParameters) {
      return { status: 'unreadable', reason: `\`${text}\` is a generic or qualified type` }
    }
    const name = reference.typeName.name
    const declaration = ast.program.body.map(typeDeclaration).find((candidate) => candidate?.id.name === name)
    if (!declaration) return { status: 'unreadable', reason: `\`${name}\` is not declared in the page file` }
    if (followed.has(name)) return { status: 'unreadable', reason: `\`${name}\` refers to itself` }
    followed.add(name)
    if (declaration.typeParameters) return { status: 'unreadable', reason: `\`${name}\` is generic` }
    located = declaration.type === 'TSInterfaceDeclaration'
      ? { kind: 'interface', node: declaration }
      : { kind: 'type', node: declaration.typeAnnotation }
  }

  if (located.kind === 'interface') {
    if (located.node.extends?.length) {
      return { status: 'unreadable', reason: `\`${located.node.id.name}\` extends another type` }
    }
    return memberKeys(located.node.body.body, source)
  }
  if (located.node.type === 'TSTypeLiteral') return memberKeys(located.node.members, source)
  return { status: 'unreadable', reason: `the props type is not an object type (${located.node.type})` }
}

function memberKeys(members: TSTypeElement[], source: string): PagePropKeys {
  const keys: PagePropKey[] = []
  for (const member of members) {
    if ((member.type !== 'TSPropertySignature' && member.type !== 'TSMethodSignature') || !memberKeyName(member)) {
      const text = source.slice(member.start!, member.end!).replace(/\s+/g, ' ')
      return { status: 'unreadable', reason: `\`${text}\` is not a named member` }
    }
    // A method signature has no single type node: its text runs from the parameter list on.
    const type = member.type === 'TSPropertySignature'
      ? member.typeAnnotation && source.slice(member.typeAnnotation.typeAnnotation.start!, member.typeAnnotation.typeAnnotation.end!)
      : source.slice(member.key.end! + (member.optional ? 1 : 0), member.end!).replace(/[;,]$/, '')
    keys.push({
      name: memberKeyName(member)!,
      optional: Boolean(member.optional),
      ...(type ? { type: type.replace(/\s+/g, ' ').trim() } : {}),
    })
  }
  return { status: 'keys', keys }
}

/** Local types referenced from `typeBody`, in dependency order. */
function collectReferencedLocalTypes(
  typeBody: string,
  localTypeMap: Map<string, string>,
  importedNames: Set<string>,
): string[] {
  const collected = new Map<string, string>()
  const visiting = new Set<string>()

  function visit(text: string): void {
    const identifiers = text.match(/\b[A-Z][A-Za-z0-9]*\b/g)
    if (!identifiers) return

    for (const name of identifiers) {
      if (importedNames.has(name)) continue
      if (collected.has(name)) continue
      if (visiting.has(name)) continue
      if (!localTypeMap.has(name)) continue

      visiting.add(name)
      const definition = localTypeMap.get(name)!
      visit(definition)
      collected.set(name, definition)
      visiting.delete(name)
    }
  }

  visit(typeBody)
  return Array.from(collected.values())
}
