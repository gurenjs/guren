/**
 * The CLI's reader of RFC 0026's manifest: spawns `introspect-child` under
 * `GUREN_INTROSPECT=1` with the app root as cwd, so Bun loads `.env` the way
 * `guren dev` does, and reads the result the child writes to a temp file.
 * Type-only against `@guren/server`: the app may resolve an older one.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { AppManifest, RouteEntry } from '@guren/server'

import { siblingEntry } from './cli-entry'
import { outputTail } from './command-output'
import type { ContractSegment } from './contract-segments'
import { bunExecutable, runCaptured } from './subprocess'

export type IntrospectionFailure = 'no-entry' | 'import' | 'timeout' | 'crashed' | 'old-server'

export type Introspection =
  | { status: 'ok'; manifest: AppManifest }
  | { status: 'failed'; reason: IntrospectionFailure; message: string }

export interface IntrospectOptions {
  /** Wall-clock cap on the child, after which it is killed and the run is `timeout`. */
  timeoutMs?: number
  /**
   * Run a new child rather than the process's memoised one: for a caller living longer than
   * one read of the app (the gate under the dev MCP server), which keeps its own per-run memo.
   */
  fresh?: boolean
  /**
   * The application graph's identity scans (RFC 0032): the child also imports model and validator
   * files to match bound models and contract schemas to their exports. Ordinary diagnostics keep
   * their import scope.
   */
  graph?: boolean
  /** Laid over the child's environment; a run given any is never memoised, since the key would not name it. */
  env?: Readonly<Record<string, string>>
  /**
   * Register the app without its env files: the child loads none (`--no-env-file`), and every name
   * they set is left out of what it inherits, since this process may have loaded them already. What
   * a machine's git-ignored `.env` turns on then reads alike on every machine. Never memoised.
   */
  withoutEnvFiles?: true
}

/**
 * The deploy target whose branch of the app's config the child registers (RFC 0035 §2.1):
 * `cloudflare` makes `isWorkersRuntime()` true there. Passed through `env`.
 */
export const INTROSPECT_TARGET_ENV = 'GUREN_INTROSPECT_TARGET'

/** The targets whose env subpath honours {@link INTROSPECT_TARGET_ENV}. */
export type IntrospectTarget = 'cloudflare'

/** Set to `1` beside `GUREN_INTROSPECT` for a {@link IntrospectOptions.graph} run. */
export const INTROSPECT_GRAPH_ENV = 'GUREN_INTROSPECT_GRAPH'

/** The warnings a graph run's identity scans add, by the relation whose identities they leave unread. */
export const GRAPH_SCAN_WARNINGS = { 'model-import': 'binds', 'validator-import': 'validates' } as const
export type GraphScanWarning = keyof typeof GRAPH_SCAN_WARNINGS

/** A route as the CLI's own child writes it: the server's fields, and the CLI's beside them. */
export type GraphRouteEntry = RouteEntry & {
  /**
   * Per contract segment the route declares, the validator-file exports its schema object *is*
   * (object identity, so a schema reached only from a call the app made). Empty: no export is it.
   */
  /** Graph runs only. */
  contractSources?: Partial<Record<ContractSegment, Array<{ file: string; exportName: string }>>>
  /**
   * Every run: the framework package whose export the routed controller class is (`@guren/core`),
   * so the class is outside the app by identity rather than unread.
   */
  controllerPackage?: string
}

export const DEFAULT_INTROSPECT_TIMEOUT_MS = 30_000

/** How far past the parent's cap the child's own budget runs, so a live parent always reports the `timeout`. */
export const INTROSPECT_CHILD_BUDGET_MARGIN_MS = 2_000

/**
 * The one cap for every command that judges the app: `check`, `audit`, `doctor`, the gate, `plan:verify`
 * and the deploy builds. One cap, or an app introspecting between two would fail `check --ci` and pass
 * the gate; short, since the gate runs on an agent's every stop. `guren introspect --timeout` diagnoses a slower app.
 */
export const CHECK_INTROSPECT_TIMEOUT_MS = 10_000

/**
 * How an in-process caller of `runCheck()` or `runAudit()` asks for the introspected app: `true`
 * for this process's memoised run under {@link CHECK_INTROSPECT_TIMEOUT_MS}, or a run of its own
 * that the caller shares between commands.
 */
export type IntrospectOption = boolean | (() => Promise<Introspection>)

/** The run {@link IntrospectOption} names, started at most once however often it is asked, or `undefined` for none. */
export function introspectRunner(cwd: string, option: () => Promise<Introspection>): () => Promise<Introspection>
export function introspectRunner(cwd: string, option: IntrospectOption | undefined): (() => Promise<Introspection>) | undefined
export function introspectRunner(cwd: string, option: IntrospectOption | undefined): (() => Promise<Introspection>) | undefined {
  const run = typeof option === 'function' ? option : option ? checkIntrospection(cwd) : undefined
  if (!run) return undefined
  let started: Promise<Introspection> | undefined
  return () => (started ??= run())
}

/** A run capped at {@link CHECK_INTROSPECT_TIMEOUT_MS}, for a command that judges the app. */
export function checkIntrospection(cwd: string, options: Pick<IntrospectOptions, 'fresh' | 'env'> = {}): () => Promise<Introspection> {
  return async () => withCapNote(await introspectApp(cwd, { ...options, timeoutMs: CHECK_INTROSPECT_TIMEOUT_MS }))
}

/** A timeout under the cap names it, so a `guren introspect` that succeeds within its 30 s reads as no contradiction. */
export function withCapNote(result: Introspection): Introspection {
  if (result.status !== 'failed' || result.reason !== 'timeout') return result
  // Appended to the first line: the readers keep only a failure's first.
  const [first, ...rest] = result.message.split('\n')
  const note = `The commands that judge the app cap introspection at ${CHECK_INTROSPECT_TIMEOUT_MS / 1000} s; \`guren introspect\` waits ${DEFAULT_INTROSPECT_TIMEOUT_MS / 1000} s by default.`
  return { ...result, message: [`${first} ${note}`, ...rest].join('\n') }
}

/** One run per app root and timeout per CLI process, so a larger `timeoutMs` can retry a timed-out run. */
const runs = new Map<string, Promise<Introspection>>()

export function introspectApp(cwd: string, options: IntrospectOptions = {}): Promise<Introspection> {
  const root = resolve(cwd)
  const timeoutMs = options.timeoutMs ?? DEFAULT_INTROSPECT_TIMEOUT_MS
  const graph = options.graph === true
  if (options.fresh || options.env || options.withoutEnvFiles) return runOrCrash(root, timeoutMs, graph, options.env, options.withoutEnvFiles === true)
  const key = `${timeoutMs}:${graph}:${root}`
  let run = runs.get(key)
  if (!run) {
    run = runOrCrash(root, timeoutMs, graph)
    runs.set(key, run)
  }
  return run
}

function runOrCrash(root: string, timeoutMs: number, graph: boolean, env?: Readonly<Record<string, string>>, withoutEnvFiles = false): Promise<Introspection> {
  return runIntrospection(root, timeoutMs, graph, env, withoutEnvFiles).catch((error: unknown): Introspection => ({
    status: 'failed',
    reason: 'crashed',
    message: `The introspection process could not run: ${error instanceof Error ? error.message : String(error)}`,
  }))
}

/** The names Bun loads from the app's env files: a Bun started on nothing else in the app root holds exactly those. */
export async function envFileNames(root: string): Promise<string[]> {
  const seeded = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(process.env.NODE_ENV ? { NODE_ENV: process.env.NODE_ENV } : {}) }
  const { stdout } = await promisify(execFile)(bunExecutable(), ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], { cwd: root, env: seeded, timeout: 30_000 })
  return (JSON.parse(stdout) as string[]).filter((name) => !(name in seeded)).sort()
}

async function runIntrospection(root: string, timeoutMs: number, graph: boolean, extraEnv?: Readonly<Record<string, string>>, withoutEnvFiles = false): Promise<Introspection> {
  const child = siblingEntry('introspect-child')
  if (!child) {
    return { status: 'failed', reason: 'crashed', message: 'introspect-child is missing beside the CLI; rebuild @guren/cli.' }
  }
  const dir = await mkdtemp(join(tmpdir(), 'guren-introspect-'))
  const resultFile = join(dir, 'result.json')

  try {
    const started = Date.now()
    const unset = withoutEnvFiles ? await envFileNames(root) : []
    const run = await runCaptured([bunExecutable(), ...(withoutEnvFiles ? ['--no-env-file'] : []), child, resultFile, String(timeoutMs + INTROSPECT_CHILD_BUDGET_MARGIN_MS)], root, {
      unset,
      timeoutMs,
      // Always set, so a value inherited from this process cannot turn an ordinary run into a graph run or a target's.
      env: { [INTROSPECT_TARGET_ENV]: '', ...extraEnv, GUREN_INTROSPECT: '1', [INTROSPECT_GRAPH_ENV]: graph ? '1' : '0' },
      processGroup: true,
    })
    const result = run.timedOut ? undefined : await readResult(resultFile)
    if (result) return result
    // A loop blocked past the cap lets the child's budget end it first, and its `close` then settles the run ahead of our timer.
    if (run.timedOut || Date.now() - started >= timeoutMs) {
      return { status: 'failed', reason: 'timeout', message: await timeoutMessage(`${resultFile}.scanning`, timeoutMs) }
    }

    const detail = outputTail(run.stderr).join('\n')
    return {
      status: 'failed',
      reason: 'crashed',
      message: `The introspection process exited with code ${run.exitCode} before reporting.${detail ? `\n${detail}` : ''}`,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Where the child was when the clock ran out: the controller, model or validator file it was importing, if any. */
async function timeoutMessage(scanFile: string, timeoutMs: number): Promise<string> {
  const file = await readFile(scanFile, 'utf8').catch(() => '')
  if (file) {
    return `The app registered, but importing ${file} to match a route's controller, bound model or contract schema did not finish within ${timeoutMs}ms. `
      + 'Its module scope may await something that never settles.'
  }
  return `The app did not finish loading and registering within ${timeoutMs}ms. `
    + 'The entry\'s module scope, or a provider\'s register(), may be waiting on a connection.'
}

async function readResult(file: string): Promise<Introspection | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }

  // Written by this CLI's own child, so only the manifest's version needs checking.
  const result = parsed as Introspection
  if (result.status === 'ok' && result.manifest.schemaVersion !== 1) {
    return { status: 'failed', reason: 'crashed', message: `The manifest has schemaVersion ${String(result.manifest.schemaVersion)}; this CLI reads 1.` }
  }
  return result
}
