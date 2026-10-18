import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ALLOW_DESTRUCTIVE_MARKER, judgeMigrations, readMigrationSources } from '@guren/orm/internal/migration-guard'
import { getChangedFilesFromBase } from './changed-files'
import { check, type CheckResult } from './check-result'

const MIGRATION_FILE = /(^|\/)migration\.sql$/
const TITLE = 'Destructive migrations'
const SUGGESTION =
  `Ask the user, then put \`-- ${ALLOW_DESTRUCTIVE_MARKER}: <reason>\` on the first line of the migration, ` +
  'or regenerate it so it does not drop, narrow or rename (RFC 0034).'

/**
 * `guren check`'s destructive-migration rule (RFC 0034 §3): the migrations not
 * on the base branch yet (merge-base diff, uncommitted and untracked), judged
 * as one pending run per migrations folder, whatever `--changed` says. Reads
 * files only, never `drizzle.config.ts` or `config/database.ts`.
 */
export async function checkDestructiveMigrations(cwd: string): Promise<CheckResult[]> {
  const changed = await getChangedFilesFromBase(cwd)
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
  if (!changed.mergeBase) {
    results.push({
      ...check(
        'migrations-destructive-no-base',
        TITLE,
        'warn',
        'No merge base with `main` or `origin/main`, so only uncommitted and untracked migrations were judged.',
      ),
      advisory: true,
    })
  }
  if (byFolder.size === 0) return results

  for (const [folder, names] of [...byFolder].sort(([a], [b]) => a.localeCompare(b))) {
    names.sort((a, b) => a.localeCompare(b))
    let report
    try {
      report = judgeMigrations(readMigrationSources(join(cwd, folder), names, folder))
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
