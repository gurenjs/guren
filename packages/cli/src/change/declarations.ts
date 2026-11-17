/**
 * The declaration matcher of RFC 0040 §3: a fact takes its declarable lane only when an approved,
 * open plan declares it. Two subjects are matched so far, both against what `plan:scaffold` writes for
 * the plan: an added file of added elements, and an added table of an added model. A subject two open
 * plans claim, or one that differs from the scaffold where the plan determines it, stays where it was.
 */

import type { ClassDeclaration, File, Statement } from '@babel/types'

import { canonicalSyntax, memberKeyName } from '../ast-walk'
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

function classNamed(ast: File, name: string): ClassDeclaration | undefined {
  for (const node of ast.program.body) {
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
  if (check.kind === 'policy') {
    const read = readPolicyAbilities(ast, check.policy.name)
    if ('unreadable' in read || read.open || read.fields.length > 0) return false
    const abilities = read.exposes ? read.declared.filter((name) => read.exposes!.includes(name)) : read.declared
    const wanted = check.policy.abilities.map((ability) => ability.name)
    return abilities.length === new Set(abilities).size && abilities.length === wanted.length && wanted.every((name) => abilities.includes(name))
  }
  const [head, scaffold] = [classNamed(ast, check.controller.className), classNamed(planned, check.controller.className)]
  if (!head || !scaffold || canonicalSyntax(head.superClass) !== canonicalSyntax(scaffold.superClass)) return false
  const actions = new Set(check.controller.actions.map((action) => action.name))
  // An action is what `Router` dispatches to; a constructor, a static member or an accessor is not one the plan names.
  return head.body.body.every((member) => {
    if (member.type === 'ClassMethod') return member.kind === 'method' && !member.static && actions.has(memberKeyName(member) ?? '')
    if (member.type === 'ClassProperty') return !member.static && (member.value?.type === 'ArrowFunctionExpression' || member.value?.type === 'FunctionExpression') && actions.has(memberKeyName(member) ?? '')
    return false
  })
}

function exportedStatement(ast: File, identifier: string): Statement | undefined {
  return ast.program.body.find((node) => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration' && node.declaration.declarations.length === 1
    && node.declaration.declarations[0]!.id.type === 'Identifier' && node.declaration.declarations[0]!.id.name === identifier)
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
  const added = new Set(plan.models.filter((candidate) => candidate.change.kind === 'add').map((candidate) => candidate.table))
  // The schema as the scaffold found it: the tables this plan adds are what it writes, not what it reads.
  const app: Partial<PlanScaffoldApp> = {
    dialect: table.dialect,
    tables: subject.tables.filter((entry) => !added.has(entry.tableName ?? '')).map((entry) => ({ identifier: entry.identifier, tableName: entry.tableName, module: entry.module, columns: entry.columns.map((column) => column.name), ...(entry.opaqueColumns ? { opaqueColumns: true } : {}) })),
  }
  for (const step of scaffoldSteps(plan)) {
    const block = planScaffoldOutput(plan, step, app).tables.find((entry) => entry.model === model.id && entry.identifier === table.identifier)?.block
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
