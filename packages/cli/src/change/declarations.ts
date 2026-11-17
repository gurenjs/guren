/**
 * The declaration matcher of RFC 0040 §3: a fact takes its declarable lane only when an approved,
 * open plan declares it. Two subjects are matched so far: an added file `plan:scaffold` writes for an
 * added element, and an added table of an added model. A match needs the element's kind (`add`), its
 * module, its identity and every property the change shows; anything else stays where the reader put it.
 */

import type { File } from '@babel/types'

import { parseSourceFile } from '../parse-cache'
import { listPlanElementEntries, type PlanColumn, type PlanDraft, type PlanElementEntry } from '../plan/schema'
import { planScaffoldFiles } from '../plan/scaffold'
import { derivePlanTasks } from '../plan/tasks'
import type { SchemaColumn, SchemaTable } from '../schema-parser'
import { FACT_CLASSES } from './fact-classes'
import type { ChangeFact } from './lane'

/** What a fact is about, kept beside it by the reader that emitted it. */
export type DeclarationSubject = { kind: 'file'; path: string } | { kind: 'table'; table: SchemaTable }

/** An approved plan that is not closed, as the head has it; `file` is app-relative. */
export interface OpenPlan {
  file: string
  plan: PlanDraft
}

export interface DeclaredFile {
  elements: string[]
  /** The value names the scaffold's own output exports, every one of which the file must export. */
  exports: string[]
}

/** The value names a module declares and exports itself; `undefined` when a star export hides them. */
export function declaredExports(ast: File): string[] | undefined {
  const names: string[] = []
  for (const node of ast.program.body) {
    if (node.type === 'ExportAllDeclaration') return undefined
    if (node.type === 'ExportDefaultDeclaration') {
      names.push('default')
      const declaration = node.declaration
      if ((declaration.type === 'ClassDeclaration' || declaration.type === 'FunctionDeclaration') && declaration.id) names.push(declaration.id.name)
      continue
    }
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue
    const declaration = node.declaration
    if ((declaration?.type === 'ClassDeclaration' || declaration?.type === 'FunctionDeclaration') && declaration.id) names.push(declaration.id.name)
    if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) if (declarator.id.type === 'Identifier') names.push(declarator.id.name)
    }
    if (node.source) continue
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ExportSpecifier' && specifier.exportKind !== 'type') names.push(specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value)
    }
  }
  return names
}

function changeKind(entry: PlanElementEntry): unknown {
  return (entry.element.change as { kind?: unknown } | undefined)?.kind
}

/**
 * The files the plan's scaffold steps write, each owned by its elements when every one is an `add` in
 * the project root. A routes file is left out: no route fact is emitted yet, so nothing declares one.
 */
export function planDeclaredFiles(plan: PlanDraft): Map<string, DeclaredFile> {
  const entries = new Map(listPlanElementEntries(plan).map((entry) => [entry.id, entry]))
  const files = new Map<string, DeclaredFile | null>()
  for (const task of derivePlanTasks(plan).tasks) {
    for (const step of task.steps) {
      if (step.kind !== 'scaffold') continue
      for (const file of planScaffoldFiles(plan, step)) {
        const owners = file.elements.map((id) => entries.get(id))
        const owned = owners.length > 0 && owners.every((entry) => entry !== undefined && entry.section !== 'routes' && changeKind(entry) === 'add' && entry.element.module === undefined)
        const ast = owned ? parseSourceFile(file.contents, file.path) : null
        const exports = ast ? declaredExports(ast) : undefined
        // Two steps naming one path cannot both own it.
        if (files.has(file.path) || !exports || exports.length === 0) files.set(file.path, null)
        else files.set(file.path, { elements: file.elements, exports })
      }
    }
  }
  return new Map([...files].filter((entry): entry is [string, DeclaredFile] => entry[1] !== null))
}

/** Whether a column the schema declares is the one the plan writes, by every property both state. */
function columnMatches(column: SchemaColumn, planned: PlanColumn): boolean {
  if (column.opaqueBuilder || column.opaqueOptions) return false
  if (planned.change.kind !== 'add') return false
  if (column.primaryKey !== (planned.primaryKey === true)) return false
  // A primary key is not null whatever the chain says.
  if (!column.primaryKey && column.notNull === planned.nullable) return false
  if (column.unique !== planned.unique) return false
  return (column.references !== undefined) === (planned.references !== undefined)
}

/** The added model whose table this is, with exactly its planned columns; `undefined` when none declares it. */
export function declaredTable(plan: PlanDraft, table: SchemaTable): string | undefined {
  if (table.opaqueColumns || table.tableName === undefined) return undefined
  const model = plan.models.find((candidate) => candidate.change.kind === 'add' && (candidate.module ?? null) === table.module && candidate.table === table.tableName)
  if (!model || model.columns.length !== table.columns.length) return undefined
  const planned = new Map(model.columns.map((column) => [column.name, column]))
  if (planned.size !== model.columns.length) return undefined
  return table.columns.every((column) => {
    const entry = planned.get(column.name)
    return entry !== undefined && columnMatches(column, entry)
  })
    ? model.id
    : undefined
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
  const matches: string[] = []
  for (const { open, files } of owned) {
    if (subject.kind === 'table') {
      const id = declaredTable(open.plan, subject.table)
      if (id) matches.push(`${open.file}#${id}`)
      continue
    }
    const declared = files.get(subject.path)
    if (!declared) continue
    const text = await readHead(subject.path)
    const ast = text === null ? null : parseSourceFile(text, subject.path)
    const exports = ast ? declaredExports(ast) : undefined
    if (exports && declared.exports.every((name) => exports.includes(name))) matches.push(`${open.file}#${declared.elements.join(',')}`)
  }
  // Two open plans claiming one subject is a question for a person, not a declaration.
  return matches.length === 1 ? matches[0] : undefined
}
