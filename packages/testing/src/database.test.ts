import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertDatabaseCount,
  assertDatabaseEmpty,
  assertDatabaseHas,
  assertDatabaseMissing,
  assertNotSoftDeleted,
  assertSoftDeleted,
  createDatabaseAssertions,
  setTestDatabase,
  useDatabaseTransactions,
  useTruncateTables,
} from './database'
import type { DatabaseConnection } from './database'

describe('database helpers', () => {
  it('throws when test database is not configured', async () => {
    vi.resetModules()
    const { getTestDatabase } = await import('./database')
    expect(() => getTestDatabase()).toThrow('Test database not configured')
  })

  it('asserts presence and counts', async () => {
    const db: DatabaseConnection = {
      query: vi.fn().mockResolvedValue([{ count: 1 }]),
      execute: vi.fn(),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
    }

    setTestDatabase(db)

    await expect(assertDatabaseHas('users', { id: 1 })).resolves.toBeUndefined()
    await expect(assertDatabaseMissing('users', { id: 2 })).rejects.toThrow()

    db.query = vi.fn().mockResolvedValue([{ count: 2 }])
    await expect(assertDatabaseCount('users', 2)).resolves.toBeUndefined()

    db.query = vi.fn().mockResolvedValue([{ count: 0 }])
    await expect(assertDatabaseEmpty('logs')).resolves.toBeUndefined()
  })

  it('asserts soft deletes', async () => {
    const db: DatabaseConnection = {
      query: vi.fn().mockResolvedValue([{ deleted_at: '2024-01-01' }]),
      execute: vi.fn(),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
    }

    await expect(assertSoftDeleted('users', { id: 1 }, 'deleted_at', db)).resolves.toBeUndefined()

    db.query = vi.fn().mockResolvedValue([{ deleted_at: null }])
    await expect(assertNotSoftDeleted('users', { id: 1 }, 'deleted_at', db)).resolves.toBeUndefined()
  })

  it('creates database assertion helpers', async () => {
    const db: DatabaseConnection = {
      query: vi.fn().mockResolvedValue([{ count: 1 }]),
      execute: vi.fn(),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
    }
    const assertions = createDatabaseAssertions(db)

    await expect(assertions.assertHas('users', { id: 1 })).resolves.toBeUndefined()
  })
})

describe('database hooks', () => {
  const db: DatabaseConnection = {
    query: vi.fn().mockResolvedValue([{ count: 0 }]),
    execute: vi.fn(),
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
  }

  afterEach(() => {
    expect(db.rollback).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()
  })

  useDatabaseTransactions(db, { beforeEach, afterEach })
  useTruncateTables(['users'], db, { beforeEach, afterEach })

  it('runs transaction and truncate hooks', () => {
    expect(db.beginTransaction).toHaveBeenCalledTimes(1)
    expect(db.execute).toHaveBeenCalledWith('DELETE FROM users')
  })
})

describe('lifecycle hook resolution', () => {
  it('throws a setup hint when no hooks are registered or injected', async () => {
    vi.resetModules()
    const { useDatabaseTransactions: use } = await import('./database')
    expect(() => use()).toThrow('@guren/testing/vitest')
  })

  it('uses hooks registered via setTestLifecycleHooks', async () => {
    vi.resetModules()
    const { setTestLifecycleHooks } = await import('./lifecycle')
    const { useDatabaseTransactions: use } = await import('./database')

    const registered = { beforeEach: vi.fn(), afterEach: vi.fn() }
    setTestLifecycleHooks(registered)
    use()

    expect(registered.beforeEach).toHaveBeenCalledTimes(1)
    expect(registered.afterEach).toHaveBeenCalledTimes(1)
  })

  it('registers vitest hooks when the vitest entry is imported', async () => {
    vi.resetModules()
    await import('./vitest')
    const { getTestLifecycleHooks } = await import('./lifecycle')
    expect(() => getTestLifecycleHooks()).not.toThrow()
  })
})
