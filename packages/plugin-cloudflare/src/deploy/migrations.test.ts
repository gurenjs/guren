import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decideLayout, migrationDirArgs, readLocalMigrations } from './migrations'

const local = { folders: ['20261001_init', '20261002_posts'], files: [] }

describe('decideLayout', () => {
  // The flat copy is what the guide's manual apply and Wrangler record, so a fresh database starts there.
  test('should put a fresh database, or one with no tracker, on the flat layout with everything pending', () => {
    expect(decideLayout(local, null)).toEqual({
      ok: true,
      layout: 'flat',
      pendingFolders: local.folders,
      pendingFiles: [],
      pending: local.folders,
    })
    expect(decideLayout(local, [])).toMatchObject({ layout: 'flat', pending: local.folders })
  })

  test('should keep a database Wrangler migrated on the flat layout', () => {
    expect(decideLayout(local, ['20261001_init.sql'])).toMatchObject({ layout: 'flat', pending: ['20261002_posts'] })
  })

  test('should keep a database cf migrated from the nested layout on it', () => {
    expect(decideLayout(local, ['20261001_init/migration.sql'])).toMatchObject({ layout: 'nested', pending: ['20261002_posts'] })
    expect(decideLayout(local, ['20261001_init/migration.sql'], false)).toEqual({ ok: false, unsupported: 'nested', nested: ['20261001_init/migration.sql'] })
  })

  test('should refuse a tracker holding both forms', () => {
    expect(decideLayout(local, ['20261001_init.sql', '20261002_posts/migration.sql'])).toEqual({
      ok: false,
      nested: ['20261002_posts/migration.sql'],
      flat: ['20261001_init.sql'],
    })
  })

  // Wrangler applies the flat copy by file name, so a plain file between two folders runs between them.
  test('should order plain files among folders by the name the tracker records', () => {
    const mixed = { folders: ['0001_init', '0003_cleanup'], files: ['0002_tmp.sql'] }

    expect(decideLayout(mixed, null)).toMatchObject({
      pendingFolders: ['0001_init', '0003_cleanup'],
      pendingFiles: ['0002_tmp.sql'],
      pending: ['0001_init', '0002_tmp.sql', '0003_cleanup'],
    })
  })

  test('should still report a plain file on the nested layout, which never applies it', () => {
    const withFile = { folders: ['0001_init'], files: ['0002_legacy.sql'] }

    expect(decideLayout(withFile, ['0001_init/migration.sql'])).toMatchObject({ layout: 'nested', pendingFiles: ['0002_legacy.sql'] })
  })

  test('should give each layout its cf d1 migrations arguments', () => {
    expect(migrationDirArgs('nested', '.guren/cloudflare/d1-migrations')).toEqual(['--dir', 'db/migrations', '--pattern', 'db/migrations/*/migration.sql'])
    expect(migrationDirArgs('flat', '.guren/cloudflare/d1-migrations')).toEqual(['--dir', '.guren/cloudflare/d1-migrations'])
  })
})

describe('readLocalMigrations', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guren-cf-migrations-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('should read the folders flattenD1Migrations copies, sorted, and skip meta and empty folders', () => {
    for (const folder of ['20261002_posts', '20261001_init']) {
      mkdirSync(join(dir, folder))
      writeFileSync(join(dir, folder, 'migration.sql'), 'select 1;\n')
    }
    mkdirSync(join(dir, 'meta'))
    mkdirSync(join(dir, 'empty'))
    writeFileSync(join(dir, '0001_legacy.sql'), 'select 1;\n')

    expect(readLocalMigrations(dir)).toEqual({ folders: ['20261001_init', '20261002_posts'], files: ['0001_legacy.sql'] })
    expect(readLocalMigrations(join(dir, 'missing'))).toEqual({ folders: [], files: [] })
  })
})
