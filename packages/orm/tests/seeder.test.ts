import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defineSeeder, loadSeeders, runSeeders, type SeederContext } from '../src/seeder'

describe('defineSeeder', () => {
  it('returns the handler function unchanged', () => {
    const handler = (ctx: SeederContext) => {
      // seeder logic
    }

    const result = defineSeeder(handler)

    expect(result).toBe(handler)
  })
})

describe('loadSeeders', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'seeder-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('loads seeders from directory sorted by filename', async () => {
    // Seeders receive { db } context, so they access ctx.db
    await writeFile(
      join(tempDir, '02-second.ts'),
      `export default function(ctx) { ctx.db.order = ctx.db.order || []; ctx.db.order.push('second'); }`,
    )
    await writeFile(
      join(tempDir, '01-first.ts'),
      `export default function(ctx) { ctx.db.order = ctx.db.order || []; ctx.db.order.push('first'); }`,
    )

    const seeders = await loadSeeders(tempDir)

    expect(seeders).toHaveLength(2)

    const mockDb: { order?: string[] } = {}
    for (const seeder of seeders) {
      await seeder({ db: mockDb as never })
    }

    expect(mockDb.order).toEqual(['first', 'second'])
  })

  it('supports export const seed pattern', async () => {
    await writeFile(
      join(tempDir, 'seed.ts'),
      `export const seed = (ctx) => { ctx.db.called = true; }`,
    )

    const seeders = await loadSeeders(tempDir)
    expect(seeders).toHaveLength(1)

    const mockDb: { called?: boolean } = {}
    await seeders[0]({ db: mockDb as never })
    expect(mockDb.called).toBe(true)
  })

  it('supports export const run pattern', async () => {
    await writeFile(
      join(tempDir, 'runner.ts'),
      `export const run = (ctx) => { ctx.db.ran = true; }`,
    )

    const seeders = await loadSeeders(tempDir)
    expect(seeders).toHaveLength(1)

    const mockDb: { ran?: boolean } = {}
    await seeders[0]({ db: mockDb as never })
    expect(mockDb.ran).toBe(true)
  })

  it('supports class-based seeders with run method', async () => {
    await writeFile(
      join(tempDir, 'class-seeder.ts'),
      `export class Seeder {
        run(ctx) { ctx.db.classRan = true; }
      }`,
    )

    const seeders = await loadSeeders(tempDir)
    expect(seeders).toHaveLength(1)

    const mockDb: { classRan?: boolean } = {}
    await seeders[0]({ db: mockDb as never })
    expect(mockDb.classRan).toBe(true)
  })

  it('supports object with run method as default export', async () => {
    await writeFile(
      join(tempDir, 'object-seeder.ts'),
      `export default { run: (ctx) => { ctx.db.objectRan = true; } }`,
    )

    const seeders = await loadSeeders(tempDir)
    expect(seeders).toHaveLength(1)

    const mockDb: { objectRan?: boolean } = {}
    await seeders[0]({ db: mockDb as never })
    expect(mockDb.objectRan).toBe(true)
  })

  it('ignores files without valid seeder export', async () => {
    await writeFile(
      join(tempDir, 'valid.ts'),
      `export default (ctx) => { ctx.db.valid = true; }`,
    )
    await writeFile(
      join(tempDir, 'invalid.ts'),
      `export const notASeeder = 'hello';`,
    )

    const seeders = await loadSeeders(tempDir)
    expect(seeders).toHaveLength(1)
  })

  it('ignores non-js/ts files', async () => {
    await writeFile(
      join(tempDir, 'seed.ts'),
      `export default (ctx) => { ctx.db.seeded = true; }`,
    )
    await writeFile(
      join(tempDir, 'readme.md'),
      `# Seeders`,
    )
    await writeFile(
      join(tempDir, 'data.json'),
      `{}`,
    )

    const seeders = await loadSeeders(tempDir)
    expect(seeders).toHaveLength(1)
  })

  it('supports URL input for directory', async () => {
    await writeFile(
      join(tempDir, 'url-seeder.ts'),
      `export default (ctx) => { ctx.db.url = true; }`,
    )

    const seeders = await loadSeeders(new URL(`file://${tempDir}`))
    expect(seeders).toHaveLength(1)
  })

  it('returns empty array for empty directory', async () => {
    const seeders = await loadSeeders(tempDir)
    expect(seeders).toEqual([])
  })
})

describe('runSeeders', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'seeder-run-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('runs all seeders in sequence', async () => {
    // runSeeders passes db directly, so seeder receives { db: mockDb }
    // and accesses ctx.db to get mockDb
    await writeFile(
      join(tempDir, '01-first.ts'),
      `export default (ctx) => { ctx.db.results = ctx.db.results || []; ctx.db.results.push(1); }`,
    )
    await writeFile(
      join(tempDir, '02-second.ts'),
      `export default (ctx) => { ctx.db.results = ctx.db.results || []; ctx.db.results.push(2); }`,
    )

    const mockDb: { results?: number[] } = {}
    await runSeeders(mockDb, tempDir)

    expect(mockDb.results).toEqual([1, 2])
  })

  it('handles async seeders', async () => {
    await writeFile(
      join(tempDir, 'async-seeder.ts'),
      `export default async (ctx) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        ctx.db.asyncDone = true;
      }`,
    )

    const mockDb: { asyncDone?: boolean } = {}
    await runSeeders(mockDb, tempDir)

    expect(mockDb.asyncDone).toBe(true)
  })
})
