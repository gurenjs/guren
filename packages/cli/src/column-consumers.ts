/**
 * Who reads a model's columns (RFC 0030 §2, Impact): property accesses on a model's
 * records in controllers, resources and page components, and the column names a query
 * on the model spells (`Post.where('title', …)`). A lower bound: a value is a record
 * only where the file says so, and it is followed through aliases, destructuring,
 * indexing and element callbacks, never across a call or a file. The walk reads the
 * AST, so a comment or a string spelling `post.title` is never a read.
 */

import { resolve } from 'node:path'
import type { Statement } from '@babel/types'

import { memberKeyName, unwrapTypeAssertion, type BabelNode } from './ast-walk'
import { toPosixRelative } from './discovery'
import { firstClassDeclaration } from './model-parser'
import type { ParseCache } from './parse-cache'
import { importsByLocal, specifierBase } from './schema-binding'

export type ColumnConsumerKind = 'controller' | 'resource' | 'page'

export interface ColumnConsumerModel {
  className: string
  /** App-relative, POSIX separators: the model's identity, since two app roots may share a class name. */
  file: string
}

export interface ColumnConsumerPage {
  id: string
  /** App-relative, POSIX separators. */
  file: string
}

export interface ColumnConsumerInput {
  models: readonly ColumnConsumerModel[]
  /** App-relative files. */
  controllers: readonly string[]
  resources: readonly string[]
  pages: readonly ColumnConsumerPage[]
}

export interface ColumnRead {
  model: ColumnConsumerModel
  property: string
  kind: ColumnConsumerKind
  file: string
  line: number
  /** `Class.member` in a controller, the class in a resource, the page id in a page; empty outside all three. */
  where: string
  /** The resource whose data type tied a page's prop to the model: the page reads the resource's key. */
  via?: string
}

/** A read no static scan can name the property of: `post[key]`, `{ ...rest } = post`, `{ ...post }`. */
export type OpaqueRead = Omit<ColumnRead, 'property' | 'via'>

export interface ResourceModelTie {
  className: string
  file: string
  models: ColumnConsumerModel[]
}

export interface ColumnConsumerScan {
  reads: ColumnRead[]
  opaque: OpaqueRead[]
  resources: ResourceModelTie[]
  /** App-relative files that would not read or parse: their reads are missing, not absent. */
  unreadable: string[]
}

interface Tie {
  model: ColumnConsumerModel
  /** A list of the model's records rather than one. */
  many: boolean
  via?: string
}

/** A record or list (`tie`), an object whose named members are (`members`, e.g. `props`), or a local that shadows either (`{}`). */
interface Binding {
  tie?: Tie
  members?: Map<string, Tie>
}

type Scope = Map<string, Binding>

/** Query results by the last method of a chain on the model class; a method in none of these ties nothing. */
const RECORD_RESULTS = new Set(['find', 'findOrFail', 'findUnique', 'findWith', 'findWithOrFail', 'first', 'firstOrFail', 'create', 'forceCreate'])
const LIST_RESULTS = new Set(['all', 'get', 'findMany', 'withAttachments', 'where', 'orWhere', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orderBy', 'select', 'limit', 'offset', 'with', 'scope', 'query', 'newQuery'])
const PAGINATED_RESULTS = new Set(['paginate', 'withPaginate'])

/** Query methods whose first argument is a column name (`select` takes several). */
const COLUMN_ARGUMENT_METHODS = new Set(['where', 'orWhere', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orderBy', 'select', 'sum', 'avg', 'min', 'max', 'countBy'])

/** Array methods: a callback's first parameter is an element, and the result is one element or a list of them. */
const ELEMENT_CALLBACKS = new Set(['map', 'forEach', 'filter', 'find', 'findLast', 'some', 'every', 'flatMap'])
const ELEMENT_RESULTS = new Set(['find', 'findLast', 'at'])
const LIST_PRESERVING = new Set(['filter', 'slice', 'toSorted', 'toReversed', 'concat'])

/** Generics whose value is still the argument's records; any other (`Record<K, V>`, a user's own) ties nothing. */
const RECORD_WRAPPERS = new Set(['Promise', 'Awaited', 'Partial', 'Readonly', 'Required', 'NonNullable', 'Pick', 'Omit', 'ReturnType', 'WithRelations'])
const LIST_WRAPPERS = new Set(['Array', 'ReadonlyArray'])
/** Guren's paginated page props: `data` holds the argument's records. */
const PAGINATED_PROPS = 'PaginatedPageProps'

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassMethod', 'ClassPrivateMethod', 'ObjectMethod'])
const TRANSPARENT_TS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSParameterProperty'])

function keyOf(node: BabelNode): string | undefined {
  return memberKeyName(node as unknown as Parameters<typeof memberKeyName>[0])
}

function withoutExtension(path: string): string {
  return path.replace(/\.[cm]?[jt]sx?$/u, '').replace(/\/index$/u, '')
}

/** The app-relative module an import lands on, extension dropped; `null` for a package. */
function importTarget(root: string, fromFile: string, specifier: string): string | null {
  const absolute = specifierBase(root, resolve(root, fromFile), specifier)
  return absolute === null ? null : withoutExtension(toPosixRelative(root, absolute))
}

interface FileTies {
  /** Value locals naming a model class. */
  models: Map<string, ColumnConsumerModel>
  /** Type names whose values are a model's records (or lists of them). */
  wholeTypes: Map<string, Tie>
  /** Type names whose members are. */
  containerTypes: Map<string, Map<string, Tie>>
  /** `Data.<Model>` from the generated data types imports no model: a class name one model owns, or the root's. */
  dataModels: ReadonlyMap<string, ColumnConsumerModel>
}

interface ScanContext {
  file: string
  kind: ColumnConsumerKind
  ties: FileTies
  /** Resource class → its models; `this.resource` inside one is their record. */
  resourceTies: Map<string, ColumnConsumerModel[]>
  pageId?: string
  scan: ColumnConsumerScan
}

interface ModelIndex {
  byFile: ReadonlyMap<string, ColumnConsumerModel>
  byData: ReadonlyMap<string, ColumnConsumerModel>
}

function indexModels(models: readonly ColumnConsumerModel[]): ModelIndex {
  const byName = new Map<string, ColumnConsumerModel[]>()
  for (const model of models) byName.set(model.className, [...(byName.get(model.className) ?? []), model])
  const byData = new Map<string, ColumnConsumerModel>()
  for (const [name, candidates] of byName) {
    const chosen = candidates.length === 1 ? candidates[0] : candidates.find((model) => !model.file.startsWith('modules/'))
    if (chosen) byData.set(name, chosen)
  }
  return { byFile: new Map(models.map((model) => [withoutExtension(model.file), model])), byData }
}

/**
 * Imports tie a file to a model: the class itself from the model's module, `MRecord`
 * from it, and any name a resource tied to the model exports (its data type).
 */
function importTies(root: string, file: string, body: Statement[], models: ModelIndex, resources: ReadonlyMap<string, ResourceModelTie>): FileTies {
  const ties: FileTies = { models: new Map(), wholeTypes: new Map(), containerTypes: new Map(), dataModels: models.byData }
  for (const [local, entry] of importsByLocal(body)) {
    const target = importTarget(root, file, entry.source)
    if (target === null) continue
    const model = models.byFile.get(target)
    if (model !== undefined) {
      if (entry.kind === 'default' || entry.imported === model.className) ties.models.set(local, model)
      else if (entry.imported === `${model.className}Record`) ties.wholeTypes.set(local, { model, many: false })
    }
    const resource = resources.get(target)
    if (resource !== undefined && entry.kind === 'named' && entry.imported !== resource.className) {
      for (const tied of resource.models) ties.wholeTypes.set(local, { model: tied, many: false, via: resource.className })
    }
  }
  return ties
}

interface TypeTie {
  whole?: Tie
  members?: Map<string, Tie>
}

function asList(tie: Tie | undefined): Tie | undefined {
  return tie ? { ...tie, many: true } : undefined
}

function typeTie(node: BabelNode | null | undefined, ties: FileTies): TypeTie {
  if (!node) return {}
  switch (node.type) {
    case 'TSTypeAnnotation':
    case 'TSParenthesizedType':
      return typeTie(node.typeAnnotation as BabelNode, ties)
    case 'TSArrayType':
      return { whole: asList(typeTie(node.elementType as BabelNode, ties).whole) }
    case 'TSTypeQuery': {
      let name = node.exprName as BabelNode
      while (name.type === 'TSQualifiedName') name = name.left as BabelNode
      const model = name.type === 'Identifier' ? ties.models.get(name.name as string) : undefined
      return model === undefined ? {} : { whole: { model, many: false } }
    }
    case 'TSTypeReference': {
      const name = node.typeName as BabelNode
      if (name.type === 'Identifier') {
        const local = name.name as string
        const whole = ties.wholeTypes.get(local)
        if (whole) return { whole }
        const members = ties.containerTypes.get(local)
        if (members) return { members }
      } else if (name.type === 'TSQualifiedName') {
        const left = name.left as BabelNode
        const model = ties.dataModels.get((name.right as { name: string }).name)
        if (left.type === 'Identifier' && left.name === 'Data' && model !== undefined) return { whole: { model, many: false } }
      }
      const params = ((node.typeParameters as BabelNode | undefined)?.params ?? []) as BabelNode[]
      const generic = name.type === 'Identifier' ? (name.name as string) : undefined
      if (generic === PAGINATED_PROPS) {
        const data = asList(typeTie(params[0], ties).whole)
        return data ? { members: new Map([['data', data]]) } : {}
      }
      if (generic !== undefined && LIST_WRAPPERS.has(generic)) return { whole: asList(typeTie(params[0], ties).whole) }
      // `Pick<PostRecord, 'id'>` and `Awaited<ReturnType<typeof Post.find>>` are records too.
      if (generic === undefined || !RECORD_WRAPPERS.has(generic)) return {}
      for (const param of params) {
        const inner = typeTie(param, ties)
        if (inner.whole || inner.members) return inner
      }
      return {}
    }
    case 'TSUnionType':
    case 'TSIntersectionType': {
      const merged: TypeTie = {}
      for (const part of node.types as BabelNode[]) {
        const inner = typeTie(part, ties)
        merged.whole ??= inner.whole
        if (inner.members) merged.members = new Map([...(merged.members ?? []), ...inner.members])
      }
      return merged
    }
    case 'TSTypeLiteral':
      return { members: memberTies(node.members as BabelNode[], ties) }
    default:
      return {}
  }
}

function memberTies(members: readonly BabelNode[], ties: FileTies): Map<string, Tie> | undefined {
  const found = new Map<string, Tie>()
  for (const member of members) {
    if (member.type !== 'TSPropertySignature') continue
    const key = keyOf(member)
    const whole = typeTie(member.typeAnnotation as BabelNode, ties).whole
    if (key !== undefined && whole) found.set(key, whole)
  }
  return found.size > 0 ? found : undefined
}

/** An interface's own members, over what an `extends Base<T>` contributes. */
function interfaceTies(declaration: BabelNode, ties: FileTies): Map<string, Tie> | undefined {
  const found = new Map<string, Tie>()
  for (const heritage of (declaration.extends ?? []) as BabelNode[]) {
    const reference = { type: 'TSTypeReference', typeName: heritage.expression, typeParameters: heritage.typeParameters } as BabelNode
    for (const [key, tie] of typeTie(reference, ties).members ?? []) found.set(key, tie)
  }
  for (const [key, tie] of memberTies((declaration.body as { body: BabelNode[] }).body, ties) ?? []) found.set(key, tie)
  return found.size > 0 ? found : undefined
}

/** Local interfaces and aliases join the ties, twice over so an alias of an alias resolves. */
function localTypeTies(body: readonly BabelNode[], ties: FileTies): void {
  const declarations = body
    .map((statement) => (statement.type === 'ExportNamedDeclaration' ? (statement.declaration as BabelNode | null) : statement))
    .filter((declaration): declaration is BabelNode => declaration?.type === 'TSInterfaceDeclaration' || declaration?.type === 'TSTypeAliasDeclaration')
  for (let pass = 0; pass < 2; pass += 1) {
    for (const declaration of declarations) {
      const name = (declaration.id as { name: string }).name
      const tie = declaration.type === 'TSInterfaceDeclaration' ? { members: interfaceTies(declaration, ties) } : typeTie(declaration.typeAnnotation as BabelNode, ties)
      if (tie.whole) ties.wholeTypes.set(name, tie.whole)
      else if (tie.members) ties.containerTypes.set(name, tie.members)
    }
  }
}

function lineOf(node: BabelNode): number {
  return node.loc?.start.line ?? 0
}

function methodName(callee: BabelNode): string | undefined {
  if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return undefined
  return callee.computed ? undefined : (callee.property as { name?: string }).name
}

class RecordWalker {
  private where: string
  private resourceTie: Tie | undefined

  constructor(private readonly context: ScanContext) {
    this.where = context.pageId ?? ''
  }

  run(body: readonly BabelNode[]): void {
    this.statements(body, new Map())
  }

  private read(tie: Tie, property: string, node: BabelNode): void {
    const { kind, file, scan } = this.context
    scan.reads.push({ model: tie.model, property, kind, file, line: lineOf(node), where: this.where, ...(tie.via ? { via: tie.via } : {}) })
  }

  private opaqueRead(tie: Tie, node: BabelNode): void {
    const { kind, file, scan } = this.context
    scan.opaque.push({ model: tie.model, kind, file, line: lineOf(node), where: this.where })
  }

  private statements(statements: readonly BabelNode[], scope: Scope): void {
    for (const statement of statements) this.visit(statement, scope)
  }

  /** The model class a query chain starts from, unless a local shadows its name. */
  private chainModel(expression: BabelNode, scope: Scope): ColumnConsumerModel | undefined {
    let root = unwrapTypeAssertion(expression)
    while (root.type === 'CallExpression' || root.type === 'OptionalCallExpression' || root.type === 'MemberExpression' || root.type === 'OptionalMemberExpression') {
      root = unwrapTypeAssertion((root.type.endsWith('CallExpression') ? root.callee : root.object) as BabelNode)
    }
    if (root.type !== 'Identifier' || scope.has(root.name as string)) return undefined
    return this.context.ties.models.get(root.name as string)
  }

  /** What an expression holds, when the file says it is a model's record or list of them. */
  private bindingOf(expression: BabelNode | null | undefined, scope: Scope): Binding | undefined {
    if (!expression) return undefined
    let node = unwrapTypeAssertion(expression)
    if (node.type === 'AwaitExpression') node = unwrapTypeAssertion(node.argument as BabelNode)
    if (node.type === 'Identifier') return scope.get(node.name as string)
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      const object = unwrapTypeAssertion(node.object as BabelNode)
      if (!node.computed && object.type === 'ThisExpression' && (node.property as { name?: string }).name === 'resource' && this.resourceTie) {
        return { tie: this.resourceTie }
      }
      const outer = this.bindingOf(object, scope)
      // `posts[0]` is one of the records; `post['x']` is a read, not a record.
      if (outer?.tie?.many && node.computed) return { tie: { ...outer.tie, many: false } }
      const property = node.computed ? undefined : (node.property as { name?: string }).name
      const member = property === undefined ? undefined : outer?.members?.get(property)
      return member ? { tie: member } : undefined
    }
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return undefined

    const callee = unwrapTypeAssertion(node.callee as BabelNode)
    const method = methodName(callee)
    if (method === undefined) return undefined
    const receiver = unwrapTypeAssertion(callee.object as BabelNode)
    if (receiver.type === 'ThisExpression' && method === 'model') {
      const argument = (node.arguments as BabelNode[])[0]
      const name = argument?.type === 'Identifier' ? (argument.name as string) : undefined
      const model = name === undefined || scope.has(name) ? undefined : this.context.ties.models.get(name)
      return model ? { tie: { model, many: false } } : undefined
    }
    // A chain on the model class is a query, judged by its last method; anything else may be a list.
    const model = this.chainModel(receiver, scope)
    if (!model) {
      const list = this.bindingOf(receiver, scope)?.tie
      if (list?.many && ELEMENT_RESULTS.has(method)) return { tie: { ...list, many: false } }
      if (list?.many && LIST_PRESERVING.has(method)) return { tie: list }
      return undefined
    }
    if (RECORD_RESULTS.has(method)) return { tie: { model, many: false } }
    if (LIST_RESULTS.has(method)) return { tie: { model, many: true } }
    if (PAGINATED_RESULTS.has(method)) return { members: new Map([['data', { model, many: true }]]) }
    return undefined
  }

  private annotated(pattern: BabelNode, binding: Binding | undefined): Binding | undefined {
    const tie = typeTie(pattern.typeAnnotation as BabelNode, this.context.ties)
    return tie.whole || tie.members ? { tie: tie.whole, members: tie.members } : binding
  }

  /** Binds a declared name, or reads the keys a pattern destructures from a record. */
  private bindPattern(pattern: BabelNode, binding: Binding | undefined, scope: Scope): void {
    if (pattern.type === 'AssignmentPattern') {
      this.visit(pattern.right as BabelNode, scope)
      this.bindPattern(pattern.left as BabelNode, binding, scope)
      return
    }
    const source = this.annotated(pattern, binding)
    if (pattern.type === 'Identifier') {
      // An empty binding still shadows: a parameter named `Post` is not the model class.
      scope.set(pattern.name as string, source ?? {})
      return
    }
    if (pattern.type === 'ArrayPattern') {
      const element = source?.tie?.many ? { tie: { ...source.tie, many: false } } : undefined
      for (const item of pattern.elements as Array<BabelNode | null>) {
        if (!item) continue
        if (item.type === 'RestElement') this.bindPattern(item.argument as BabelNode, source?.tie?.many ? source : undefined, scope)
        else this.bindPattern(item, element, scope)
      }
      return
    }
    if (pattern.type !== 'ObjectPattern') return
    const record = source?.tie && !source.tie.many ? source.tie : undefined
    for (const property of pattern.properties as BabelNode[]) {
      if (property.type === 'RestElement') {
        if (record) this.opaqueRead(record, property)
        this.bindPattern(property.argument as BabelNode, undefined, scope)
        continue
      }
      const key = keyOf(property)
      if (key === undefined) {
        if (property.computed) this.visit(property.key as BabelNode, scope)
        if (record) this.opaqueRead(record, property)
      } else if (record) {
        this.read(record, key, property)
      }
      const member = key === undefined ? undefined : source?.members?.get(key)
      this.bindPattern(property.value as BabelNode, member ? { tie: member } : undefined, scope)
    }
  }

  private fn(node: BabelNode, scope: Scope, element?: Tie): void {
    const inner: Scope = new Map(scope)
    ;((node.params ?? []) as BabelNode[]).forEach((param, index) => {
      const target = param.type === 'TSParameterProperty' ? (param.parameter as BabelNode) : param
      this.bindPattern(target, index === 0 && element ? { tie: element } : undefined, inner)
    })
    const body = node.body as BabelNode
    if (body.type === 'BlockStatement') this.statements(body.body as BabelNode[], inner)
    else this.visit(body, inner)
  }

  /** `Post.where('title', …)`, `.select('title', 'body')`, `.where({ title })`: the column names a query spells. */
  private queryColumns(node: BabelNode, method: string, receiver: BabelNode, scope: Scope): void {
    if (!COLUMN_ARGUMENT_METHODS.has(method)) return
    const model = this.chainModel(receiver, scope)
    if (!model) return
    const tie: Tie = { model, many: false }
    const args = node.arguments as BabelNode[]
    for (const argument of method === 'select' ? args : args.slice(0, 1)) {
      if (argument.type === 'StringLiteral') this.read(tie, argument.value as string, argument)
      if (argument.type !== 'ObjectExpression') continue
      for (const property of argument.properties as BabelNode[]) {
        const key = property.type === 'ObjectProperty' ? keyOf(property) : undefined
        if (key !== undefined) this.read(tie, key, property)
      }
    }
  }

  private visit(node: BabelNode | null | undefined, scope: Scope): void {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
    const type = node.type
    if ((type.startsWith('TS') && !TRANSPARENT_TS.has(type)) || type === 'ImportDeclaration') return

    if (type === 'ClassDeclaration' || type === 'ClassExpression') return this.klass(node, scope)
    if (FUNCTION_TYPES.has(type)) return this.fn(node, scope)
    if (type === 'BlockStatement') return this.statements(node.body as BabelNode[], new Map(scope))
    if (type === 'VariableDeclarator') {
      this.visit(node.init as BabelNode, scope)
      this.bindPattern(node.id as BabelNode, this.bindingOf(node.init as BabelNode, scope), scope)
      return
    }
    if (type === 'ForOfStatement') {
      this.visit(node.right as BabelNode, scope)
      const inner: Scope = new Map(scope)
      const list = this.bindingOf(node.right as BabelNode, scope)?.tie
      const left = node.left as BabelNode
      const target = left.type === 'VariableDeclaration' ? ((left.declarations as BabelNode[])[0]?.id as BabelNode) : left
      if (target) this.bindPattern(target, list?.many ? { tie: { ...list, many: false } } : undefined, inner)
      this.visit(node.body as BabelNode, inner)
      return
    }
    if (type === 'SpreadElement' || type === 'JSXSpreadAttribute') {
      const tie = this.bindingOf(node.argument as BabelNode, scope)?.tie
      if (tie && !tie.many) this.opaqueRead(tie, node)
      this.visit(node.argument as BabelNode, scope)
      return
    }
    if (type === 'CallExpression' || type === 'OptionalCallExpression') {
      const callee = unwrapTypeAssertion(node.callee as BabelNode)
      const method = methodName(callee)
      // A method called on a record (`post.save()`, `posts.map()`) is not a column read.
      if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
        this.visit(callee.object as BabelNode, scope)
        if (callee.computed) this.visit(callee.property as BabelNode, scope)
      } else {
        this.visit(callee, scope)
      }
      if (method !== undefined) this.queryColumns(node, method, callee.object as BabelNode, scope)
      const list = method !== undefined && ELEMENT_CALLBACKS.has(method) ? this.bindingOf(callee.object as BabelNode, scope)?.tie : undefined
      const element = list?.many ? { ...list, many: false } : undefined
      for (const argument of node.arguments as BabelNode[]) {
        if (element && FUNCTION_TYPES.has(argument.type)) this.fn(argument, scope, element)
        else this.visit(argument, scope)
      }
      return
    }
    if (type === 'MemberExpression' || type === 'OptionalMemberExpression') {
      const tie = this.bindingOf(node.object as BabelNode, scope)?.tie
      const property = node.property as BabelNode
      if (tie && !tie.many) {
        if (!node.computed) this.read(tie, property.name as string, property)
        else if (property.type === 'StringLiteral') this.read(tie, property.value as string, property)
        else this.opaqueRead(tie, property)
      }
      this.visit(node.object as BabelNode, scope)
      if (node.computed) this.visit(property, scope)
      return
    }

    for (const key in node) {
      if (key === 'loc' || key === 'type' || key.endsWith('Comments') || key === 'typeAnnotation' || key === 'typeParameters' || key === 'returnType') continue
      const child = node[key]
      if (Array.isArray(child)) for (const item of child) this.visit(item as BabelNode, scope)
      else if (child && typeof child === 'object') this.visit(child as BabelNode, scope)
    }
  }

  private klass(node: BabelNode, scope: Scope): void {
    const className = (node.id as { name?: string } | null)?.name ?? ''
    const models = this.context.kind === 'resource' ? (this.context.resourceTies.get(className) ?? []) : []
    const previous = { where: this.where, resourceTie: this.resourceTie }
    // A resource tied to two models reads each of them, so its body is walked once per model.
    const passes: Array<Tie | undefined> = models.length > 0 ? models.map((model) => ({ model, many: false })) : [undefined]
    for (const pass of passes) {
      this.resourceTie = pass
      for (const member of (node.body as { body: BabelNode[] }).body) {
        const name = keyOf(member) ?? '?'
        if (this.context.kind === 'controller') this.where = `${className}.${name}`
        else if (this.context.kind === 'resource') this.where = className
        this.visit(member.type === 'ClassProperty' ? (member.value as BabelNode | null) : member, scope)
      }
    }
    this.where = previous.where
    this.resourceTie = previous.resourceTie
  }
}

/**
 * Which models a resource file is about: the ones it imports from a model's module,
 * narrowed to `MResource`'s own model when the class is named after one of them.
 */
function resourceTie(root: string, file: string, body: Statement[], models: ModelIndex): ResourceModelTie | undefined {
  const className = firstClassDeclaration(body)?.id?.name
  if (!className) return undefined
  const imported = new Map<string, ColumnConsumerModel>()
  for (const entry of importsByLocal(body).values()) {
    const target = importTarget(root, file, entry.source)
    const model = target === null ? undefined : models.byFile.get(target)
    if (model) imported.set(model.file, model)
  }
  const tied = [...imported.values()].sort((a, b) => a.file.localeCompare(b.file))
  const named = tied.find((model) => className === `${model.className}Resource`)
  return { className, file, models: named ? [named] : tied }
}

export async function scanColumnConsumers(root: string, input: ColumnConsumerInput, cache: ParseCache): Promise<ColumnConsumerScan> {
  const models = indexModels(input.models)
  const scan: ColumnConsumerScan = { reads: [], opaque: [], resources: [], unreadable: [] }

  const parse = async (file: string): Promise<Statement[] | undefined> => {
    const outcome = await cache.read(resolve(root, file))
    if (outcome.status === 'parsed') return outcome.ast.program.body
    scan.unreadable.push(file)
    return undefined
  }

  const resourceBodies = new Map<string, Statement[]>()
  for (const file of input.resources) {
    const body = await parse(file)
    if (!body) continue
    resourceBodies.set(file, body)
    const tie = resourceTie(root, file, body, models)
    if (tie && tie.models.length > 0) scan.resources.push(tie)
  }
  const resourcesByFile = new Map(scan.resources.map((resource) => [withoutExtension(resource.file), resource]))
  const resourceTies = new Map(scan.resources.map((resource) => [resource.className, resource.models]))

  const run = (file: string, body: Statement[], kind: ColumnConsumerKind, pageId?: string): void => {
    const ties = importTies(root, file, body, models, resourcesByFile)
    const nodes = body as unknown as BabelNode[]
    localTypeTies(nodes, ties)
    new RecordWalker({ file, kind, ties, resourceTies, scan, ...(pageId ? { pageId } : {}) }).run(nodes)
  }

  for (const file of input.controllers) {
    const body = await parse(file)
    if (body) run(file, body, 'controller')
  }
  for (const [file, body] of resourceBodies) run(file, body, 'resource')
  for (const page of input.pages) {
    const body = await parse(page.file)
    if (body) run(page.file, body, 'page', page.id)
  }
  return scan
}
