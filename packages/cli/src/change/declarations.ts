/**
 * The declaration matcher of RFC 0040 §3: a fact takes its declarable lane only when an approved,
 * open plan declares it. Two subjects are matched so far, both against what `plan:scaffold` writes for
 * the plan: an added file of added elements, and an added table of an added model. A subject two open
 * plans claim, or one that differs from the scaffold where the plan determines it, stays where it was.
 */

import type { ClassDeclaration, File, Statement } from '@babel/types'

import { canonicalSyntax, referencedIdentifiers, walk } from '../ast-walk'
import { classActionMembers } from '../controller-methods'
import { extractClassDeclaration } from '../model-parser'
import { parseSourceFile } from '../parse-cache'
import { readPolicyAbilities } from '../plan/policy-abilities'
import { listPlanElementEntries, type PlanController, type PlanDraft, type PlanElementEntry, type PlanPolicy } from '../plan/schema'
import { planScaffoldOutput, type PlanScaffoldApp } from '../plan/scaffold'
import { providerFilePath } from '../plan/scaffold-http'
import { derivePlanTasks, type PlanDerivedStep } from '../plan/tasks'
import type { SchemaTable } from '../schema-parser'
import { FACT_CLASSES } from './fact-classes'
import type { ChangeFact } from './lane'

/** What a fact is about, kept beside it by the reader that emitted it. `tables` are the head's tables of the same file. */
export type DeclarationSubject =
  | { kind: 'file'; path: string }
  | { kind: 'table'; table: SchemaTable; file: string; tables: readonly SchemaTable[] }

/** An approved plan that is not closed, as the head has it; `file` is app-relative. */
export interface OpenPlan {
  file: string
  plan: PlanDraft
}

/**
 * How a file is held to the plan beyond its exports: a provider runs at boot and the plan determines all of
 * it, a policy's abilities are planned by name, and a controller's members are the planned actions.
 */
export type DeclaredFileCheck = { kind: 'exports' } | { kind: 'whole' } | { kind: 'policy'; policy: PlanPolicy } | { kind: 'controller'; controller: PlanController }

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
      if ((declaration.type === 'ClassDeclaration' || declaration.type === 'FunctionDeclaration') && declaration.id) names.push('default', declaration.id.name)
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

function checkOf(path: string, owners: readonly PlanElementEntry[]): DeclaredFileCheck {
  const policy = owners.find((entry) => entry.section === 'policies')?.element as PlanPolicy | undefined
  if (policy) return path === providerFilePath(policy) ? { kind: 'whole' } : { kind: 'policy', policy }
  const controller = owners.find((entry) => entry.section === 'controllers')?.element as PlanController | undefined
  return controller ? { kind: 'controller', controller } : { kind: 'exports' }
}

/**
 * The files the plan's scaffold steps write, each owned by its elements when every one is an `add` in
 * the project root. A routes file is left out: no route fact is emitted yet, so nothing declares one.
 */
export function planDeclaredFiles(plan: PlanDraft): Map<string, DeclaredFile> {
  const entries = new Map(listPlanElementEntries(plan).map((entry) => [entry.id, entry]))
  const files = new Map<string, DeclaredFile | null>()
  for (const step of scaffoldSteps(plan)) {
    for (const file of planScaffoldOutput(plan, step).files) {
      const owners = file.elements.map((id) => entries.get(id))
      const owned = owners.length > 0 && owners.every((entry) => entry !== undefined && entry.section !== 'routes' && changeKind(entry) === 'add' && entry.element.module === undefined)
      const ast = owned ? parseSourceFile(file.contents, file.path) : null
      const exports = ast ? declaredExports(ast) : undefined
      // Two steps naming one path cannot both own it.
      if (files.has(file.path) || !exports || exports.length === 0) files.set(file.path, null)
      else files.set(file.path, { elements: file.elements, exports, contents: file.contents, check: checkOf(file.path, owners as PlanElementEntry[]) })
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
function passesCheck(declared: DeclaredFile, ast: File, path: string): boolean {
  const { check } = declared
  if (check.kind === 'exports') return true
  const planned = parseSourceFile(declared.contents, path)
  if (!planned) return false
  if (check.kind === 'whole') return canonicalSyntax(ast.program.body) === canonicalSyntax(planned.program.body)
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

/**
 * Whether every name the statement reads is a framework builder imported under its own name, another table
 * of the file, or a parameter it binds: `import { text as integer }` keeps the syntax and swaps the types.
 */
function importsBuildersAsThemselves(ast: File, statement: Statement, tables: readonly SchemaTable[]): boolean {
  const builders = new Set<string>()
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration' || !FRAMEWORK_MODULE.test(node.source.value)) continue
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
): Promise<ChangeFact[]> {
  const owned = plans.map((open) => ({ open, files: planDeclaredFiles(open.plan) }))
  const result: ChangeFact[] = []
  for (const fact of facts) {
    const subject = subjects.get(fact)
    const declaredBy = subject ? await declarationOf(subject, owned, readHead) : undefined
    result.push(declaredBy ? { ...fact, lane: FACT_CLASSES[fact.code].lowest, declaredBy } : fact)
  }
  return result
}

async function declarationOf(
  subject: DeclarationSubject,
  owned: ReadonlyArray<{ open: OpenPlan; files: Map<string, DeclaredFile> }>,
  readHead: (path: string) => Promise<string | null>,
): Promise<string | undefined> {
  // Claimed by identity first: two approved plans about one file or table are a question for a person.
  const claims = owned.filter(({ open, files }) => (subject.kind === 'table' ? claimedModel(open.plan, subject.table) !== undefined : files.has(subject.path)))
  if (claims.length !== 1) return undefined
  const { open, files } = claims[0]!
  if (subject.kind === 'table') {
    const id = declaredTable(open.plan, subject, await readHead(subject.file))
    return id ? `${open.file}#${id}` : undefined
  }
  const declared = files.get(subject.path)!
  const text = await readHead(subject.path)
  const ast = text === null ? null : parseSourceFile(text, subject.path)
  const exports = ast ? declaredExports(ast) : undefined
  if (!ast || !exports || !declared.exports.every((name) => exports.includes(name)) || !passesCheck(declared, ast, subject.path)) return undefined
  return `${open.file}#${declared.elements.join(',')}`
}
