/**
 * `guren browser:record` (RFC 0033 §7): the one writer of a verification run's `run.json`.
 * A step is opened (the runtime-error head is taken) and closed with the recorder's account,
 * which is kept apart from what this process measured: the screenshots' digests and the error
 * window. The recorder's result can only be lowered here, by an error or an unreadable window.
 * Commands are read-modify-write without a lock, so steps of one run are recorded one at a time.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'

import { CliError, formatSchemaIssues } from './cli-error'
import { readBesideRecord, writeFileAtomic } from './plan/beside'
import { sha256 } from './plan/verification'
import { resolveInside } from './plugin-manifest'
import { readWindowStart, windowSince, type RuntimeErrorEvent, type RuntimeErrorRead } from './runtime-error-window'
import { runtimeOrigin } from './runtime-errors'
import { slugifyProse } from './utils'

export const BROWSER_RUNS_DIR = '.guren/browser'
const RUN_FILE = 'run.json'
const ERRORS_FILE = 'runtime-errors.json'
const SCREENSHOTS_DIR = 'screenshots'
/** Only the names `--begin` writes: a stamp and a slug, so no name leaves the runs directory. */
const RUN_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[a-z0-9-]+$/u
/** An acceptance id or a charter slug; never a key `Object.prototype` already holds. */
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u

const windowStartSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), head: z.object({ sessionId: z.string(), after: z.number().int() }), dropped: z.number().int() }),
  z.object({ status: z.literal('unavailable'), reason: z.string() }),
])

/** What the agent or a spec reports for a step; any other field is refused rather than kept unread. */
const recorderInputSchema = z.strictObject({
  result: z.enum(['pass', 'fail', 'inconclusive']),
  action: z.string().min(1),
  landed: z.strictObject({ url: z.string(), component: z.string().optional() }).optional(),
  errorsShown: z.array(z.string()).optional(),
  database: z.array(z.strictObject({ table: z.string(), has: z.unknown().optional(), missing: z.unknown().optional(), found: z.boolean() })).optional(),
  screenshots: z.array(z.string()).default([]),
})
type RecorderInput = z.infer<typeof recorderInputSchema>

const stepSchema = z.object({
  id: z.string(),
  result: z.enum(['pass', 'fail', 'inconclusive']),
  lowered: z.string().optional(),
  recorder: recorderInputSchema.omit({ screenshots: true }),
  cli: z.object({
    screenshots: z.array(z.object({ path: z.string(), sha256: z.string() })),
    runtimeErrors: z.object({ window: z.enum(['conclusive', 'inconclusive', 'unavailable']), reason: z.string().optional(), events: z.number().int() }),
  }),
})
export type BrowserStep = z.infer<typeof stepSchema>

const runSchema = z.object({
  schemaVersion: z.literal(1),
  run: z.string(),
  origin: z.string(),
  feature: z.string(),
  graphSnapshot: z.string().nullable(),
  commit: z.object({ rev: z.string(), dirty: z.boolean() }).nullable(),
  steps: z.array(stepSchema),
  open: z.record(z.string(), windowStartSchema),
})
type BrowserRun = z.infer<typeof runSchema>

const eventsSchema = z.array(z.object({ sessionId: z.string(), sequence: z.number().int() }).passthrough())

export interface RecordDeps {
  readErrors: RuntimeErrorRead
  /** The graph snapshot id the run is judged against, or null when the graph could not be read. */
  graphSnapshot: () => Promise<string | null>
  commit: () => Promise<BrowserRun['commit']>
  now: () => Date
}

function runDir(cwd: string, run: string): string {
  if (!RUN_NAME.test(run)) throw new CliError(`${run} is not a run name browser:record --begin wrote.`)
  return join(resolve(cwd), BROWSER_RUNS_DIR, run)
}

function stepId(step: string): string {
  if (!STEP_ID.test(step) || step in Object.prototype) throw new CliError(`${step} is not a step id: use an acceptance id or a charter slug (letters, digits, _ . : -).`)
  return step
}

export async function readRun(cwd: string, name: string): Promise<BrowserRun> {
  const path = join(runDir(cwd, name), RUN_FILE)
  const read = await readBesideRecord(path, runSchema, 'browser run')
  if (read.unreadable) throw new CliError(read.unreadable)
  if (!read.value) throw new CliError(`No run ${name}: start one with browser:record --begin.`)
  if (read.value.run !== name) throw new CliError(`${path} names run ${read.value.run}; it was copied from another run.`)
  return read.value
}

async function writeRun(cwd: string, run: BrowserRun): Promise<void> {
  await writeFileAtomic(join(runDir(cwd, run.run), RUN_FILE), `${JSON.stringify(run, null, 2)}\n`)
}

/** The runs directory, ignoring itself and everything in it; a `.gitignore` already there is kept. */
async function runsDirectory(cwd: string): Promise<void> {
  const dir = join(resolve(cwd), BROWSER_RUNS_DIR)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
}

export async function beginRun(cwd: string, options: { url: string; feature: string }, deps: RecordDeps): Promise<BrowserRun> {
  const origin = runtimeOrigin(options.url).origin
  await runsDirectory(cwd)
  const stamp = deps.now().toISOString().replace(/\.\d+Z$/u, 'Z').replaceAll(':', '-')
  const base = `${stamp}-${slugifyProse(options.feature, '-', 'feature')}`
  let name = base
  // Not recursive, so a name another --begin took in the same second is skipped rather than shared.
  for (let n = 2; ; n++) {
    try {
      await mkdir(runDir(cwd, name))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      name = `${base}-${n}`
    }
  }
  await mkdir(join(runDir(cwd, name), SCREENSHOTS_DIR))
  const [graphSnapshot, commit] = await Promise.all([deps.graphSnapshot(), deps.commit()])
  const run: BrowserRun = { schemaVersion: 1, run: name, origin, feature: options.feature, graphSnapshot, commit, steps: [], open: {} }
  await writeRun(cwd, run)
  return run
}

export async function openStep(cwd: string, name: string, step: string, deps: RecordDeps): Promise<void> {
  const id = stepId(step)
  const run = await readRun(cwd, name)
  if (run.steps.some((entry) => entry.id === id)) throw new CliError(`Step ${id} is already recorded in ${name}; a step is recorded once, so retry under a new step id or a new run.`)
  if (Object.hasOwn(run.open, id)) throw new CliError(`Step ${id} is already open in ${name}; close it first.`)
  run.open[id] = await readWindowStart(deps.readErrors, run.origin)
  await writeRun(cwd, run)
}

/** Each screenshot as a path inside the run's `screenshots/`, links resolved, with its digest; refuses anything else. */
async function screenshotDigests(dir: string, paths: readonly string[]): Promise<BrowserStep['cli']['screenshots']> {
  const root = join(dir, SCREENSHOTS_DIR)
  const digests: BrowserStep['cli']['screenshots'] = []
  for (const path of paths) {
    const inside = isAbsolute(path) ? null : relative(root, resolve(dir, path))
    const target = inside ? await resolveInside(root, inside) : null
    if (!target) throw new CliError(`Screenshot ${path} is not a file inside the run's ${SCREENSHOTS_DIR}/; save it there and name it relative to the run.`)
    let bytes: Buffer
    try {
      bytes = await readFile(target)
    } catch {
      throw new CliError(`Screenshot ${path} does not exist in the run.`)
    }
    digests.push({ path: relative(dir, target).split('\\').join('/'), sha256: sha256(bytes) })
  }
  return digests
}

/** The recorder's result after this process lowers it; the reason when it did. */
export function lowerResult(result: RecorderInput['result'], window: { status: string; events: readonly unknown[] }): { result: RecorderInput['result']; lowered?: string } {
  if (window.events.length > 0 && result !== 'fail') return { result: 'fail', lowered: `${window.events.length} server error(s) during the step.` }
  if (window.status !== 'conclusive' && result === 'pass') return { result: 'inconclusive', lowered: `The runtime-error window is ${window.status}.` }
  return { result }
}

export async function closeStep(cwd: string, name: string, step: string, input: unknown, deps: RecordDeps): Promise<BrowserStep> {
  const id = stepId(step)
  const run = await readRun(cwd, name)
  if (run.steps.some((entry) => entry.id === id)) throw new CliError(`Step ${id} is already recorded in ${name}.`)
  if (!Object.hasOwn(run.open, id)) throw new CliError(`Step ${id} was never opened in ${name}; run browser:record ${name} --step ${id} --open before it.`)
  const parsed = recorderInputSchema.safeParse(input)
  if (!parsed.success) throw new CliError(`The step input is not what browser:record reads:\n${formatSchemaIssues(parsed.error)}`)
  const { screenshots, ...recorder } = parsed.data
  const dir = runDir(cwd, name)
  const digests = await screenshotDigests(dir, screenshots)

  const window = await windowSince(deps.readErrors, run.origin, run.open[id]!)
  if (window.events.length > 0) await appendEvents(dir, window.events)

  const record: BrowserStep = {
    id, ...lowerResult(recorder.result, window), recorder,
    cli: { screenshots: digests, runtimeErrors: { window: window.status, ...(window.reason ? { reason: window.reason } : {}), events: window.events.length } },
  }
  delete run.open[id]
  run.steps.push(record)
  await writeRun(cwd, run)
  return record
}

/** Appended by session and sequence, so a retry after a failed run write records no event twice. */
async function appendEvents(dir: string, events: readonly RuntimeErrorEvent[]): Promise<void> {
  const path = join(dir, ERRORS_FILE)
  const read = await readBesideRecord(path, eventsSchema, 'runtime errors')
  if (read.unreadable) throw new CliError(read.unreadable)
  const existing = read.value ?? []
  const seen = new Set(existing.map((event) => `${event.sessionId}:${event.sequence}`))
  const added = events.filter((event) => !seen.has(`${event.sessionId}:${event.sequence}`))
  await writeFileAtomic(path, `${JSON.stringify([...existing, ...added], null, 2)}\n`)
}

/** Refuses a run that was never begun or that names another origin, before the doctor's report is filed there. */
export async function writeDoctorEvidence(cwd: string, name: string, report: { origin: string }): Promise<void> {
  const run = await readRun(cwd, name)
  if (run.origin !== report.origin) throw new CliError(`Run ${name} is against ${run.origin}, not ${report.origin}; the report is not filed there.`)
  await writeFileAtomic(join(runDir(cwd, name), 'doctor.json'), `${JSON.stringify(report, null, 2)}\n`)
}
