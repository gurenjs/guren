import { describe, expect, it } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gatingResults } from '../src/check-result'
import { checkDestructiveMigrations } from '../src/migrations-check'
import { createTempRoot } from './helpers'
import { writeCascadeRebuild } from './migration-fixtures'

async function writeMigration(cwd: string, name: string, sql: string): Promise<void> {
  await mkdir(join(cwd, 'db/migrations', name), { recursive: true })
  await writeFile(join(cwd, 'db/migrations', name, 'migration.sql'), sql)
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

/** A repo whose `main` already shipped a create and an unacknowledged drop, on a feature branch. */
async function repoWithHistory(): Promise<string> {
  const cwd = await createTempRoot('guren-migrations-check-')
  git(cwd, 'init', '-q', '-b', 'main')
  await writeMigration(cwd, '0001_create', 'CREATE TABLE "posts" ("id" serial);\n--> statement-breakpoint\nCREATE TABLE "tags" ("id" serial);')
  await writeMigration(cwd, '0002_drop_tags', 'DROP TABLE "tags";')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-q', '-m', 'history')
  git(cwd, 'checkout', '-q', '-b', 'feature')
  return cwd
}

describe('checkDestructiveMigrations', () => {
  it('should judge only migrations not on main, so a shipped drop is never reported', async () => {
    const cwd = await repoWithHistory()
    try {
      expect(gatingResults({ cwd, checks: await checkDestructiveMigrations(cwd), passCount: 0, warnCount: 0, failCount: 0 })).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('should report an untracked destructive migration as a gating finding with its file and line', async () => {
    const cwd = await repoWithHistory()
    try {
      await writeMigration(cwd, '0003_drop_bio', '-- generated\nALTER TABLE "posts" DROP COLUMN "bio";')
      const results = await checkDestructiveMigrations(cwd)
      const gating = gatingResults({ cwd, checks: results, passCount: 0, warnCount: 0, failCount: 0 })
      expect(gating).toMatchObject([
        {
          key: 'migrations-destructive:db/migrations/0003_drop_bio/migration.sql:2',
          status: 'warn',
          filePath: 'db/migrations/0003_drop_bio/migration.sql',
        },
      ])
      expect(gating[0]!.message).toContain('drops column posts.bio')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('should report a committed branch migration too, and pass it once acknowledged', async () => {
    const cwd = await repoWithHistory()
    try {
      await writeMigration(cwd, '0003_drop_posts', 'DROP TABLE "posts";')
      git(cwd, 'add', '.')
      git(cwd, 'commit', '-q', '-m', 'drop')
      expect((await checkDestructiveMigrations(cwd)).filter((result) => result.status === 'warn')).toHaveLength(1)

      await writeMigration(cwd, '0003_drop_posts', '-- guren:allow-destructive: replaced by articles\nDROP TABLE "posts";')
      expect(await checkDestructiveMigrations(cwd)).toMatchObject([
        { status: 'pass', message: 'Destructive statements acknowledged: replaced by articles.' },
      ])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('should exempt a drop of a table another branch migration creates', async () => {
    const cwd = await repoWithHistory()
    try {
      await writeMigration(cwd, '0003_create_drafts', 'CREATE TABLE "drafts" ("id" serial);')
      await writeMigration(cwd, '0004_drop_drafts', 'DROP TABLE "drafts";')
      expect((await checkDestructiveMigrations(cwd)).map((result) => result.status)).toEqual(['pass'])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('should report a gating finding when a git listing fails, rather than an empty pass', async () => {
    const cwd = await repoWithHistory()
    try {
      const listing = async () => ({ files: new Set<string>(), mergeBase: 'abc', complete: false })
      const gating = gatingResults({ cwd, checks: await checkDestructiveMigrations(cwd, listing), passCount: 0, warnCount: 0, failCount: 0 })
      expect(gating.map((result) => result.key)).toEqual(['migrations-destructive-incomplete'])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('should judge a repository with no commit yet, which has no HEAD to diff against', async () => {
    const cwd = await createTempRoot('guren-migrations-check-nocommit-')
    try {
      git(cwd, 'init', '-q', '-b', 'main')
      await writeMigration(cwd, '0001_create', 'CREATE TABLE "posts" ("id" serial);')
      git(cwd, 'add', '.')
      await writeMigration(cwd, '0002_drop', 'DROP TABLE "posts";\nDROP TABLE "tags";')
      const results = await checkDestructiveMigrations(cwd)
      expect(results.map((result) => result.key)).not.toContain('migrations-destructive-incomplete')
      expect(gatingResults({ cwd, checks: results, passCount: 0, warnCount: 0, failCount: 0 })).toMatchObject([
        { key: 'migrations-destructive:db/migrations/0002_drop/migration.sql:2' },
      ])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('should judge a migration whose folder name git would quote', async () => {
    const cwd = await repoWithHistory()
    try {
      await writeMigration(cwd, '0003_削除', 'DROP TABLE "posts";')
      const gating = gatingResults({ cwd, checks: await checkDestructiveMigrations(cwd), passCount: 0, warnCount: 0, failCount: 0 })
      expect(gating.map((result) => result.filePath)).toEqual(['db/migrations/0003_削除/migration.sql'])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('should fail, not pass, when commits exist but no base branch shares their history', async () => {
    const cwd = await createTempRoot('guren-migrations-check-nobase-')
    try {
      git(cwd, 'init', '-q', '-b', 'trunk')
      await writeMigration(cwd, '0001_drop', 'DROP TABLE "posts";')
      git(cwd, 'add', '.')
      git(cwd, 'commit', '-q', '-m', 'drop')
      const gating = gatingResults({ cwd, checks: await checkDestructiveMigrations(cwd), passCount: 0, warnCount: 0, failCount: 0 })
      expect(gating.map((result) => result.key)).toEqual(['migrations-destructive-no-base'])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('should not gate on a missing base in an app with no migrations', async () => {
    const cwd = await createTempRoot('guren-migrations-check-nobase-empty-')
    try {
      git(cwd, 'init', '-q', '-b', 'trunk')
      git(cwd, 'commit', '-q', '--allow-empty', '-m', 'root')
      expect(await checkDestructiveMigrations(cwd)).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('should say, on the base branch itself, that merged migrations are not judged', async () => {
    const cwd = await repoWithHistory()
    try {
      git(cwd, 'checkout', '-q', 'main')
      expect(await checkDestructiveMigrations(cwd)).toMatchObject([
        { key: 'migrations-destructive-on-base', status: 'warn', advisory: true },
      ])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('should report a rebuild of a table a child references with ON DELETE CASCADE, which D1 applies with foreign keys on', async () => {
    const cwd = await createTempRoot('guren-migrations-check-cascade-')
    try {
      git(cwd, 'init', '-q', '-b', 'main')
      await writeCascadeRebuild(cwd)
      await rm(join(cwd, 'db/migrations/0002_default'), { recursive: true })
      git(cwd, 'add', '.')
      git(cwd, 'commit', '-q', '-m', 'create')
      git(cwd, 'checkout', '-q', '-b', 'feature')
      await writeCascadeRebuild(cwd)
      const gating = gatingResults({ cwd, checks: await checkDestructiveMigrations(cwd), passCount: 0, warnCount: 0, failCount: 0 })
      expect(gating).toMatchObject([{ key: 'migrations-destructive:db/migrations/0002_default/migration.sql:7' }])

      // bun:sqlite's runner migrates with foreign keys off, so its config passes the same rebuild.
      await mkdir(join(cwd, 'config'))
      await writeFile(join(cwd, 'config/database.ts'), "const database = createSqliteDatabase({ migrationsFolder: 'db/migrations' })\n")
      expect(gatingResults({ cwd, checks: await checkDestructiveMigrations(cwd), passCount: 0, warnCount: 0, failCount: 0 })).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('should judge an untracked migration in an app below the repository root', async () => {
    const root = await createTempRoot('guren-migrations-check-subdir-')
    try {
      git(root, 'init', '-q', '-b', 'main')
      git(root, 'commit', '-q', '--allow-empty', '-m', 'root')
      const cwd = join(root, 'app')
      await writeMigration(cwd, '0001_drop', 'DROP TABLE "posts";')
      const gating = gatingResults({ cwd, checks: await checkDestructiveMigrations(cwd), passCount: 0, warnCount: 0, failCount: 0 })
      expect(gating.map((result) => result.filePath)).toEqual(['db/migrations/0001_drop/migration.sql'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('should report itself unverified, never passed, outside a git repository', async () => {
    const cwd = await createTempRoot('guren-migrations-check-nogit-')
    try {
      await writeMigration(cwd, '0001_drop', 'DROP TABLE "posts";')
      expect(await checkDestructiveMigrations(cwd)).toMatchObject([
        { key: 'migrations-destructive-unverified', status: 'warn', advisory: true },
      ])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
