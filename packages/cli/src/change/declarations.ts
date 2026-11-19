/**
 * The declaration matcher of RFC 0040 §3: a fact takes its declarable lane only when an approved, open plan
 * declares it. Matched so far: an added file of added elements and an added table of an added model, both
 * against what `plan:scaffold` writes (a declared table taking its own residue with it), and an added migration
 * that only creates such tables; an added route, and the routes entry edited by `--mount` alone. A subject
 * two open plans claim, or one the plan does not determine, stays.
 */

import type { ClassDeclaration, File, Statement } from '@babel/types'

import { readCreationStatements, snapshotRecordsCreation, type CreationForeignKey, type CreationStatement, type MigrationDialect } from '@guren/orm/internal/migration-guard'

import { canonicalSyntax, referencedIdentifiers, walk } from '../ast-walk'
import { classActionMembers } from '../controller-methods'
import { extractClassDeclaration } from '../model-parser'
import { parseSourceFile } from '../parse-cache'
import { readPolicyAbilities } from '../plan/policy-abilities'
import { listPlanElementEntries, type PlanController, type PlanDraft, type PlanElementEntry, type PlanPolicy } from '../plan/schema'
import { plannedSqlDefault, planScaffoldMounts, planScaffoldOutput, sqlNameOf, type PlanScaffoldApp } from '../plan/scaffold'
import { MODELS_DIR } from '../discovery'
import { DIALECT_BARRELS, DRIZZLE_CORE_SUBPATHS } from '../drizzle-specifiers'
import { isAutoIncrementPrimaryKey, migrationSqlType } from '../schema-columns'
import { policyFilePath, providerFilePath, resourceFilePath, validatorFilePath } from '../plan/scaffold-http'
import { controllerFilePath, scaffoldRoutesFile, sideEffectFilePath } from '../plan/scaffold-controller'
import { derivePlanTasks, type PlanDerivedStep } from '../plan/tasks'
import { composeRouteRegistrarCall } from '../route-registrar'
import { parseSchemaSource, type SchemaDialect, type SchemaTable } from '../schema-parser'
import { answersMethod, registeredBefore, routePathCovers } from '../test-requests'
import { importSpecifier } from '../utils'
import { FACT_CLASSES } from './fact-classes'
import type { ChangeFact } from './lane'
import { sameRecordPart, type RouteSecurityRecord } from './security-records'

/**
 * What a fact is about, kept beside it by the reader that emitted it. `tables` are the head's tables of the same
 * file; a migration's `files` are its changed paths, and `previous` the migration folder before it at the head.
 * A table's residue is the code inside an added table the column reader does not state.
 */
export type DeclarationSubject =
  | { kind: 'file'; path: string }
  | { kind: 'table'; table: SchemaTable; file: string; tables: readonly SchemaTable[] }
  | { kind: 'migration'; dir: string; files: string[]; previous?: string }
  | { kind: 'table-residue'; file: string; identifier: string }
  /** A route as the head's records hold it (`base` for a change), with every head route in registration order. */
  | { kind: 'route'; change: 'add' | 'drop' | 'alter'; route: RouteSecurityRecord; base?: RouteSecurityRecord; routes: readonly RouteSecurityRecord[] }
  | { kind: 'agent'; route: RouteSecurityRecord; base?: RouteSecurityRecord }
  /** The routes entry, edited in place. */
  | { kind: 'routes-entry'; path: string }

/** An approved plan that is not closed, as the head has it; `file` is app-relative. */
export interface OpenPlan {
  file: string
  plan: PlanDraft
}

/**
 * How a file is held to the plan beyond its exports: a provider runs at boot and the plan determines all of
 * it, a policy's abilities are planned by name, and a controller's members are the planned actions.
 */
export type DeclaredFileCheck =
  | { kind: 'exports' }
  | { kind: 'whole' }
  | { kind: 'policy'; policy: PlanPolicy }
  | { kind: 'controller'; controller: PlanController }
  /** The whole file, as the scaffold writes it against the head's model and validator files, which it imports. */
  | { kind: 'routes'; step: PlanDerivedStep }

export interface DeclaredFile {
  elements: string[]
  /** The value names the scaffold's own output exports, every one of which the file must export. */
  exports: string[]
  /** What the scaffold writes there. */
  contents: string
  check: DeclaredFileCheck
}

/**
 * The value names a module declares and exports itself; `undefined` when a star export hides them. A
 * specifier exporting an imported binding is a re-export, and is not counted.
 */
export function declaredExports(ast: File): string[] | undefined {
  const imported = new Set(ast.program.body.flatMap((node) => (node.type === 'ImportDeclaration' ? node.specifiers.map((specifier) => specifier.local.name) : [])))
  const names: string[] = []
  for (const node of ast.program.body) {
    if (node.type === 'ExportAllDeclaration') return undefined
    if (node.type === 'ExportDefaultDeclaration') {
      const declaration = node.declaration
      // `export default class X` exports `default` only: an importer of `{ X }` finds nothing.
      if ((declaration.type === 'ClassDeclaration' || declaration.type === 'FunctionDeclaration') && declaration.id) names.push('default')
      continue
    }
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue
    const declaration = node.declaration
    if ((declaration?.type === 'ClassDeclaration' || declaration?.type === 'FunctionDeclaration') && declaration.id && !('declare' in declaration && declaration.declare)) names.push(declaration.id.name)
    if (declaration?.type === 'VariableDeclaration' && !declaration.declare) {
      for (const declarator of declaration.declarations) if (declarator.id.type === 'Identifier') names.push(declarator.id.name)
    }
    if (node.source) continue
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ExportSpecifier' || specifier.exportKind === 'type' || imported.has(specifier.local.name)) continue
      names.push(specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value)
    }
  }
  return names
}

function changeKind(entry: PlanElementEntry): unknown {
  return (entry.element.change as { kind?: unknown } | undefined)?.kind
}

function scaffoldSteps(plan: PlanDraft): PlanDerivedStep[] {
  return derivePlanTasks(plan).tasks.flatMap((task) => task.steps.filter((step) => step.kind === 'scaffold'))
}

function checkOf(path: string, owners: readonly PlanElementEntry[], step: PlanDerivedStep): DeclaredFileCheck {
  // Unmounted, a routes file registers nothing; what it registers once mounted is read off the records.
  if (owners.some((entry) => entry.section === 'routes')) return { kind: 'routes', step }
  const policy = owners.find((entry) => entry.section === 'policies')?.element as PlanPolicy | undefined
  if (policy) return path === providerFilePath(policy) ? { kind: 'whole' } : { kind: 'policy', policy }
  const controller = owners.find((entry) => entry.section === 'controllers')?.element as PlanController | undefined
  return controller ? { kind: 'controller', controller } : { kind: 'exports' }
}

/** The files the plan's scaffold steps write, each owned by its elements when every one is an `add` in the project root. */
export function planDeclaredFiles(plan: PlanDraft): Map<string, DeclaredFile> {
  const entries = new Map(listPlanElementEntries(plan).map((entry) => [entry.id, entry]))
  const files = new Map<string, DeclaredFile | null>()
  for (const step of scaffoldSteps(plan)) {
    for (const file of planScaffoldOutput(plan, step).files) {
      const owners = file.elements.map((id) => entries.get(id))
      const owned = owners.length > 0 && owners.every((entry) => entry !== undefined && changeKind(entry) === 'add' && entry.element.module === undefined)
      const ast = owned ? parseSourceFile(file.contents, file.path) : null
      const exports = ast ? declaredExports(ast) : undefined
      // Two steps naming one path cannot both own it.
      if (files.has(file.path) || !exports || exports.length === 0) files.set(file.path, null)
      else files.set(file.path, { elements: file.elements, exports, contents: file.contents, check: checkOf(file.path, owners as PlanElementEntry[], step) })
    }
  }
  return new Map([...files].filter((entry): entry is [string, DeclaredFile] => entry[1] !== null))
}

/** The class exported as itself under `name`: a local class an alias exports is not the one a reader of the export gets. */
function exportedClass(ast: File, name: string): ClassDeclaration | undefined {
  for (const node of ast.program.body) {
    if (node.type !== 'ExportNamedDeclaration' && node.type !== 'ExportDefaultDeclaration') continue
    const declaration = extractClassDeclaration(node)
    if (declaration?.id?.name === name) return declaration
  }
  return undefined
}

/** Whether the head file holds no more than the plan declares, beyond the exports both have. */
function passesCheck(declared: DeclaredFile, ast: File, path: string, contents = declared.contents): boolean {
  const { check } = declared
  if (check.kind === 'exports') return true
  const planned = parseSourceFile(contents, path)
  if (!planned) return false
  if (check.kind === 'whole' || check.kind === 'routes') return canonicalSyntax(ast.program.body) === canonicalSyntax(planned.program.body)
  const className = check.kind === 'policy' ? check.policy.name : check.controller.className
  const members = new Set(check.kind === 'policy' ? check.policy.abilities.map((ability) => ability.name) : check.controller.actions.map((action) => action.name))
  const head = classFileAllowed(ast, planned, className, members)
  if (!head || check.kind === 'controller') return head !== undefined
  // The scaffold writes a class; a `definePolicy()` object keeps keys its `exposes` leaves out, `before` among them.
  const read = readPolicyAbilities(ast, className)
  if ('unreadable' in read || read.open || read.fields.length > 0 || read.exposes) return false
  return read.declared.length === members.size && read.declared.every((name) => members.has(name))
}

/**
 * The class `className` when the file is nothing but it, imports with names and type declarations, and the
 * class extends the scaffold's base, imported as the scaffold imports it, with no member but `members`.
 * An allowlist: any other statement, a decorator, a static block or an inherited member goes unread otherwise.
 */
function classFileAllowed(ast: File, planned: File, className: string, members: ReadonlySet<string>): ClassDeclaration | undefined {
  const head = exportedClass(ast, className)
  const scaffold = exportedClass(planned, className)
  if (!head || !scaffold || head.superClass?.type !== 'Identifier' || canonicalSyntax(head.superClass) !== canonicalSyntax(scaffold.superClass)) return undefined
  const base = head.superClass.name
  if (importOf(ast, base) === undefined || importOf(ast, base) !== importOf(planned, base)) return undefined
  const allowed = ast.program.body.every((node) => {
    if (node.type === 'ImportDeclaration') return node.specifiers.length > 0
    if (node.type === 'TSTypeAliasDeclaration' || node.type === 'TSInterfaceDeclaration') return true
    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') && extractClassDeclaration(node) === head) return true
    return node.type === 'ExportNamedDeclaration' && !node.source && (node.declaration?.type === 'TSTypeAliasDeclaration' || node.declaration?.type === 'TSInterfaceDeclaration')
  })
  if (!allowed || (head.decorators?.length ?? 0) > 0) return undefined
  // A member is what `Router` dispatches to or the Gate asks: a constructor, a static member or an accessor is not one the plan names.
  const actions = [...classActionMembers(head)]
  const onlyPlanned = actions.length === head.body.body.length && actions.every(({ member, name }) =>
    !member.static && !member.decorators?.length && (!('kind' in member) || member.kind === 'method') && members.has(name))
  return onlyPlanned ? head : undefined
}

/** `module#imported` for the local name `local`, or `undefined` when no import binds it. */
function importOf(ast: File, local: string): string | undefined {
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') continue
    for (const specifier of node.specifiers) {
      if (specifier.local.name !== local || specifier.type !== 'ImportSpecifier') continue
      return `${node.source.value}#${specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value}`
    }
  }
  return undefined
}

function exportedStatement(ast: File, identifier: string): Statement | undefined {
  return ast.program.body.find((node) => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration' && node.declaration.declarations.length === 1
    && node.declaration.declarations[0]!.id.type === 'Identifier' && node.declaration.declarations[0]!.id.name === identifier)
}

const FRAMEWORK_MODULE = /^(?:drizzle-orm|@guren\/orm)(?:\/|$)/

/** `pgTable` in `export const posts = pgTable('posts', …)`. */
function factoryName(statement: Statement): string | undefined {
  if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration') return undefined
  const init = statement.declaration.declarations[0]?.init
  return init?.type === 'CallExpression' && init.callee.type === 'Identifier' ? init.callee.name : undefined
}

/**
 * Whether every name the statement reads is a framework builder imported under its own name, another table
 * of the file, or a parameter it binds: `import { text as integer }` keeps the syntax and swaps the types.
 */
function importsBuildersAsThemselves(ast: File, statement: Statement, tables: readonly SchemaTable[]): boolean {
  // One dialect's barrel: pg's `text` under an sqlite table keeps the syntax and drops sqlite's modes.
  const factory = factoryName(statement)
  const source = factory === undefined ? undefined : importOf(ast, factory)?.split('#')[0]
  if (source === undefined || !FRAMEWORK_MODULE.test(source)) return false
  // `appendTableToSchema()` adds builders from the dialect's `@guren/orm` barrel beside a `drizzle-orm` subpath, which it re-exports.
  const dialect = (Object.keys(DRIZZLE_CORE_SUBPATHS) as SchemaDialect[]).find((key) => DRIZZLE_CORE_SUBPATHS[key] === source || DIALECT_BARRELS[key] === source)
  const sources = new Set(dialect ? [DRIZZLE_CORE_SUBPATHS[dialect], DIALECT_BARRELS[dialect]] : [source])
  const builders = new Set<string>()
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration' || !sources.has(node.source.value)) continue
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && specifier.imported.name === specifier.local.name) builders.add(specifier.local.name)
    }
  }
  const bound = new Set<string>()
  walk(statement, (node) => {
    if (node.type !== 'ArrowFunctionExpression' && node.type !== 'FunctionExpression') return
    for (const param of (node as { params?: Array<{ type: string; name?: string }> }).params ?? []) if (param.type === 'Identifier' && param.name) bound.add(param.name)
  })
  const own = new Set(tables.map((entry) => entry.identifier))
  return referencedIdentifiers(statement).every((name) => builders.has(name) || own.has(name) || bound.has(name))
}

/**
 * Every path a scaffold of any of the plan's elements would write, whatever its kind, module or task:
 * a second plan naming the file is a claim even where its own scaffold writes nothing there.
 */
export function planClaimedPaths(plan: PlanDraft): Set<string> {
  return new Set([
    ...plan.models.flatMap((model) => [`${MODELS_DIR}/${model.name}.ts`, validatorFilePath(model), scaffoldRoutesFile(model).path]),
    ...plan.resources.map(resourceFilePath),
    ...plan.policies.flatMap((policy) => [policyFilePath(policy), providerFilePath(policy)]),
    ...plan.controllers.map(controllerFilePath),
    ...plan.sideEffects.map(sideEffectFilePath),
  ])
}

/** Whether any model of the plan, whatever its change, names this table by SQL name in its module. */
function claimsTable(plan: PlanDraft, table: SchemaTable): boolean {
  return plan.models.some((model) => (model.module ?? null) === table.module && (model.table === table.tableName || model.tableRenamedFrom === table.tableName))
}

/** The added model the plan claims this table for, by SQL name and module, before anything else is compared. */
function claimedModel(plan: PlanDraft, table: SchemaTable): PlanDraft['models'][number] | undefined {
  return plan.models.find((candidate) => candidate.change.kind === 'add' && (candidate.module ?? null) === table.module && candidate.table === table.tableName)
}

/**
 * The added model whose table this is, when the head declares it exactly as `plan:scaffold` writes it into
 * this schema: every column, default, key, reference and index the plan determines.
 */
export function declaredTable(plan: PlanDraft, subject: Extract<DeclarationSubject, { kind: 'table' }>, headText: string | null): string | undefined {
  const { table } = subject
  const model = table.tableName === undefined ? undefined : claimedModel(plan, table)
  const ast = model && headText !== null ? parseSourceFile(headText, subject.file) : null
  const statement = ast ? exportedStatement(ast, table.identifier) : undefined
  if (!model || !statement) return undefined
  if (!importsBuildersAsThemselves(ast!, statement, subject.tables)) return undefined
  // The schema as the scaffold found it: its own table is what it writes; a parent an earlier step added is there.
  const app: Partial<PlanScaffoldApp> = {
    dialect: table.dialect,
    tables: subject.tables.filter((entry) => entry.identifier !== table.identifier).map((entry) => ({ identifier: entry.identifier, tableName: entry.tableName, module: entry.module, columns: entry.columns.map((column) => column.name), ...(entry.opaqueColumns ? { opaqueColumns: true } : {}) })),
  }
  for (const step of scaffoldSteps(plan)) {
    const output = planScaffoldOutput(plan, step, app)
    // A run that refuses writes nothing, and its block can lack what it refused over (a foreign key).
    const block = output.refusals.length > 0 ? undefined : output.tables.find((entry) => entry.model === model.id && entry.identifier === table.identifier)?.block
    const written = block === undefined ? null : parseSourceFile(block, subject.file)
    if (written && written.program.body.length === 1 && canonicalSyntax(written.program.body[0]) === canonicalSyntax(statement)) return model.id
  }
  return undefined
}

/**
 * Lowers each fact a plan declares to the lowest lane its class allows and names the declaration in
 * `declaredBy`. `readHead` gives a file's content at the head, `null` when it has none.
 */
export async function applyPlanDeclarations(
  facts: readonly ChangeFact[],
  subjects: ReadonlyMap<ChangeFact, DeclarationSubject>,
  plans: readonly OpenPlan[],
  readHead: (path: string) => Promise<string | null>,
  readBase: (path: string) => Promise<string | null> = async () => null,
): Promise<ChangeFact[]> {
  const owned = plans.map((open) => ({ open, files: planDeclaredFiles(open.plan), paths: planClaimedPaths(open.plan) }))
  const result: ChangeFact[] = []
  const declaredTables = new Set<string>()
  for (const fact of facts) {
    const subject = subjects.get(fact)
    const declaredBy = subject?.kind === 'table-residue' || subject?.kind === 'routes-entry' ? undefined
      : subject?.kind === 'migration' ? await declaredMigration(subject, plans, readHead)
      : subject?.kind === 'route' ? (subject.change === 'add' ? declaredRoute(subject.route, subject.routes, plans) : undefined)
      : subject?.kind === 'agent' ? (subject.base === undefined ? declaredAgentOf(subject.route, facts, subjects, plans) : undefined)
      : subject ? await declarationOf(subject, owned, readHead) : undefined
    if (declaredBy && subject?.kind === 'table') declaredTables.add(`${subject.file}\u0000${subject.table.identifier}`)
    result.push(declaredBy ? { ...fact, lane: FACT_CLASSES[fact.code].lowest, declaredBy } : fact)
  }
  const mounted = await declaredMount(result, subjects, plans, readHead, readBase)
  // The statement a declared table matched is the scaffold's whole, its `sql` defaults and index callback included.
  return result.filter((fact) => {
    const subject = subjects.get(fact)
    if (subject?.kind === 'routes-entry') return !mounted.has(subject.path)
    return subject?.kind !== 'table-residue' || !declaredTables.has(`${subject.file}\u0000${subject.identifier}`)
  })
}

/** The plan routes naming this route by name or by endpoint, in any change: a claim, before anything is compared. */
function claimsRoute(plan: PlanDraft, route: RouteSecurityRecord): boolean {
  return plan.routes.some((planned) => planned.name === route.name || (planned.method === route.method && planned.path === route.path))
}

/**
 * The added plan route this registered route is, by every property the record holds: its endpoint and name, its
 * action as the controller file the scaffold writes exports it, its middleware by name, its bindings, its agent
 * metadata and its contract exports, the policy ability the action calls. A route registered before another it
 * answers the requests of could take them over without either record changing, so it declares nothing.
 */
export function declaredRoute(route: RouteSecurityRecord, routes: readonly RouteSecurityRecord[], plans: readonly OpenPlan[]): string | undefined {
  const claims = plans.filter((open) => claimsRoute(open.plan, route))
  if (claims.length !== 1 || route.module !== null || route.name === undefined) return undefined
  const { file, plan } = claims[0]!
  const planned = plan.routes.find((candidate) => candidate.name === route.name)
  if (!planned || planned.change.kind !== 'add' || planned.method !== route.method || planned.path !== route.path) return undefined
  const controller = plan.controllers.find((candidate) => candidate.actions.some((action) => action.id === planned.action))
  const action = controller?.actions.find((candidate) => candidate.id === planned.action)
  if (!controller || !action || controller.module !== undefined || controller.change.kind !== 'add' || action.change.kind !== 'add') return undefined
  if (route.action !== `${controllerFilePath(controller)}#default.${action.name}`) return undefined

  const middleware = [...new Set([...planned.middleware, ...action.authorization.middleware])]
  if (route.middleware.length !== middleware.length) return undefined
  for (const [at, entry] of route.middleware.entries()) {
    if (entry.kind === 'inline' || entry.unresolved || entry.name !== middleware[at]) return undefined
    if (entry.name === 'auth' && entry.capabilities.authentication?.mode !== 'required') return undefined
  }
  // The manifest names each binding's model and not its lookup column, so a planned key cannot be held.
  if (planned.bind.some((binding) => binding.key !== undefined)) return undefined
  const bindings = Object.fromEntries(planned.bind.map((binding) => [binding.param, plan.models.find((model) => model.id === binding.model)?.name]))
  if (!sameRecordPart(route.bindings ?? {}, bindings)) return undefined
  const agent = planned.agent ? { toolName: planned.agent.toolName, readOnlyHint: planned.agent.readOnly } : undefined
  if (!sameRecordPart(route.agent ?? null, agent ?? null)) return undefined
  for (const segment of ['params', 'query', 'body'] as const) {
    const validator = action[segment] === undefined ? undefined : plan.validators.find((candidate) => candidate.id === action[segment])
    const contract = route.contracts[segment]
    if (!validator) {
      if (contract) return undefined
      continue
    }
    if (validator.module !== undefined || !contract || contract.exports.length !== 1) return undefined
    const [exportFile, exportName] = contract.exports[0]!.split('#')
    if (exportName !== validator.name || exportFile === undefined || exportFile.startsWith('modules/')) return undefined
  }
  const policy = action.authorization.policy
  if (policy && ('unread' in route.handler || !route.handler.authorizes.some((call) => call.member === 'authorize' && call.ability === policy.ability))) return undefined

  const self = { module: route.module, index: routes.indexOf(route) }
  if (self.index === -1) return undefined
  for (const [index, other] of routes.entries()) {
    if (other === route || !answersMethod(route.method, other.method)) continue
    if (registeredBefore(self, { module: other.module, index }) === false) continue
    if (routePathCovers(route.path, other.path) !== 'none') return undefined
  }
  return `${file}#${planned.id}`
}

/** An added route's agent tool is declared with the route: `declaredRoute()` holds its metadata to the plan's. */
function declaredAgentOf(route: RouteSecurityRecord, facts: readonly ChangeFact[], subjects: ReadonlyMap<ChangeFact, DeclarationSubject>, plans: readonly OpenPlan[]): string | undefined {
  const added = facts.find((fact) => {
    const subject = subjects.get(fact)
    return subject?.kind === 'route' && subject.change === 'add' && subject.route === route
  })
  const subject = added && subjects.get(added)
  return subject?.kind === 'route' && route.agent !== undefined ? declaredRoute(route, subject.routes, plans) : undefined
}

/**
 * The routes entries `--mount` alone edited: the head is the base with one scaffolded registrar's call and import
 * composed in, as `composeRouteRegistrarCall()` writes them, and the change's route facts are exactly that file's
 * routes added, each declared by the plan that mounts it. A route changed, removed or added beside them keeps the edit.
 */
async function declaredMount(
  facts: readonly ChangeFact[],
  subjects: ReadonlyMap<ChangeFact, DeclarationSubject>,
  plans: readonly OpenPlan[],
  readHead: (path: string) => Promise<string | null>,
  readBase: (path: string) => Promise<string | null>,
): Promise<Set<string>> {
  const mounted = new Set<string>()
  const routeFacts = facts.filter((fact) => fact.code === 'route-added' || fact.code === 'route-changed' || fact.code === 'route-removed' || fact.code === 'agent-tool')
  for (const fact of facts) {
    const subject = subjects.get(fact)
    if (subject?.kind !== 'routes-entry') continue
    const [base, head] = [await readBase(subject.path), await readHead(subject.path)]
    if (base === null || head === null) continue
    const candidates = plans.flatMap((open) => planScaffoldMounts(open.plan, derivePlanTasks(open.plan)).flatMap((mount) => {
      const composed = composeRouteRegistrarCall(base, subject.path, mount.registrar, `import { ${mount.registrar} } from '${importSpecifier(subject.path, mount.path)}'`)
      return 'content' in composed && composed.content === head ? [{ open, mount }] : []
    }))
    if (candidates.length !== 1) continue
    const { open, mount } = candidates[0]!
    const declaredRoutes = new Set(mount.routes.map((id) => `${open.file}#${id}`))
    const added = routeFacts.filter((entry) => entry.code === 'route-added')
    if (routeFacts.some((entry) => entry.declaredBy === undefined) || added.length !== declaredRoutes.size) continue
    if (added.every((entry) => declaredRoutes.has(entry.declaredBy!))) mounted.add(subject.path)
  }
  return mounted
}

async function declarationOf(
  subject: Extract<DeclarationSubject, { kind: 'file' | 'table' }>,
  owned: ReadonlyArray<{ open: OpenPlan; files: Map<string, DeclaredFile>; paths: Set<string> }>,
  readHead: (path: string) => Promise<string | null>,
): Promise<string | undefined> {
  // Claimed by identity first: two approved plans about one file or table are a question for a person.
  const claims = owned.filter(({ open, files, paths }) => (subject.kind === 'table' ? claimsTable(open.plan, subject.table) : files.has(subject.path) || paths.has(subject.path)))
  if (claims.length !== 1) return undefined
  const { open, files } = claims[0]!
  if (subject.kind === 'file' && !files.has(subject.path)) return undefined
  if (subject.kind === 'table') {
    const id = declaredTable(open.plan, subject, await readHead(subject.file))
    return id ? `${open.file}#${id}` : undefined
  }
  const declared = files.get(subject.path)!
  const text = await readHead(subject.path)
  const ast = text === null ? null : parseSourceFile(text, subject.path)
  const exports = ast ? declaredExports(ast) : undefined
  if (!ast || !exports || !declared.exports.every((name) => exports.includes(name))) return undefined
  const contents = declared.check.kind === 'routes' ? await routesFileAtHead(open.plan, declared.check.step, subject.path, readHead) : declared.contents
  if (contents === undefined || !passesCheck(declared, ast, subject.path, contents)) return undefined
  return `${open.file}#${declared.elements.join(',')}`
}

/**
 * The routes file the scaffold writes for `step` against the head: each plan model whose class its
 * conventional file declares, and each plan validator a plan model's validator file exports. A class or
 * schema the head keeps elsewhere is not found, and the file then differs from what the scaffold wrote.
 */
async function routesFileAtHead(plan: PlanDraft, step: PlanDerivedStep, path: string, readHead: (path: string) => Promise<string | null>): Promise<string | undefined> {
  const modelFiles: Record<string, string> = {}
  const validatorFiles: Record<string, string> = {}
  for (const model of plan.models.filter((entry) => entry.module === undefined)) {
    const file = `${MODELS_DIR}/${model.name}.ts`
    const text = await readHead(file)
    const ast = text === null ? null : parseSourceFile(text, file)
    if (ast && exportedClass(ast, model.name)) modelFiles[model.name] = file
    const validators = validatorFilePath(model)
    const source = await readHead(validators)
    const parsed = source === null ? null : parseSourceFile(source, validators)
    const exported = parsed ? declaredExports(parsed) : undefined
    for (const validator of plan.validators) if (exported?.includes(validator.name) && validatorFiles[validator.name] === undefined) validatorFiles[validator.name] = validators
  }
  return planScaffoldOutput(plan, step, { modelFiles, validatorFiles }).files.find((file) => file.path === path)?.contents
}

const MIGRATION_DIALECTS: Record<SchemaDialect, MigrationDialect> = { pg: 'postgres', mysql: 'mysql', sqlite: 'sqlite' }
const ROOT_SCHEMA = 'db/schema.ts'

function readJson(text: string | null): unknown {
  if (text === null) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/**
 * The added models a migration creates, when it does nothing else (`readCreationStatements()`): every table it
 * touches is one model one open plan adds in the project root, with exactly the planned columns, each foreign key
 * one the plan states and each index one it plans; and its `snapshot.json`, which later migrations are judged
 * against, records what the SQL creates over the migration before it and nothing else.
 */
export async function declaredMigration(
  subject: Extract<DeclarationSubject, { kind: 'migration' }>,
  plans: readonly OpenPlan[],
  readHead: (path: string) => Promise<string | null>,
): Promise<string | undefined> {
  const [sqlFile, snapshotFile] = [`${subject.dir}/migration.sql`, `${subject.dir}/snapshot.json`]
  if (!subject.files.every((file) => file === sqlFile || file === snapshotFile)) return undefined
  const schemaText = await readHead(ROOT_SCHEMA)
  const tables = schemaText === null ? undefined : parseSchemaSource(schemaText, ROOT_SCHEMA, null)
  const dialects = new Set(tables?.map((table) => table.dialect))
  const sql = await readHead(sqlFile)
  if (!tables || dialects.size !== 1 || sql === null) return undefined
  const statements = readCreationStatements(sql, MIGRATION_DIALECTS[[...dialects][0]!])
  if (!statements || statements.length === 0) return undefined

  // drizzle-kit writes one beside every migration; without it the next `generate` diffs against an older one.
  const snapshot = readJson(await readHead(snapshotFile))
  const previous = subject.previous === undefined ? undefined : readJson(await readHead(`${subject.previous}/snapshot.json`))
  if (snapshot === undefined || snapshot === null || previous === null || (subject.previous !== undefined && previous === undefined) || !snapshotRecordsCreation(previous, snapshot, statements)) return undefined

  // Claimed by SQL name in any module: two plans about one table of one database are a question for a person.
  const touched = new Set(statements.map((statement) => statement.table))
  const claims = plans.filter(({ plan }) => plan.models.some((model) => touched.has(model.table) || (model.tableRenamedFrom !== undefined && touched.has(model.tableRenamedFrom))))
  if (claims.length !== 1 || ![...touched].every((table) => claims[0]!.plan.models.some((model) => model.table === table || model.tableRenamedFrom === table))) return undefined
  const ids = planCreatesStatements(claims[0]!.plan, statements, tables, [...dialects][0]!)
  return ids ? `${claims[0]!.file}#${ids.join(',')}` : undefined
}

/**
 * The models `statements` create when they create exactly what `plan` adds for each table and nothing else: the
 * planned columns with the type, nullability, keys and default the scaffold's builders give them in `dialect`, and
 * every planned unique, index and foreign key once, each after the `CREATE TABLE` of its table.
 */
export function planCreatesStatements(plan: PlanDraft, statements: readonly CreationStatement[], tables: readonly SchemaTable[], dialect: SchemaDialect): string[] | undefined {
  const created = new Map<string, { model: PlanDraft['models'][number]; keys: CreationForeignKey[]; uniques: string[][]; indexes: string[][] }>()
  for (const statement of statements) {
    if (statement.kind !== 'create-table') continue
    const model = plan.models.find((candidate) => candidate.change.kind === 'add' && candidate.module === undefined && candidate.table === statement.table)
    if (!model || created.has(statement.table) || !createsPlannedTable(statement, model, dialect)) return undefined
    created.set(statement.table, { model, keys: plannedForeignKeys(plan, model, tables), uniques: plannedIndexes(model, true), indexes: plannedIndexes(model, false) })
  }
  const before = new Set<string>()
  for (const statement of statements) {
    const table = created.get(statement.table)
    // An index or a key ahead of its table does not apply, and on MySQL meets any table of that name first.
    if (statement.kind === 'create-table') before.add(statement.table)
    if (!table || !before.has(statement.table)) return undefined
    const stated = statement.kind === 'create-table' ? statement.foreignKeys : statement.kind === 'add-foreign-key' ? [statement.foreignKey] : []
    if (!stated.every((key) => takeForeignKey(table.keys, key))) return undefined
    const uniques = statement.kind === 'create-table' ? [...statement.uniques, ...statement.columns.filter((column) => column.unique).map((column) => [column.name])] : statement.kind === 'create-index' && statement.unique ? [statement.columns] : []
    const indexes = statement.kind === 'create-index' && !statement.unique ? [statement.columns] : []
    if (!uniques.every((columns) => take(table.uniques, columns)) || !indexes.every((columns) => take(table.indexes, columns))) return undefined
  }
  // What the plan states and the SQL does not: a missing key, unique or index is a table the plan did not ask for.
  if ([...created.values()].some((table) => table.keys.length + table.uniques.length + table.indexes.length > 0)) return undefined
  return [...created.values()].map((table) => table.model.id)
}

/** Removes `columns` from `lists`, telling whether it was there. */
function take(lists: string[][], columns: readonly string[]): boolean {
  const at = lists.findIndex((entry) => sameList(entry, columns))
  if (at !== -1) lists.splice(at, 1)
  return at !== -1
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, at) => value === b[at])

/** Exactly the planned columns by SQL name, each with its type, nullability, keys and default, and the planned composite key. */
function createsPlannedTable(statement: Extract<CreationStatement, { kind: 'create-table' }>, model: PlanDraft['models'][number], dialect: SchemaDialect): boolean {
  const byName = new Map(statement.columns.map((column) => [column.name, column]))
  if (byName.size !== statement.columns.length || byName.size !== model.columns.length) return false
  const primary = model.columns.filter((column) => column.primaryKey)
  // In the scaffold's column order: the key's index serves queries on its leading column.
  if (primary.length > 1 ? !statement.primaryKey || !sameList(statement.primaryKey, primary.map(sqlNameOf)) : statement.primaryKey !== undefined) return false
  return model.columns.every((planned) => {
    const column = byName.get(sqlNameOf(planned))
    const single = planned.primaryKey === true && primary.length === 1
    const generated = isAutoIncrementPrimaryKey(planned, primary.length)
    const type = migrationSqlType(dialect, planned, generated)
    // drizzle-kit writes no NOT NULL on a single key, nor on pg's composite one, whose constraint holds its columns not null.
    const keyed = planned.primaryKey === true && primary.length > 1 && dialect !== 'sqlite'
    return column !== undefined && type !== undefined && column.type === type && column.autoIncrement === (generated && dialect !== 'pg')
      && column.primaryKey === single && (column.notNull || column.primaryKey || keyed) === (!planned.nullable || single || keyed) && sameDefault(planned, column.default, dialect)
  })
}

/** Whether the SQL's default is the planned one, written as drizzle-kit writes it or in parentheses. */
function sameDefault(column: PlanDraft['models'][number]['columns'][number], stated: string | undefined, dialect: SchemaDialect): boolean {
  const planned = plannedSqlDefault(column, dialect)
  if (planned === undefined || stated === undefined) return planned === stated
  return planned !== null && (stated === planned || stated === `(${planned})`)
}

/** The column lists the model plans an index over (`unique`: a unique one), by SQL name. */
function plannedIndexes(model: PlanDraft['models'][number], unique: boolean): string[][] {
  const byName = new Map(model.columns.map((column) => [column.name, sqlNameOf(column)]))
  return [
    ...model.columns.filter((column) => (unique ? column.unique : column.index)).map((column) => [sqlNameOf(column)]),
    ...(model.indexes ?? []).filter((index) => index.unique === unique).map((index) => index.columns.map((name) => byName.get(name) ?? '')),
  ]
}

/** Each planned reference as the SQL states it, the target column by SQL name from the plan or else the head's schema. */
function plannedForeignKeys(plan: PlanDraft, model: PlanDraft['models'][number], tables: readonly SchemaTable[]): CreationForeignKey[] {
  return model.columns.flatMap((column) => {
    const reference = column.references
    const target = reference && plan.models.find((candidate) => candidate.id === reference.model)
    if (!reference || !target) return []
    const planned = target.columns.find((candidate) => candidate.name === reference.column)
    const existing = tables.find((table) => table.module === null && table.tableName === target.table)?.columns.find((candidate) => candidate.name === reference.column)
    const to = planned ? sqlNameOf(planned) : existing ? existing.columnName ?? existing.name : undefined
    return to === undefined ? [] : [{ columns: [sqlNameOf(column)], table: target.table, columnsTo: [to], ...(reference.onDelete ? { onDelete: reference.onDelete.toUpperCase() } : {}) }]
  })
}

/** Removes and confirms the planned key `key` states; `NO ACTION` is what an absent action means. */
function takeForeignKey(planned: CreationForeignKey[], key: CreationForeignKey): boolean {
  const action = (value: string | undefined) => value ?? 'NO ACTION'
  if (action(key.onUpdate) !== 'NO ACTION') return false
  const at = planned.findIndex((entry) => entry.table === key.table && sameList(entry.columns, key.columns) && sameList(entry.columnsTo, key.columnsTo) && action(entry.onDelete) === action(key.onDelete))
  if (at === -1) return false
  planned.splice(at, 1)
  return true
}
