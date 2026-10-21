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

export type Read<T> = { ok: true; value: T } | { ok: false; reason: string }

/** A D1 database (`uuid`, `name`) or a KV namespace (`id`, `title`), in one shape. */
export interface AccountResource {
  id: string
  name: string
}

/** `cf` prints a listing's `result` and drops `result_info`, so a full page is the only sign of another. */
const PAGE_SIZE = 100
const MAX_PAGES = 50

/**
 * The app's `cf` or `wrangler`, run by the `node` on PATH (cf loads cloudflare.config.ts
 * with it). No stdin and CI=1, so no prompt waits and none writes wrangler.jsonc.
 */
export function appCliRunner(root: string, bin: string): CliRunner {
  return (args) => {
    const result = Bun.spawnSync({
      cmd: ['node', bin, ...args],
      cwd: root,
      env: { ...process.env, CI: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }
}

export function listD1Databases(cf: CliRunner): Read<AccountResource[]> {
  return listPages(cf, ['d1', 'list'], 'cf d1 list', 'uuid', 'name')
}

export function listKvNamespaces(cf: CliRunner): Read<AccountResource[]> {
  return listPages(cf, ['kv', 'namespaces', 'list'], 'cf kv namespaces list', 'id', 'title')
}

/** `cf auth whoami` exits 0 when logged out too, printing `{ "authenticated": false, "error": … }`. */
export function checkAuth(cf: CliRunner): Read<true> {
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
export function readMigrationTracker(cf: CliRunner, databaseId: string): Read<string[] | null> {
  return trackerRows(cf(['d1', 'query', databaseId, '--sql', trackerQuery(DEFAULT_TRACKER)]), 'cf d1 query', DEFAULT_TRACKER)
}

/** The table both CLIs record applied migrations in, unless wrangler.jsonc names another (`migrations_table`). */
export const DEFAULT_TRACKER = 'd1_migrations'

export function trackerQuery(table: string): string {
  const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(table) ? table : `"${table.replaceAll('"', '""')}"`
  return `select name from ${name} order by id`
}

/** A tracker query's result: the API answers `[{ results: [...], success, meta }]`, with or without the envelope. */
export function trackerRows(result: CliResult, label: string, table: string): Read<string[] | null> {
  if (result.exitCode !== 0) {
    if (failureText(result).toLowerCase().includes(`no such table: ${table.toLowerCase()}`)) return { ok: true, value: null }
    return { ok: false, reason: `${label} on the migrations table failed: ${failureText(result)}` }
  }
  const statements = resultArray(parseJson(result.stdout))
  const rows = names(statements?.[0] !== undefined && isRecord(statements[0]) ? statements[0].results : undefined)
  return rows
    ? { ok: true, value: rows }
    : { ok: false, reason: `${label} printed no \`results\` rows with a \`name\` for the migrations table` }
}

/** The secret names a deployed Worker has. Fails on a Worker that does not exist yet, too. */
export function listWorkerSecrets(cf: CliRunner, worker: string): Read<string[]> {
  const result = cf(['workers', 'secrets', 'list', '--worker', worker])
  if (result.exitCode !== 0) {
    return { ok: false, reason: `cf workers secrets list failed: ${failureText(result)}` }
  }
  const secrets = names(resultArray(parseJson(result.stdout)))
  return secrets ? { ok: true, value: secrets } : { ok: false, reason: 'cf workers secrets list printed no list of named secrets' }
}

/** The R2 API's page ceiling; a full page could hide the exact match behind it. */
const R2_PAGE_SIZE = 1000

/**
 * The buckets named exactly as `bucketNames`, as `{ id: name, name }` since R2 has no id. Looked up
 * by `--name-contains`, because a listing pages by a cursor that cf may not print.
 */
export function listR2Buckets(cf: CliRunner, bucketNames: readonly string[]): Read<AccountResource[]> {
  const found: AccountResource[] = []
  for (const name of new Set(bucketNames)) {
    const result = cf(['r2', 'buckets', 'list', '--name-contains', name, '--per-page', String(R2_PAGE_SIZE)])
    if (result.exitCode !== 0) return { ok: false, reason: `cf r2 buckets list failed: ${failureText(result)}` }
    const value = parseJson(result.stdout)
    const buckets = Array.isArray(value) ? value : resultObject(value)?.buckets
    if (!Array.isArray(buckets)) return { ok: false, reason: 'cf r2 buckets list printed no list of buckets' }
    if (buckets.length >= R2_PAGE_SIZE) return { ok: false, reason: `cf r2 buckets list matched ${R2_PAGE_SIZE} or more buckets containing "${name}"` }
    const listed = names(buckets)
    if (!listed) return { ok: false, reason: 'cf r2 buckets list returned a bucket with no name' }
    if (listed.includes(name)) found.push({ id: name, name })
  }
  return { ok: true, value: found }
}

/** `cf r2 buckets create`: a bucket's name is its id. */
export function createR2Bucket(cf: CliRunner, name: string): Read<string> {
  const result = cf(['r2', 'buckets', 'create', '--name', name])
  return result.exitCode === 0 ? { ok: true, value: name } : { ok: false, reason: `cf r2 buckets create failed: ${failureText(result)}` }
}

/** `cf d1 create`: the new database's id, read from `uuid`. Unparseable output is a failure, though the database may exist. */
export function createD1Database(cf: CliRunner, name: string): Read<string> {
  return readField(cf, ['d1', 'create', '--name', name], 'cf d1 create', 'uuid')
}

/** `cf kv namespaces create`: the new namespace's id. */
export function createKvNamespace(cf: CliRunner, title: string): Read<string> {
  return readField(cf, ['kv', 'namespaces', 'create', '--title', title], 'cf kv namespaces create', 'id')
}

/** The Time Travel bookmark a restore would return the database to. */
export function getBookmark(cf: CliRunner, databaseId: string): Read<string> {
  return readField(cf, ['d1', 'time-travel', 'get-bookmark', databaseId], 'cf d1 time-travel get-bookmark', 'bookmark')
}

export function applyMigrations(cf: CliRunner, databaseId: string, dirArgs: string[]): Read<string> {
  const result = cf(['d1', 'migrations', 'apply', databaseId, ...dirArgs])
  return result.exitCode === 0
    ? { ok: true, value: result.stdout }
    : { ok: false, reason: `cf d1 migrations apply failed: ${failureText(result)}` }
}

/** Stage 7: the build already evaluated, and no resource created behind the plan's back (RFC 0035 §4). */
export function deployPrebuilt(cf: CliRunner, secretsFile: string | undefined): Read<string> {
  const result = cf(['deploy', '--prebuilt', '--no-provision', ...(secretsFile ? ['--secrets-file', secretsFile] : [])])
  return result.exitCode === 0
    ? { ok: true, value: `${result.stdout}${result.stderr}` }
    : { ok: false, reason: `cf deploy failed: ${failureText(result)}` }
}

/** One string field of a single result the CLI prints. */
export function readField(cf: CliRunner, args: string[], label: string, key: string): Read<string> {
  const result = cf(args)
  if (result.exitCode !== 0) return { ok: false, reason: `${label} failed: ${failureText(result)}` }
  const value = resultObject(parseJson(result.stdout))?.[key]
  return typeof value === 'string' ? { ok: true, value } : { ok: false, reason: `${label} printed no ${key}` }
}

/** `build` through cf's implementation protocol: evaluates cloudflare.config.ts and writes the build output the plan reads. */
export function cfBuild(cf: CliRunner): Read<true> {
  const result = cf(['build'])
  return result.exitCode === 0 ? { ok: true, value: true } : { ok: false, reason: failureText(result) }
}

function listPages(cf: CliRunner, command: string[], label: string, idKey: string, nameKey: string): Read<AccountResource[]> {
  const all: AccountResource[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const listed = parseResources(cf([...command, '--page', String(page), '--per-page', String(PAGE_SIZE)]), label, idKey, nameKey)
    if (!listed.ok) return listed
    all.push(...listed.value)
    if (listed.value.length < PAGE_SIZE) {
      return { ok: true, value: all }
    }
  }
  return { ok: false, reason: `${label} still had results after ${MAX_PAGES} pages of ${PAGE_SIZE}` }
}

/** One listing's entries, each read as `{ id, name }` from the keys the resource type uses. */
export function parseResources(result: CliResult, label: string, idKey: string, nameKey: string): Read<AccountResource[]> {
  if (result.exitCode !== 0) return { ok: false, reason: `${label} failed: ${failureText(result)}` }
  const entries = resultArray(parseJson(result.stdout))
  if (!entries) return { ok: false, reason: `${label} printed no JSON list` }
  const resources: AccountResource[] = []
  for (const entry of entries) {
    const id: unknown = isRecord(entry) ? entry[idKey] : undefined
    const name: unknown = isRecord(entry) ? entry[nameKey] : undefined
    if (typeof id !== 'string' || typeof name !== 'string') {
      return { ok: false, reason: `${label} returned an entry of an unexpected shape: ${JSON.stringify(entry)}` }
    }
    resources.push({ id, name })
  }
  return { ok: true, value: resources }
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

/** The JSON a command printed, past any line the CLI writes ahead of it (an update notice). */
export function parseJson(text: string): unknown {
  const whole = tryParse(text)
  if (whole !== undefined) return whole
  const start = text.search(/^[[{]/m)
  return start === -1 ? undefined : tryParse(text.slice(start))
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function failureText(result: CliResult): string {
  const text = `${result.stderr}${result.stdout}`.trim()
  return text === '' ? `exit code ${result.exitCode}` : text
}
