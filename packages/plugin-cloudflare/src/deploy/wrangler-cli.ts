/**
 * The Wrangler backend's account operations (RFC 0035 §7, Appendix B), against
 * Wrangler 4.129 or later. Every command naming a database, the secrets listing and
 * the deploy take the rendered deploy config (`-c`), so a database is found by its
 * binding there and never through a placeholder id in wrangler.jsonc. `d1 execute`
 * and `d1 migrations apply` default to the local database, so both pass `--remote`.
 */
import {
  failureText,
  names,
  parseJson,
  parseResources,
  readField,
  resultArray,
  TRACKER_QUERY,
  trackerRows,
  type AccountResource,
  type CliRunner,
  type Read,
} from './cf-cli'

/** `whoami --json` exits non-zero when nobody is logged in. */
export function checkWranglerAuth(wrangler: CliRunner): Read<true> {
  const result = wrangler(['whoami', '--json'])
  return result.exitCode === 0 ? { ok: true, value: true } : { ok: false, reason: failureText(result) }
}

/** Wrangler pages through the whole account itself. */
export function listWranglerD1(wrangler: CliRunner): Read<AccountResource[]> {
  return parseResources(wrangler(['d1', 'list', '--json']), 'wrangler d1 list', 'uuid', 'name')
}

/** Prints JSON with no flag (Appendix B row 7). */
export function listWranglerKv(wrangler: CliRunner): Read<AccountResource[]> {
  return parseResources(wrangler(['kv', 'namespace', 'list']), 'wrangler kv namespace list', 'id', 'title')
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
  return trackerRows(wrangler(['d1', 'execute', binding, '--remote', '--json', '--command', TRACKER_QUERY, ...configArgs]), 'wrangler d1 execute')
}

export function getWranglerBookmark(wrangler: CliRunner, binding: string, configArgs: string[]): Read<string> {
  return readField(wrangler, ['d1', 'time-travel', 'info', binding, '--json', ...configArgs], 'wrangler d1 time-travel info', 'bookmark')
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
  const secrets = names(resultArray(parseJson(result.stdout)))
  return secrets ? { ok: true, value: secrets } : { ok: false, reason: 'wrangler secret list printed no list of named secrets' }
}

/** Stage 7 with provisioning off, so a binding that does not resolve fails the upload (RFC 0035 §4). */
export function deployWithWrangler(wrangler: CliRunner, configArgs: string[], secretsFile: string | undefined): Read<string> {
  const result = wrangler(['deploy', ...configArgs, '--x-provision=false', ...(secretsFile ? ['--secrets-file', secretsFile] : [])])
  return result.exitCode === 0
    ? { ok: true, value: `${result.stdout}${result.stderr}` }
    : { ok: false, reason: `wrangler deploy failed: ${failureText(result)}` }
}
