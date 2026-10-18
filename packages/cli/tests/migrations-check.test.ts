import { describe, expect, it } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gatingResults } from '../src/check-result'
import { checkDestructiveMigrations } from '../src/migrations-check'
import { createTempRoot } from './helpers'

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
