/**
 * `guren browser:record` (RFC 0033 §7): the one writer of a verification run's `run.json`.
 * A step is opened (the runtime-error head is taken) and closed with the recorder's account,
 * which is kept apart from what this process measured: the screenshots' digests and the error
 * window. The recorder's result can only be lowered here, by an error or an unreadable window.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

import { CliError } from './cli-error'
import { writeFileAtomic } from './plan/beside'
import { drainRuntimeErrors, judgeWindow, type Drained, type RuntimeErrorEvent, type RuntimeErrorRead } from './runtime-error-window'
import { runtimeOrigin } from './runtime-errors'
import { slugifyProse } from './utils'

export const BROWSER_RUNS_DIR = '.guren/browser'
const RUN_FILE = 'run.json'
const ERRORS_FILE = 'runtime-errors.json'
const SCREENSHOTS_DIR = 'screenshots'

const cursorSchema = z.union([
  z.object({ status: z.literal('available'), sessionId: z.string(), after: z.number().int(), dropped: z.number().int() }),
  z.object({ status: z.literal('unavailable'), reason: z.string() }),
])

/** What the agent or a spec reports for a step; any other field is refused rather than kept unread. */
export const recorderInputSchema = z.strictObject({
  result: z.enum(['pass', 'fail', 'inconclusive']),
  action: z.string().min(1),
  landed: z.strictObject({ url: z.string(), component: z.string().optional() }).optional(),
  errorsShown: z.array(z.string()).optional(),
  database: z.array(z.strictObject({ table: z.string(), has: z.unknown().optional(), missing: z.unknown().optional(), found: z.boolean() })).optional(),
  screenshots: z.array(z.string()).default([]),
})
export type RecorderInput = z.infer<typeof recorderInputSchema>

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
  open: z.record(z.string(), cursorSchema),
})
export type BrowserRun = z.infer<typeof runSchema>

export interface RecordDeps {
  readErrors: RuntimeErrorRead
  /** The graph snapshot id the run is judged against, or null when the graph could not be read. */
  graphSnapshot: () => Promise<string | null>
  commit: () => Promise<BrowserRun['commit']>
  now: () => Date
}

function runDir(cwd: string, run: string): string {
  if (!/^[\w.-]+$/u.test(run)) throw new CliError(`${run} is not a run name browser:record --begin wrote.`)
  return join(cwd, BROWSER_RUNS_DIR, run)
}

async function readRun(cwd: string, run: string): Promise<BrowserRun> {
  const path = join(runDir(cwd, run), RUN_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new CliError(`No run ${run}: start one with browser:record --begin.`)
  }
  const parsed = runSchema.safeParse(JSON.parse(text))
  if (!parsed.success) throw new CliError(`${path} is not a run browser:record wrote; it was edited by hand or by another version.`)
  return parsed.data
}

async function writeRun(cwd: string, run: BrowserRun): Promise<void> {
  await writeFileAtomic(join(runDir(cwd, run.run), RUN_FILE), `${JSON.stringify(run, null, 2)}\n`)
}

/** The runs directory, ignoring itself and everything in it, as `.guren/plans/` does. */
async function runsDirectory(cwd: string): Promise<void> {
  const dir = join(cwd, BROWSER_RUNS_DIR)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'w' })
}

export async function beginRun(cwd: string, options: { url: string; feature: string }, deps: RecordDeps): Promise<BrowserRun> {
  const origin = runtimeOrigin(options.url).origin
  await runsDirectory(cwd)
  const stamp = deps.now().toISOString().replace(/\.\d+Z$/u, 'Z').replaceAll(':', '-')
  const base = `${stamp}-${slugifyProse(options.feature, '-', 'feature')}`
  let name = base
  for (let n = 2; await stat(join(cwd, BROWSER_RUNS_DIR, name)).then(() => true, () => false); n++) name = `${base}-${n}`
  await mkdir(join(cwd, BROWSER_RUNS_DIR, name, SCREENSHOTS_DIR), { recursive: true })
  const run: BrowserRun = {
    schemaVersion: 1, run: name, origin, feature: options.feature,
    graphSnapshot: await deps.graphSnapshot(), commit: await deps.commit(), steps: [], open: {},
  }
  await writeRun(cwd, run)
  return run
}

export async function openStep(cwd: string, name: string, step: string, deps: RecordDeps): Promise<BrowserRun> {
  const run = await readRun(cwd, name)
  if (run.steps.some((entry) => entry.id === step)) throw new CliError(`Step ${step} is already recorded in ${name}.`)
  if (run.open[step]) throw new CliError(`Step ${step} is already open in ${name}; close it first.`)
  const head = await drainRuntimeErrors(deps.readErrors, run.origin, {})
  run.open[step] = head.status === 'available'
    ? { status: 'available', sessionId: head.sessionId, after: head.head.after ?? 0, dropped: head.dropped }
    : { status: 'unavailable', reason: head.reason }
  await writeRun(cwd, run)
  return run
}

/** Each screenshot as a path inside the run's `screenshots/`, with its digest; refuses anything else. */
async function screenshotDigests(dir: string, paths: readonly string[]): Promise<BrowserStep['cli']['screenshots']> {
  const root = join(dir, SCREENSHOTS_DIR)
  const digests: BrowserStep['cli']['screenshots'] = []
  for (const path of paths) {
    const absolute = resolve(dir, path)
    if (!absolute.startsWith(`${root}${sep}`)) throw new CliError(`Screenshot ${path} is outside ${relative(process.cwd(), root)}; save it there.`)
    let bytes: Buffer
    try {
      bytes = await readFile(absolute)
    } catch {
      throw new CliError(`Screenshot ${path} does not exist in the run.`)
    }
    digests.push({ path: relative(dir, absolute).split(sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex') })
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
  const run = await readRun(cwd, name)
  const opened = run.open[step]
  if (!opened) throw new CliError(`Step ${step} was never opened in ${name}; run browser:record ${name} --step ${step} --open before it.`)
  const parsed = recorderInputSchema.safeParse(input)
  if (!parsed.success) throw new CliError(`The step input is not what browser:record reads: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`)
  const { screenshots, ...recorder } = parsed.data
  const dir = runDir(cwd, name)
  const digests = await screenshotDigests(dir, screenshots)

  const start: Drained = opened.status === 'available'
    ? { status: 'available', sessionId: opened.sessionId, head: { sessionId: opened.sessionId, after: opened.after }, dropped: opened.dropped, expired: false, events: [] }
    : opened
  const window = judgeWindow(start, start.status === 'available' ? await drainRuntimeErrors(deps.readErrors, run.origin, start.head) : start)
  if (window.events.length > 0) await appendEvents(dir, window.events)

  const verdict = lowerResult(recorder.result, window)
  const record: BrowserStep = {
    id: step, result: verdict.result, ...(verdict.lowered ? { lowered: verdict.lowered } : {}), recorder,
    cli: { screenshots: digests, runtimeErrors: { window: window.status, ...(window.reason ? { reason: window.reason } : {}), events: window.events.length } },
  }
  delete run.open[step]
  run.steps.push(record)
  await writeRun(cwd, run)
  return record
}

async function appendEvents(dir: string, events: readonly RuntimeErrorEvent[]): Promise<void> {
  const path = join(dir, ERRORS_FILE)
  const existing = await readFile(path, 'utf8').then((text) => JSON.parse(text) as unknown[], () => [])
  await writeFileAtomic(path, `${JSON.stringify([...existing, ...events], null, 2)}\n`)
}

/** Writes a doctor report into a run `browser:record --begin` created. */
export async function writeDoctorEvidence(cwd: string, name: string, report: unknown): Promise<void> {
  await readRun(cwd, name)
  await writeFileAtomic(join(runDir(cwd, name), 'doctor.json'), `${JSON.stringify(report, null, 2)}\n`)
}
