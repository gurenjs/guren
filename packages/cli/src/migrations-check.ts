import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ALLOW_DESTRUCTIVE_MARKER, judgeMigrations, readMigrationSources } from '@guren/orm/internal/migration-guard'
import { getChangedFilesFromBase } from './changed-files'
import { check, type CheckResult } from './check-result'
import { DATABASE_CONFIG_CANDIDATES } from './db-migrate'
import { readIfExists } from './discovery'

const MIGRATION_FILE = /(^|\/)migration\.sql$/
const TITLE = 'Destructive migrations'
const SUGGESTION =
  `Ask the user, then put \`-- ${ALLOW_DESTRUCTIVE_MARKER}: <reason>\` on the first line of the migration, ` +
  'or regenerate it so it does not drop, narrow or rename (RFC 0034).'

/**
 * Whether the app's migrations run with foreign keys on, read from source: off
 * only for a `createSqliteDatabase()` config (bun:sqlite's runner turns them off)
 * with no D1 in sight. Anything else keeps them on, as D1 does.
 */
async function foreignKeysEnforced(cwd: string): Promise<boolean> {
  if (['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'].some((file) => existsSync(join(cwd, file)))) return true
  for (const file of DATABASE_CONFIG_CANDIDATES) {
    const source = await readIfExists(cwd, file).catch(() => null)
    if (source !== null) return !(source.includes('createSqliteDatabase(') && !source.includes('createD1Database('))
  }
  return true
}

/**
 * `guren check`'s destructive-migration rule (RFC 0034 §3): the migrations not
 * on the base branch yet (merge-base diff, uncommitted and untracked), judged
 * as one pending run per migrations folder, whatever `--changed` says. Reads
 * files only, never `drizzle.config.ts` or `config/database.ts`.
 */
export async function checkDestructiveMigrations(
  cwd: string,
  listChanged: typeof getChangedFilesFromBase = getChangedFilesFromBase,
): Promise<CheckResult[]> {
  const changed = await listChanged(cwd)
  if (!changed) {
    if (!existsSync(join(cwd, 'db/migrations'))) return []
    return [{
      ...check(
        'migrations-destructive-unverified',
        TITLE,
        'warn',
        'Not a git repository, so the migrations not yet on the base branch cannot be told from the ones already shipped, and none were judged.',
        'Run `bunx guren db:migrate --dry-run` against the database to judge the pending ones.',
      ),
      advisory: true,
    }]
  }

  const byFolder = new Map<string, string[]>()
  for (const file of changed.files) {
    if (!MIGRATION_FILE.test(file) || file.split('/').includes('node_modules')) continue
    // A migration deleted on this branch is in the diff and on no disk.
    if (!existsSync(join(cwd, file))) continue
    const migrationDir = dirname(file)
    const folder = dirname(migrationDir)
    const names = byFolder.get(folder) ?? []
    names.push(migrationDir.slice(folder === '.' ? 0 : folder.length + 1))
    byFolder.set(folder, names)
  }

  const results: CheckResult[] = []
  // Gating, unlike a missing merge base: the listing claims a scope it did not cover.
  if (!changed.complete) {
    results.push(check(
      'migrations-destructive-incomplete',
      TITLE,
      'warn',
      'A git listing of the changed files failed, so migrations not yet on `main` may be missing from this check.',
      'Run `git status` and `git diff` to see why git failed, then check again.',
    ))
  }
  const hasMigrations = existsSync(join(cwd, 'db/migrations'))
  // Gating: a shallow clone has commits whose migrations nothing judged.
  if (changed.head && !changed.mergeBase && (hasMigrations || byFolder.size > 0)) {
    results.push(check(
      'migrations-destructive-no-base',
      TITLE,
      'warn',
      'No merge base with `main`, `origin/main` or `origin/HEAD`, so committed migrations cannot be told from shipped ones and only uncommitted and untracked ones were judged.',
      'Fetch the base branch (`git fetch origin main`, or `fetch-depth: 0` in CI) and check again.',
    ))
  } else if (byFolder.size === 0 && changed.head && changed.mergeBase === changed.head && hasMigrations) {
    results.push({
      ...check(
        'migrations-destructive-on-base',
        TITLE,
        'warn',
        'HEAD is on `main`, so the migrations committed there count as shipped and only uncommitted and untracked ones were judged. ' +
          'This rule judges a branch before it merges; it cannot tell which migrations a database has applied.',
      ),
      advisory: true,
    })
  }
  if (byFolder.size === 0) return results

  const enforced = await foreignKeysEnforced(cwd)

  for (const [folder, names] of [...byFolder].sort(([a], [b]) => a.localeCompare(b))) {
    names.sort((a, b) => a.localeCompare(b))
    let report
    try {
      report = judgeMigrations(readMigrationSources(join(cwd, folder), names, folder), { foreignKeysEnforced: enforced })
    } catch (error) {
      results.push(check(`migrations-destructive:${folder}`, TITLE, 'warn', (error as Error).message, undefined, folder))
      continue
    }

    for (const finding of report.unacknowledged) {
      results.push(check(
        `migrations-destructive:${finding.file}:${finding.line}`,
        TITLE,
        'warn',
        `line ${finding.line} ${finding.message} (${finding.kind}), and the migration carries no acknowledgement.`,
        SUGGESTION,
        finding.file,
      ))
    }
    for (const { file, reason } of report.acknowledged) {
      results.push(check(
        `migrations-destructive:${file}`,
        TITLE,
        'pass',
        `Destructive statements acknowledged: ${reason ?? '(no reason given after the marker)'}.`,
        undefined,
        file,
      ))
    }
    if (report.unacknowledged.length === 0 && report.acknowledged.length === 0) {
      results.push(check(`migrations-destructive:${folder}`, TITLE, 'pass', `${names.length} new migration(s) in ${folder} hold no destructive statement.`))
    }
  }

  return results
}
