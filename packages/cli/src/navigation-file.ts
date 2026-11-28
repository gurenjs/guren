/**
 * `config/navigation.ts` read by its syntax, never imported (RFC 0040 §5): the one reading
 * `guren check` judges entries by, and the one a writer or a change fact is to read through.
 * Every value is written in place: a spread, a computed key, a call (a translated label), a
 * name for anything but an entry list or a `can` model, or a key `show` does not take makes the
 * file unreadable, with the line, rather than an entry read in part. Another key of an entry is
 * passed over, as `defineNavigation()` passes it over.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ArrayExpression, CallExpression, File, Node } from '@babel/types'

import { memberKeyName, unwrapTypeAssertion } from './ast-walk'
import { parseSourceFile } from './parse-cache'
import { definitionBuilderCall } from './resolved-config'
import { importsByLocal, specifierBase, withoutExtension } from './schema-binding'

export type NavigationFileAuth = 'any' | 'required' | 'guest'

export type NavigationFieldValue = string | number | boolean | null

/** The class a `can` names, as the file spells it and where its import leads. */
export interface NavigationModelRef {
  /** `Job`, or `Models.Job` under a namespace import. */
  expression: string
  /** The exported class name the import names; the local name for a default import. */
  className: string
  /** The imported module, absolute and without its extension; absent for a package or a class the file declares itself. */
  module?: string
}

export interface NavigationFileEntry {
  label: string
  route: string
  auth?: NavigationFileAuth
  where?: Record<string, NavigationFieldValue>
  can?: { ability: string; model: NavigationModelRef }
  /** 1-based line of the entry's object. */
  line: number
}

export type NavigationFileReading =
  | { status: 'read'; entries: NavigationFileEntry[] }
  /** Not a `defineNavigation()` definition by the rule config wiring reads files by. */
  | { status: 'not-a-definition' }
  | { status: 'unreadable'; reason: string; line?: number }

/** `--can create:Job` as the ability and the model; the ability is everything before the last colon. */
export function splitCanFlag(value: string): { ability: string; model: string } | undefined {
  const colon = value.lastIndexOf(':')
  return colon === -1 ? undefined : { ability: value.slice(0, colon), model: value.slice(colon + 1) }
}

const ENTRY_KEYS: ReadonlySet<string> = new Set(['label', 'route', 'show'])
const SHOW_KEYS: ReadonlySet<string> = new Set(['auth', 'can', 'where'])
const AUTH_VALUES: ReadonlySet<string> = new Set<NavigationFileAuth>(['any', 'required', 'guest'])

class Unreadable extends Error {
  constructor(readonly reason: string, readonly line?: number) {
    super(reason)
  }
}

const lineOf = (node: Node): number | undefined => node.loc?.start.line

function refuse(node: Node, reason: string): never {
  throw new Unreadable(reason, lineOf(node))
}

export const NAVIGATION_CONFIG_FILE = 'config/navigation.ts'

/**
 * The entries of an app root's `config/navigation.ts` on disk: none when the file is absent, why when it does not read.
 * Never throws, since every plan command reads it whether or not the plan states an entry.
 */
export async function readNavigationEntries(cwd: string): Promise<NavigationFileEntry[] | { unreadable: string }> {
  const file = resolve(cwd, NAVIGATION_CONFIG_FILE)
  if (!existsSync(file)) return []
  try {
    const ast = parseSourceFile(await readFile(file, 'utf8'), file)
    if (ast === null) return { unreadable: `${NAVIGATION_CONFIG_FILE} does not parse` }
    const reading = readNavigationFile(ast, { cwd, file })
    if (reading.status === 'not-a-definition') return { unreadable: `${NAVIGATION_CONFIG_FILE} is no defineNavigation() definition` }
    if (reading.status === 'unreadable') return { unreadable: `${NAVIGATION_CONFIG_FILE}${reading.line ? `:${reading.line}` : ''} cannot be read as data (${reading.reason})` }
    return reading.entries
  } catch (error) {
    return { unreadable: `${NAVIGATION_CONFIG_FILE} could not be read (${error instanceof Error ? error.message : String(error)})` }
  }
}

/** `file` is absolute, so an import of the `can` model resolves from it; `cwd` is the app root `@/` names. */
export function readNavigationFile(ast: File, source: { cwd: string; file: string }): NavigationFileReading {
  const definition = definitionBuilderCall(ast)
  if (definition?.builder !== 'defineNavigation') return { status: 'not-a-definition' }
  try {
    const constants = topLevelConstants(ast)
    const list = entryList(definition.call, constants)
    const imports = importsByLocal(ast.program.body)
    const entries: NavigationFileEntry[] = []
    const routes = new Set<string>()
    for (const element of list.elements) {
      if (element === null) refuse(list, 'the list has a hole')
      if (element.type === 'SpreadElement') refuse(element, 'the list spreads another list')
      const entry = readEntry(unwrapTypeAssertion(element as Node), { ...source, imports, constants })
      if (routes.has(entry.route)) refuse(element as Node, `route "${entry.route}" is named twice, which defineNavigation() refuses`)
      routes.add(entry.route)
      entries.push(entry)
    }
    return { status: 'read', entries }
  } catch (error) {
    if (error instanceof Unreadable) return { status: 'unreadable', reason: error.reason, ...(error.line ? { line: error.line } : {}) }
    throw error
  }
}

function entryList(call: CallExpression, constants: Map<string, Node>): ArrayExpression {
  const [argument, ...rest] = call.arguments
  if (argument === undefined || rest.length > 0) refuse(call, 'defineNavigation() is not given one list of entries')
  let list = unwrapTypeAssertion(argument as Node)
  if (list.type === 'Identifier') {
    const initializer = constants.get(list.name)
    if (initializer === undefined) refuse(list, `the entries are ${list.name}, which is no top-level const of the file`)
    list = unwrapTypeAssertion(initializer)
  }
  if (list.type !== 'ArrayExpression') refuse(list, 'the entries are not a list written in place')
  return list
}

/** The list literal the entries are written in, for a writer; only for a file `readNavigationFile()` reads. */
export function navigationEntryList(ast: File): ArrayExpression | undefined {
  const definition = definitionBuilderCall(ast)
  if (definition?.builder !== 'defineNavigation') return undefined
  try {
    return entryList(definition.call, topLevelConstants(ast))
  } catch (error) {
    if (error instanceof Unreadable) return undefined
    throw error
  }
}

interface ReadContext {
  cwd: string
  file: string
  imports: ReturnType<typeof importsByLocal>
  constants: Map<string, Node>
}

function topLevelConstants(ast: File): Map<string, Node> {
  const constants = new Map<string, Node>()
  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue
    for (const declarator of declaration.declarations) {
      if (declarator.id.type === 'Identifier' && declarator.init) constants.set(declarator.id.name, declarator.init)
    }
  }
  return constants
}

/** The object's keys and values, refusing a spread, a computed key and a method; a key outside `allowed` is refused, or skipped when `others` is `'skip'`. */
function properties(node: Node, allowed: ReadonlySet<string>, what: string, others: 'refuse' | 'skip' = 'refuse'): Map<string, Node> {
  if (node.type !== 'ObjectExpression') refuse(node, `${what} is not an object written in place`)
  const read = new Map<string, Node>()
  for (const property of node.properties) {
    if (property.type === 'SpreadElement') refuse(property, `${what} spreads another object`)
    if (property.type !== 'ObjectProperty' || property.computed) refuse(property, `${what} has a computed key or a method`)
    const key = memberKeyName(property)
    if (key === undefined) refuse(property, `${what} has a key that is not a name`)
    if (!allowed.has(key)) {
      if (others === 'skip') continue
      refuse(property, `${what} has "${key}", which defineNavigation() does not take`)
    }
    read.set(key, unwrapTypeAssertion(property.value as Node))
  }
  return read
}

function text(node: Node, what: string): string {
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map((quasi) => quasi.value.cooked ?? '').join('')
  refuse(node, `${what} is not a string written in place`)
}

function readEntry(node: Node, context: ReadContext): NavigationFileEntry {
  const fields = properties(node, ENTRY_KEYS, 'an entry', 'skip')
  const line = lineOf(node) ?? 1
  const labelNode = fields.get('label')
  const routeNode = fields.get('route')
  if (labelNode === undefined) refuse(node, 'an entry has no label')
  if (routeNode === undefined) refuse(node, 'an entry names no route')
  const label = text(labelNode, 'a label')
  const route = text(routeNode, 'a route name')
  if (label.trim() === '') refuse(labelNode, 'a label is empty, which defineNavigation() refuses')
  if (route === '') refuse(routeNode, 'a route name is empty, which defineNavigation() refuses')
  const entry: NavigationFileEntry = { label, route, line }
  const showNode = fields.get('show')
  if (showNode !== undefined) Object.assign(entry, readShow(showNode, context))
  return entry
}

function readShow(node: Node, context: ReadContext): Pick<NavigationFileEntry, 'auth' | 'where' | 'can'> {
  const fields = properties(node, SHOW_KEYS, 'show')
  const show: Pick<NavigationFileEntry, 'auth' | 'where' | 'can'> = {}
  const auth = fields.get('auth')
  if (auth !== undefined) {
    const value = text(auth, 'show.auth')
    if (!AUTH_VALUES.has(value)) refuse(auth, `show.auth is "${value}"; it takes any, required or guest`)
    show.auth = value as NavigationFileAuth
  }
  const where = fields.get('where')
  if (where !== undefined) show.where = readWhere(where)
  const can = fields.get('can')
  if (can !== undefined) show.can = readCan(can, context)
  return show
}

function readWhere(node: Node): Record<string, NavigationFieldValue> {
  if (node.type !== 'ObjectExpression') refuse(node, 'show.where is not an object written in place')
  const where: Record<string, NavigationFieldValue> = {}
  for (const property of node.properties) {
    if (property.type !== 'ObjectProperty' || property.computed) refuse(property, 'show.where has a spread, a computed key or a method')
    const key = memberKeyName(property)
    if (key === undefined) refuse(property, 'show.where has a key that is not a name')
    where[key] = fieldValue(unwrapTypeAssertion(property.value as Node), key)
  }
  return where
}

function fieldValue(node: Node, field: string): NavigationFieldValue {
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral' || node.type === 'BooleanLiteral') return node.value
  if (node.type === 'NullLiteral') return null
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return text(node, `show.where.${field}`)
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral') return -node.argument.value
  refuse(node, `show.where.${field} is not a string, number, boolean or null written in place`)
}

function readCan(node: Node, context: ReadContext): NonNullable<NavigationFileEntry['can']> {
  if (node.type !== 'ArrayExpression' || node.elements.length !== 2) refuse(node, 'show.can is not [ability, Model] written in place')
  const [abilityNode, modelNode] = node.elements.map((element) => element && element.type !== 'SpreadElement' ? unwrapTypeAssertion(element as Node) : null)
  if (!abilityNode || !modelNode) refuse(node, 'show.can is not [ability, Model] written in place')
  const ability = text(abilityNode, 'the ability show.can names')
  if (ability === '') refuse(abilityNode, 'show.can names an empty ability, which defineNavigation() refuses')
  return { ability, model: modelRef(modelNode, context) }
}

function modelRef(node: Node, { cwd, file, imports }: ReadContext): NavigationModelRef {
  const base = (sourceSpecifier: string): string | undefined => {
    const resolved = specifierBase(cwd, file, sourceSpecifier)
    return resolved === null ? undefined : withoutExtension(resolved)
  }
  if (node.type === 'Identifier') {
    const entry = imports.get(node.name)
    if (entry === undefined || entry.kind === 'namespace') return { expression: node.name, className: node.name }
    const module = base(entry.source)
    return { expression: node.name, className: entry.kind === 'named' ? entry.imported : node.name, ...(module ? { module } : {}) }
  }
  if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.property.type === 'Identifier') {
    const entry = imports.get(node.object.name)
    const expression = `${node.object.name}.${node.property.name}`
    if (entry?.kind !== 'namespace') return { expression, className: node.property.name }
    const module = base(entry.source)
    return { expression, className: node.property.name, ...(module ? { module } : {}) }
  }
  refuse(node, 'the model show.can names is not a class name')
}
