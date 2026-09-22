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
import { memberKeyName, nodeText } from './ast-walk'
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

  const found = locatePropsType(ast)
  if (!found) return result

  const located = found.kind === 'declaration' ? locatedFrom(found.declaration) : found
  result.rawType = located.kind === 'interface' ? interfaceRawType(located.node) : nodeText(source, located.node)
  result.localTypes = collectReferencedLocalTypes(result.rawType, localTypeMap, importedNames)
  return result
}

type PropsDeclaration = TSInterfaceDeclaration | TSTypeAliasDeclaration

type LocatedPropsType =
  | { kind: 'interface'; node: TSInterfaceDeclaration }
  | { kind: 'type'; node: TSType }

function locatedFrom(declaration: PropsDeclaration): LocatedPropsType {
  return declaration.type === 'TSInterfaceDeclaration'
    ? { kind: 'interface', node: declaration }
    : { kind: 'type', node: declaration.typeAnnotation }
}

function typeDeclaration(node: Statement): PropsDeclaration | undefined {
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
function locatePropsType(ast: File): { kind: 'declaration'; declaration: PropsDeclaration } | Extract<LocatedPropsType, { kind: 'type' }> | undefined {
  for (const node of ast.program.body) {
    const declaration = typeDeclaration(node)
    if (declaration?.id.name === 'Props') return { kind: 'declaration', declaration }
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

/**
 * The one same-file declaration of `name`, or why it does not give a key set: interfaces
 * merge and a generic's members depend on its arguments, so either leaves one
 * declaration's members short of it.
 */
function declaredType(ast: File, name: string): LocatedPropsType | string {
  const declarations = ast.program.body.map(typeDeclaration).filter((candidate) => candidate?.id.name === name)
  if (declarations.length === 0) return `\`${name}\` is not declared in the page file`
  if (declarations.length > 1) return `\`${name}\` is declared more than once`
  return declarations[0]!.typeParameters ? `\`${name}\` is generic` : locatedFrom(declarations[0]!)
}

export async function extractPagePropKeys(filePath: string): Promise<PagePropKeys> {
  return extractPagePropKeysFromSource(await readFile(filePath, 'utf-8'), filePath)
}

/**
 * The page's `Props` followed through same-file references to the type that carries its
 * members, `undefined` when nothing declares one, or the reason the walk stopped short.
 * Both readers below start here, so they cannot disagree about where the props are.
 */
function resolvePropsType(ast: File, source: string): LocatedPropsType | string | undefined {
  const found = locatePropsType(ast)
  if (!found) return undefined

  const followed = new Set<string>()
  const resolve = (name: string): LocatedPropsType | string => {
    if (followed.has(name)) return `\`${name}\` refers to itself`
    followed.add(name)
    return declaredType(ast, name)
  }

  // `Props` itself goes through the same resolution as a name it refers to.
  let located = found.kind === 'declaration' ? resolve(found.declaration.id.name) : found
  while (typeof located !== 'string' && located.kind === 'type' && located.node.type === 'TSTypeReference') {
    const reference: TSTypeReference = located.node
    located = reference.typeName.type === 'Identifier' && !reference.typeParameters
      ? resolve(reference.typeName.name)
      : `\`${nodeText(source, reference)}\` is a generic or qualified type`
  }
  return located
}

export function extractPagePropKeysFromSource(source: string, filePath = 'page.tsx'): PagePropKeys {
  const ast = parseSourceFile(source, filePath)
  if (!ast) return { status: 'unreadable', reason: 'the page does not parse' }

  const located = resolvePropsType(ast, source)
  if (located === undefined) return { status: 'undeclared' }
  if (typeof located === 'string') return { status: 'unreadable', reason: located }

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
    const info = readMember(member, source)
    if (!info) {
      return { status: 'unreadable', reason: `\`${nodeText(source, member).replace(/\s+/g, ' ')}\` is not a named member` }
    }
    const { acceptsUndefined: _acceptsUndefined, ...key } = info
    keys.push(key)
  }
  return { status: 'keys', keys }
}

export interface PagePropMemberInfo extends PagePropKey {
  /** Optional, unannotated (implicit `any`), or spelled with a type that admits `undefined`. */
  acceptsUndefined: boolean
}

/**
 * The members a page's props declare, read once per page. `open` names why a
 * member outside `members` may still be declared (a heritage clause, an opaque
 * intersection part); absent, the map is the whole key set.
 */
export type PagePropMembers =
  | { status: 'members'; members: Map<string, PagePropMemberInfo>; open?: string }
  | { status: 'unreadable'; reason: string }
  | { status: 'undeclared' }

/** One member asked for by name: `absent` is confident only when the map is the whole key set. */
export type PagePropMember =
  | ({ status: 'declared' } & PagePropMemberInfo)
  | { status: 'absent' }
  | { status: 'unreadable'; reason: string }
  | { status: 'undeclared' }

export function readPagePropMembers(ast: File, source: string): PagePropMembers {
  const located = resolvePropsType(ast, source)
  if (located === undefined) return { status: 'undeclared' }
  if (typeof located === 'string') return { status: 'unreadable', reason: located }

  const members = new Map<string, PagePropMemberInfo>()
  const collect = (elements: TSTypeElement[]): void => {
    for (const element of elements) {
      const info = readMember(element, source, ast)
      if (info && !members.has(info.name)) members.set(info.name, info)
    }
  }

  if (located.kind === 'interface') {
    collect(located.node.body.body)
    const extended = located.node.extends?.length ? `\`${located.node.id.name}\` extends another type, which may declare it` : undefined
    return { status: 'members', members, ...(extended ? { open: extended } : {}) }
  }

  // An intersection's literal parts are read; any other part may declare a member.
  const parts = located.node.type === 'TSIntersectionType' ? located.node.types : [located.node]
  let opaque: TSType | undefined
  for (const part of parts) {
    const unwrapped = part.type === 'TSParenthesizedType' ? part.typeAnnotation : part
    if (unwrapped.type === 'TSTypeLiteral') collect(unwrapped.members)
    else opaque ??= unwrapped
  }
  if (opaque && members.size === 0) {
    return { status: 'unreadable', reason: `the props type is not an object type (\`${nodeText(source, opaque).replace(/\s+/g, ' ')}\`)` }
  }
  const open = opaque ? `\`${nodeText(source, opaque).replace(/\s+/g, ' ')}\` is intersected in, and may declare it` : undefined
  return { status: 'members', members, ...(open ? { open } : {}) }
}

export function pagePropMember(read: PagePropMembers, name: string): PagePropMember {
  if (read.status !== 'members') return read
  const info = read.members.get(name)
  if (info) return { status: 'declared', ...info }
  return read.open ? { status: 'unreadable', reason: read.open } : { status: 'absent' }
}

/**
 * One named property or method signature; undefined for anything else (an index
 * signature, a computed key). A method signature has no single type node, so its
 * text runs from the parameter list on, and it never admits undefined.
 */
function readMember(member: TSTypeElement, source: string, ast?: File): PagePropMemberInfo | undefined {
  if (member.type !== 'TSPropertySignature' && member.type !== 'TSMethodSignature') return undefined
  const name = memberKeyName(member)
  if (!name) return undefined
  const optional = Boolean(member.optional)
  const annotation = member.type === 'TSPropertySignature' ? member.typeAnnotation?.typeAnnotation : undefined
  const type = member.type === 'TSPropertySignature'
    ? annotation && nodeText(source, annotation)
    : source.slice(member.key.end! + (optional ? 1 : 0), member.end!).replace(/[;,]$/, '')
  const acceptsUndefined = member.type === 'TSMethodSignature'
    ? optional
    : optional || annotation === undefined || admitsUndefined(annotation, ast, new Set())
  return { name, optional, acceptsUndefined, ...(type ? { type: type.replace(/\s+/g, ' ').trim() } : {}) }
}

/**
 * Whether a type as written admits `undefined`. A same-file alias is followed
 * once (`type Posts = Post[] | undefined`); an imported or generic name is not.
 */
function admitsUndefined(type: TSType, ast: File | undefined, followed: Set<string>): boolean {
  switch (type.type) {
    case 'TSUndefinedKeyword':
    case 'TSUnknownKeyword':
    case 'TSAnyKeyword':
    case 'TSVoidKeyword':
      return true
    case 'TSUnionType':
      return type.types.some((part) => admitsUndefined(part, ast, followed))
    case 'TSParenthesizedType':
      return admitsUndefined(type.typeAnnotation, ast, followed)
    case 'TSTypeReference': {
      if (!ast || type.typeName.type !== 'Identifier' || type.typeParameters || followed.has(type.typeName.name)) return false
      followed.add(type.typeName.name)
      const alias = declaredType(ast, type.typeName.name)
      return typeof alias !== 'string' && alias.kind === 'type' && admitsUndefined(alias.node, ast, followed)
    }
    default:
      return false
  }
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
