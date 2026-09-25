/**
 * `guren plan:scaffold` (RFC 0030 §5, Part 3 item 6): writes what `plan/scaffold.ts` emits for
 * one scaffold step of an approved plan, the step `plan:next` has marked, and registers each
 * policy provider in `createApp()`. Every refusal is decided before the first write, so a refused
 * run leaves the application as it was, and a re-run over a scaffolded step is refused on the
 * targets it already wrote. It runs no codegen and no migration: those are `plan:verify`'s.
 */

import { basename, resolve } from 'node:path'

import { isConfirmedApiOnlyApp } from './app-surface'
import { CliError } from './cli-error'
import {
  classNameFromPath,
  discoverPolicyFiles,
  discoverResourceFiles,
  discoverValidatorFiles,
  excludeBarrelFiles,
  moduleNameFromRelPath,
  readIfExists,
  toPosixRelative,
} from './discovery'
import { DIALECT_BARRELS } from './drizzle-specifiers'
import { discoverModelClasses } from './model-parser'
import { ParseCache } from './parse-cache'
import { appendTableToSchema, detectSchemaDialect, ensureNamedImports } from './patch-helpers'
import { readPlanFile } from './plan-render'
import { exportedNames } from './plan/app-detail'
import { requirePlanApproval } from './plan/approvals'
import { writeFileAtomic } from './plan/beside'
import { emitPlanScaffold, type PlanScaffoldOutput } from './plan/scaffold'
import { planSlug, readPlanState } from './plan/state'
import { derivePlanTasks, findPlanStep, listPlanSteps } from './plan/tasks'
import { composeAppProviderRegistration, resolveAppEntry } from './provider-registrar'
import { parseSchemaTables, schemaPathFor } from './schema-parser'
import { pathExists, writeScaffoldFiles } from './utils'

export const PLAN_SCAFFOLD_REPORT_VERSION = 1

export interface PlanScaffoldReport extends Pick<PlanScaffoldOutput, 'emitted' | 'left' | 'omitted' | 'unwritten'> {
  reportVersion: typeof PLAN_SCAFFOLD_REPORT_VERSION
  plan: { file: string; title: string; hash: string }
  step: string
  /** The files created, relative to the application root with POSIX separators. */
  created: string[]
  /** The schema file the tables were appended to, and their exports. */
  appended: { file: string; tables: string[] }
  /** The app entry the policy providers were registered in; `file` is null when there was none to register. */
  registered: { file: string | null; providers: string[] }
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
  const cache = new ParseCache()
  const models = (await discoverModelClasses(root, cache)).filter((model) => model.module === null).map((model) => model.className)
  const validators = await rootValidatorExports(root, cache)
  if ('unreadable' in validators) refuse([`plan:scaffold cannot tell which schemas the validator files already export: ${validators.unreadable}.`])

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
    validators: validators.names,
    resources: await rootClassNames(root, discoverResourceFiles),
    policies: await rootClassNames(root, discoverPolicyFiles),
  })
  const inTheWay = []
  for (const file of output.files) if (await pathExists(resolve(root, file.path))) inTheWay.push(`${file.path} already exists.`)
  const registration = await registerProviders(root, output.providers)
  const refusals = [...output.refusals, ...inTheWay, ...registration.refusals]
  if (refusals.length > 0) {
    refuse([
      `plan:scaffold cannot write ${step.id}:`,
      ...refusals.map((line) => `  ${line}`),
      'If this step was scaffolded before, it has nothing left to write: run guren plan:verify for it.',
    ])
  }

  let content = ensureNamedImports(schema, DIALECT_BARRELS[dialect], [...new Set(output.tables.flatMap((table) => table.imports))])
  for (const table of output.tables) content = appendTableToSchema(content, table.identifier, table.block).source

  // The schema first: the model files import its exports; the entry last, since it imports the
  // providers. A failure after the first write names what is on disk, since the refusal a re-run
  // gives would read as a finished step.
  const written: string[] = []
  const created: string[] = []
  let writing: string | undefined
  try {
    if (output.tables.length > 0) {
      writing = schemaPath
      await writeFileAtomic(resolve(root, schemaPath), content)
      written.push(schemaPath)
    }
    for (const file of output.files) {
      writing = file.path
      for (const path of await writeScaffoldFiles([{ path: file.path, contents: file.contents }], { cwd: root })) {
        const relative = toPosixRelative(root, path)
        written.push(relative)
        created.push(relative)
      }
    }
    if (registration.entry && registration.content !== undefined) {
      writing = registration.entry
      await writeFileAtomic(resolve(root, registration.entry), registration.content)
      written.push(registration.entry)
    }
  } catch (error) {
    if (written.length === 0) throw error
    // A `wx` write that fails after opening leaves the file behind, possibly empty.
    const failing = writing && !written.includes(writing) ? ` ${writing} failed and may exist, part written.` : ''
    throw new CliError(
      `plan:scaffold stopped part way through ${step.id}: ${error instanceof Error ? error.message : String(error)}\n`
        + `Already written: ${written.join(', ')}.${failing} The step is half scaffolded, and running plan:scaffold again refuses on these files.\n`
        + 'Fix the cause, restore them (git checkout / git clean on those paths), and run plan:scaffold again.',
    )
  }

  return {
    reportVersion: PLAN_SCAFFOLD_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash: approval.hash },
    step: step.id,
    created,
    appended: { file: schemaPath, tables: output.tables.map((table) => table.identifier) },
    registered: { file: registration.entry, providers: output.providers },
    emitted: output.emitted,
    left: output.left,
    omitted: output.omitted,
    unwritten: output.unwritten,
  }
}

/** The names the root's validator files export, which a planned validator must not take: `plan:status` finds a validator by its name. */
async function rootValidatorExports(root: string, cache: ParseCache): Promise<{ names: string[] } | { unreadable: string }> {
  const names: string[] = []
  for (const filePath of excludeBarrelFiles(await discoverValidatorFiles(root))) {
    const file = toPosixRelative(root, filePath)
    if (moduleNameFromRelPath(file) !== null) continue
    const parsed = await cache.get(filePath)
    const exported = parsed ? exportedNames(parsed.ast, 'this file') : null
    if (exported === null) return { unreadable: `${file} could not be read for its exports` }
    names.push(...exported)
  }
  return { names }
}

async function rootClassNames(root: string, discover: (appRoot: string) => Promise<string[]>): Promise<string[]> {
  const files = excludeBarrelFiles(await discover(root))
  return files.filter((file) => moduleNameFromRelPath(toPosixRelative(root, file)) === null).map(classNameFromPath)
}

/**
 * `wireAppProvider()`'s patch of the app entry, composed here before any write: that function
 * writes as it goes and only warns on a failure, where a policy nothing registers would read
 * as scaffolded while the gate denies every ability for want of it.
 */
async function registerProviders(root: string, providers: readonly string[]): Promise<{ entry: string | null; content?: string; refusals: string[] }> {
  if (providers.length === 0) return { entry: null, refusals: [] }
  const entry = await resolveAppEntry(root)
  if (entry === null) return { entry, refusals: [`${providers.join(', ')} would be registered in createApp(), and this application has neither src/app.ts nor app.ts.`] }
  let content = (await readIfExists(root, entry)) ?? ''
  const refusals: string[] = []
  for (const provider of providers) {
    const { wiring, content: patched } = composeAppProviderRegistration(content, entry, provider)
    if (!wiring.registered) refusals.push(`${provider} cannot be registered in ${entry}: ${wiring.entry.reason}.`)
    else if (!wiring.entry.modified) refusals.push(`${entry} already registers ${provider}.`)
    content = patched ?? content
  }
  return { entry, content, refusals }
}

export function formatPlanScaffold(report: PlanScaffoldReport, planArgument: string): string {
  const lines = [`${report.plan.title} (${report.plan.file}): scaffolded ${report.step}`, '']
  if (report.created.length > 0) lines.push('Created:', ...report.created.map((file) => `  ${file}`))
  if (report.appended.tables.length > 0) lines.push(`Appended to ${report.appended.file}: ${report.appended.tables.join(', ')}`)
  if (report.registered.providers.length > 0) lines.push(`Registered in ${report.registered.file}: ${report.registered.providers.join(', ')}`)
  if (report.emitted.length > 0) lines.push('', `Elements written: ${report.emitted.join(', ')}`)
  if (report.left.length > 0) {
    lines.push('', 'Not written by plan:scaffold; the http step writes these by hand:')
    lines.push(...report.left.map((element) => `  ${element.id} (${element.section})${element.reason ? `: ${element.reason}` : ''}`))
  }
  if (report.unwritten.length > 0) {
    lines.push('', 'Written as a stub or not at all, to finish in the http step:')
    lines.push(...report.unwritten.map((entry) => `  ${entry.element} ${entry.detail}: ${entry.reason}`))
  }
  if (report.omitted.length > 0) {
    lines.push('', 'Relationships left out of the model, to add once what they need exists; until then plan:status reads the model as drifted:')
    lines.push(...report.omitted.map((entry) => `  ${entry.model} ${entry.relationship}: ${entry.reason}`))
  }
  lines.push('', `No codegen or migration was run. Next: bunx guren plan:verify ${planArgument} --step ${report.step}, and commit once it is verified.`)
  return lines.join('\n')
}
