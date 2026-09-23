import { describe, expect, it } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CLI_BIN_PATH, createTempRoot } from './helpers'

async function invoke(args: string[], production = false, failMigration = false) {
  const cwd = await createTempRoot('guren-db-command-boundary-')
  try {
    await mkdir(join(cwd, 'config'))
    await writeFile(join(cwd, 'config/database.ts'), `
import { appendFileSync } from 'node:fs'
const record = (event: string) => appendFileSync('calls.txt', event + '\\n')
record('import')
export async function resetDatabase() { record('reset') }
export async function migrateDatabase() {
  record('migrate')
  ${failMigration ? "throw new Error('fixture migration failed')" : 'return { migrationsFound: 2, looseSqlFiles: 0 }'}
}
export async function seedDatabase() { record('seed'); return { seedersRan: 1, filesWithoutSeeder: 0 } }
export async function migrationStatus() { record('status'); return [] }
export async function closeDatabase() { record('close') }
`)
    const child = Bun.spawn(['bun', CLI_BIN_PATH, ...args], {
      cwd,
      env: { ...process.env, NODE_ENV: production ? 'production' : 'development' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    const calls = await readFile(join(cwd, 'calls.txt'), 'utf8').catch(() => '')
    return { stdout, stderr, exitCode, calls: calls.trim().split('\n').filter(Boolean) }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

describe('database command boundary', () => {
  for (const command of ['db:seed', 'db:reset', 'db:fresh']) {
    it(`${command} refuses production before importing application database code`, async () => {
      const result = await invoke([command, '--dry-run', '--json'], true)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Use --force to run in production')
      expect(result.calls).toEqual([])
    })

    it(`${command} permits forced production dry runs without importing database code`, async () => {
      const result = await invoke([command, '--force', '--dry-run', '--json'], true)
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ action: command, dryRun: true })
      expect(result.calls).toEqual([])
    })
  }

  it('db:migrate dry-run returns JSON without importing database code', async () => {
    const result = await invoke(['db:migrate', '--dry-run', '--json'], true)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ action: 'db:migrate', dryRun: true })
    expect(result.calls).toEqual([])
  })

  for (const command of ['db:reset', 'db:fresh']) {
    it(`${command} keeps reset, migration, seed, and close ordering`, async () => {
      const result = await invoke([command, '--force', '--seed', '--json'], true)
      expect(result.exitCode).toBe(0)
      expect(result.calls).toEqual(['import', 'reset', 'migrate', 'seed', 'close'])
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: command, success: true, seed: true, migrationsFound: 2, seedersRan: 1,
      })
    })
  }

  it('a failed migration closes the database and exits unsuccessfully', async () => {
    const result = await invoke(['db:reset', '--seed', '--json'], false, true)
    expect(result.exitCode).toBe(1)
    expect(result.calls).toEqual(['import', 'reset', 'migrate', 'close'])
    expect(result.stderr).toContain('fixture migration failed')
    expect(result.stdout).toBe('')
  })

  it('db:rollback reports unsupported and exits 1 without loading the database', async () => {
    const result = await invoke(['db:rollback', '--json'])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ command: 'db:rollback', status: 'unsupported' })
    expect(result.calls).toEqual([])
  })

  it('db:status preserves JSON output and closes the database', async () => {
    const result = await invoke(['db:status', '--json'])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ command: 'db:status', migrations: [] })
    expect(result.calls).toEqual(['import', 'status', 'close'])
  })
})
