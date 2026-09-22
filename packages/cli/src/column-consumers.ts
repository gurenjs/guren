/**
 * Who reads a model's columns (RFC 0030 §2, Impact): property accesses on a model's
 * records in controllers, resources and page components. A lower bound by construction:
 * a record is followed only from where the file itself says it is one (a call chain on
 * the imported model class, `this.model(M)`, `this.resource` in a resource tied to the
 * model, an annotation naming `MRecord` or a resource's data type), through plain
 * aliases, destructuring and element callbacks. Nothing crosses a function call or a file.
 * The walk reads the AST, so a comment or a string spelling `post.title` is never a read.
 */

import { dirname, resolve } from 'node:path'
import type { Statement } from '@babel/types'

import { memberKeyName, unwrapTypeAssertion, type BabelNode } from './ast-walk'
import { toPosixRelative } from './discovery'
import { extractClassDeclaration } from './model-parser'
import { ParseCache } from './parse-cache'

export type ColumnConsumerKind = 'controller' | 'resource' | 'page'

export interface ColumnConsumerModel {
  className: string
  /** App-relative, POSIX separators. */
  file: string
}

export interface ColumnConsumerPage {
  id: string
  /** App-relative, POSIX separators. */
  file: string
}

export interface ColumnConsumerInput {
  models: readonly ColumnConsumerModel[]
  /** App-relative files, as the discoverers' results made relative. */
  controllers: readonly string[]
  resources: readonly string[]
  pages: readonly ColumnConsumerPage[]
}

export interface ColumnRead {
  model: string
  property: string
  kind: ColumnConsumerKind
  file: string
  line: number
  /** `Class.member` in a controller, the class in a resource, the page id in a page. */
  where: string
  /** The resource whose data type tied a page's prop to the model: the page reads the resource's key. */
  via?: string
}

/** An access on a record whose property no static read can name: `post[key]`, `{ ...rest } = post`. */
export interface OpaqueRead {
  model: string
  kind: ColumnConsumerKind
  file: string
  line: number
  where: string
}

export interface ResourceModelTie {
  className: string
  file: string
  models: string[]
}

export interface ColumnConsumerScan {
  reads: ColumnRead[]
  opaque: OpaqueRead[]
  resources: ResourceModelTie[]
  /** App-relative files that would not read or parse: their reads are missing, not absent. */
  unreadable: string[]
}

interface Tie {
  model: string
  via?: string
}

/** A local that is a record (`tie`), or an object whose named members are (`members`), such as `props`. */
interface Binding {
  tie?: Tie
  members?: Map<string, Tie>
}

type Scope = Map<string, Binding>

/** Callbacks whose first parameter is an element of the receiver. */
const ELEMENT_CALLBACK_METHODS = new Set(['map', 'forEach', 'filter', 'find', 'findLast', 'some', 'every', 'flatMap'])

/** Methods returning elements of the receiver, so the result is still the model's records. */
const ELEMENT_PRESERVING_METHODS = new Set(['filter', 'find', 'findLast', 'slice', 'at', 'toSorted', 'toReversed'])

/** Generics whose value is still the argument's records; any other (`Record<K, V>`, a user's own) ties nothing. */
const RECORD_WRAPPERS = new Set(['Array', 'ReadonlyArray', 'Promise', 'Awaited', 'Partial', 'Readonly', 'Required', 'NonNullable', 'Pick', 'Omit', 'ReturnType', 'WithRelations'])

/** Guren's paginated page props: `data` holds the argument's records. */
const PAGINATED_PROPS = 'PaginatedPageProps'

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassMethod', 'ClassPrivateMethod', 'ObjectMethod'])

function withoutExtension(path: string): string {
  return path.replace(/\.[cm]?[jt]sx?$/u, '').replace(/\/index$/u, '')
}

function specifierTarget(root: string, fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('.')) return withoutExtension(toPosixRelative(root, resolve(dirname(resolve(root, fromFile)), specifier)))
  if (specifier.startsWith('@/')) return withoutExtension(specifier.slice(2))
  return null
}

interface FileTies {
  /** Value locals naming a model class. */
  models: Map<string, string>
  /** Type names whose values are a model's records. */
  wholeTypes: Map<string, Tie>
  /** Type names whose members are a model's records. */
  containerTypes: Map<string, Map<string, Tie>>
  /** Every model class, for `Data.<Model>` from the generated data types, which imports none. */
  modelNames: ReadonlySet<string>
}

interface ScanContext {
  file: string
  kind: ColumnConsumerKind
  ties: FileTies
  /** Resource class → the models it is tied to; `this.resource` inside one is their record. */
  resourceTies: Map<string, string[]>
  /** The page id, which names every read in a page file. */
  pageId?: string
  reads: ColumnRead[]
  opaque: OpaqueRead[]
}

/**
 * Imports tie a file to a model: the class itself from the model's module, `MRecord`
 * from it, and any name a resource tied to the model exports (its data type).
 */
function importTies(
  root: string,
  file: string,
  program: BabelNode,
  modelsByFile: ReadonlyMap<string, string>,
  resourcesByFile: ReadonlyMap<string, ResourceModelTie>,
): FileTies {
  const ties: FileTies = { models: new Map(), wholeTypes: new Map(), containerTypes: new Map(), modelNames: new Set(modelsByFile.values()) }
  for (const statement of program.body as BabelNode[]) {
    if (statement.type !== 'ImportDeclaration') continue
    const target = specifierTarget(root, file, (statement.source as { value: string }).value)
    if (target === null) continue
    const model = modelsByFile.get(target)
    const resource = resourcesByFile.get(target)
    for (const specifier of statement.specifiers as BabelNode[]) {
      if (specifier.type === 'ImportDefaultSpecifier' && model !== undefined) ties.models.set((specifier.local as { name: string }).name, model)
      if (specifier.type !== 'ImportSpecifier') continue
      const local = (specifier.local as { name: string }).name
      const importedNode = specifier.imported as { type: string; name?: string; value?: string }
      const imported = importedNode.type === 'Identifier' ? importedNode.name : importedNode.value
      if (model !== undefined) {
        if (imported === model) ties.models.set(local, model)
        else if (imported === `${model}Record`) ties.wholeTypes.set(local, { model })
      }
      if (resource !== undefined && imported !== resource.className) {
        for (const tied of resource.models) ties.wholeTypes.set(local, { model: tied, via: resource.className })
      }
    }
  }
  return ties
}

interface TypeTie {
  whole?: Tie
  members?: Map<string, Tie>
}

function typeTie(node: BabelNode | null | undefined, ties: FileTies): TypeTie {
  if (!node) return {}
  switch (node.type) {
    case 'TSTypeAnnotation':
    case 'TSParenthesizedType':
      return typeTie(node.typeAnnotation as BabelNode, ties)
    case 'TSArrayType':
      return { whole: typeTie(node.elementType as BabelNode, ties).whole }
    case 'TSTypeQuery': {
      let name = node.exprName as BabelNode
      while (name.type === 'TSQualifiedName') name = name.left as BabelNode
      const model = name.type === 'Identifier' ? ties.models.get(name.name as string) : undefined
      return model === undefined ? {} : { whole: { model } }
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
        const right = (name.right as { name: string }).name
        if (left.type === 'Identifier' && left.name === 'Data' && ties.modelNames.has(right)) return { whole: { model: right } }
      }
      // `Pick<PostRecord, 'id'>` and `Awaited<ReturnType<typeof Post.find>>` are records too.
      const params = ((node.typeParameters as BabelNode | undefined)?.params ?? []) as BabelNode[]
      const generic = name.type === 'Identifier' ? (name.name as string) : undefined
      if (generic === PAGINATED_PROPS) {
        const data = typeTie(params[0], ties).whole
        return data ? { members: new Map([['data', data]]) } : {}
      }
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
    const key = memberKeyName(member as unknown as Parameters<typeof memberKeyName>[0])
    const whole = typeTie(member.typeAnnotation as BabelNode, ties).whole
    if (key !== undefined && whole) found.set(key, whole)
  }
  return found.size > 0 ? found : undefined
}

/** An interface's own members, over what an `extends Base<T>` it names contributes. */
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
function localTypeTies(program: BabelNode, ties: FileTies): void {
  const declarations: BabelNode[] = []
  for (const statement of program.body as BabelNode[]) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? (statement.declaration as BabelNode | null) : statement
    if (declaration && (declaration.type === 'TSInterfaceDeclaration' || declaration.type === 'TSTypeAliasDeclaration')) {
      declarations.push(declaration)
    }
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (const declaration of declarations) {
      const name = (declaration.id as { name: string }).name
      const tie =
        declaration.type === 'TSInterfaceDeclaration'
          ? { members: interfaceTies(declaration, ties) }
          : typeTie(declaration.typeAnnotation as BabelNode, ties)
      if (tie.whole) ties.wholeTypes.set(name, tie.whole)
      else if (tie.members) ties.containerTypes.set(name, tie.members)
    }
  }
}

function lineOf(node: BabelNode): number {
  return node.loc?.start.line ?? 0
}

class RecordWalker {
  private where: string
  private resourceTie: Tie[] = []

  constructor(private readonly context: ScanContext) {
    this.where = context.pageId ?? ''
  }

  run(program: BabelNode): void {
    this.statements(program.body as BabelNode[], new Map())
  }

  private read(tie: Tie, property: string, node: BabelNode): void {
    const { kind, file, reads } = this.context
    reads.push({ model: tie.model, property, kind, file, line: lineOf(node), where: this.where, ...(tie.via ? { via: tie.via } : {}) })
  }

  private opaqueRead(tie: Tie, node: BabelNode): void {
    const { kind, file, opaque } = this.context
    opaque.push({ model: tie.model, kind, file, line: lineOf(node), where: this.where })
  }

  private statements(statements: readonly BabelNode[], scope: Scope): void {
    for (const statement of statements) this.visit(statement, scope)
  }

  /** What an expression holds, when the file says it is a model's records. */
  private bindingOf(expression: BabelNode | null | undefined, scope: Scope): Binding | undefined {
    if (!expression) return undefined
    let node = unwrapTypeAssertion(expression)
    if (node.type === 'AwaitExpression') node = unwrapTypeAssertion(node.argument as BabelNode)
    if (node.type === 'Identifier') return scope.get(node.name as string)
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      const object = unwrapTypeAssertion(node.object as BabelNode)
      const property = node.computed ? undefined : (node.property as { name?: string }).name
      if (object.type === 'ThisExpression' && property === 'resource' && this.resourceTie.length > 0) {
        return { tie: this.resourceTie[0] }
      }
      const tie = property === undefined ? undefined : this.bindingOf(object, scope)?.members?.get(property)
      return tie ? { tie } : undefined
    }
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return undefined

    const callee = unwrapTypeAssertion(node.callee as BabelNode)
    if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return undefined
    const method = callee.computed ? undefined : (callee.property as { name?: string }).name
    const receiver = unwrapTypeAssertion(callee.object as BabelNode)
    if (receiver.type === 'ThisExpression' && method === 'model') {
      const argument = (node.arguments as BabelNode[])[0]
      const model = argument?.type === 'Identifier' ? this.context.ties.models.get(argument.name as string) : undefined
      return model === undefined ? undefined : { tie: { model } }
    }
    if (method !== undefined && ELEMENT_PRESERVING_METHODS.has(method)) {
      const tie = this.bindingOf(receiver, scope)?.tie
      if (tie) return { tie }
    }
    // A query chain rooted at the model class: `Post.where(...).first()`, `Post.findOrFail(id)`.
    let root: BabelNode = receiver
    while (root.type === 'CallExpression' || root.type === 'MemberExpression' || root.type === 'OptionalCallExpression' || root.type === 'OptionalMemberExpression') {
      root = unwrapTypeAssertion((root.type.endsWith('CallExpression') ? root.callee : root.object) as BabelNode)
    }
    const model = root.type === 'Identifier' && !scope.has(root.name as string) ? this.context.ties.models.get(root.name as string) : undefined
    return model === undefined ? undefined : { tie: { model } }
  }

  /** Binds a declared name, or reads the keys a pattern destructures from a record. */
  private bindPattern(pattern: BabelNode, binding: Binding | undefined, scope: Scope): void {
    if (pattern.type === 'AssignmentPattern') {
      this.visit(pattern.right as BabelNode, scope)
      this.bindPattern(pattern.left as BabelNode, binding, scope)
      return
    }
    if (pattern.type === 'Identifier') {
      const name = pattern.name as string
      const annotated = typeTie(pattern.typeAnnotation as BabelNode, this.context.ties)
      const bound: Binding | undefined = annotated.whole || annotated.members ? { tie: annotated.whole, members: annotated.members } : binding
      if (bound) scope.set(name, bound)
      else scope.delete(name)
      return
    }
    const annotated = typeTie(pattern.typeAnnotation as BabelNode, this.context.ties)
    const source: Binding | undefined = annotated.whole || annotated.members ? { tie: annotated.whole, members: annotated.members } : binding
    if (pattern.type === 'ArrayPattern') {
      for (const element of (pattern.elements as Array<BabelNode | null>)) {
        if (!element) continue
        const inner = element.type === 'RestElement' ? (element.argument as BabelNode) : element
        this.bindPattern(inner, source?.tie ? { tie: source.tie } : undefined, scope)
      }
      return
    }
    if (pattern.type !== 'ObjectPattern') return
    for (const property of pattern.properties as BabelNode[]) {
      if (property.type === 'RestElement') {
        if (source?.tie) this.opaqueRead(source.tie, property)
        this.bindPattern(property.argument as BabelNode, undefined, scope)
        continue
      }
      const key = memberKeyName(property as unknown as Parameters<typeof memberKeyName>[0])
      if (key === undefined) {
        if (property.computed) this.visit(property.key as BabelNode, scope)
        if (source?.tie) this.opaqueRead(source.tie, property)
      } else if (source?.tie) {
        this.read(source.tie, key, property)
      }
      const memberTie = key === undefined ? undefined : source?.members?.get(key)
      this.bindPattern(property.value as BabelNode, memberTie ? { tie: memberTie } : undefined, scope)
    }
  }

  private fn(node: BabelNode, scope: Scope, elementOf?: Tie): void {
    const inner: Scope = new Map(scope)
    const params = (node.params ?? []) as BabelNode[]
    params.forEach((param, index) => {
      const target = param.type === 'TSParameterProperty' ? (param.parameter as BabelNode) : param
      this.bindPattern(target, index === 0 && elementOf ? { tie: elementOf } : undefined, inner)
    })
    const body = node.body as BabelNode
    if (body.type === 'BlockStatement') this.statements(body.body as BabelNode[], inner)
    else this.visit(body, inner)
  }

  private visit(node: BabelNode | null | undefined, scope: Scope): void {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
    const type = node.type

    if (type.startsWith('TS') && type !== 'TSAsExpression' && type !== 'TSSatisfiesExpression' && type !== 'TSNonNullExpression' && type !== 'TSTypeAssertion' && type !== 'TSParameterProperty') return
    if (type === 'ImportDeclaration') return

    if (type === 'ClassDeclaration' || type === 'ClassExpression') {
      this.klass(node, scope)
      return
    }
    if (FUNCTION_TYPES.has(type)) {
      this.fn(node, scope)
      return
    }
    if (type === 'BlockStatement') {
      this.statements(node.body as BabelNode[], new Map(scope))
      return
    }
    if (type === 'VariableDeclarator') {
      this.visit(node.init as BabelNode, scope)
      this.bindPattern(node.id as BabelNode, this.bindingOf(node.init as BabelNode, scope), scope)
      return
    }
    if (type === 'ForOfStatement') {
      this.visit(node.right as BabelNode, scope)
      const inner: Scope = new Map(scope)
      const left = node.left as BabelNode
      const tie = this.bindingOf(node.right as BabelNode, scope)?.tie
      const target = left.type === 'VariableDeclaration' ? ((left.declarations as BabelNode[])[0]?.id as BabelNode) : left
      if (target) this.bindPattern(target, tie ? { tie } : undefined, inner)
      this.visit(node.body as BabelNode, inner)
      return
    }
    if (type === 'CallExpression' || type === 'OptionalCallExpression') {
      const callee = unwrapTypeAssertion(node.callee as BabelNode)
      const isMember = callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression'
      // A method called on a record (`post.save()`, `posts.map()`) is not a column read.
      if (isMember) {
        this.visit(callee.object as BabelNode, scope)
        if (callee.computed) this.visit(callee.property as BabelNode, scope)
      } else {
        this.visit(callee, scope)
      }
      const method = isMember && !callee.computed ? (callee.property as { name?: string }).name : undefined
      const receiver = method !== undefined && ELEMENT_CALLBACK_METHODS.has(method) ? this.bindingOf(callee.object as BabelNode, scope)?.tie : undefined
      for (const argument of node.arguments as BabelNode[]) {
        if (receiver && FUNCTION_TYPES.has(argument.type)) this.fn(argument, scope, receiver)
        else this.visit(argument, scope)
      }
      return
    }
    if (type === 'MemberExpression' || type === 'OptionalMemberExpression') {
      const tie = this.bindingOf(node.object as BabelNode, scope)?.tie
      const property = node.property as BabelNode
      if (tie) {
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
    this.resourceTie = models.map((model) => ({ model }))
    for (const member of (node.body as { body: BabelNode[] }).body) {
      const name = memberKeyName(member as unknown as Parameters<typeof memberKeyName>[0]) ?? '?'
      if (this.context.kind === 'controller') this.where = `${className}.${name}`
      else if (this.context.kind === 'resource') this.where = className
      const value = member.type === 'ClassProperty' ? (member.value as BabelNode | null) : member
      if (!value) continue
      if (this.resourceTie.length > 1) {
        // A resource tied to two models reads each of them; walk once per model.
        for (const tie of models.map((model) => ({ model }))) {
          this.resourceTie = [tie]
          this.visit(value, scope)
        }
        this.resourceTie = models.map((model) => ({ model }))
      } else {
        this.visit(value, scope)
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
function resourceTie(root: string, file: string, program: BabelNode, modelsByFile: ReadonlyMap<string, string>): ResourceModelTie | undefined {
  const declaration = (program.body as unknown as Statement[]).map((statement) => extractClassDeclaration(statement)).find((found) => found !== null)
  const className = declaration?.id?.name
  if (!className) return undefined
  const imported = new Set<string>()
  for (const statement of program.body as BabelNode[]) {
    if (statement.type !== 'ImportDeclaration') continue
    const target = specifierTarget(root, file, (statement.source as { value: string }).value)
    const model = target === null ? undefined : modelsByFile.get(target)
    if (model !== undefined) imported.add(model)
  }
  const named = [...imported].find((model) => className === `${model}Resource`)
  return { className, file, models: named ? [named] : [...imported].sort() }
}

export async function scanColumnConsumers(root: string, input: ColumnConsumerInput, cache: ParseCache = new ParseCache()): Promise<ColumnConsumerScan> {
  const modelsByFile = new Map(input.models.map((model) => [withoutExtension(model.file), model.className]))
  const scan: ColumnConsumerScan = { reads: [], opaque: [], resources: [], unreadable: [] }

  const parse = async (file: string): Promise<BabelNode | undefined> => {
    const outcome = await cache.read(resolve(root, file))
    if (outcome.status === 'parsed') return outcome.ast.program as unknown as BabelNode
    scan.unreadable.push(file)
    return undefined
  }

  const resourcePrograms = new Map<string, BabelNode>()
  for (const file of input.resources) {
    const program = await parse(file)
    if (!program) continue
    resourcePrograms.set(file, program)
    const tie = resourceTie(root, file, program, modelsByFile)
    if (tie && tie.models.length > 0) scan.resources.push(tie)
  }
  const resourcesByFile = new Map(scan.resources.map((resource) => [withoutExtension(resource.file), resource]))
  const resourceTies = new Map(scan.resources.map((resource) => [resource.className, resource.models]))

  const run = (file: string, program: BabelNode, kind: ColumnConsumerKind, pageId?: string): void => {
    const ties = importTies(root, file, program, modelsByFile, resourcesByFile)
    localTypeTies(program, ties)
    const context: ScanContext = { file, kind, ties, resourceTies, reads: scan.reads, opaque: scan.opaque, ...(pageId ? { pageId } : {}) }
    new RecordWalker(context).run(program)
  }

  for (const file of input.controllers) {
    const program = await parse(file)
    if (program) run(file, program, 'controller')
  }
  for (const [file, program] of resourcePrograms) run(file, program, 'resource')
  for (const page of input.pages) {
    const program = await parse(page.file)
    if (program) run(page.file, program, 'page', page.id)
  }
  return scan
}
