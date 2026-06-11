import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LocalDriver,
  MemoryDriver,
  StorageManager,
  createStorageManager,
} from '../../src/storage'

describe('LocalDriver', () => {
  let driver: LocalDriver
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'guren-storage-'))
    driver = new LocalDriver({ root: tmpDir, url: '/storage' })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('put/get', () => {
    it('stores and retrieves a file', async () => {
      await driver.put('test.txt', 'Hello, World!')
      const content = await driver.get('test.txt')
      expect(content?.toString()).toBe('Hello, World!')
    })

    it('stores a buffer', async () => {
      const buffer = Buffer.from('Binary content')
      await driver.put('binary.bin', buffer)
      const content = await driver.get('binary.bin')
      expect(content?.toString()).toBe('Binary content')
    })

    it('creates nested directories', async () => {
      await driver.put('path/to/nested/file.txt', 'Nested content')
      const content = await driver.get('path/to/nested/file.txt')
      expect(content?.toString()).toBe('Nested content')
    })

    it('returns null for missing file', async () => {
      const content = await driver.get('missing.txt')
      expect(content).toBeNull()
    })
  })

  describe('path traversal protection', () => {
    it('rejects writes escaping the storage root', async () => {
      await expect(driver.put('../escape.txt', 'x')).rejects.toThrow('escapes the storage root')
    })

    it('rejects reads escaping the storage root', async () => {
      await expect(driver.get('../../etc/passwd')).rejects.toThrow('escapes the storage root')
    })

    it('rejects deletes escaping the storage root', async () => {
      await expect(driver.delete('../../outside.txt')).rejects.toThrow('escapes the storage root')
    })

    it('allows relative segments that stay within the root', async () => {
      await driver.put('a/../b.txt', 'ok')
      expect(await driver.getAsString('b.txt')).toBe('ok')
    })
  })

  describe('getAsString', () => {
    it('returns content as string', async () => {
      await driver.put('test.txt', 'Hello, World!')
      const content = await driver.getAsString('test.txt')
      expect(content).toBe('Hello, World!')
    })

    it('returns null for missing file', async () => {
      const content = await driver.getAsString('missing.txt')
      expect(content).toBeNull()
    })
  })

  describe('putFile', () => {
    it('copies a local file', async () => {
      const sourcePath = join(tmpDir, 'source.txt')
      await writeFile(sourcePath, 'Source content')

      await driver.putFile('dest.txt', sourcePath)
      const content = await driver.getAsString('dest.txt')
      expect(content).toBe('Source content')
    })
  })

  describe('exists', () => {
    it('returns true for existing file', async () => {
      await driver.put('test.txt', 'content')
      expect(await driver.exists('test.txt')).toBe(true)
    })

    it('returns false for missing file', async () => {
      expect(await driver.exists('missing.txt')).toBe(false)
    })
  })

  describe('delete', () => {
    it('deletes an existing file', async () => {
      await driver.put('test.txt', 'content')
      expect(await driver.delete('test.txt')).toBe(true)
      expect(await driver.exists('test.txt')).toBe(false)
    })

    it('returns false for missing file', async () => {
      expect(await driver.delete('missing.txt')).toBe(false)
    })
  })

  describe('deleteMany', () => {
    it('deletes multiple files', async () => {
      await driver.put('file1.txt', 'content1')
      await driver.put('file2.txt', 'content2')
      await driver.put('file3.txt', 'content3')

      const deleted = await driver.deleteMany(['file1.txt', 'file2.txt', 'missing.txt'])
      expect(deleted).toBe(2)
      expect(await driver.exists('file1.txt')).toBe(false)
      expect(await driver.exists('file2.txt')).toBe(false)
      expect(await driver.exists('file3.txt')).toBe(true)
    })
  })

  describe('copy', () => {
    it('copies a file', async () => {
      await driver.put('source.txt', 'content')
      await driver.copy('source.txt', 'dest.txt')

      expect(await driver.getAsString('source.txt')).toBe('content')
      expect(await driver.getAsString('dest.txt')).toBe('content')
    })
  })

  describe('move', () => {
    it('moves a file', async () => {
      await driver.put('source.txt', 'content')
      await driver.move('source.txt', 'dest.txt')

      expect(await driver.exists('source.txt')).toBe(false)
      expect(await driver.getAsString('dest.txt')).toBe('content')
    })
  })

  describe('url', () => {
    it('returns the URL for a file', () => {
      expect(driver.url('avatars/user-1.jpg')).toBe('/storage/avatars/user-1.jpg')
    })
  })

  describe('size', () => {
    it('returns the file size', async () => {
      await driver.put('test.txt', 'Hello')
      const size = await driver.size('test.txt')
      expect(size).toBe(5)
    })
  })

  describe('lastModified', () => {
    it('returns the last modified date', async () => {
      const before = new Date()
      await driver.put('test.txt', 'content')
      const after = new Date()

      const modified = await driver.lastModified('test.txt')
      expect(modified.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
      expect(modified.getTime()).toBeLessThanOrEqual(after.getTime() + 1000)
    })
  })

  describe('metadata', () => {
    it('returns file metadata', async () => {
      await driver.put('test.txt', 'content')
      const meta = await driver.metadata('test.txt')

      expect(meta).not.toBeNull()
      expect(meta?.path).toBe('test.txt')
      expect(meta?.size).toBe(7)
    })

    it('returns null for missing file', async () => {
      const meta = await driver.metadata('missing.txt')
      expect(meta).toBeNull()
    })
  })

  describe('files', () => {
    it('lists files in a directory', async () => {
      await driver.put('dir/file1.txt', 'content1')
      await driver.put('dir/file2.txt', 'content2')
      await driver.put('dir/subdir/file3.txt', 'content3')

      const files = await driver.files('dir')
      expect(files).toHaveLength(2)
      expect(files).toContain('dir/file1.txt')
      expect(files).toContain('dir/file2.txt')
    })

    it('returns empty array for missing directory', async () => {
      const files = await driver.files('missing')
      expect(files).toHaveLength(0)
    })
  })

  describe('directories', () => {
    it('lists subdirectories', async () => {
      await driver.put('dir/subdir1/file.txt', 'content')
      await driver.put('dir/subdir2/file.txt', 'content')
      await driver.put('dir/file.txt', 'content')

      const dirs = await driver.directories('dir')
      expect(dirs).toHaveLength(2)
      expect(dirs).toContain('dir/subdir1')
      expect(dirs).toContain('dir/subdir2')
    })
  })

  describe('allFiles', () => {
    it('lists all files recursively', async () => {
      await driver.put('dir/file1.txt', 'content1')
      await driver.put('dir/subdir/file2.txt', 'content2')
      await driver.put('dir/subdir/deep/file3.txt', 'content3')

      const files = await driver.allFiles('dir')
      expect(files).toHaveLength(3)
      expect(files).toContain('dir/file1.txt')
      expect(files).toContain('dir/subdir/file2.txt')
      expect(files).toContain('dir/subdir/deep/file3.txt')
    })
  })

  describe('makeDirectory', () => {
    it('creates a directory', async () => {
      await driver.makeDirectory('new/nested/dir')
      const dirs = await driver.directories('new/nested')
      expect(dirs).toContain('new/nested/dir')
    })
  })

  describe('deleteDirectory', () => {
    it('deletes a directory and its contents', async () => {
      await driver.put('dir/file1.txt', 'content1')
      await driver.put('dir/subdir/file2.txt', 'content2')

      await driver.deleteDirectory('dir')
      expect(await driver.exists('dir/file1.txt')).toBe(false)
      expect(await driver.exists('dir/subdir/file2.txt')).toBe(false)
    })
  })
})

describe('MemoryDriver', () => {
  let driver: MemoryDriver

  beforeEach(() => {
    driver = new MemoryDriver({ url: 'memory://' })
  })

  describe('put/get', () => {
    it('stores and retrieves a file', async () => {
      await driver.put('test.txt', 'Hello, World!')
      const content = await driver.get('test.txt')
      expect(content?.toString()).toBe('Hello, World!')
    })

    it('stores a buffer', async () => {
      const buffer = Buffer.from('Binary content')
      await driver.put('binary.bin', buffer)
      const content = await driver.get('binary.bin')
      expect(content?.toString()).toBe('Binary content')
    })

    it('returns null for missing file', async () => {
      const content = await driver.get('missing.txt')
      expect(content).toBeNull()
    })

    it('handles nested paths', async () => {
      await driver.put('path/to/file.txt', 'content')
      const content = await driver.getAsString('path/to/file.txt')
      expect(content).toBe('content')
    })
  })

  describe('exists', () => {
    it('returns true for existing file', async () => {
      await driver.put('test.txt', 'content')
      expect(await driver.exists('test.txt')).toBe(true)
    })

    it('returns false for missing file', async () => {
      expect(await driver.exists('missing.txt')).toBe(false)
    })
  })

  describe('delete', () => {
    it('deletes an existing file', async () => {
      await driver.put('test.txt', 'content')
      expect(await driver.delete('test.txt')).toBe(true)
      expect(await driver.exists('test.txt')).toBe(false)
    })
  })

  describe('copy/move', () => {
    it('copies a file', async () => {
      await driver.put('source.txt', 'content')
      await driver.copy('source.txt', 'dest.txt')

      expect(await driver.getAsString('source.txt')).toBe('content')
      expect(await driver.getAsString('dest.txt')).toBe('content')
    })

    it('moves a file', async () => {
      await driver.put('source.txt', 'content')
      await driver.move('source.txt', 'dest.txt')

      expect(await driver.exists('source.txt')).toBe(false)
      expect(await driver.getAsString('dest.txt')).toBe('content')
    })
  })

  describe('url', () => {
    it('returns the URL for a file', () => {
      expect(driver.url('avatars/user-1.jpg')).toBe('memory:///avatars/user-1.jpg')
    })
  })

  describe('size/lastModified', () => {
    it('returns the file size', async () => {
      await driver.put('test.txt', 'Hello')
      const size = await driver.size('test.txt')
      expect(size).toBe(5)
    })

    it('returns the last modified date', async () => {
      const before = new Date()
      await driver.put('test.txt', 'content')

      const modified = await driver.lastModified('test.txt')
      expect(modified.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100)
    })
  })

  describe('files/directories', () => {
    it('lists files in a directory', async () => {
      await driver.put('dir/file1.txt', 'content1')
      await driver.put('dir/file2.txt', 'content2')
      await driver.put('dir/subdir/file3.txt', 'content3')

      const files = await driver.files('dir')
      expect(files).toHaveLength(2)
      expect(files).toContain('dir/file1.txt')
      expect(files).toContain('dir/file2.txt')
    })

    it('lists directories', async () => {
      await driver.put('dir/subdir1/file.txt', 'content')
      await driver.put('dir/subdir2/file.txt', 'content')

      const dirs = await driver.directories('dir')
      expect(dirs).toHaveLength(2)
    })

    it('lists all files recursively', async () => {
      await driver.put('dir/file1.txt', 'content1')
      await driver.put('dir/subdir/file2.txt', 'content2')

      const files = await driver.allFiles('dir')
      expect(files).toHaveLength(2)
    })
  })

  describe('visibility', () => {
    it('sets and gets visibility', async () => {
      await driver.put('test.txt', 'content', { visibility: 'public' })
      expect(await driver.getVisibility('test.txt')).toBe('public')

      await driver.setVisibility('test.txt', 'private')
      expect(await driver.getVisibility('test.txt')).toBe('private')
    })
  })

  describe('deleteDirectory', () => {
    it('deletes a directory and its contents', async () => {
      await driver.put('dir/file1.txt', 'content1')
      await driver.put('dir/subdir/file2.txt', 'content2')

      await driver.deleteDirectory('dir')
      expect(await driver.exists('dir/file1.txt')).toBe(false)
      expect(await driver.exists('dir/subdir/file2.txt')).toBe(false)
    })
  })

  describe('clear', () => {
    it('clears all files', async () => {
      await driver.put('file1.txt', 'content1')
      await driver.put('file2.txt', 'content2')

      driver.clear()
      expect(driver.count()).toBe(0)
    })
  })
})

describe('StorageManager', () => {
  let manager: StorageManager

  beforeEach(() => {
    manager = new StorageManager({
      default: 'memory',
      disks: {
        memory: { driver: 'memory' },
      },
    })
  })

  describe('disk', () => {
    it('returns the default disk', async () => {
      const disk = manager.disk()
      await disk.put('test.txt', 'content')
      expect(await disk.getAsString('test.txt')).toBe('content')
    })

    it('returns a named disk', async () => {
      const disk = manager.disk('memory')
      await disk.put('test.txt', 'content')
      expect(await disk.getAsString('test.txt')).toBe('content')
    })

    it('throws for unknown disk', () => {
      expect(() => manager.disk('unknown')).toThrow('Storage disk not found: unknown')
    })

    it('caches resolved disks', () => {
      const disk1 = manager.disk()
      const disk2 = manager.disk()
      expect(disk1).toBe(disk2)
    })
  })

  describe('registerDisk', () => {
    it('registers a custom disk', async () => {
      manager.registerDisk('custom', () => new MemoryDriver())

      const disk = manager.disk('custom')
      await disk.put('test.txt', 'content')
      expect(await disk.getAsString('test.txt')).toBe('content')
    })
  })

  describe('hasDisk', () => {
    it('returns true for registered disks', () => {
      expect(manager.hasDisk('memory')).toBe(true)
    })

    it('returns false for unregistered disks', () => {
      expect(manager.hasDisk('unknown')).toBe(false)
    })
  })

  describe('getDiskNames', () => {
    it('returns all registered disk names', () => {
      expect(manager.getDiskNames()).toContain('memory')
    })
  })

  describe('createStorageManager', () => {
    it('creates a manager with default config', async () => {
      const mgr = createStorageManager({
        default: 'memory',
        disks: {
          memory: { driver: 'memory' },
        },
      })
      const disk = mgr.disk()
      await disk.put('test.txt', 'content')
      expect(await disk.getAsString('test.txt')).toBe('content')
    })
  })
})
