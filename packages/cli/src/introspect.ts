/**
 * The CLI's reader of RFC 0026's manifest: spawns `introspect-child` under
 * `GUREN_INTROSPECT=1` with the app root as cwd, so Bun loads `.env` the way
 * `guren dev` does, and reads the result the child writes to a temp file.
 * Type-only against `@guren/server`: the app may resolve an older one.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AppManifest } from '@guren/server'

import { siblingEntry } from './cli-entry'
import { outputTail } from './command-output'
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
}

export const DEFAULT_INTROSPECT_TIMEOUT_MS = 30_000

/**
 * How an in-process caller of `runCheck()` or `runAudit()` asks for the introspected app: `true`
 * for this process's memoised run, or a run of its own that the caller shares between commands.
 */
export type IntrospectOption = boolean | (() => Promise<Introspection>)

/** The run {@link IntrospectOption} names, or `undefined` for none. */
export function introspectRunner(cwd: string, option: IntrospectOption | undefined): (() => Promise<Introspection>) | undefined {
  if (typeof option === 'function') return option
  return option ? () => introspectApp(cwd) : undefined
}

/** One run per app root and timeout per CLI process, so a larger `timeoutMs` can retry a timed-out run. */
const runs = new Map<string, Promise<Introspection>>()

export function introspectApp(cwd: string, options: IntrospectOptions = {}): Promise<Introspection> {
  const root = resolve(cwd)
  const timeoutMs = options.timeoutMs ?? DEFAULT_INTROSPECT_TIMEOUT_MS
  if (options.fresh) return runOrCrash(root, timeoutMs)
  const key = `${timeoutMs}:${root}`
  let run = runs.get(key)
  if (!run) {
    run = runOrCrash(root, timeoutMs)
    runs.set(key, run)
  }
  return run
}

function runOrCrash(root: string, timeoutMs: number): Promise<Introspection> {
  return runIntrospection(root, timeoutMs).catch((error: unknown): Introspection => ({
    status: 'failed',
    reason: 'crashed',
    message: `The introspection process could not run: ${error instanceof Error ? error.message : String(error)}`,
  }))
}

async function runIntrospection(root: string, timeoutMs: number): Promise<Introspection> {
  const child = siblingEntry('introspect-child')
  if (!child) {
    return { status: 'failed', reason: 'crashed', message: 'introspect-child is missing beside the CLI; rebuild @guren/cli.' }
  }
  const dir = await mkdtemp(join(tmpdir(), 'guren-introspect-'))
  const resultFile = join(dir, 'result.json')

  try {
    const run = await runCaptured([bunExecutable(), child, resultFile], root, {
      timeoutMs,
      env: { GUREN_INTROSPECT: '1' },
      processGroup: true,
    })
    if (run.timedOut) {
      return { status: 'failed', reason: 'timeout', message: await timeoutMessage(`${resultFile}.scanning`, timeoutMs) }
    }

    const result = await readResult(resultFile)
    if (result) return result

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

/** Where the child was when the clock ran out: the controller file it was importing, if any. */
async function timeoutMessage(scanFile: string, timeoutMs: number): Promise<string> {
  const file = await readFile(scanFile, 'utf8').catch(() => '')
  if (file) {
    return `The app registered, but importing ${file} to match a routed controller did not finish within ${timeoutMs}ms. `
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
