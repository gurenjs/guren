/**
 * Every account operation `cloudflare:deploy` performs goes through the app's own
 * `cf` (RFC 0035 §7). The argv here is the contract with a beta CLI, pinned by
 * `cf-cli.test.ts` and checked against the real one by the GUREN_TEST_CF probe.
 * A result that does not parse is `unreadable`, never an empty listing: an empty
 * listing would make the plan create a resource that already exists.
 */
import { join } from 'node:path'

export interface CfResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Runs `cf` with `args` from the app root. The seam the tests replace. */
export type CfRunner = (args: string[]) => CfResult

export type Read<T> = { ok: true; value: T } | { ok: false; reason: string }

export interface D1Database {
  uuid: string
  name: string
}

export interface KvNamespace {
  id: string
  title: string
}

/** `cf` prints a listing's `result` and drops `result_info`, so a full page is the only sign of another. */
const PAGE_SIZE = 100
const MAX_PAGES = 50

/** The app's `cf`, run by `node` from PATH; cf loads cloudflare.config.ts with that Node. */
export function appCfRunner(root: string, bin = join(root, 'node_modules', 'cf', 'bin', 'cf')): CfRunner {
  return (args) => {
    const result = Bun.spawnSync({
      cmd: ['node', bin, ...args],
      cwd: root,
      // No colour and no prompts: the output is parsed.
      env: { ...process.env, CI: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }
}

export function listD1Databases(cf: CfRunner): Read<D1Database[]> {
  return listPages(cf, ['d1', 'list'], 'cf d1 list', (entry) =>
    typeof entry.uuid === 'string' && typeof entry.name === 'string' ? { uuid: entry.uuid, name: entry.name } : undefined)
}

export function listKvNamespaces(cf: CfRunner): Read<KvNamespace[]> {
  return listPages(cf, ['kv', 'namespaces', 'list'], 'cf kv namespaces list', (entry) =>
    typeof entry.id === 'string' && typeof entry.title === 'string' ? { id: entry.id, title: entry.title } : undefined)
}

/** `cf auth whoami` exits 0 when logged out too, printing `{ "authenticated": false, "error": … }`. */
export function checkAuth(cf: CfRunner): Read<true> {
  const result = cf(['auth', 'whoami'])
  if (result.exitCode !== 0) {
    return { ok: false, reason: `cf auth whoami failed: ${failureText(result)}` }
  }
  const status = parseJson(result.stdout)
  if (typeof status !== 'object' || status === null || !('authenticated' in status)) {
    return { ok: false, reason: 'cf auth whoami printed no "authenticated" field' }
  }
  if (status.authenticated !== true) {
    const error = 'error' in status && typeof status.error === 'string' ? status.error : 'not authenticated'
    return { ok: false, reason: error }
  }
  return { ok: true, value: true }
}

/** `cf build`: evaluates cloudflare.config.ts and writes the build output the plan reads. */
export function cfBuild(cf: CfRunner): Read<true> {
  const result = cf(['build'])
  return result.exitCode === 0 ? { ok: true, value: true } : { ok: false, reason: failureText(result) }
}

function listPages<T>(
  cf: CfRunner,
  command: string[],
  label: string,
  parse: (entry: Record<string, unknown>) => T | undefined,
): Read<T[]> {
  const all: T[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = cf([...command, '--page', String(page), '--per-page', String(PAGE_SIZE)])
    if (result.exitCode !== 0) {
      return { ok: false, reason: `${label} failed: ${failureText(result)}` }
    }
    const entries = parseJsonArray(result.stdout)
    if (!entries) {
      return { ok: false, reason: `${label} printed something other than a JSON array` }
    }
    for (const entry of entries) {
      const parsed = typeof entry === 'object' && entry !== null ? parse(entry as Record<string, unknown>) : undefined
      if (parsed === undefined) {
        return { ok: false, reason: `${label} returned an entry of an unexpected shape: ${JSON.stringify(entry)}` }
      }
      all.push(parsed)
    }
    if (entries.length < PAGE_SIZE) {
      return { ok: true, value: all }
    }
  }
  return { ok: false, reason: `${label} still had results after ${MAX_PAGES} pages of ${PAGE_SIZE}` }
}

function parseJsonArray(text: string): unknown[] | undefined {
  const value = parseJson(text)
  return Array.isArray(value) ? value : undefined
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function failureText(result: CfResult): string {
  const text = `${result.stderr}${result.stdout}`.trim()
  return text === '' ? `exit code ${result.exitCode}` : text
}
