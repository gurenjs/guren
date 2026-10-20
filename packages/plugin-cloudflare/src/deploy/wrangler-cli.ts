/**
 * The Wrangler backend's account operations (RFC 0035 §7, Appendix B), against
 * Wrangler 4.129 or later. Every command but `whoami` takes the rendered deploy
 * config (`-c`), so a database is found by its binding there and never through a
 * placeholder id in wrangler.jsonc. D1 commands default to the local database,
 * which is why each one here passes `--remote`.
 */
import { isRecord } from '../backend'
import {
  failureText,
  names,
  parseJson,
  resultArray,
  resultObject,
  type AccountResource,
  type CliRunner,
  type Read,
} from './cf-cli'

/** The app's Wrangler, run by `node` with no stdin, so no prompt can wait and none writes wrangler.jsonc. */
export function appWranglerRunner(root: string, bin: string): CliRunner {
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

/** `whoami --json` exits non-zero when nobody is logged in. */
export function checkWranglerAuth(wrangler: CliRunner): Read<true> {
  const result = wrangler(['whoami', '--json'])
  return result.exitCode === 0 ? { ok: true, value: true } : { ok: false, reason: failureText(result) }
}

/** Wrangler pages through the whole account itself. */
export function listWranglerD1(wrangler: CliRunner): Read<AccountResource[]> {
  return listResources(wrangler, ['d1', 'list', '--json'], 'wrangler d1 list', 'uuid', 'name')
}

/** Prints JSON with no flag (Appendix B row 7). */
export function listWranglerKv(wrangler: CliRunner): Read<AccountResource[]> {
  return listResources(wrangler, ['kv', 'namespace', 'list'], 'wrangler kv namespace list', 'id', 'title')
}

/**
 * `--update-config=false` answers the "add it to your config?" prompt before it is
 * asked. Create prints no JSON, so the id is read back from the listing by name.
 */
export function createWranglerResource(wrangler: CliRunner, type: 'd1' | 'kv', name: string): Read<string> {
  const args = type === 'd1'
    ? ['d1', 'create', name, '--update-config=false']
    : ['kv', 'namespace', 'create', name, '--update-config=false']
  const label = `wrangler ${args.slice(0, type === 'd1' ? 2 : 3).join(' ')}`
  const result = wrangler(args)
  if (result.exitCode !== 0) return { ok: false, reason: `${label} failed: ${failureText(result)}` }

  const listing = type === 'd1' ? listWranglerD1(wrangler) : listWranglerKv(wrangler)
  if (!listing.ok) return { ok: false, reason: `${label} succeeded, but ${listing.reason}` }
  const found = listing.value.filter((resource) => resource.name === name)
  return found.length === 1 && found[0]
    ? { ok: true, value: found[0].id }
    : { ok: false, reason: `${label} succeeded, but the listing has ${found.length} named "${name}"` }
}

/** The names `d1_migrations` records, or `null` when the table does not exist yet. */
export function readWranglerTracker(wrangler: CliRunner, binding: string, configArgs: string[]): Read<string[] | null> {
  const result = wrangler(['d1', 'execute', binding, '--remote', '--json', '--command', 'select name from d1_migrations order by id', ...configArgs])
  if (result.exitCode !== 0) {
    if (/no such table:?\s*d1_migrations/i.test(failureText(result))) return { ok: true, value: null }
    return { ok: false, reason: `wrangler d1 execute on the migrations table failed: ${failureText(result)}` }
  }
  const statements = resultArray(parseJsonOutput(result.stdout))
  const rows = names(statements?.[0] !== undefined && isRecord(statements[0]) ? statements[0].results : undefined)
  return rows
    ? { ok: true, value: rows }
    : { ok: false, reason: 'wrangler d1 execute printed no `results` rows with a `name` for the migrations table' }
}

export function getWranglerBookmark(wrangler: CliRunner, binding: string, configArgs: string[]): Read<string> {
  const result = wrangler(['d1', 'time-travel', 'info', binding, '--json', ...configArgs])
  if (result.exitCode !== 0) return { ok: false, reason: `wrangler d1 time-travel info failed: ${failureText(result)}` }
  const bookmark = resultObject(parseJsonOutput(result.stdout))?.bookmark
  return typeof bookmark === 'string' ? { ok: true, value: bookmark } : { ok: false, reason: 'wrangler d1 time-travel info printed no bookmark' }
}

/** Applies from the `migrations_dir` the deploy config gives the binding; non-interactive, so unprompted. */
export function applyWranglerMigrations(wrangler: CliRunner, binding: string, applyArgs: string[]): Read<string> {
  const result = wrangler(['d1', 'migrations', 'apply', binding, ...applyArgs])
  return result.exitCode === 0
    ? { ok: true, value: result.stdout }
    : { ok: false, reason: `wrangler d1 migrations apply failed: ${failureText(result)}` }
}

/** Fails on a Worker that does not exist yet, as on a first deploy. */
export function listWranglerSecrets(wrangler: CliRunner, worker: string, configArgs: string[]): Read<string[]> {
  const result = wrangler(['secret', 'list', '--name', worker, '--format', 'json', ...configArgs])
  if (result.exitCode !== 0) return { ok: false, reason: `wrangler secret list failed: ${failureText(result)}` }
  const secrets = names(resultArray(parseJsonOutput(result.stdout)))
  return secrets ? { ok: true, value: secrets } : { ok: false, reason: 'wrangler secret list printed no list of named secrets' }
}

/** Stage 7 with provisioning off, so a binding that does not resolve fails the upload (RFC 0035 §4). */
export function deployWithWrangler(wrangler: CliRunner, configArgs: string[], secretsFile: string | undefined): Read<string> {
  const result = wrangler(['deploy', ...configArgs, '--x-provision=false', ...(secretsFile ? ['--secrets-file', secretsFile] : [])])
  return result.exitCode === 0
    ? { ok: true, value: `${result.stdout}${result.stderr}` }
    : { ok: false, reason: `wrangler deploy failed: ${failureText(result)}` }
}

function listResources(wrangler: CliRunner, args: string[], label: string, idKey: string, nameKey: string): Read<AccountResource[]> {
  const result = wrangler(args)
  if (result.exitCode !== 0) return { ok: false, reason: `${label} failed: ${failureText(result)}` }
  const entries = resultArray(parseJsonOutput(result.stdout))
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

/** The JSON a command printed, past any line Wrangler writes ahead of it (an update notice). */
function parseJsonOutput(text: string): unknown {
  const whole = parseJson(text)
  if (whole !== undefined) return whole
  const start = text.search(/^[[{]/m)
  return start === -1 ? undefined : parseJson(text.slice(start))
}
