/**
 * Every account operation `cloudflare:deploy` performs goes through the app's own
 * `cf` (RFC 0035 §7). The argv here is the contract with a beta CLI, pinned by
 * `cf-cli.test.ts` and checked against the real one by the GUREN_TEST_CF probe.
 * A result that does not parse is `unreadable`, never an empty listing: an empty
 * listing would make the plan create a resource that already exists.
 */
import { isRecord } from '../backend'

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Runs a CLI with `args` from the app root. The seam the tests replace. */
export type CliRunner = (args: string[]) => CliResult

export type CfResult = CliResult
export type CfRunner = CliRunner

export type Read<T> = { ok: true; value: T } | { ok: false; reason: string }

/** A D1 database (`uuid`, `name`) or a KV namespace (`id`, `title`), in one shape. */
export interface AccountResource {
  id: string
  name: string
}

/** `cf` prints a listing's `result` and drops `result_info`, so a full page is the only sign of another. */
const PAGE_SIZE = 100
const MAX_PAGES = 50

/** The app's `cf`, run by `node` from PATH; cf loads cloudflare.config.ts with that Node. */
export function appCfRunner(root: string, bin: string): CfRunner {
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

export function listD1Databases(cf: CfRunner): Read<AccountResource[]> {
  return listPages(cf, ['d1', 'list'], 'cf d1 list', 'uuid', 'name')
}

export function listKvNamespaces(cf: CfRunner): Read<AccountResource[]> {
  return listPages(cf, ['kv', 'namespaces', 'list'], 'cf kv namespaces list', 'id', 'title')
}

/** `cf auth whoami` exits 0 when logged out too, printing `{ "authenticated": false, "error": … }`. */
export function checkAuth(cf: CfRunner): Read<true> {
  const result = cf(['auth', 'whoami'])
  if (result.exitCode !== 0) {
    return { ok: false, reason: `cf auth whoami failed: ${failureText(result)}` }
  }
  const status = parseJson(result.stdout)
  if (!isRecord(status) || !('authenticated' in status)) {
    return { ok: false, reason: 'cf auth whoami printed no "authenticated" field' }
  }
  if (status.authenticated !== true) {
    const error = typeof status.error === 'string' ? status.error : 'not authenticated'
    return { ok: false, reason: error }
  }
  return { ok: true, value: true }
}

/**
 * The names `d1_migrations` records, in apply order, or `null` when the table does not
 * exist yet (nothing applied). Any other failure is unreadable: guessing "nothing
 * applied" would replay the whole history against live data.
 */
export function readMigrationTracker(cf: CfRunner, databaseId: string): Read<string[] | null> {
  const result = cf(['d1', 'query', databaseId, '--sql', 'select name from d1_migrations order by id'])
  if (result.exitCode !== 0) {
    if (/no such table:?\s*d1_migrations/i.test(failureText(result))) return { ok: true, value: null }
    return { ok: false, reason: `cf d1 query on the migrations table failed: ${failureText(result)}` }
  }
  // The API answers `[{ results: [...], success, meta }]`, with or without the envelope around it.
  const statements = resultArray(parseJson(result.stdout))
  const rows = names(statements?.[0] !== undefined && isRecord(statements[0]) ? statements[0].results : undefined)
  return rows
    ? { ok: true, value: rows }
    : { ok: false, reason: 'cf d1 query printed no `results` rows with a `name` for the migrations table' }
}

/** The secret names a deployed Worker has. Fails on a Worker that does not exist yet, too. */
export function listWorkerSecrets(cf: CfRunner, worker: string): Read<string[]> {
  const result = cf(['workers', 'secrets', 'list', '--worker', worker])
  if (result.exitCode !== 0) {
    return { ok: false, reason: `cf workers secrets list failed: ${failureText(result)}` }
  }
  const secrets = names(resultArray(parseJson(result.stdout)))
  return secrets ? { ok: true, value: secrets } : { ok: false, reason: 'cf workers secrets list printed no list of named secrets' }
}

/** `cf d1 create`: the new database's id, read from `uuid`. Unparseable output is a failure, though the database may exist. */
export function createD1Database(cf: CfRunner, name: string): Read<string> {
  return readField(cf, ['d1', 'create', '--name', name], 'cf d1 create', 'uuid')
}

/** `cf kv namespaces create`: the new namespace's id. */
export function createKvNamespace(cf: CfRunner, title: string): Read<string> {
  return readField(cf, ['kv', 'namespaces', 'create', '--title', title], 'cf kv namespaces create', 'id')
}

/** The Time Travel bookmark a restore would return the database to. */
export function getBookmark(cf: CfRunner, databaseId: string): Read<string> {
  return readField(cf, ['d1', 'time-travel', 'get-bookmark', databaseId], 'cf d1 time-travel get-bookmark', 'bookmark')
}

export function applyMigrations(cf: CfRunner, databaseId: string, dirArgs: string[]): Read<string> {
  const result = cf(['d1', 'migrations', 'apply', databaseId, ...dirArgs])
  return result.exitCode === 0
    ? { ok: true, value: result.stdout }
    : { ok: false, reason: `cf d1 migrations apply failed: ${failureText(result)}` }
}

/** Stage 7: the build already evaluated, and no resource created behind the plan's back (RFC 0035 §4). */
export function deployPrebuilt(cf: CfRunner, secretsFile: string | undefined): Read<string> {
  const result = cf(['deploy', '--prebuilt', '--no-provision', ...(secretsFile ? ['--secrets-file', secretsFile] : [])])
  return result.exitCode === 0
    ? { ok: true, value: `${result.stdout}${result.stderr}` }
    : { ok: false, reason: `cf deploy failed: ${failureText(result)}` }
}

/** One string field of a single result `cf` prints. */
function readField(cf: CfRunner, args: string[], label: string, key: string): Read<string> {
  const result = cf(args)
  if (result.exitCode !== 0) return { ok: false, reason: `${label} failed: ${failureText(result)}` }
  const value = resultObject(parseJson(result.stdout))?.[key]
  return typeof value === 'string' ? { ok: true, value } : { ok: false, reason: `${label} printed no ${key}` }
}

/** `cf build`: evaluates cloudflare.config.ts and writes the build output the plan reads. */
export function cfBuild(cf: CfRunner): Read<true> {
  const result = cf(['build'])
  return result.exitCode === 0 ? { ok: true, value: true } : { ok: false, reason: failureText(result) }
}

function listPages(cf: CfRunner, command: string[], label: string, idKey: string, nameKey: string): Read<AccountResource[]> {
  const all: AccountResource[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = cf([...command, '--page', String(page), '--per-page', String(PAGE_SIZE)])
    if (result.exitCode !== 0) {
      return { ok: false, reason: `${label} failed: ${failureText(result)}` }
    }
    const entries = resultArray(parseJson(result.stdout))
    if (!entries) {
      return { ok: false, reason: `${label} printed no JSON list` }
    }
    for (const entry of entries) {
      const id: unknown = isRecord(entry) ? entry[idKey] : undefined
      const name: unknown = isRecord(entry) ? entry[nameKey] : undefined
      if (typeof id !== 'string' || typeof name !== 'string') {
        return { ok: false, reason: `${label} returned an entry of an unexpected shape: ${JSON.stringify(entry)}` }
      }
      all.push({ id, name })
    }
    if (entries.length < PAGE_SIZE) {
      return { ok: true, value: all }
    }
  }
  return { ok: false, reason: `${label} still had results after ${MAX_PAGES} pages of ${PAGE_SIZE}` }
}

/** A listing as `cf` prints it: the `result` array alone, or the API envelope around it. */
export function resultArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value
  return isRecord(value) && Array.isArray(value.result) ? value.result : undefined
}

/** A single result as `cf` prints it: the object alone, or the API envelope around it. */
export function resultObject(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value) && isRecord(value.result)) return value.result
  return isRecord(value) ? value : undefined
}

/** Every entry's string `name`, or nothing when any entry has none. */
export function names(entries: unknown): string[] | undefined {
  if (!Array.isArray(entries)) return undefined
  const read = entries.map((entry) => (isRecord(entry) && typeof entry.name === 'string' ? entry.name : undefined))
  return read.every((name) => name !== undefined) ? (read as string[]) : undefined
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function failureText(result: CfResult): string {
  const text = `${result.stderr}${result.stdout}`.trim()
  return text === '' ? `exit code ${result.exitCode}` : text
}
