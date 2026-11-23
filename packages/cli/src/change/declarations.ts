/**
 * The declaration matcher of RFC 0040 §3: a fact takes its declarable lane only when an approved, open plan
 * declares it. Matched so far: an added file of added elements and an added table of an added model, both
 * against what `plan:scaffold` writes (a declared table taking its own residue with it), an added file a plan's
 * command writes (`plan/command-files.ts`), an added migration that only creates such tables, an added route,
 * a route a plan alters or drops, a file a `drop` element owns deleted, the routes entry edited by `--mount` alone, and a provider a planned policy implies, registered as
 * `plan:scaffold` registers it. A subject two open plans claim, or one the plan does not determine, stays.
 */

import { posix } from 'node:path'

import type { CallExpression, ClassDeclaration, File, Statement } from '@babel/types'
import type { JsonSchemaObject } from '@guren/server/internal/zod-json-schema'

import { readCreationStatements, snapshotRecordsCreation, type CreationForeignKey, type CreationStatement, type MigrationDialect } from '@guren/orm/internal/migration-guard'

import { canonicalSyntax, referencedIdentifiers, sameComments, unconditionalThisCalls, walk } from '../ast-walk'
import { classActionMembers } from '../controller-methods'
import { extractClassDeclaration } from '../model-parser'
import { parseSourceFile } from '../parse-cache'
import { validatorFieldProperties } from '../plan/field-status'
import { readPolicyAbilities } from '../plan/policy-abilities'
import { planApprovalsPath } from '../plan/approvals'
import { planCommandClaims, planCommandFiles } from '../plan/command-files'
import { listPlanElementEntries, type PlanController, type PlanDraft, type PlanElementEntry, type PlanPolicy, type PlanRoute } from '../plan/schema'
import { plannedSqlDefault, type PlanScaffoldApp, planScaffoldMounts, planScaffoldOutput, sqlNameOf, TWIN_EXTENSIONS } from '../plan/scaffold'
import { CONFIG_DIR, MODELS_DIR, PROVIDERS_DIR } from '../discovery'
import { defaultImportBinding } from '../patch-helpers'
import { DIALECT_BARRELS, DRIZZLE_CORE_SUBPATHS } from '../drizzle-specifiers'
import { isAutoIncrementPrimaryKey, migrationSqlType } from '../schema-columns'
import { policyFilePath, policyProviderName, providerFilePath, resourceFilePath, validatorFilePath } from '../plan/scaffold-http'
import { asksPolicyOfRecord, controllerFilePath, plannedAgentMetadata, plannedRouteMiddleware, scaffoldRoutesFile, sideEffectFilePath } from '../plan/scaffold-controller'
import { derivePlanTasks, type PlanDerivedStep } from '../plan/tasks'
import { composeRouteRegistrarCall, findRouteRegistrar } from '../route-registrar'
import { parseSchemaSource, type SchemaDialect, type SchemaTable } from '../schema-parser'
import { registeredBefore, routePathsMayOverlap } from '../test-requests'
import { importSpecifier, kebabCase } from '../utils'
import { composeAppProviderRegistration } from '../provider-registrar'
import { appEntryListNames, type AppEntryList } from './app-entry'
import { envKeyValue, importsFrameworkEnv } from './app-env'
import { envBuilderSignature, planEnvEntry, plannedEnvSignature } from '../env-declarations'
import { FACT_CLASSES } from './fact-classes'
import type { ChangeFact } from './lane'
import { sameRecordPart, type RouteSecurityRecord } from './security-records'

/**
 * What a fact is about, kept beside it by the reader that emitted it. `tables` are the head's tables of the same
 * file; a migration's `files` are its changed paths, and `previous` the migration folder before it at the head.
 * A table's residue is the code inside an added table the column reader does not state.
 */
export type DeclarationSubject =
  /** A source file the change adds, or with `edited` one it edits that the commit recording the plan's approval did not have. */
  | { kind: 'file'; path: string; edited?: true }
  | { kind: 'table'; table: SchemaTable; file: string; tables: readonly SchemaTable[] }
  | { kind: 'migration'; dir: string; files: string[]; previous?: string }
  | { kind: 'table-residue'; file: string; identifier: string }
  /** A route as the head's records hold it (the base's for a removal, `base` beside it for a change), with every head route in order and the ones the change adds. */
  | { kind: 'route'; change: 'add' | 'drop' | 'alter'; route: RouteSecurityRecord; base?: RouteSecurityRecord } & HeadRoutes
  | { kind: 'agent'; route: RouteSecurityRecord; base?: RouteSecurityRecord }
  /** The routes entry, edited in place. */
  | { kind: 'routes-entry'; path: string }
  /** An entry the application entry's `createApp()` list gains, with the import binding it and nothing else. */
  | { kind: 'app-entry'; path: string; list: AppEntryList; name: string }
  /** A key the `defineEnv()` literal of `config/env.ts` gains, with the `Env` import and nothing else. */
  | { kind: 'env'; path: string; key: string }
  /** A source file the change deletes. */
  | { kind: 'removed-file'; path: string }

/** Every route the head registers, in registration order, and those of them with no counterpart at the base. */
export interface HeadRoutes {
  routes: readonly RouteSecurityRecord[]
  added: readonly RouteSecurityRecord[]
  /** Every base route in registration order, for a route the change removes or changes. */
  baseRoutes?: readonly RouteSecurityRecord[]
}

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
  /** The value names the scaffold's own output exports (a command's generator's, for a file it writes), every one of which the file must export. */
  exports: string[]
  /** What the scaffold, or the command's generator, writes there. */
  contents: string
  check: DeclaredFileCheck
  /** What a plan's command writes there, when no planned element owns it: the file holds only as one of these, as syntax. */
  generated?: string[]
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
  const scaffolded = new Set([...files.values()].flatMap((file) => file?.elements ?? []))
  const commandFiles = planCommandFiles(plan)
  const claims = planCommandClaims(plan)
  // A command of the plan whose words may name a scaffold path leaves it to no one, whether or not its call reads. A
  // blueprint's `'all'` is left to `plan:command-target`, which judges its targets against the scaffold's at approval.
  for (const path of files.keys()) if ([...claims.values()].some((paths) => paths !== 'all' && paths.has(path))) files.set(path, null)
  const owners = new Map<string, number>()
  for (const file of commandFiles) for (const id of file.elements) owners.set(id, (owners.get(id) ?? 0) + 1)
  for (const file of commandFiles) {
    const ast = parseSourceFile(file.contents[0]!, file.path)
    const exports = ast ? declaredExports(ast) : undefined
    // A path the scaffold or another command may also write is not one command's, and an element is held to one file:
    // the scaffold's where it writes the element (a validator's file is named after its model, not after it).
    const shared = [...claims].some(([id, paths]) => id !== file.commandId && (paths === 'all' || paths.has(file.path)))
    const owned = file.elements.some((id) => scaffolded.has(id) || owners.get(id)! > 1)
    if (files.has(file.path) || shared || owned || !exports || exports.length === 0) files.set(file.path, null)
    else files.set(file.path, { elements: [file.commandId, ...file.elements], exports, contents: file.contents[0]!, check: file.check, ...(file.check.kind === 'whole' ? { generated: file.contents } : {}) })
  }
  return new Map([...files].filter((entry): entry is [string, DeclaredFile] => entry[1] !== null))
}

/** Whether the head is the planned file as syntax, with its comments: `canonicalSyntax` drops a `// @ts-nocheck` an edit adds. */
function sameWhole(planned: File, plannedText: string, head: File, headText: string): boolean {
  return canonicalSyntax(head.program.body) === canonicalSyntax(planned.program.body) && sameComments(planned, plannedText, head, headText)
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
function passesCheck(declared: DeclaredFile, ast: File, text: string, path: string, contents = declared.contents): boolean {
  const { check } = declared
  if (check.kind === 'exports') return true
  const planned = parseSourceFile(contents, path)
  if (!planned) return false
  if (check.kind === 'whole' || check.kind === 'routes') return sameWhole(planned, contents, ast, text)
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
  // A module's element is claimed in its module too, where a command of another plan may write it.
  const inRoot = (element: { module?: string }, paths: string[]): string[] =>
    element.module === undefined ? paths : [...paths, ...paths.map((path) => `modules/${kebabCase(element.module!)}/${path}`)]
  return new Set([
    ...plan.models.flatMap((model) => inRoot(model, [`${MODELS_DIR}/${model.name}.ts`, validatorFilePath(model), scaffoldRoutesFile(model).path])),
    ...plan.resources.flatMap((resource) => inRoot(resource, [resourceFilePath(resource)])),
    ...plan.policies.flatMap((policy) => inRoot(policy, [policyFilePath(policy), providerFilePath(policy)])),
    ...plan.controllers.flatMap((controller) => inRoot(controller, [controllerFilePath(controller)])),
    ...plan.sideEffects.flatMap((effect) => inRoot(effect, [sideEffectFilePath(effect)])),
    ...(plan.providers ?? []).map((provider) => `${PROVIDERS_DIR}/${provider.className}.ts`),
    ...(plan.config ?? []).map((entry) => `config/${entry.name}.ts`),
    ...[...planCommandClaims(plan).values()].flatMap((paths) => (paths === 'all' ? [] : [...paths])),
  ])
}

/** Whether a command of the plan may write files no reading places, which claims every path a command declares. */
function claimsEveryCommandPath(plan: PlanDraft): boolean {
  return [...planCommandClaims(plan).values()].includes('all')
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
  presentWhenAdded: (record: string, path: string) => Promise<boolean | undefined> = async () => undefined,
  recordsCoverRoutes = false,
): Promise<ChangeFact[]> {
  const owned = plans.map((open) => ({ open, files: planDeclaredFiles(open.plan), paths: planClaimedPaths(open.plan) }))
  const result: ChangeFact[] = []
  // A lowered fact is a new object, so the subjects are keyed again by what the result holds.
  const resultSubjects = new Map<ChangeFact, DeclarationSubject>()
  const declaredTables = new Set<string>()
  const registered = await declaredRegistrations(facts, subjects, owned, readHead, readBase)
  for (const fact of facts) {
    const subject = subjects.get(fact)
    const declaredBy = subject?.kind === 'table-residue' || subject?.kind === 'routes-entry' ? undefined
      : subject?.kind === 'app-entry' ? registered.get(entryKey(subject.list, subject.name))
      : subject?.kind === 'env' ? await declaredEnvKey(subject, owned, readHead)
      : subject?.kind === 'removed-file' ? await declaredRemovedFile(subject.path, owned, readHead, readBase, presentWhenAdded)
      : subject?.kind === 'migration' ? await declaredMigration(subject, plans, readHead)
      : subject?.kind === 'route' ? (subject.change === 'add' ? await declaredRoute(subject.route, subject, plans, readHead) : subject.change === 'alter' ? declaredRouteChange(subject, plans) : declaredRouteRemoval(subject, plans))
      : subject?.kind === 'agent' ? await declaredAgentOf(subject.route, subject.base, facts, subjects, plans, readHead)
      // An edit outside the security surface weakens no route only where every route's record was compared.
      : subject?.kind === 'file' && subject.edited && !recordsCoverRoutes ? undefined
      : subject ? await declarationOf(subject, owned, readHead, presentWhenAdded) : undefined
    if (declaredBy && subject?.kind === 'table') declaredTables.add(`${subject.file}\u0000${subject.table.identifier}`)
    // An edit to a file the plan added is that element's addition in every task that touches it.
    const code = declaredBy && subject?.kind === 'file' && subject.edited ? 'file-added' : declaredBy && subject?.kind === 'removed-file' ? 'file-removed' : fact.code
    const judged = declaredBy ? { ...fact, code, lane: FACT_CLASSES[code].lowest, declaredBy, ...(code === 'file-added' && code !== fact.code ? { message: `${fact.message}: absent when the plan's approval was recorded, so its addition`, planAddition: true as const } : {}) } : fact
    result.push(judged)
    if (subject) resultSubjects.set(judged, subject)
  }
  const mounted = await declaredMount(result, resultSubjects, plans, readHead, readBase)
  // The statement a declared table matched is the scaffold's whole, its `sql` defaults and index callback included.
  return result.filter((fact) => {
    const subject = resultSubjects.get(fact)
    if (subject?.kind === 'routes-entry') return !mounted.has(subject.path)
    return subject?.kind !== 'table-residue' || !declaredTables.has(`${subject.file}\u0000${subject.identifier}`)
  })
}

/** The plan routes naming this route by name or by endpoint, in any change: a claim, before anything is compared. */
function claimsRoute(plan: PlanDraft, route: RouteSecurityRecord): boolean {
  return plan.routes.some((planned) => planned.name === route.name || (planned.change.kind === 'rename' && planned.change.from === route.name)
    || (planned.method === route.method && planned.path === route.path))
}

/**
 * The added plan route this registered route is, by every property the record holds: its endpoint and name, its
 * action as the controller file the scaffold writes exports it, its middleware by name, its bindings, its agent
 * metadata, its contracts by export and rendered keys, the policy ability the action asks of the policy's model.
 * A route registered before another that a request could match too takes that request without either record
 * changing, so it declares nothing. A binding's lookup column is not in the record, so an unplanned one is unseen.
 */
export async function declaredRoute(route: RouteSecurityRecord, head: HeadRoutes, plans: readonly OpenPlan[], readHead: (path: string) => Promise<string | null>): Promise<string | undefined> {
  const claims = plans.filter((open) => claimsRoute(open.plan, route))
  if (claims.length !== 1 || route.module !== null || route.name === undefined) return undefined
  const { file, plan } = claims[0]!
  const planned = plan.routes.find((candidate) => candidate.name === route.name)
  if (!planned || planned.change.kind !== 'add' || planned.method !== route.method || planned.path !== route.path) return undefined
  // A name registered twice points the router's name map at one of them, so an existing `route(name)` would move.
  if (head.routes.some((other) => other !== route && other.name === route.name)) return undefined
  const controller = plan.controllers.find((candidate) => candidate.actions.some((action) => action.id === planned.action))
  const action = controller?.actions.find((candidate) => candidate.id === planned.action)
  if (!controller || !action || controller.module !== undefined || controller.change.kind !== 'add' || action.change.kind !== 'add') return undefined
  if (route.action !== `${controllerFilePath(controller)}#default.${action.name}`) return undefined

  if (!holdsPlannedMiddleware(route, plannedRouteMiddleware(planned, action))) return undefined
  const bindings = plannedBindings(plan, planned)
  if (!bindings || !sameRecordPart(route.bindings ?? {}, bindings)) return undefined
  if (!sameRecordPart(route.agent ?? null, plannedAgentMetadata(planned) ?? null)) return undefined
  for (const segment of ['params', 'query', 'body'] as const) {
    const validator = action[segment] === undefined ? undefined : plan.validators.find((candidate) => candidate.id === action[segment])
    const contract = route.contracts[segment]
    if (!validator) {
      if (contract) return undefined
      continue
    }
    if (validator.module !== undefined || !contract || contract.exports.length !== 1) return undefined
    const validatorFiles = new Set(plan.models.filter((model) => model.module === undefined).map(validatorFilePath))
    const [exportFile, exportName] = contract.exports[0]!.split('#')
    if (exportName !== validator.name || exportFile === undefined || !validatorFiles.has(exportFile) || !rendersPlannedFields(contract.schema, validator)) return undefined
  }
  const policy = action.authorization.policy
  if (policy) {
    const model = plan.models.find((candidate) => candidate.id === plan.policies.find((entry) => entry.id === policy.id)?.model)
    if (!model || model.module !== undefined || 'unread' in route.handler) return undefined
    const tuple = new RegExp(`^\\[\\s*${model.name}\\s*,\\s*[A-Za-z_$][\\w$]*\\s*\\]$`)
    const asks = (subject: string): boolean => tuple.test(subject) || (!asksPolicyOfRecord(plan, action) && subject === model.name)
    if (!route.handler.authorizes.some((call) => call.member === 'authorize' && call.unconditional && call.ability === policy.ability && asks(call.subject))) return undefined
    // The record reads calls by pattern, so the action is read for the call itself: awaited, a statement of the body, on the model.
    const path = controllerFilePath(controller)
    const source = await readHead(path)
    const ast = source === null ? null : parseSourceFile(source, path)
    if (!ast || !namesModelAsItself(ast, path, model.name)) return undefined
    if (!awaitsPolicy(ast, controller.className, action.name, policy.ability, model.name, asksPolicyOfRecord(plan, action))) return undefined
  }

  const self = { module: route.module, index: head.routes.indexOf(route) }
  if (self.index === -1) return undefined
  const added = new Set(head.added)
  for (const [index, other] of head.routes.entries()) {
    // A plan route is never `ALL`; an `ALL` route registered after it answers its method too. A route the change adds loses no request.
    const methods = route.method === other.method || other.method === 'ALL'
    if (added.has(other) || !methods || registeredBefore(self, { module: other.module, index }) === false) continue
    if (routePathsMayOverlap(route.path, other.path)) return undefined
  }
  return `${file}#${planned.id}`
}

/** The record parts an `alter` route may change: what its element states about the route itself, beside its action. */
const ALTERABLE_ROUTE_PARTS: ReadonlySet<string> = new Set(['method', 'path', 'middleware', 'bindings', 'agent'])

/** Whether the route's chain is the planned middleware by name, each resolved, `auth` requiring a user. */
function holdsPlannedMiddleware(route: RouteSecurityRecord, middleware: readonly string[]): boolean {
  return route.middleware.length === middleware.length && route.middleware.every((entry, at) =>
    entry.kind !== 'inline' && !entry.unresolved && entry.name === middleware[at] && (entry.name !== 'auth' || entry.capabilities.authentication?.mode === 'required'))
}

/**
 * The bindings a plan route registers, each param to its root model's `file#export`; `undefined` when one cannot be
 * stated: a planned lookup column (the manifest does not carry it), or a model in a module or absent from the plan.
 */
function plannedBindings(plan: PlanDraft, planned: PlanRoute): Record<string, string> | undefined {
  const bindings: Record<string, string> = {}
  for (const binding of planned.bind) {
    const model = plan.models.find((entry) => entry.id === binding.model)
    if (binding.key !== undefined || !model || model.module !== undefined) return undefined
    bindings[binding.param] = `${MODELS_DIR}/${model.name}.ts#${model.name}`
  }
  return bindings
}

/** The one root plan route of `name` with change `kind`, claimed by one open plan alone, its action a root controller's. */
function plannedRouteOf(plans: readonly OpenPlan[], route: RouteSecurityRecord, kind: 'alter' | 'drop', base?: RouteSecurityRecord): { file: string; plan: PlanDraft; planned: PlanRoute } | undefined {
  // A changed route is claimed by what names either side: a plan renaming it, or one naming the endpoint it left.
  const claims = plans.filter((open) => claimsRoute(open.plan, route) || (base !== undefined && claimsRoute(open.plan, base)))
  if (claims.length !== 1 || route.module !== null || route.name === undefined) return undefined
  const { file, plan } = claims[0]!
  const planned = plan.routes.filter((candidate) => candidate.name === route.name)
  if (planned.length !== 1 || planned[0]!.change.kind !== kind) return undefined
  const controller = plan.controllers.find((candidate) => candidate.actions.some((action) => action.id === planned[0]!.action))
  if (!controller || controller.module !== undefined) return undefined
  return { file, plan, planned: planned[0]! }
}

/** Whether a route of `method` and `path` at `index` overlaps one registered after it that answers its method. */
function shadowsLater(method: string, path: string, self: { module: string | null; index: number }, routes: readonly RouteSecurityRecord[], skip: ReadonlySet<RouteSecurityRecord>): boolean {
  return routes.some((other, index) => !skip.has(other) && (other.method === method || other.method === 'ALL')
    && registeredBefore(self, { module: other.module, index }) !== false && index !== self.index && routePathsMayOverlap(path, other.path))
}

/**
 * Whether a head route could take the requests `left` (a base route the change removes or moves) answered: one of its
 * method or `ALL` at a path that may overlap, unless it is a base route registered before `left`, unchanged, which
 * answered them first already. A route the change adds or moves counts, since nothing judged it against `left`.
 */
function headTakesOver(left: RouteSecurityRecord, baseRoutes: readonly RouteSecurityRecord[], headRoutes: readonly RouteSecurityRecord[], skip: ReadonlySet<RouteSecurityRecord>): boolean {
  const leftAt = { module: left.module, index: baseRoutes.indexOf(left) }
  return headRoutes.some((other) => {
    if (skip.has(other) || !(other.method === left.method || other.method === 'ALL') || !routePathsMayOverlap(left.path, other.path)) return false
    const earlier = baseRoutes.findIndex((candidate, index) => sameRecordPart(candidate, other) && registeredBefore({ module: candidate.module, index }, leftAt) === true)
    return earlier === -1
  })
}

/**
 * A route the change removes, declared by the one open plan whose `drop` route names it at its method and path. A base
 * route registered after it, or a head route that was not answering before it, at an overlapping path of its method or
 * `ALL` would answer its requests once it is gone.
 */
function declaredRouteRemoval(subject: Extract<DeclarationSubject, { kind: 'route' }>, plans: readonly OpenPlan[]): string | undefined {
  const { route, baseRoutes } = subject
  const found = plannedRouteOf(plans, route, 'drop')
  if (!found || !baseRoutes || found.planned.method !== route.method || found.planned.path !== route.path) return undefined
  if (subject.routes.some((other) => other.name === route.name)) return undefined
  const index = baseRoutes.indexOf(route)
  if (index === -1 || shadowsLater(route.method, route.path, { module: route.module, index }, baseRoutes, new Set([route]))) return undefined
  if (headTakesOver(route, baseRoutes, subject.routes, new Set())) return undefined
  return `${found.file}#${found.planned.id}`
}

/**
 * A route the change alters, declared by the one open plan whose `alter` route names it: the name, module and action are the
 * same on both sides, every part that changed is one the element states about the route, and the head holds it as stated.
 * A moved route is held to both overlap rules: the path it leaves and the one it takes.
 */
function declaredRouteChange(subject: Extract<DeclarationSubject, { kind: 'route' }>, plans: readonly OpenPlan[]): string | undefined {
  const { route, base, baseRoutes } = subject
  if (!base || !baseRoutes || base.name !== route.name || base.module !== route.module || base.action !== route.action) return undefined
  const found = plannedRouteOf(plans, route, 'alter', base)
  if (!found) return undefined
  const { file, plan, planned } = found
  if (subject.routes.some((other) => other !== route && other.name === route.name)) return undefined
  // One head route paired with two base routes leaves one of them gone with no removal fact.
  if (baseRoutes.some((other) => other !== base && (other.name === base.name || (other.action === base.action && other.module === base.module)))) return undefined
  const parts = new Set([...Object.keys(base), ...Object.keys(route)])
  const changed = [...parts].filter((part) => !sameRecordPart(base[part as keyof RouteSecurityRecord], route[part as keyof RouteSecurityRecord]))
  if (changed.length === 0 || changed.some((part) => !ALTERABLE_ROUTE_PARTS.has(part))) return undefined

  if (planned.method !== route.method || planned.path !== route.path) return undefined
  // The route's action is the element's: `<file>#<export>.<action>`, the class by its export or, for a default export, its file.
  const controller = plan.controllers.find((candidate) => candidate.actions.some((action) => action.id === planned.action))
  const action = controller?.actions.find((candidate) => candidate.id === planned.action)
  const target = route.action?.match(/^(?<file>[^#]+)#(?<exported>[^.]+)\.(?<member>[^.]+)$/)?.groups
  if (!controller || !action || controller.module !== undefined || !target || target.member !== action.name) return undefined
  if (target.exported !== controller.className && !(target.exported === 'default' && posix.basename(target.file!).replace(SOURCE_EXTENSION, '') === controller.className)) return undefined
  if (changed.includes('middleware') && !holdsPlannedMiddleware(route, plannedRouteMiddleware(planned, action))) return undefined
  if (changed.includes('bindings')) {
    const bindings = plannedBindings(plan, planned)
    if (!bindings || !sameRecordPart(route.bindings ?? {}, bindings)) return undefined
  }
  if (changed.includes('agent') && !sameRecordPart(route.agent ?? null, plannedAgentMetadata(planned) ?? null)) return undefined

  if (changed.includes('method') || changed.includes('path')) {
    const headIndex = subject.routes.indexOf(route)
    const baseIndex = baseRoutes.indexOf(base)
    if (headIndex === -1 || baseIndex === -1) return undefined
    const added = new Set(subject.added)
    if (shadowsLater(route.method, route.path, { module: route.module, index: headIndex }, subject.routes, new Set([route, ...added]))) return undefined
    if (shadowsLater(base.method, base.path, { module: base.module, index: baseIndex }, baseRoutes, new Set([base]))) return undefined
    if (headTakesOver(base, baseRoutes, subject.routes, new Set([route]))) return undefined
  }
  return `${file}#${planned.id}`
}

/**
 * Whether the action's body holds, as a statement of its own, `await this.authorize(ability, subject)`: the subject
 * `[Model, record]`, or also the bare class where the scaffold writes that. A call not awaited lets the action run on.
 */
function awaitsPolicy(ast: File, className: string, actionName: string, ability: string, model: string, recordOnly: boolean): boolean {
  const declaration = exportedClass(ast, className)
  // Two members of the name leave which one the router dispatches to unread.
  const members = declaration ? [...classActionMembers(declaration)].filter((entry) => entry.name === actionName) : []
  const body = members.length === 1 && !members[0]!.member.static ? members[0]!.body : undefined
  if (body?.type !== 'BlockStatement') return false
  const isModel = (node: unknown): boolean => (node as { type?: string; name?: string } | null)?.type === 'Identifier' && (node as { name: string }).name === model
  return unconditionalThisCalls(body, 'authorize').some((call) => {
    if (call.arguments.length !== 2) return false
    const [first, subject] = call.arguments
    if (first?.type !== 'StringLiteral' || first.value !== ability) return false
    if (subject?.type === 'ArrayExpression') return subject.elements.length === 2 && isModel(subject.elements[0]) && subject.elements[1]?.type === 'Identifier'
    return !recordOnly && isModel(subject)
  })
}

/** Whether the file imports `name` as itself from that model's file, and binds the name nowhere else. */
function namesModelAsItself(ast: File, path: string, name: string): boolean {
  const specifier = importSpecifier(path, `${MODELS_DIR}/${name}.ts`)
  const imported = ast.program.body.some((node) => node.type === 'ImportDeclaration' && node.importKind !== 'type' && node.source.value === specifier
    && node.specifiers.some((entry) => entry.type === 'ImportSpecifier' && entry.importKind !== 'type' && entry.local.name === name && entry.imported.type === 'Identifier' && entry.imported.name === name))
  return imported && bindingsOf(ast, name) === 1
}

/** How many declarations bind `name` anywhere in the file: imports, declarators, functions, classes, parameters, catch clauses. */
function bindingsOf(ast: File, name: string): number {
  const roots: unknown[] = []
  walk(ast.program, (node) => {
    const value = node as unknown as Record<string, unknown>
    if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') roots.push(value.local)
    else if (node.type === 'VariableDeclarator') roots.push(value.id)
    else if (node.type === 'CatchClause') roots.push(value.param)
    else if (/^(?:Function|Class)(?:Declaration|Expression)$/u.test(node.type)) roots.push(value.id)
    if (Array.isArray(value.params)) roots.push(...value.params)
  })
  let count = 0
  // A pattern root counts every identifier inside it, a destructured key included: an over-count only keeps a fact.
  walk(roots, (node) => {
    if (node.type === 'Identifier' && (node as unknown as { name: string }).name === name) count += 1
  })
  return count
}

/**
 * Whether a rendered contract schema is an object with exactly the validator's planned keys, each matching its planned
 * type, requiredness and rules as `plan:status` judges them: a verdict that is not a match keeps the route.
 */
function rendersPlannedFields(schema: unknown, validator: PlanDraft['validators'][number]): boolean {
  if (!schema || typeof schema !== 'object' || 'unreadable' in schema) return false
  const { type, properties, required } = schema as { type?: unknown; properties?: unknown; required?: unknown }
  if (type !== 'object' || !properties || typeof properties !== 'object') return false
  if (!sameRecordPart(Object.keys(properties).sort(), validator.fields.map((field) => field.name).sort())) return false
  const requiredKeys = new Set(Array.isArray(required) ? required : [])
  const fields = Object.fromEntries(Object.entries(properties as Record<string, JsonSchemaObject>).map(([name, output]) => [name, { output, date: false, required: requiredKeys.has(name) }]))
  return validatorFieldProperties(validator.fields, { fields }).every((property) => property.verdict === 'match')
}

/** A route's agent tool is declared with the route: `declaredRoute()` or `declaredRouteChange()` holds its metadata to the plan's. */
async function declaredAgentOf(route: RouteSecurityRecord, base: RouteSecurityRecord | undefined, facts: readonly ChangeFact[], subjects: ReadonlyMap<ChangeFact, DeclarationSubject>, plans: readonly OpenPlan[], readHead: (path: string) => Promise<string | null>): Promise<string | undefined> {
  const change = base === undefined ? 'add' : 'alter'
  const routed = facts.find((fact) => {
    const subject = subjects.get(fact)
    return subject?.kind === 'route' && subject.change === change && subject.route === route && subject.base === base
  })
  const subject = routed && subjects.get(routed)
  if (subject?.kind !== 'route') return undefined
  if (change === 'alter') return declaredRouteChange(subject, plans)
  return route.agent !== undefined ? declaredRoute(route, subject, plans, readHead) : undefined
}

/**
 * The routes entries `--mount` alone edited: the head is the base with one scaffolded registrar's call and import
 * composed in, as `composeRouteRegistrarCall()` writes them, and the change's route facts are exactly that file's
 * routes added, each declared by the plan that mounts it. A route changed, removed or added beside them keeps the edit,
 * and so does an alias the mounted file sets that another route names, unless the entry's registrar sets it after.
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
    // Only additions: a route changed or removed beside the mount keeps the edit, declared or not.
    const onlyAdditions = routeFacts.every((entry) => entry.code === 'route-added' || (entry.code === 'agent-tool' && (subjects.get(entry) as { base?: unknown } | undefined)?.base === undefined))
    if (!onlyAdditions || routeFacts.some((entry) => entry.declaredBy === undefined) || added.length !== declaredRoutes.size) continue
    // Each planned route once: two additions citing one element stand in for a route the mount did not register.
    if (!added.every((entry) => declaredRoutes.has(entry.declaredBy!)) || new Set(added.map((entry) => entry.declaredBy)).size !== added.length) continue
    // One alias map serves the router: the mounted file's alias, set first, replaces one set before the entry registrar runs.
    const addedRoutes = new Set(added.flatMap((entry) => {
      const subject = subjects.get(entry)
      return subject?.kind === 'route' ? [subject.route] : []
    }))
    const headRoutes = [...subjects.values()].find((entry): entry is Extract<DeclarationSubject, { kind: 'route' }> => entry.kind === 'route')?.routes ?? []
    // The file runs at mount, past what its routes' records show (a router-wide binding, an alias), so it must be the scaffold's.
    const mountedText = await readHead(mount.path)
    const step = derivePlanTasks(open.plan).tasks.flatMap((task) => task.steps).find((entry) => entry.id === mount.scaffoldStep)
    const scaffolded = step && mountedText !== null ? await routesFileAtHead(open.plan, step, mount.path, readHead) : undefined
    const [mountedAst, scaffoldedAst] = [mountedText === null ? null : parseSourceFile(mountedText, mount.path), scaffolded === undefined ? null : parseSourceFile(scaffolded, mount.path)]
    if (!mountedAst || !scaffoldedAst || canonicalSyntax(mountedAst.program.body) !== canonicalSyntax(scaffoldedAst.program.body)) continue
    const aliases = aliasNames(mountedText!, mount.path)
    if (!aliases) continue
    const entryAliases = registrarAliases(base, subject.path)
    const replaced = aliases.filter((name) => headRoutes.some((route) => !addedRoutes.has(route) && route.middleware.some((entry) => entry.name === name || entry.members?.includes(name) === true)) && !entryAliases.has(name))
    if (replaced.length === 0) mounted.add(subject.path)
  }
  return mounted
}

/** The names a file passes to `aliasMiddleware()`; `undefined` when it does not parse or names one other than by a literal. */
function aliasNames(text: string, path: string): string[] | undefined {
  const ast = parseSourceFile(text, path)
  if (!ast) return undefined
  const names: string[] = []
  let open = false
  walk(ast.program, (node) => {
    const call = node.type === 'CallExpression' ? (node as unknown as CallExpression) : undefined
    const callee = call?.callee
    if (!callee || (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') || callee.property.type !== 'Identifier' || callee.property.name !== 'aliasMiddleware') return
    const [first] = call.arguments
    if (first?.type === 'StringLiteral') names.push(first.value)
    else open = true
  })
  return open ? undefined : names
}

/**
 * The aliases the entry's registrar sets whenever it runs, after a call `--mount` puts first: a top-level statement of
 * its body chaining `aliasMiddleware('<name>', …)` off its router, or off a constant a statement before bound from it.
 */
function registrarAliases(text: string, path: string): Set<string> {
  const names = new Set<string>()
  const registrar = findRouteRegistrar(text)
  const ast = registrar ? parseSourceFile(text, path) : null
  let body: Statement[] | undefined
  walk(ast?.program, (node) => {
    if (body === undefined && node.type === 'BlockStatement' && node.start === registrar!.bodyStart - 1) body = (node as unknown as { body: Statement[] }).body
  })
  const routers = new Set([registrar?.parameterName])
  // The names one chain sets, when it starts at a router; `undefined` when it does not.
  const chain = (expression: unknown): string[] | undefined => {
    const set: string[] = []
    let current = expression as { type?: string; callee?: { type: string; object?: unknown; property?: { type: string; name?: string } }; arguments?: Array<{ type: string; value?: unknown }>; name?: string } | undefined
    while (current?.type === 'CallExpression' && current.callee?.type === 'MemberExpression') {
      const [first] = current.arguments ?? []
      if (current.callee.property?.name === 'aliasMiddleware' && first?.type === 'StringLiteral') set.push(String(first.value))
      current = current.callee.object as typeof current
    }
    return current?.type === 'Identifier' && routers.has(current.name) ? set : undefined
  }
  for (const statement of body ?? []) {
    if (statement.type === 'ExpressionStatement') for (const name of chain(statement.expression) ?? []) names.add(name)
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue
    for (const declarator of statement.declarations) {
      const set = chain(declarator.init)
      if (!set) continue
      for (const name of set) names.add(name)
      if (declarator.id.type === 'Identifier') routers.add(declarator.id.name)
    }
  }
  return names
}

async function declarationOf(
  subject: Extract<DeclarationSubject, { kind: 'file' | 'table' }>,
  owned: ReadonlyArray<{ open: OpenPlan; files: Map<string, DeclaredFile>; paths: Set<string> }>,
  readHead: (path: string) => Promise<string | null>,
  presentWhenAdded: (record: string, path: string) => Promise<boolean | undefined>,
): Promise<string | undefined> {
  // Claimed by identity first: two approved plans about one file or table are a question for a person.
  const claims = owned.filter(({ open, files, paths }) => (subject.kind === 'table' ? claimsTable(open.plan, subject.table) : files.has(subject.path) || paths.has(subject.path)))
  if (claims.length !== 1) return undefined
  const { open, files } = claims[0]!
  if (subject.kind === 'file' && !files.has(subject.path)) return undefined
  // The commit that recorded the plan's approval, on the merge base's history whatever the merge style, tells the
  // plan's own work from a file the application already had; a person read that commit, a plan-record change.
  if (subject.kind === 'file' && subject.edited && (await presentWhenAdded(planApprovalsPath(open.file), subject.path)) !== false) return undefined
  if (subject.kind === 'table') {
    const id = declaredTable(open.plan, subject, await readHead(subject.file))
    return id ? `${open.file}#${id}` : undefined
  }
  const declared = files.get(subject.path)!
  if (subject.kind === 'file' && subject.edited && !editLowers(declared, subject.path)) return undefined
  // A command of another plan that no reading places may write any declared path, the scaffold's included.
  if (owned.some((entry) => entry.open !== open && claimsEveryCommandPath(entry.open.plan))) return undefined
  return (await holdsDeclared(open.plan, declared, subject.path, readHead)) ? `${open.file}#${declared.elements.join(',')}` : undefined
}

/**
 * The files whose edit may read as the plan's addition: a controller, whose `authorize()`/`validate*()` calls the records
 * read, and a model, whose fillable owner and serialized sensitive columns the audit reads. A validator, a resource or a side
 * effect has no reader of its edit. What an action checks by hand and the rest of a model stay unread, as for an addition.
 */
function editLowers(declared: DeclaredFile, path: string): boolean {
  if (declared.check.kind === 'controller') return true
  return declared.check.kind === 'exports' && MODEL_FILE.test(path) && declared.elements.some((id) => id.startsWith('model.'))
}

const MODEL_FILE = new RegExp(`^(?:modules/[^/]+/)?${MODELS_DIR}/`)

/** The root files a plan's `drop` elements own, each with the name its file exports: the path `plan:scaffold` would write it at. */
function planDroppedFiles(plan: PlanDraft): Map<string, { id: string; name: string } | null> {
  const files = new Map<string, { id: string; name: string } | null>()
  // An element of any other change at the path (an `add` of the same name) leaves it to no one.
  const own = (element: { id: string; module?: string; change: { kind: string } }, path: string, name: string): void => {
    const dropped = element.change.kind === 'drop' && element.module === undefined
    files.set(path, files.has(path) || !dropped ? null : { id: element.id, name })
  }
  for (const model of plan.models) own(model, `${MODELS_DIR}/${model.name}.ts`, model.name)
  for (const resource of plan.resources) own(resource, resourceFilePath(resource), resource.name)
  for (const controller of plan.controllers) own(controller, controllerFilePath(controller), controller.className)
  for (const effect of plan.sideEffects) own(effect, sideEffectFilePath(effect), effect.name)
  return files
}

/**
 * Whether the file is the class `name` and nothing else a reader would miss once it is gone: imports with names, type
 * declarations, and the class exported as itself. A second class, a top-level call (`registerJob()`) or another value
 * export leaves with the file, and an auto-discovered listener or job is imported by nothing that would fail.
 */
function holdsOnlyClass(ast: File, name: string): boolean {
  const declaration = exportedClass(ast, name)
  if (!declaration || (declaration.decorators?.length ?? 0) > 0) return false
  // A static block or a static initializer that calls runs when the class loads, as a top-level statement would.
  for (const member of declaration.body.body) {
    if (member.type === 'StaticBlock' || ('decorators' in member && (member.decorators?.length ?? 0) > 0)) return false
    if ('static' in member && member.static && 'value' in member && member.value) {
      let calls = false
      walk([member.value], (node) => { if (node.type === 'CallExpression' || node.type === 'NewExpression' || node.type === 'TaggedTemplateExpression') calls = true })
      if (calls) return false
    }
  }
  return ast.program.body.every((node) => {
    if (node.type === 'ImportDeclaration') return node.specifiers.length > 0 || node.importKind === 'type'
    if (node.type === 'TSTypeAliasDeclaration' || node.type === 'TSInterfaceDeclaration') return true
    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') && extractClassDeclaration(node) === declaration) return true
    return node.type === 'ExportNamedDeclaration' && !node.source && (node.declaration?.type === 'TSTypeAliasDeclaration' || node.declaration?.type === 'TSInterfaceDeclaration')
  })
}

/**
 * A source file the change deletes, declared by the one open plan whose `drop` element owns its path, when the base's file
 * was that class alone and was there when the approval was recorded. What still imports it fails the gate; what it guarded is a route fact.
 */
async function declaredRemovedFile(
  path: string,
  owned: ReadonlyArray<{ open: OpenPlan; files: Map<string, DeclaredFile>; paths: Set<string> }>,
  readHead: (path: string) => Promise<string | null>,
  readBase: (path: string) => Promise<string | null>,
  presentWhenAdded: (record: string, path: string) => Promise<boolean | undefined>,
): Promise<string | undefined> {
  const claims = owned.filter(({ paths }) => paths.has(path))
  if (claims.length !== 1 || owned.some((entry) => claimsEveryCommandPath(entry.open.plan))) return undefined
  const { open, files } = claims[0]!
  const dropped = planDroppedFiles(open.plan).get(path)
  // The plan's scaffold or one of its commands writing the path is another claim on it.
  if (!dropped || files.has(path) || [...planCommandClaims(open.plan).values()].some((paths) => paths !== 'all' && paths.has(path))) return undefined
  const text = await readBase(path)
  const ast = text === null ? null : parseSourceFile(text, path)
  if (!ast || !holdsOnlyClass(ast, dropped.name)) return undefined
  // An importer of the module resolves to a twin or a directory index the change leaves behind, which nothing judged.
  const stem = path.replace(SOURCE_EXTENSION, '')
  if ((await readHead(`${stem}/package.json`)) !== null) return undefined
  for (const extension of TWIN_EXTENSIONS) {
    if ((await readHead(`${stem}${extension}`)) !== null || (await readHead(`${stem}/index${extension}`)) !== null) return undefined
  }
  // The file the plan was approved against: one a later change wrote after the approval is not the element it drops.
  if ((await presentWhenAdded(planApprovalsPath(open.file), path)) !== true) return undefined
  return `${open.file}#${dropped.id}`
}

/** Whether the head's file at `path` is what the plan declares there: its exports, and the check its kind takes. */
async function holdsDeclared(plan: PlanDraft, declared: DeclaredFile, path: string, readHead: (path: string) => Promise<string | null>): Promise<boolean> {
  // The scaffold imports `./P.js`, which Bun resolves to a `P.js` ahead of `P.ts`: a twin would run in the file's place.
  const stem = path.replace(SOURCE_EXTENSION, '')
  if (stem !== path) for (const extension of TWIN_EXTENSIONS) if (`${stem}${extension}` !== path && (await readHead(`${stem}${extension}`)) !== null) return false
  const text = await readHead(path)
  const ast = text === null ? null : parseSourceFile(text, path)
  const exports = ast ? declaredExports(ast) : undefined
  if (!ast || !exports || !declared.exports.every((name) => exports.includes(name))) return false
  if (declared.generated?.some((generated) => { const written = parseSourceFile(generated, path); return written !== null && sameWhole(written, generated, ast, text!) })) return true
  const contents = declared.check.kind === 'routes' ? await routesFileAtHead(plan, declared.check.step, path, readHead) : declared.contents
  return contents !== undefined && passesCheck(declared, ast, text!, path, contents)
}

/**
 * A key one open plan's `env` element adds (RFC 0040 §5), declared as that element states it: the builder chain means
 * what `guren plugin` would write for the element (`envBuilderSignature()`, `.describe()` aside), on the framework's `Env`.
 */
async function declaredEnvKey(
  subject: Extract<DeclarationSubject, { kind: 'env' }>,
  owned: ReadonlyArray<{ open: OpenPlan }>,
  readHead: (path: string) => Promise<string | null>,
): Promise<string | undefined> {
  const head = await readHead(subject.path)
  const value = head === null ? undefined : envKeyValue(head, subject.path, subject.key)
  if (head === null || value === undefined || !importsFrameworkEnv(head, subject.path)) return undefined
  const claims = owned.flatMap(({ open }) => (open.plan.env ?? []).filter((element) => element.key === subject.key).map((element) => ({ open, element })))
  if (claims.length !== 1 || claims[0]!.element.change.kind !== 'add') return undefined
  const { open, element } = claims[0]!
  const signature = envBuilderSignature(value)
  return signature !== undefined && signature === plannedEnvSignature(planEnvEntry(element)) ? `${open.file}#${element.id}` : undefined
}

const entryKey = (list: AppEntryList, name: string): string => `${list}\u0000${name}`

/**
 * The entries the application entry gains that a plan declares, keyed by {@link entryKey}: the providers a scaffold
 * step implies, as {@link impliedRegistrations} reads them, and else each entry a `providers` or `config` element adds.
 */
async function declaredRegistrations(
  facts: readonly ChangeFact[],
  subjects: ReadonlyMap<ChangeFact, DeclarationSubject>,
  owned: ReadonlyArray<{ open: OpenPlan; files: Map<string, DeclaredFile>; paths: Set<string> }>,
  readHead: (path: string) => Promise<string | null>,
  readBase: (path: string) => Promise<string | null>,
): Promise<Map<string, string>> {
  const implied = await impliedRegistrations(facts, subjects, owned, readHead, readBase)
  const added = facts.map((fact) => subjects.get(fact)).filter((subject): subject is Extract<DeclarationSubject, { kind: 'app-entry' }> => subject?.kind === 'app-entry')
  for (const subject of added) {
    const key = entryKey(subject.list, subject.name)
    if (implied.has(key)) continue
    const declaredBy = await declaredEntry(subject, owned, readHead)
    if (declaredBy) implied.set(key, declaredBy)
  }
  return implied
}

/**
 * An entry one open plan's `providers` or `config` element adds (RFC 0040 §5): the head binds the entry by a real
 * default import of `app/Providers/<className>` or `config/<name>`, and nothing but that file answers the import.
 * The file itself is the plan's to name, not to write, so it stays a fact of its own.
 */
async function declaredEntry(
  subject: Extract<DeclarationSubject, { kind: 'app-entry' }>,
  owned: ReadonlyArray<{ open: OpenPlan }>,
  readHead: (path: string) => Promise<string | null>,
): Promise<string | undefined> {
  const head = await readHead(subject.path)
  if (head === null) return undefined
  // One element declares one registration: a name the list holds twice, or held before the change, is a second one.
  if (appEntryListNames(head, subject.path, subject.list)?.filter((name) => name === subject.name).length !== 1) return undefined
  const claims = owned.flatMap(({ open }) => {
    const elements = subject.list === 'providers'
      ? (open.plan.providers ?? []).map((element) => ({ id: element.id, change: element.change, target: `${PROVIDERS_DIR}/${element.className}` }))
      : (open.plan.config ?? []).map((element) => ({ id: element.id, change: element.change, target: `${CONFIG_DIR}/${element.name}` }))
    return elements.filter((element) => element.change.kind === 'add' && defaultImportBinding(head, subject.path, element.target) === subject.name)
      .map((element) => ({ open, element }))
  })
  if (claims.length !== 1) return undefined
  const { open, element } = claims[0]!
  // A twin of another extension may answer the import in the file's place, as it does for a declared file.
  const present = await Promise.all(TWIN_EXTENSIONS.map(async (extension) => (await readHead(`${element.target}${extension}`)) !== null))
  return present.filter(Boolean).length === 1 ? `${open.file}#${element.id}` : undefined
}

/**
 * The providers the application entry gains that a plan implies, by name: the head is `composeAppProviderRegistration()`
 * of the base for one scaffold step's providers, in its order, byte for byte, and each provider and the policy it
 * registers hold what the plan declares. A provider runs at boot, so one the plan does not determine stays.
 */
async function impliedRegistrations(
  facts: readonly ChangeFact[],
  subjects: ReadonlyMap<ChangeFact, DeclarationSubject>,
  owned: ReadonlyArray<{ open: OpenPlan; files: Map<string, DeclaredFile>; paths: Set<string> }>,
  readHead: (path: string) => Promise<string | null>,
  readBase: (path: string) => Promise<string | null>,
): Promise<Map<string, string>> {
  const declared = new Map<string, string>()
  const added = facts.map((fact) => subjects.get(fact)).filter((subject): subject is Extract<DeclarationSubject, { kind: 'app-entry' }> => subject?.kind === 'app-entry')
  const [first] = added
  if (!first || added.some((subject) => subject.list !== 'providers' || subject.path !== first.path)) return declared
  const [base, head] = [await readBase(first.path), await readHead(first.path)]
  if (base === null || head === null) return declared
  const candidates = owned.flatMap(({ open, files }) => scaffoldSteps(open.plan).flatMap((step) => {
    const { providers } = planScaffoldOutput(open.plan, step)
    if (providers.length !== added.length) return []
    let content = base
    for (const provider of providers) {
      const { wiring, content: patched } = composeAppProviderRegistration(content, first.path, provider)
      if (!wiring.registered || !wiring.entry.modified || patched === undefined) return []
      content = patched
    }
    // Each entry names a real default import of its provider: an import line the composer reads as present may sit in a comment.
    if (content !== head || providers.some((provider, index) => defaultImportBinding(head, first.path, `${PROVIDERS_DIR}/${provider}`) !== added[index]!.name)) return []
    return [{ open, files, providers }]
  }))
  if (candidates.length !== 1) return declared
  const { open, files, providers } = candidates[0]!
  const matched = new Map<string, string>()
  for (const provider of providers) {
    const policy = open.plan.policies.find((entry) => policyProviderName(entry) === provider)
    if (!policy) return declared
    for (const path of [providerFilePath(policy), policyFilePath(policy)]) {
      // Claimed by one plan alone, as a file is; a second plan's policy of that name is a question for a person.
      if (owned.filter((entry) => entry.files.has(path) || entry.paths.has(path)).length !== 1) return declared
      const file = files.get(path)
      if (!file || !(await holdsDeclared(open.plan, file, path, readHead))) return declared
    }
    matched.set(entryKey('providers', added[providers.indexOf(provider)]!.name), `${open.file}#${policy.id}`)
  }
  return matched
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
  const output = planScaffoldOutput(plan, step, { modelFiles, validatorFiles })
  const file = output.files.find((entry) => entry.path === path)
  // A binding or contract the scaffold would leave out here is one the real run, finding the class elsewhere, writes.
  return file && !output.unwritten.some((entry) => file.elements.includes(entry.element)) ? file.contents : undefined
}

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/u
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
