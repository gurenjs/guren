import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resetDatabase } from '../src/db-migrate'

describe('resetDatabase', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'guren-cli-db-reset-test-'))
    originalCwd = process.cwd()
    process.chdir(tempDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  it('calls resetDatabase and migrateDatabase in sequence', async () => {
    const calls: string[] = []

    await mkdir(join(tempDir, 'config'), { recursive: true })
    await writeFile(
      join(tempDir, 'config/database.ts'),
      `
export async function resetDatabase() {
  (globalThis as any).__calls.push('reset')
}

export async function migrateDatabase() {
  (globalThis as any).__calls.push('migrate')
}

export async function closeDatabase() {
  (globalThis as any).__calls.push('close')
}
`,
      'utf8',
    )

    ;(globalThis as any).__calls = calls

    await resetDatabase()

    expect(calls).toEqual(['reset', 'migrate', 'close'])

    delete (globalThis as any).__calls
  })

  it('calls seedDatabase when seed option is true', async () => {
    const calls: string[] = []

    await mkdir(join(tempDir, 'config'), { recursive: true })
    await writeFile(
      join(tempDir, 'config/database.ts'),
      `
export async function resetDatabase() {
  (globalThis as any).__calls.push('reset')
}

export async function migrateDatabase() {
  (globalThis as any).__calls.push('migrate')
}

export async function seedDatabase() {
  (globalThis as any).__calls.push('seed')
}

export async function closeDatabase() {
  (globalThis as any).__calls.push('close')
}
`,
      'utf8',
    )

    ;(globalThis as any).__calls = calls

    const summary = await resetDatabase({ seed: true })

    expect(calls).toEqual(['reset', 'migrate', 'seed', 'close'])
    // Neither half reports anything here, which is what an app on an older
    // @guren/orm looks like — both commands must keep their plain ✔ rather
    // than warning about a run they cannot describe.
    expect(summary).toEqual({ migrations: undefined, seeders: undefined })

    delete (globalThis as any).__calls
  })

  it('does not call seedDatabase when seed option is false', async () => {
    const calls: string[] = []

    await mkdir(join(tempDir, 'config'), { recursive: true })
    await writeFile(
      join(tempDir, 'config/database.ts'),
      `
export async function resetDatabase() {
  (globalThis as any).__calls.push('reset')
}

export async function migrateDatabase() {
  (globalThis as any).__calls.push('migrate')
}

export async function seedDatabase() {
  (globalThis as any).__calls.push('seed')
}

export async function closeDatabase() {
  (globalThis as any).__calls.push('close')
}
`,
      'utf8',
    )

    ;(globalThis as any).__calls = calls

    await resetDatabase({ seed: false })

    expect(calls).not.toContain('seed')

    delete (globalThis as any).__calls
  })

  it('refuses to seed a config with no seed function, before dropping anything', async () => {
    const calls: string[] = []

    await mkdir(join(tempDir, 'config'), { recursive: true })
    await writeFile(
      join(tempDir, 'config/database.ts'),
      `
export async function resetDatabase() {
  (globalThis as any).__calls.push('reset')
}

export async function migrateDatabase() {
  (globalThis as any).__calls.push('migrate')
}
`,
      'utf8',
    )

    ;(globalThis as any).__calls = calls

    await expect(resetDatabase({ seed: true })).rejects.toThrow('must export seedDatabase() or runSeeders()')
    // The alternative was to drop every table and then report a seed that
    // never ran, which is the ✔ this whole guard exists to prevent.
    expect(calls).toEqual([])

    delete (globalThis as any).__calls
  })

  it('throws error when resetDatabase function is not exported', async () => {
    await mkdir(join(tempDir, 'config'), { recursive: true })
    await writeFile(
      join(tempDir, 'config/database.ts'),
      `
export async function migrateDatabase() {}
`,
      'utf8',
    )

    await expect(resetDatabase()).rejects.toThrow('must export resetDatabase()')
  })

  it('throws error when migrateDatabase function is not exported', async () => {
    await mkdir(join(tempDir, 'config'), { recursive: true })
    await writeFile(
      join(tempDir, 'config/database.ts'),
      `
export async function resetDatabase() {}
`,
      'utf8',
    )

    await expect(resetDatabase()).rejects.toThrow('must export migrateDatabase()')
  })

  it('supports dropAllTables as alternative to resetDatabase', async () => {
    const calls: string[] = []

    await mkdir(join(tempDir, 'config'), { recursive: true })
    await writeFile(
      join(tempDir, 'config/database.ts'),
      `
export async function dropAllTables() {
  (globalThis as any).__calls.push('drop')
}

export async function migrateDatabase() {
  (globalThis as any).__calls.push('migrate')
}
`,
      'utf8',
    )

    ;(globalThis as any).__calls = calls

    await resetDatabase()

    expect(calls).toContain('drop')
    expect(calls).toContain('migrate')

    delete (globalThis as any).__calls
  })
})

