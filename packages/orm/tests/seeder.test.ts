import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defineSeeder, loadSeeders, runSeeders, type SeederContext } from '../src/seeder'

describe('defineSeeder', () => {
  it('returns the handler function unchanged', () => {
    const handler = (ctx: SeederContext) => {
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

  it('returns empty array for a directory that does not exist', async () => {
    const seeders = await loadSeeders(join(tempDir, 'never-created'))
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

describe('runSeeders run summary', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'seeder-summary-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  // The scaffolded `db/seeders/` ships holding only .gitkeep, so this is the shape a fresh app reports.
  it('should report nothing ran for a folder holding no seeders', async () => {
    await writeFile(join(tempDir, '.gitkeep'), '')

    expect(await runSeeders({}, tempDir)).toEqual({
      seedersFolder: tempDir,
      seedersRan: 0,
      filesWithoutSeeder: 0,
    })
  })

  it('should report how many seeders ran', async () => {
    await writeFile(join(tempDir, '01-first.ts'), `export default (ctx) => { ctx.db.ran = true; }`)
    await writeFile(join(tempDir, '02-second.ts'), `export const seed = () => {};`)

    expect(await runSeeders({}, tempDir)).toEqual({
      seedersFolder: tempDir,
      seedersRan: 2,
      filesWithoutSeeder: 0,
    })
  })

  // A "run make:seeder" hint would misdiagnose this: the files are there, they
  // just export nothing runnable.
  it('should count files that exported no seeder', async () => {
    await writeFile(join(tempDir, 'helpers.ts'), `export const fixtures = [1, 2, 3];`)
    await writeFile(join(tempDir, 'types.ts'), `export const kind = 'seed';`)

    expect(await runSeeders({}, tempDir)).toEqual({
      seedersFolder: tempDir,
      seedersRan: 0,
      filesWithoutSeeder: 2,
    })
  })

  // A .d.ts carries a supported extension but can never export a seeder, so
  // counting it would suppress the make:seeder hint for an empty folder.
  it('should not count declaration files as seeders that failed to export', async () => {
    await writeFile(join(tempDir, 'fixtures.d.ts'), `export declare const rows: number[]`)

    expect(await runSeeders({}, tempDir)).toEqual({
      seedersFolder: tempDir,
      seedersRan: 0,
      filesWithoutSeeder: 0,
    })
  })

  // Non-seeder extensions were never candidates, so they are not "skipped".
  it('should not count files the loader never considered', async () => {
    await writeFile(join(tempDir, 'seed.ts'), `export default () => {};`)
    await writeFile(join(tempDir, 'README.md'), '# Seeders')

    expect(await runSeeders({}, tempDir)).toEqual({
      seedersFolder: tempDir,
      seedersRan: 1,
      filesWithoutSeeder: 0,
    })
  })

  // A missing db/seeders/ holds no seeders, which is the nothing-to-run case
  // db:seed already reports — not a database failure. `inspectMigrationsFolder()`
  // answers the same way for a missing db/migrations.
  it('should report nothing ran for a folder that does not exist', async () => {
    const missing = join(tempDir, 'never-created')

    expect(await runSeeders({}, missing)).toEqual({
      seedersFolder: missing,
      seedersRan: 0,
      filesWithoutSeeder: 0,
    })
  })

  // A dangling symlink gives the same ENOENT as a folder that was never created,
  // so it reads as absent rather than as an error of its own.
  it('should report nothing ran for a dangling symlink', async () => {
    const link = join(tempDir, 'seeders')
    await symlink(join(tempDir, 'never-created'), link)

    expect(await runSeeders({}, link)).toEqual({
      seedersFolder: link,
      seedersRan: 0,
      filesWithoutSeeder: 0,
    })
  })

  // Absence is ENOENT and nothing else: a file where the folder belongs is a
  // misconfiguration, and "empty folder" would send the user to `make:seeder`
  // to write into a path that cannot hold one.
  it('should not report nothing ran for a file where the folder belongs', async () => {
    const notAFolder = join(tempDir, 'seeders')
    await writeFile(notAFolder, '')

    await expect(runSeeders({}, notAFolder)).rejects.toThrow(/ENOTDIR/)
  })

  // Configs pass the folder as a URL, so the guard has to hold on that path too.
  it('should report nothing ran for a missing folder given as a URL', async () => {
    const missing = join(tempDir, 'never-created')

    expect(await runSeeders({}, new URL(`file://${missing}`))).toEqual({
      seedersFolder: missing,
      seedersRan: 0,
      filesWithoutSeeder: 0,
    })
  })

  // The folder is reported as a path even when it was configured as a URL —
  // `seedersFolder: new URL(...)` is what the scaffolded config passes.
  it('should report a filesystem path for a URL directory', async () => {
    await writeFile(join(tempDir, 'seed.ts'), `export default () => {};`)

    expect(await runSeeders({}, new URL(`file://${tempDir}`))).toEqual({
      seedersFolder: tempDir,
      seedersRan: 1,
      filesWithoutSeeder: 0,
    })
  })
})
