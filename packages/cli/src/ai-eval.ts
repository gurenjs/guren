/**
 * `guren ai:eval` — run one eval against the real model (RFC 0029 §10).
 *
 * Opt-in: nothing in `guren check` or `guren gate` reaches it.
 * The eval file and the runner both resolve from the *app's* `@guren/plugin-ai`, so the
 * `defineEval()` that wrote the definition and the `runEval()` that reads it are one copy.
 * It emits data and prints where: the `.claude/hillclimb/` layout is the claude-api
 * harness's to read, and Guren vendors no viewer (RFC 0029 Open Question 7).
 */
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consola } from 'consola'

/** The runner's surface as this command calls it: the app's copy, resolved at run time. */
export interface EvalRunnerModule {
  runEval: (definition: unknown, options: Record<string, unknown>) => Promise<EvalRunResultLike>
  formatSummary: (summary: EvalSummaryLike) => string
}

export interface EvalSummaryLike {
  flow: string
  variant: string
  cases: number
  reps: number
  rows: number
  truncated: number
  failures: number
  metrics: Array<{ id: string; kind: string; mean: number; n: number; halfWidth?: number }>
  costUsd?: number
  durationMs: number
}

export interface EvalRunResultLike {
  summary: EvalSummaryLike
  failures: unknown[]
  location?: string
  plannedCases: Array<{ id: string }>
}

export interface AiEvalOptions {
  /** The eval's name: `tests/evals/<flow>.eval.ts` unless `file` names one. */
  flow: string
  file?: string
  /** Where `<flow>.eval.ts` is looked for. `tests/evals` when absent. */
  dir?: string
  appRoot?: string
  variant?: string
  reps?: number
  cases?: number
  maxCostUsd?: number
  concurrency?: number
  dryRun?: boolean
  json?: boolean
}

export interface AiEvalDependencies {
  /** Import the eval file and return its default export. */
  loadDefinition?: (path: string) => Promise<unknown>
  /** Import the app's `@guren/plugin-ai/eval`. */
  loadRunner?: () => Promise<EvalRunnerModule>
  /** Everything the command prints, so a test reads it instead of stdout. */
  print?: (line: string) => void
  warn?: (message: string) => void
}

const EVAL_DIR = 'tests/evals'
const EVAL_SUFFIXES = ['.eval.ts', '.eval.mts', '.eval.js', '.eval.mjs'] as const
const EVAL_KIND = 'guren.eval'

export async function runAiEval(options: AiEvalOptions, dependencies: AiEvalDependencies = {}): Promise<EvalRunResultLike> {
  const print = dependencies.print ?? ((line: string) => consola.log(line))
  const warn = dependencies.warn ?? ((message: string) => consola.warn(message))
  const appRoot = resolve(process.cwd(), options.appRoot ?? '.')
  const file = await resolveEvalFile(options, appRoot)
  const definition = await (dependencies.loadDefinition ?? importDefault)(file)

  if (typeof definition !== 'object' || definition === null || (definition as { kind?: unknown }).kind !== EVAL_KIND) {
    throw new Error(
      `${file} does not default-export a defineEval() result. An eval file ends with `
      + '`export default defineEval({ agent, app, cases, grade, metrics })`.',
    )
  }

  const runner = await loadRunner(dependencies.loadRunner)
  const result = await runner.runEval(definition, {
    flow: options.flow,
    ...defined('variant', options.variant),
    ...defined('reps', options.reps),
    ...defined('cases', options.cases),
    ...defined('maxCostUsd', options.maxCostUsd),
    ...defined('concurrency', options.concurrency),
    ...defined('dryRun', options.dryRun),
    onWarning: warn,
  })

  if (options.json) {
    print(JSON.stringify({ summary: result.summary, location: result.location, cases: result.plannedCases.length }, null, 2))
    return result
  }

  if (options.dryRun) {
    print(`${options.flow}: ${result.plannedCases.length} case(s) would run, ${result.summary.reps} rep(s) each. Nothing was called or written.`)
  } else {
    print(runner.formatSummary(result.summary))
  }
  if (result.location) {
    print(`\nResults: ${result.location}`)
    print('Read them with the claude-api harness\'s report builder and hillclimb, which own this layout; Guren ships no viewer.')
  }
  return result
}

async function resolveEvalFile(options: AiEvalOptions, appRoot: string): Promise<string> {
  if (options.file) {
    const absolute = resolve(appRoot, options.file)
    await assertReadable(absolute, `--file ${options.file}`)
    return absolute
  }

  const directory = resolve(appRoot, options.dir ?? EVAL_DIR)
  for (const suffix of EVAL_SUFFIXES) {
    const candidate = resolve(directory, `${options.flow}${suffix}`)
    if (await exists(candidate)) return candidate
  }
  throw new Error(
    `No eval named "${options.flow}": looked for ${EVAL_SUFFIXES.map((suffix) => `${options.flow}${suffix}`).join(', ')} `
    + `in ${directory}. Pass --file to name one elsewhere, or --dir to look somewhere else.`,
  )
}

async function importDefault(path: string): Promise<unknown> {
  const module = (await import(pathToFileURL(path).href)) as { default?: unknown }
  return module.default
}

async function loadRunner(importer?: () => Promise<EvalRunnerModule>): Promise<EvalRunnerModule> {
  try {
    return await (importer ?? (() => import('@guren/plugin-ai/eval') as Promise<unknown> as Promise<EvalRunnerModule>))()
  } catch (error) {
    throw new Error(
      '`guren ai:eval` runs the eval through @guren/plugin-ai/eval, and could not import it. '
      + 'Install the plugin in your app (`guren add ai`), or upgrade it to a release that ships the eval subpath.',
      { cause: error },
    )
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function assertReadable(path: string, label: string): Promise<void> {
  if (!(await exists(path))) throw new Error(`${label} does not exist: ${path}`)
}

function defined<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

/** `--reps 2` and friends arrive as strings from citty; a non-number must name itself. */
export function parseNumericArg(name: string, raw: unknown): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number, got ${JSON.stringify(raw)}.`)
  }
  return value
}
