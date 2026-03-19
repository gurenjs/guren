import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanMigrationFiles,
  ensureMigrationTable,
  getAppliedMigrations,
  getLastBatch,
  recordMigration,
  removeMigrationRecord,
  getLastBatchMigrations,
  rollbackMigrations,
  getMigrationStatus,
  type SqlExecutor,
  type MigrationRecord,
} from '../src/migration-tracker'

/**
 * In-memory SQL executor for testing.
 */
class MemorySqlExecutor implements SqlExecutor {
  private tables: Map<string, unknown[]> = new Map()
  private idCounter = 0

  constructor() {
    this.tables.set('_guren_migrations', [])
  }

  async execute(sql: string): Promise<void> {
    // Parse and execute simple SQL for testing
    if (sql.includes('CREATE TABLE IF NOT EXISTS "_guren_migrations"')) {
      // Table already initialized in constructor
      return
    }

    if (sql.includes('INSERT INTO "_guren_migrations"')) {
      const match = sql.match(/VALUES \('(.+)', (\d+)\)/)
      if (match) {
        const migrations = this.tables.get('_guren_migrations') as MigrationRecord[]
        migrations.push({
          id: ++this.idCounter,
          name: match[1],
          batch: parseInt(match[2], 10),
          executed_at: new Date(),
        })
      }
      return
    }

    if (sql.includes('DELETE FROM "_guren_migrations"')) {
      const match = sql.match(/WHERE "name" = '(.+)'/)
      if (match) {
        const migrations = this.tables.get('_guren_migrations') as MigrationRecord[]
        const index = migrations.findIndex((m) => m.name === match[1])
        if (index >= 0) {
          migrations.splice(index, 1)
        }
      }
      return
    }

    // For down migrations, just track that it was executed
    if (sql.includes('DROP TABLE') || sql.includes('ALTER TABLE')) {
      // Simulated execution
      return
    }
  }

  async query<T>(sql: string): Promise<T[]> {
    const migrations = this.tables.get('_guren_migrations') as MigrationRecord[]

    if (sql.includes('SELECT * FROM "_guren_migrations"')) {
      if (sql.includes('WHERE "batch"')) {
        const match = sql.match(/WHERE "batch" = (\d+)/)
        if (match) {
          const batch = parseInt(match[1], 10)
          const filtered = migrations.filter((m) => m.batch === batch)
          return filtered.sort((a, b) => b.id - a.id) as T[]
        }
      }
      return migrations.slice().sort((a, b) => b.id - a.id) as T[]
    }

    if (sql.includes('SELECT MAX("batch")')) {
      const maxBatch = migrations.reduce((max, m) => Math.max(max, m.batch), 0)
      return [{ max: maxBatch || null }] as T[]
    }

    return []
  }

  getMigrations(): MigrationRecord[] {
    return this.tables.get('_guren_migrations') as MigrationRecord[]
  }
}

describe('Migration Tracker', () => {
  let executor: MemorySqlExecutor
  let tmpDir: string

  beforeEach(async () => {
    executor = new MemorySqlExecutor()
    tmpDir = await mkdtemp(join(tmpdir(), 'guren-migrations-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('scanMigrationFiles', () => {
    it('finds migration files', async () => {
      await writeFile(join(tmpDir, '0001_create_users.sql'), 'CREATE TABLE users...')
      await writeFile(join(tmpDir, '0002_create_posts.sql'), 'CREATE TABLE posts...')

      const files = await scanMigrationFiles(tmpDir)

      expect(files).toHaveLength(2)
      expect(files[0].name).toBe('0001_create_users')
      expect(files[1].name).toBe('0002_create_posts')
    })

    it('detects down migrations', async () => {
      await writeFile(join(tmpDir, '0001_create_users.sql'), 'CREATE TABLE users...')
      await writeFile(join(tmpDir, '0001_create_users.down.sql'), 'DROP TABLE users...')
      await writeFile(join(tmpDir, '0002_create_posts.sql'), 'CREATE TABLE posts...')

      const files = await scanMigrationFiles(tmpDir)

      expect(files).toHaveLength(2)
      expect(files[0].hasDownMigration).toBe(true)
      expect(files[0].downPath).toContain('0001_create_users.down.sql')
      expect(files[1].hasDownMigration).toBe(false)
      expect(files[1].downPath).toBeNull()
    })

    it('ignores non-migration files', async () => {
      await writeFile(join(tmpDir, '0001_create_users.sql'), 'CREATE TABLE users...')
      await writeFile(join(tmpDir, 'README.md'), '# Migrations')
      await writeFile(join(tmpDir, '.gitkeep'), '')

      const files = await scanMigrationFiles(tmpDir)

      expect(files).toHaveLength(1)
    })
  })

  describe('ensureMigrationTable', () => {
    it('creates the migrations table', async () => {
      await ensureMigrationTable(executor)
      // Table should exist (initialized in MemorySqlExecutor)
      const migrations = executor.getMigrations()
      expect(Array.isArray(migrations)).toBe(true)
    })
  })

  describe('recordMigration and getAppliedMigrations', () => {
    it('records and retrieves migrations', async () => {
      await ensureMigrationTable(executor)
      await recordMigration(executor, '0001_create_users', 1)
      await recordMigration(executor, '0002_create_posts', 1)

      const applied = await getAppliedMigrations(executor)

      expect(applied).toHaveLength(2)
      expect(applied.map((m) => m.name)).toContain('0001_create_users')
      expect(applied.map((m) => m.name)).toContain('0002_create_posts')
    })

    it('returns migrations in reverse order', async () => {
      await ensureMigrationTable(executor)
      await recordMigration(executor, '0001_create_users', 1)
      await recordMigration(executor, '0002_create_posts', 2)

      const applied = await getAppliedMigrations(executor)

      expect(applied[0].name).toBe('0002_create_posts')
      expect(applied[1].name).toBe('0001_create_users')
    })
  })

  describe('getLastBatch', () => {
    it('returns 0 when no migrations', async () => {
      await ensureMigrationTable(executor)
      const batch = await getLastBatch(executor)
      expect(batch).toBe(0)
    })

    it('returns the highest batch number', async () => {
      await ensureMigrationTable(executor)
      await recordMigration(executor, '0001_create_users', 1)
      await recordMigration(executor, '0002_create_posts', 2)
      await recordMigration(executor, '0003_create_comments', 3)

      const batch = await getLastBatch(executor)

      expect(batch).toBe(3)
    })
  })

  describe('removeMigrationRecord', () => {
    it('removes a migration record', async () => {
      await ensureMigrationTable(executor)
      await recordMigration(executor, '0001_create_users', 1)
      await recordMigration(executor, '0002_create_posts', 1)

      await removeMigrationRecord(executor, '0001_create_users')

      const applied = await getAppliedMigrations(executor)
      expect(applied).toHaveLength(1)
      expect(applied[0].name).toBe('0002_create_posts')
    })
  })

  describe('getLastBatchMigrations', () => {
    it('returns empty array when no migrations', async () => {
      await ensureMigrationTable(executor)
      const migrations = await getLastBatchMigrations(executor)
      expect(migrations).toHaveLength(0)
    })

    it('returns only migrations from the last batch', async () => {
      await ensureMigrationTable(executor)
      await recordMigration(executor, '0001_create_users', 1)
      await recordMigration(executor, '0002_create_posts', 1)
      await recordMigration(executor, '0003_create_comments', 2)

      const migrations = await getLastBatchMigrations(executor)

      expect(migrations).toHaveLength(1)
      expect(migrations[0].name).toBe('0003_create_comments')
    })
  })

  describe('rollbackMigrations', () => {
    it('rolls back the last migration', async () => {
      await writeFile(join(tmpDir, '0001_create_users.sql'), 'CREATE TABLE users...')
      await writeFile(join(tmpDir, '0001_create_users.down.sql'), 'DROP TABLE users;')
      await writeFile(join(tmpDir, '0002_create_posts.sql'), 'CREATE TABLE posts...')
      await writeFile(join(tmpDir, '0002_create_posts.down.sql'), 'DROP TABLE posts;')

      await ensureMigrationTable(executor)
      await recordMigration(executor, '0001_create_users', 1)
      await recordMigration(executor, '0002_create_posts', 1)

      const rolledBack = await rollbackMigrations(executor, {
        migrationsDir: tmpDir,
        steps: 1,
      })

      expect(rolledBack).toHaveLength(1)
      expect(rolledBack[0]).toBe('0002_create_posts')

      const applied = await getAppliedMigrations(executor)
      expect(applied).toHaveLength(1)
    })

    it('rolls back multiple migrations', async () => {
      await writeFile(join(tmpDir, '0001_create_users.sql'), 'CREATE TABLE users...')
      await writeFile(join(tmpDir, '0001_create_users.down.sql'), 'DROP TABLE users;')
      await writeFile(join(tmpDir, '0002_create_posts.sql'), 'CREATE TABLE posts...')
      await writeFile(join(tmpDir, '0002_create_posts.down.sql'), 'DROP TABLE posts;')

      await ensureMigrationTable(executor)
      await recordMigration(executor, '0001_create_users', 1)
      await recordMigration(executor, '0002_create_posts', 1)

      const rolledBack = await rollbackMigrations(executor, {
        migrationsDir: tmpDir,
        steps: 2,
      })

      expect(rolledBack).toHaveLength(2)
      const applied = await getAppliedMigrations(executor)
      expect(applied).toHaveLength(0)
    })

    it('throws when down migration is missing', async () => {
      await writeFile(join(tmpDir, '0001_create_users.sql'), 'CREATE TABLE users...')
      // No down migration file

      await ensureMigrationTable(executor)
      await recordMigration(executor, '0001_create_users', 1)

      await expect(
        rollbackMigrations(executor, { migrationsDir: tmpDir })
      ).rejects.toThrow('No down migration found')
    })

    it('rolls back entire batch with batch option', async () => {
      await writeFile(join(tmpDir, '0001_create_users.sql'), 'CREATE TABLE users...')
      await writeFile(join(tmpDir, '0001_create_users.down.sql'), 'DROP TABLE users;')
      await writeFile(join(tmpDir, '0002_create_posts.sql'), 'CREATE TABLE posts...')
      await writeFile(join(tmpDir, '0002_create_posts.down.sql'), 'DROP TABLE posts;')
      await writeFile(join(tmpDir, '0003_create_comments.sql'), 'CREATE TABLE comments...')
      await writeFile(join(tmpDir, '0003_create_comments.down.sql'), 'DROP TABLE comments;')

      await ensureMigrationTable(executor)
      await recordMigration(executor, '0001_create_users', 1)
      await recordMigration(executor, '0002_create_posts', 2)
      await recordMigration(executor, '0003_create_comments', 2)

      const rolledBack = await rollbackMigrations(executor, {
        migrationsDir: tmpDir,
        batch: true,
      })

      expect(rolledBack).toHaveLength(2)
      expect(rolledBack).toContain('0002_create_posts')
      expect(rolledBack).toContain('0003_create_comments')

      const applied = await getAppliedMigrations(executor)
      expect(applied).toHaveLength(1)
      expect(applied[0].name).toBe('0001_create_users')
    })

    it('returns empty array when nothing to rollback', async () => {
      await ensureMigrationTable(executor)

      const rolledBack = await rollbackMigrations(executor, {
        migrationsDir: tmpDir,
      })

      expect(rolledBack).toHaveLength(0)
    })
  })

  describe('getMigrationStatus', () => {
    it('returns status of all migrations', async () => {
      await writeFile(join(tmpDir, '0001_create_users.sql'), 'CREATE TABLE users...')
      await writeFile(join(tmpDir, '0001_create_users.down.sql'), 'DROP TABLE users;')
      await writeFile(join(tmpDir, '0002_create_posts.sql'), 'CREATE TABLE posts...')

      await ensureMigrationTable(executor)
      await recordMigration(executor, '0001_create_users', 1)

      const status = await getMigrationStatus(executor, tmpDir)

      expect(status).toHaveLength(2)

      const usersStatus = status.find((s) => s.name === '0001_create_users')
      expect(usersStatus?.applied).toBe(true)
      expect(usersStatus?.batch).toBe(1)
      expect(usersStatus?.hasDownMigration).toBe(true)

      const postsStatus = status.find((s) => s.name === '0002_create_posts')
      expect(postsStatus?.applied).toBe(false)
      expect(postsStatus?.batch).toBeNull()
      expect(postsStatus?.hasDownMigration).toBe(false)
    })
  })
})
