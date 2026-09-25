/**
 * `guren plan:scaffold` (RFC 0030 §5, Part 3 item 6): writes what `plan/scaffold.ts` emits for
 * one scaffold step of an approved plan, the step `plan:next` has marked, and registers each
 * policy provider in `createApp()`; with `--mount`, from the http step, it calls the routes file
 * that scaffold wrote from the entry registrar. Every refusal is decided before the first write,
 * so a refused run leaves the application as it was, and a re-run over a scaffolded step is
 * refused on the targets it already wrote. It runs no codegen and no migration: those are `plan:verify`'s.
 */

import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { File } from '@babel/types'

import { isConfirmedApiOnlyApp } from './app-surface'
import { CliError } from './cli-error'
import {
  classNameFromPath,
  discoverControllerFiles,
  discoverPolicyFiles,
  discoverResourceFiles,
  discoverSideEffectFiles,
  discoverValidatorFiles,
  excludeBarrelFiles,
  moduleNameFor,
  readIfExists,
  SIDE_EFFECT_DIRS,
  toPosixRelative,
  type SideEffectKind,
} from './discovery'
import { DIALECT_BARRELS } from './drizzle-specifiers'
import { discoverModelClasses } from './model-parser'
import { parseSourceFile, ParseCache } from './parse-cache'
import { appendTableToSchema, detectSchemaDialect, ensureNamedImports } from './patch-helpers'
import { readPlanFile } from './plan-render'
import { exportedNames } from './plan/app-detail'
import { requirePlanApproval } from './plan/approvals'
import { writeFileAtomic } from './plan/beside'
import { entityDocPath } from './plan/close-docs'
import { emitPlanScaffold, planScaffoldMountCommandLine, planScaffoldMounts, type PlanScaffoldMount, type PlanScaffoldOutput } from './plan/scaffold'
import { importSpecifier } from './plan/scaffold-controller'
import type { Plan } from './plan/schema'
import { planSlug, readPlanState } from './plan/state'
import { derivePlanTasks, findPlanStep, listPlanSteps, type PlanTaskDerivation } from './plan/tasks'
import { composeAppProviderRegistration, resolveAppEntry } from './provider-registrar'
import { composeRouteRegistrarCall, resolveRoutesEntry } from './route-registrar'
import { isRoutesFileMounted } from './routes-check'
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
  /** The routes file written unmounted, and the http step that mounts it with `--mount`; null when the step writes none. */
  unmounted: { file: string; registrar: string; step: string } | null
}

export interface PlanScaffoldFileOptions {
  appRoot: string
  step: string
  cwd?: string
}

/** How a refusal of each form ends, and what the approval gate says of an unapproved plan. */
interface Outcome {
  refused: string
  approval: string
}

const SCAFFOLD: Outcome = { refused: 'Nothing was scaffolded.', approval: 'nothing is scaffolded from it' }
const MOUNT: Outcome = { refused: 'Nothing was mounted.', approval: 'nothing is mounted from it' }

function refuse(lines: string[], outcome: Outcome = SCAFFOLD): never {
  throw new CliError(`${lines.join('\n')}\n${outcome.refused}`)
}

function refuseMount(lines: string[]): never {
  refuse(lines, MOUNT)
}

/** The approval gate, and the refusal of an API-only application, which derivation gives no scaffold step. */
async function approvedPlan(planPath: string, options: PlanScaffoldFileOptions, outcome: Outcome): Promise<{ path: string; plan: Plan; hash: string }> {
  const { path, plan } = await readPlanFile(planPath, options.cwd)
  const approval = await requirePlanApproval(path, plan, outcome.approval)
  if (!approval) {
    refuse([`${basename(path)} is a draft: plan:scaffold writes code from an approved plan only. Run guren plan:approve ${planPath} first.`], outcome)
  }
  if (await isConfirmedApiOnlyApp(options.appRoot).catch(() => false)) {
    refuse(['This application is API-only, so its plans have no scaffold step: plan:scaffold writes a model for an application that renders Inertia pages.'], outcome)
  }
  return { path, plan: plan as Plan, hash: approval.hash }
}

/** One step is one commit, measured from where plan:next marked it (plan/work.ts), and plan:next accepts a dirty tree only as the marked step's own work. */
async function requireMark(root: string, path: string, planPath: string, stepId: string, outcome: Outcome): Promise<void> {
  const active = (await readPlanState(root, planSlug(path))).state?.active
  if (active?.step === stepId) return
  refuse([
    `${stepId} is not the step plan:next marked${active ? ` (it marked ${active.step})` : ''}. Run guren plan:next ${planPath} first:`,
    '  it marks the step, so what plan:scaffold writes counts as that step’s work.',
  ], outcome)
}

/** Where to go instead of a step that is no scaffold step: its `--mount` form, the task's own scaffold step, or the plan's. */
function scaffoldStepHint(plan: Plan, derivation: PlanTaskDerivation, planPath: string, stepId: string, found: ReturnType<typeof findPlanStep>): string {
  if (planScaffoldMounts(plan, derivation).some((mount) => mount.httpStep === stepId)) {
    return `To mount the routes its scaffold step wrote, run ${planScaffoldMountCommandLine(planPath, stepId)}.`
  }
  const own = found?.task.steps.find((step) => step.kind === 'scaffold')
  if (own) return `The scaffold step of ${found?.task.id} is ${own.id}.`
  const scaffoldSteps = listPlanSteps(derivation).filter(({ step }) => step.kind === 'scaffold').map(({ step }) => step.id)
  return scaffoldSteps.length > 0 ? `Its scaffold steps: ${scaffoldSteps.join(', ')}.` : 'The plan has no scaffold step.'
}

/** The root entity documents that exist, which a `@docs` tag may name without failing `guren check`. */
async function existingEntityDocs(root: string, plan: Plan): Promise<string[]> {
  const docs = plan.models.filter((model) => !model.module).map(entityDocPath)
  const exists = await Promise.all(docs.map((doc) => pathExists(resolve(root, doc))))
  return docs.filter((_, index) => exists[index])
}

export async function planScaffoldFile(planPath: string, options: PlanScaffoldFileOptions): Promise<PlanScaffoldReport> {
  const { path, plan, hash } = await approvedPlan(planPath, options, SCAFFOLD)
  const root = options.appRoot

  const derivation = derivePlanTasks(plan)
  const found = findPlanStep(derivation, options.step)
  if (!found || found.step.kind !== 'scaffold') {
    refuse([`${options.step} is ${found ? `a ${found.step.kind} step` : 'no step of the plan'}, and plan:scaffold writes a scaffold step only. ${scaffoldStepHint(plan, derivation, planPath, options.step, found)}`])
  }
  const { step } = found
  await requireMark(root, path, planPath, step.id, SCAFFOLD)

  const schemaPath = schemaPathFor(null)
  const schema = await readIfExists(root, schemaPath)
  if (schema === null) refuse([`plan:scaffold appends tables to ${schemaPath}, which this application does not have.`])
  const dialect = detectSchemaDialect(schema)
  const tables = await parseSchemaTables(root)
  const cache = new ParseCache()
  const models = (await discoverModelClasses(root, cache)).filter((model) => model.module === null)
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
    models: models.map((model) => model.className),
    validators: Object.keys(validators.files),
    resources: await rootClassNames(root, discoverResourceFiles),
    policies: await rootClassNames(root, discoverPolicyFiles),
    controllers: await rootClassNames(root, discoverControllerFiles),
    sideEffects: Object.fromEntries(
      await Promise.all((Object.keys(SIDE_EFFECT_DIRS) as SideEffectKind[]).map(async (kind) => [kind, await rootClassNames(root, (appRoot) => discoverSideEffectFiles(appRoot, kind))] as const)),
    ),
    modelFiles: Object.fromEntries(models.map((model) => [model.className, toPosixRelative(root, model.filePath)])),
    validatorFiles: validators.files,
    docs: await existingEntityDocs(root, plan),
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
    if (registration.entry !== null) {
      writing = registration.entry
      await writeFileAtomic(resolve(root, registration.entry), registration.content)
      written.push(registration.entry)
    }
  } catch (error) {
    if (written.length === 0) throw error
    const failing = failedWrite(writing, written, registration, output.providers)
    throw new CliError(
      `plan:scaffold stopped part way through ${step.id}: ${error instanceof Error ? error.message : String(error)}\n`
        + `Already written: ${written.join(', ')}.${failing} The step is half scaffolded, and running plan:scaffold again refuses on these files.\n`
        + 'Fix the cause, restore them (git checkout / git clean on those paths), and run plan:scaffold again.',
    )
  }

  return {
    reportVersion: PLAN_SCAFFOLD_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash },
    step: step.id,
    created,
    appended: { file: schemaPath, tables: output.tables.map((table) => table.identifier) },
    registered: { file: registration.entry, providers: output.providers },
    unmounted: unmountedRoutes(plan, derivation, step.id, created),
    emitted: output.emitted,
    left: output.left,
    omitted: output.omitted,
    unwritten: output.unwritten,
  }
}

/** What the write that threw left behind, for the partial-write message. */
function failedWrite(writing: string | undefined, written: readonly string[], registration: ProviderRegistration, providers: readonly string[]): string {
  if (!writing || written.includes(writing)) return ''
  // The entry is written atomically, so a failure leaves it as it was.
  if (writing === registration.entry) {
    return ` ${writing} was left unchanged, so ${providers.join(', ')} ${providers.length === 1 ? 'is' : 'are'} not registered.`
  }
  // A `wx` write that fails after opening leaves the file behind, possibly empty.
  return ` ${writing} failed and may exist, part written.`
}

/**
 * The names the root's validator files export, with the file each is in: a planned validator must
 * not take one (`plan:status` finds a validator by its name), and a controller imports one from there.
 */
async function rootValidatorExports(root: string, cache: ParseCache): Promise<{ files: Record<string, string> } | { unreadable: string }> {
  const files: Record<string, string> = {}
  for (const filePath of excludeBarrelFiles(await discoverValidatorFiles(root))) {
    if (moduleNameFor(root, filePath) !== null) continue
    const file = toPosixRelative(root, filePath)
    const parsed = await cache.get(filePath)
    const exported = parsed ? exportedNames(parsed.ast, 'this file') : null
    if (exported === null) return { unreadable: `${file} could not be read for its exports` }
    for (const name of exported) files[name] ??= file
  }
  return { files }
}

async function rootClassNames(root: string, discover: (appRoot: string) => Promise<string[]>): Promise<string[]> {
  const files = excludeBarrelFiles(await discover(root))
  return files.filter((file) => moduleNameFor(root, file) === null).map(classNameFromPath)
}

/**
 * `wireAppProvider()`'s patch of the app entry, composed here before any write: that function
 * writes as it goes and only warns on a failure, where a policy nothing registers would read
 * as scaffolded while the gate denies every ability for want of it.
 */
type ProviderRegistration = { entry: null; refusals: string[] } | { entry: string; content: string; refusals: string[] }

async function registerProviders(root: string, providers: readonly string[]): Promise<ProviderRegistration> {
  if (providers.length === 0) return { entry: null, refusals: [] }
  const entry = await resolveAppEntry(root)
  if (entry === null) return { entry, refusals: [`${providers.join(', ')} would be registered in createApp(), and this application has neither src/app.ts nor app.ts.`] }
  let content = await readFile(resolve(root, entry), 'utf8')
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
  if (report.unmounted) {
    const { file, step } = report.unmounted
    lines.push('', `${file} is not mounted, so its routes answer nothing until the http step ${step} runs ${planScaffoldMountCommandLine(planArgument, step)}.`)
  }
  lines.push('', `No codegen or migration was run. Next: bunx guren plan:verify ${planArgument} --step ${report.step}, and commit once it is verified.`)
  return lines.join('\n')
}

export interface PlanScaffoldMountReport {
  reportVersion: typeof PLAN_SCAFFOLD_REPORT_VERSION
  plan: { file: string; title: string; hash: string }
  step: string
  /** The routes file the scaffold step wrote, the registrar it exports, and the entry registrar that now calls it first. */
  mounted: { file: string; registrar: string; entry: string }
}

/**
 * `plan:scaffold --mount` from the http step (D3): one `wireRouteRegistrar()` call, composed as
 * `composeRouteRegistrarCall()` so every refusal comes first, and the entry written atomically.
 * Mounted is `guren check`'s own reach from the entry, so a file another routes file calls is refused.
 */
export async function planScaffoldMountFile(planPath: string, options: PlanScaffoldFileOptions): Promise<PlanScaffoldMountReport> {
  const { path, plan, hash } = await approvedPlan(planPath, options, MOUNT)
  const root = options.appRoot
  const derivation = derivePlanTasks(plan)
  const found = findPlanStep(derivation, options.step)
  const mounts = planScaffoldMounts(plan, derivation)
  const mount = mounts.find((candidate) => candidate.httpStep === options.step)
  if (!found || !mount) {
    refuseMount([`${options.step} is ${found ? `a ${found.step.kind} step` : 'no step of the plan'} that mounts no routes file: ${describeMounts(mounts)}`])
  }
  await requireMark(root, path, planPath, options.step, MOUNT)

  const content = await readIfExists(root, mount.path)
  if (content === null) {
    refuseMount([`Nothing to mount: ${mount.path} does not exist. plan:scaffold ${planPath} --step ${mount.scaffoldStep} writes it.`])
  }
  const parsed = parseSourceFile(content, mount.path)
  const exported = parsed ? exportedNames(parsed, 'anywhere') : null
  if (!exported?.includes(mount.registrar)) {
    refuseMount([`${mount.path} ${parsed ? `no longer exports ${mount.registrar}` : 'does not parse'}, which --mount calls. Restore it (git checkout ${mount.path}) or mount it by hand.`])
  }
  const entry = await resolveRoutesEntry(root)
  if (entry === null) refuseMount([`This application has no routes entry (routes/web.ts) to call ${mount.registrar} from.`])

  if (await isRoutesFileMounted(root, mount.path)) refuseMount([`${mount.path} is already mounted: ${entry} reaches ${mount.registrar}.`])
  const entryContent = await readFile(resolve(root, entry), 'utf8')
  const entryAst = parseSourceFile(entryContent, entry)
  if (entryAst && topLevelBindings(entryAst).has(mount.registrar)) {
    refuseMount([`${entry} already declares or imports ${mount.registrar}, so the call --mount adds would not reach ${mount.path}. Mount it by hand under an alias.`])
  }
  const composed = composeRouteRegistrarCall(entryContent, entry, mount.registrar, `import { ${mount.registrar} } from '${importSpecifier(entry, mount.path)}'`)
  if (composed.content === undefined) refuseMount([`${mount.registrar} cannot be called from ${entry}: ${composed.reason}.`])

  await writeFileAtomic(resolve(root, entry), composed.content)
  return {
    reportVersion: PLAN_SCAFFOLD_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash },
    step: options.step,
    mounted: { file: mount.path, registrar: mount.registrar, entry },
  }
}

/** Names a module's top-level scope binds: an import, a function, a class or a variable of the same name shadows the one `--mount` imports. */
function topLevelBindings(ast: File): Set<string> {
  const names = new Set<string>()
  for (const node of ast.program.body) {
    const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node
    if (declaration?.type === 'ImportDeclaration') for (const specifier of declaration.specifiers) names.add(specifier.local.name)
    else if ((declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') && declaration.id) names.add(declaration.id.name)
    else if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) if (declarator.id.type === 'Identifier') names.add(declarator.id.name)
    }
  }
  return names
}

function unmountedRoutes(plan: Plan, derivation: PlanTaskDerivation, stepId: string, created: readonly string[]): PlanScaffoldReport['unmounted'] {
  const mount = planScaffoldMounts(plan, derivation).find((candidate) => candidate.scaffoldStep === stepId)
  return mount && created.includes(mount.path) ? { file: mount.path, registrar: mount.registrar, step: mount.httpStep } : null
}

function describeMounts(mounts: readonly PlanScaffoldMount[]): string {
  if (mounts.length === 0) return 'the plan’s scaffold steps write no routes file.'
  return `--mount runs from the http step holding a scaffolded routes file: ${mounts.map((mount) => `${mount.httpStep} (${mount.path})`).join(', ')}.`
}

export function formatPlanScaffoldMount(report: PlanScaffoldMountReport, planArgument: string): string {
  const { file, registrar, entry } = report.mounted
  return [
    `${report.plan.title} (${report.plan.file}): mounted ${file} for ${report.step}`,
    '',
    `${entry} now calls ${registrar}() first, so its routes are registered.`,
    'The controller actions still answer 501: write their bodies and responses, then run',
    `  bunx guren plan:verify ${planArgument} --step ${report.step}, and commit once it is verified.`,
  ].join('\n')
}
