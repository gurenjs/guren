/**
 * `guren plan:scaffold` (RFC 0030 §5, Part 3 item 6): writes what `plan/scaffold.ts` emits for
 * one scaffold step of an approved plan, the step `plan:next` has marked. Every refusal is
 * decided before the first write, so a refused run leaves the application as it was, and a
 * re-run over a scaffolded step is refused on the targets it already wrote. It runs no codegen
 * and no migration: those are the step's `plan:verify` and the `data` step's.
 */

import { writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { isConfirmedApiOnlyApp } from './app-surface'
import { CliError } from './cli-error'
import { readIfExists, toPosixRelative } from './discovery'
import { DIALECT_BARRELS } from './drizzle-specifiers'
import { discoverModelClasses } from './model-parser'
import { ParseCache } from './parse-cache'
import { appendTableToSchema, detectSchemaDialect, ensureNamedImports } from './patch-helpers'
import { readPlanFile } from './plan-render'
import { requirePlanApproval } from './plan/approvals'
import { emitPlanScaffold, type PlanScaffoldOutput } from './plan/scaffold'
import { planSlug, readPlanState } from './plan/state'
import { derivePlanTasks, findPlanStep, listPlanSteps } from './plan/tasks'
import { parseSchemaTables, schemaPathFor } from './schema-parser'
import { pathExists, writeScaffoldFiles } from './utils'

export const PLAN_SCAFFOLD_REPORT_VERSION = 1

export interface PlanScaffoldReport extends Pick<PlanScaffoldOutput, 'emitted' | 'left' | 'omitted'> {
  reportVersion: typeof PLAN_SCAFFOLD_REPORT_VERSION
  plan: { file: string; title: string; hash: string }
  step: string
  /** The files created, relative to the application root with POSIX separators. */
  created: string[]
  /** The schema file the tables were appended to, and their exports. */
  appended: { file: string; tables: string[] }
}

export interface PlanScaffoldFileOptions {
  appRoot: string
  step: string
  cwd?: string
}

function refuse(lines: string[]): never {
  throw new CliError(`${lines.join('\n')}\nNothing was scaffolded.`)
}

export async function planScaffoldFile(planPath: string, options: PlanScaffoldFileOptions): Promise<PlanScaffoldReport> {
  const { path, plan } = await readPlanFile(planPath, options.cwd)
  const approval = await requirePlanApproval(path, plan, 'nothing is scaffolded from it')
  if (!approval) {
    refuse([`${basename(path)} is a draft: plan:scaffold writes code from an approved plan only. Run guren plan:approve ${planPath} first.`])
  }
  const root = options.appRoot
  if (await isConfirmedApiOnlyApp(root).catch(() => false)) {
    refuse(['This application is API-only, so its plans have no scaffold step: plan:scaffold writes a model for an application that renders Inertia pages.'])
  }

  const derivation = derivePlanTasks(plan)
  const found = findPlanStep(derivation, options.step)
  if (!found || found.step.kind !== 'scaffold') {
    const scaffoldSteps = listPlanSteps(derivation).filter(({ step }) => step.kind === 'scaffold').map(({ step }) => step.id)
    const own = found?.task.steps.find((step) => step.kind === 'scaffold')
    const hint = own
      ? `The scaffold step of ${found?.task.id} is ${own.id}.`
      : scaffoldSteps.length > 0 ? `Its scaffold steps: ${scaffoldSteps.join(', ')}.` : 'The plan has no scaffold step.'
    refuse([`${options.step} is ${found ? `a ${found.step.kind} step` : 'no step of the plan'}, and plan:scaffold writes a scaffold step only. ${hint}`])
  }
  const { step } = found

  // One step is one commit, measured from where plan:next marked it (plan/work.ts), and
  // plan:next accepts a dirty tree only as the marked step's own work.
  const active = (await readPlanState(root, planSlug(path))).state?.active
  if (active?.step !== step.id) {
    refuse([
      `${step.id} is not the step plan:next marked${active ? ` (it marked ${active.step})` : ''}. Run guren plan:next ${planPath} first:`,
      '  it marks the step, so what plan:scaffold writes counts as that step’s work.',
    ])
  }

  const schemaPath = schemaPathFor(null)
  const schema = await readIfExists(root, schemaPath)
  if (schema === null) refuse([`plan:scaffold appends tables to ${schemaPath}, which this application does not have.`])
  const dialect = detectSchemaDialect(schema)
  const tables = await parseSchemaTables(root)
  const models = (await discoverModelClasses(root, new ParseCache())).filter((model) => model.module === null).map((model) => model.className)

  const output = emitPlanScaffold(plan, step, {
    dialect,
    tables: tables.map((table) => ({
      identifier: table.identifier,
      ...(table.tableName !== undefined ? { tableName: table.tableName } : {}),
      module: table.module,
      columns: table.columns.map((column) => column.name),
      ...(table.opaqueColumns ? { opaqueColumns: true } : {}),
    })),
    models,
  })
  const inTheWay = []
  for (const file of output.files) if (await pathExists(resolve(root, file.path))) inTheWay.push(`${file.path} already exists.`)
  const refusals = [...output.refusals, ...inTheWay]
  if (refusals.length > 0) {
    refuse([
      `plan:scaffold cannot write ${step.id}:`,
      ...refusals.map((line) => `  ${line}`),
      'If this step was scaffolded before, it has nothing left to write: run guren plan:verify for it.',
    ])
  }

  let content = ensureNamedImports(schema, DIALECT_BARRELS[dialect], [...new Set(output.tables.flatMap((table) => table.imports))])
  for (const table of output.tables) content = appendTableToSchema(content, table.identifier, table.block).source

  // The schema first: the model files import its exports. A failure after the first write names
  // what is on disk, since the refusal a re-run gives would read as a finished step.
  const written: string[] = []
  const created: string[] = []
  try {
    if (output.tables.length > 0) {
      await writeFile(resolve(root, schemaPath), content, 'utf8')
      written.push(schemaPath)
    }
    for (const file of output.files) {
      for (const path of await writeScaffoldFiles([{ path: file.path, contents: file.contents }], { cwd: root })) {
        const relative = toPosixRelative(root, path)
        written.push(relative)
        created.push(relative)
      }
    }
  } catch (error) {
    if (written.length === 0) throw error
    throw new CliError(
      `plan:scaffold stopped part way through ${step.id}: ${error instanceof Error ? error.message : String(error)}\n`
        + `Already written: ${written.join(', ')}. The step is half scaffolded, and running plan:scaffold again refuses on these files.\n`
        + 'Fix the cause, restore them (git checkout / git clean on those paths), and run plan:scaffold again.',
    )
  }

  return {
    reportVersion: PLAN_SCAFFOLD_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash: approval.hash },
    step: step.id,
    created,
    appended: { file: schemaPath, tables: output.tables.map((table) => table.identifier) },
    emitted: output.emitted,
    left: output.left,
    omitted: output.omitted,
  }
}

export function formatPlanScaffold(report: PlanScaffoldReport, planArgument: string): string {
  const lines = [`${report.plan.title} (${report.plan.file}): scaffolded ${report.step}`, '']
  if (report.created.length > 0) lines.push('Created:', ...report.created.map((file) => `  ${file}`))
  if (report.appended.tables.length > 0) lines.push(`Appended to ${report.appended.file}: ${report.appended.tables.join(', ')}`)
  if (report.emitted.length > 0) lines.push('', `Elements written: ${report.emitted.join(', ')}`)
  if (report.left.length > 0) {
    lines.push('', 'Not written by plan:scaffold; the http step writes these by hand:', ...report.left.map((element) => `  ${element.id} (${element.section})`))
  }
  if (report.omitted.length > 0) {
    lines.push('', 'Relationships left out of the model, to add once what they need exists; until then plan:status reads the model as drifted:')
    lines.push(...report.omitted.map((entry) => `  ${entry.model} ${entry.relationship}: ${entry.reason}`))
  }
  lines.push('', `No codegen or migration was run. Next: bunx guren plan:verify ${planArgument} --step ${report.step}, and commit once it is verified.`)
  return lines.join('\n')
}
