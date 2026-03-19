import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, lstatSync, readlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createStorageLink, removeStorageLink, hasStorageLink } from '../src/storage-link'

describe('storage-link', () => {
  const testDir = resolve(import.meta.dir, '.test-storage-link')
  const storagePath = join(testDir, 'storage/app/public')
  const publicPath = join(testDir, 'public/storage')

  beforeEach(() => {
    // Clean up and create fresh test directories
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true })
    }
    mkdirSync(storagePath, { recursive: true })
    mkdirSync(join(testDir, 'public'), { recursive: true })
  })

  afterEach(() => {
    // Clean up test directories
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true })
    }
  })

  describe('createStorageLink', () => {
    test('creates symbolic link from public/storage to storage/app/public', () => {
      const result = createStorageLink({ appRoot: testDir })

      expect(result).toBe(true)
      expect(existsSync(publicPath)).toBe(true)
      expect(lstatSync(publicPath).isSymbolicLink()).toBe(true)
    })

    test('returns false if storage directory does not exist', () => {
      rmSync(storagePath, { recursive: true })

      const result = createStorageLink({ appRoot: testDir })

      expect(result).toBe(false)
      expect(existsSync(publicPath)).toBe(false)
    })

    test('returns true if link already exists (no force)', () => {
      // Create initial link
      createStorageLink({ appRoot: testDir })
      expect(existsSync(publicPath)).toBe(true)

      // Try to create again without force
      const result = createStorageLink({ appRoot: testDir })

      expect(result).toBe(true)
    })

    test('recreates link with force option', () => {
      // Create initial link
      createStorageLink({ appRoot: testDir })

      // Recreate with force
      const result = createStorageLink({ appRoot: testDir, force: true })

      expect(result).toBe(true)
      expect(existsSync(publicPath)).toBe(true)
      expect(lstatSync(publicPath).isSymbolicLink()).toBe(true)
    })

    test('creates relative symlink when relative option is true', () => {
      const result = createStorageLink({ appRoot: testDir, relative: true })

      expect(result).toBe(true)
      expect(existsSync(publicPath)).toBe(true)
      expect(lstatSync(publicPath).isSymbolicLink()).toBe(true)

      // Check that the link target is relative
      const linkTarget = readlinkSync(publicPath)
      expect(linkTarget.startsWith('..')).toBe(true)
    })
  })

  describe('removeStorageLink', () => {
    test('removes existing symbolic link', () => {
      createStorageLink({ appRoot: testDir })
      expect(existsSync(publicPath)).toBe(true)

      const result = removeStorageLink({ appRoot: testDir })

      expect(result).toBe(true)
      expect(existsSync(publicPath)).toBe(false)
    })

    test('returns true if link does not exist', () => {
      const result = removeStorageLink({ appRoot: testDir })

      expect(result).toBe(true)
    })
  })

  describe('hasStorageLink', () => {
    test('returns true if storage link exists', () => {
      createStorageLink({ appRoot: testDir })

      const result = hasStorageLink({ appRoot: testDir })

      expect(result).toBe(true)
    })

    test('returns false if storage link does not exist', () => {
      const result = hasStorageLink({ appRoot: testDir })

      expect(result).toBe(false)
    })

    test('returns false if path exists but is not a symbolic link', () => {
      // Create a regular directory instead of a symlink
      mkdirSync(publicPath, { recursive: true })

      const result = hasStorageLink({ appRoot: testDir })

      expect(result).toBe(false)
    })
  })
})
