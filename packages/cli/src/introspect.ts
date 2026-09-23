/**
 * The CLI's reader of RFC 0026's manifest: spawns `introspect-child` under
 * `GUREN_INTROSPECT=1` with the app root as cwd, so Bun loads `.env` the way
 * `guren dev` does, and reads the result the child writes to a temp file.
 * Type-only against `@guren/server`: the app may resolve an older one.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppManifest } from '@guren/server'

import { bunExecutable, runCaptured, type CapturedExec } from './subprocess'

export type IntrospectionFailure = 'no-entry' | 'import' | 'timeout' | 'crashed' | 'old-server'

export type Introspection =
  | { status: 'ok'; manifest: AppManifest }
  | { status: 'failed'; reason: IntrospectionFailure; message: string }

export interface IntrospectOptions {
  /** Wall-clock cap on the child, after which it is killed and the run is `timeout`. */
  timeoutMs?: number
  /** The subprocess seam, for tests. */
  exec?: CapturedExec
}

export const DEFAULT_INTROSPECT_TIMEOUT_MS = 30_000

/** One run per app root per CLI process, shared by every command that asks. */
const runs = new Map<string, Promise<Introspection>>()

export function introspectApp(cwd: string, options: IntrospectOptions = {}): Promise<Introspection> {
  const root = resolve(cwd)
  let run = runs.get(root)
  if (!run) {
    run = runIntrospection(root, options)
    runs.set(root, run)
  }
  return run
}

/** Forgets every memoised run; for tests that introspect one root twice. */
export function resetIntrospections(): void {
  runs.clear()
}

let childEntryPath: string | undefined

/** `introspect-child` beside this module: `.js` in dist, `.ts` from source. */
function childEntry(): string {
  if (childEntryPath) return childEntryPath
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = ['introspect-child.js', 'introspect-child.ts'].map((name) => join(here, name))
  childEntryPath = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  return childEntryPath
}

async function runIntrospection(root: string, options: IntrospectOptions): Promise<Introspection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INTROSPECT_TIMEOUT_MS
  const exec = options.exec ?? runCaptured
  const dir = await mkdtemp(join(tmpdir(), 'guren-introspect-'))
  const resultFile = join(dir, 'result.json')

  try {
    const run = await exec([bunExecutable(), childEntry(), resultFile], root, {
      timeoutMs,
      env: { GUREN_INTROSPECT: '1' },
    })
    if (run.timedOut) {
      return {
        status: 'failed',
        reason: 'timeout',
        message: `The app did not finish registering within ${timeoutMs}ms. A provider's register() may be waiting on a connection.`,
      }
    }

    const result = await readResult(resultFile)
    if (result) return result

    const detail = run.stderr.trim().split('\n').slice(-10).join('\n')
    return {
      status: 'failed',
      reason: 'crashed',
      message: `The introspection process exited with code ${run.exitCode} before reporting.${detail ? `\n${detail}` : ''}`,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function readResult(file: string): Promise<Introspection | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }

  const result = parsed as Partial<Introspection> | null
  if (result?.status === 'ok' && (result as { manifest?: { schemaVersion?: unknown } }).manifest?.schemaVersion === 1) {
    return result as Introspection
  }
  if (result?.status === 'failed' && typeof (result as { reason?: unknown }).reason === 'string') {
    return result as Introspection
  }
  return undefined
}
