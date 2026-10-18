import { Database } from 'bun:sqlite'
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CLI_BIN_PATH, createTempRoot } from './helpers'

// Every case spawns the CLI (some twice), past Bun's 5 s default on a loaded runner.
setDefaultTimeout(30_000)

const ORM_SQLITE = resolve(import.meta.dir, '../../orm/src/sqlite.ts')

interface Fixture {
  migrations: Record<string, string>
  /** Rows `migrationStatus()` returns; `undefined` leaves the export out. */
  status?: Array<{ name: string; applied: boolean; path?: string }>
  production?: boolean
}

async function writeMigrations(cwd: string, migrations: Record<string, string>): Promise<void> {
  for (const [name, sql] of Object.entries(migrations)) {
    await mkdir(join(cwd, 'db/migrations', name), { recursive: true })
    await writeFile(join(cwd, 'db/migrations', name, 'migration.sql'), sql)
  }
}

async function run(cwd: string, args: string[], production = false) {
  const child = Bun.spawn(['bun', CLI_BIN_PATH, ...args], {
    cwd,
    env: { ...process.env, NODE_ENV: production ? 'production' : 'development', GUREN_ALLOW_DESTRUCTIVE_MIGRATIONS: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

/** An inert config that records calls, so a refusal can be shown to precede `migrateDatabase()`. */
async function invoke(args: string[], fixture: Fixture) {
  const cwd = await createTempRoot('guren-db-migrate-guard-')
  try {
    await mkdir(join(cwd, 'config'))
    await writeMigrations(cwd, fixture.migrations)
    // The rows go through a file the config reads, so no fixture value becomes code.
    if (fixture.status) await writeFile(join(cwd, 'status.json'), JSON.stringify(fixture.status))
    const status = fixture.status
      ? "export async function migrationStatus() { record('status'); return JSON.parse(readFileSync('status.json', 'utf8')).map((row) => ({ appliedAt: null, ...row, path: row.path?.replace('$CWD', process.cwd()) })) }"
      : ''
    await writeFile(join(cwd, 'config/database.ts'), `
import { appendFileSync, readFileSync } from 'node:fs'
const record = (event: string) => appendFileSync('calls.txt', event + '\\n')
export async function migrateDatabase() {
  record('migrate:' + (process.env.GUREN_ALLOW_DESTRUCTIVE_MIGRATIONS ?? ''))
  return { migrationsFound: 1, looseSqlFiles: 0 }
}
${status}
export async function closeDatabase() { record('close') }
`)
    const result = await run(cwd, args, fixture.production)
    const calls = await readFile(join(cwd, 'calls.txt'), 'utf8').catch(() => '')
    return { ...result, calls: calls.trim().split('\n').filter(Boolean) }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

const CREATE = 'CREATE TABLE "posts" ("id" serial PRIMARY KEY);'
const DROP = 'DROP TABLE "posts";'
const applied = (name: string) => ({ name, applied: true, path: `$CWD/db/migrations/${name}/migration.sql` })
const pending = (name: string) => ({ name, applied: false, path: `$CWD/db/migrations/${name}/migration.sql` })

describe('db:migrate destructive guard', () => {
  it('refuses a pending unacknowledged DROP TABLE before migrateDatabase(), in production too', async () => {
    for (const production of [false, true]) {
      const result = await invoke(['db:migrate'], {
        migrations: { '0001_create': CREATE, '0002_drop': DROP },
        status: [applied('0001_create'), pending('0002_drop')],
        production,
      })
      expect(result.exitCode).toBe(1)
      expect(result.calls).toEqual(['status', 'close'])
      expect(result.stderr + result.stdout).toContain('db/migrations/0002_drop/migration.sql:1: drops table posts (drop-table)')
    }
  })

  it('reports the refusal as JSON', async () => {
    const result = await invoke(['db:migrate', '--json'], {
      migrations: { '0001_create': CREATE, '0002_drop': DROP },
      status: [applied('0001_create'), pending('0002_drop')],
    })
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      action: 'db:migrate',
      destructive: { pending: ['0002_drop'], pendingFrom: 'status', findings: [{ kind: 'drop-table', line: 1, table: 'posts', migration: '0002_drop' }] },
    })
  })

  it('dry-run judges without applying and exits 1 on a finding', async () => {
    const result = await invoke(['db:migrate', '--dry-run', '--json'], {
      migrations: { '0001_create': CREATE, '0002_drop': DROP },
      status: [applied('0001_create'), pending('0002_drop')],
    })
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, destructive: { findings: [{ kind: 'drop-table' }] } })
    expect(result.calls).toEqual(['status', 'close'])
  })

  it('dry-run exits 0 when nothing pending is destructive', async () => {
    const result = await invoke(['db:migrate', '--dry-run', '--json'], {
      migrations: { '0001_create': CREATE },
      status: [pending('0001_create')],
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, destructive: { pending: ['0001_create'], findings: [] } })
  })

  it('applies with --allow-destructive and hands the override to the factory', async () => {
    const result = await invoke(['db:migrate', '--allow-destructive', '--json'], {
      migrations: { '0001_create': CREATE, '0002_drop': DROP },
      status: [applied('0001_create'), pending('0002_drop')],
    })
    expect(result.exitCode).toBe(0)
    expect(result.calls).toEqual(['status', 'close', 'migrate:1', 'close'])
  })

  it('applies a migration that carries the marker, reporting its reason', async () => {
    const result = await invoke(['db:migrate', '--json'], {
      migrations: { '0001_create': CREATE, '0002_drop': `-- guren:allow-destructive: archived in #12\n${DROP}` },
      status: [applied('0001_create'), pending('0002_drop')],
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      destructive: { findings: [], acknowledged: [{ migration: '0002_drop', reason: 'archived in #12' }] },
    })
  })

  it("falls back to the drizzle config's default folder for a status row without a path", async () => {
    const result = await invoke(['db:migrate', '--json'], {
      migrations: { '0001_create': CREATE, '0002_drop': DROP },
      status: [{ name: '0001_create', applied: true }, { name: '0002_drop', applied: false }],
    })
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout).destructive.findings).toHaveLength(1)
  })

  it('refuses a pending migration whose file it cannot find, rather than skipping it', async () => {
    const result = await invoke(['db:migrate'], {
      migrations: {},
      status: [{ name: '0009_elsewhere', applied: false }],
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('cannot be checked for destructive statements')
    expect(result.calls).toEqual(['status', 'close'])
  })

  it('judges every local migration, with no created-in-run exemption, when the config exports no migrationStatus()', async () => {
    // 0001 may well be applied: over the whole history its CREATE must not exempt 0002's DROP.
    const result = await invoke(['db:migrate', '--json'], {
      migrations: { '0001_create': CREATE, '0002_drop': DROP },
    })
    expect(result.exitCode).toBe(1)
    expect(result.calls).toEqual([])
    expect(JSON.parse(result.stdout)).toMatchObject({
      destructive: { pendingFrom: 'all', pending: ['0001_create', '0002_drop'], findings: [{ kind: 'drop-table', migration: '0002_drop' }] },
    })
  })
})

describe('db:migrate with a drizzle config that will not load', () => {
  it('refuses rather than judging the default folder, when the config exports no migrationStatus()', async () => {
    const cwd = await createTempRoot('guren-db-migrate-guard-config-')
    try {
      await mkdir(join(cwd, 'config'))
      await writeFile(join(cwd, 'config/database.ts'), `
import { appendFileSync } from 'node:fs'
export async function migrateDatabase() { appendFileSync('calls.txt', 'migrate\\n'); return { migrationsFound: 1, looseSqlFiles: 0 } }
`)
      await writeFile(join(cwd, 'drizzle.config.ts'), "throw new Error('DATABASE_URL is not set')\n")
      await mkdir(join(cwd, 'elsewhere/0001_drop'), { recursive: true })
      await writeFile(join(cwd, 'elsewhere/0001_drop/migration.sql'), DROP)
      const result = await run(cwd, ['db:migrate'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Could not load drizzle.config.ts')
      expect(await readFile(join(cwd, 'calls.txt'), 'utf8').catch(() => '')).toBe('')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('db:migrate against a real SQLite app', () => {
  it('refuses, then applies once acknowledged, over the factory a scaffolded app exports', async () => {
    const cwd = await createTempRoot('guren-db-migrate-guard-sqlite-')
    try {
      await mkdir(join(cwd, 'config'))
      await writeFile(join(cwd, 'config/database.ts'), `
import { createSqliteDatabase } from ${JSON.stringify(ORM_SQLITE)}
const database = createSqliteDatabase({ migrationsFolder: new URL('../db/migrations', import.meta.url), filename: './app.db' })
export const { migrateDatabase, closeDatabase, migrationStatus } = database
`)
      await writeMigrations(cwd, { '0001_create': 'CREATE TABLE `posts` (`id` integer PRIMARY KEY, `title` text);' })
      expect((await run(cwd, ['db:migrate'])).exitCode).toBe(0)
      const raw = new Database(join(cwd, 'app.db'))
      raw.exec("INSERT INTO posts (title) VALUES ('kept')")
      raw.close()

      await writeMigrations(cwd, { '0002_drop': 'DROP TABLE `posts`;' })
      const refused = await run(cwd, ['db:migrate', '--json'])
      expect(refused.exitCode).toBe(1)
      expect(JSON.parse(refused.stdout).destructive.findings).toMatchObject([{ file: 'db/migrations/0002_drop/migration.sql', line: 1 }])

      await writeMigrations(cwd, { '0002_drop': '-- guren:allow-destructive: test\nDROP TABLE `posts`;' })
      const accepted = await run(cwd, ['db:migrate', '--json'])
      expect(accepted.exitCode).toBe(0)
      const after = new Database(join(cwd, 'app.db'))
      expect(after.query("SELECT name FROM sqlite_master WHERE name = 'posts'").all()).toEqual([])
      after.close()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
