import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalDriver } from '../../src/storage/drivers/LocalDriver'

describe('LocalDriver storage boundary', () => {
  let fixture: string
  let root: string
  let outside: string
  let driver: LocalDriver

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'guren-local-boundary-'))
    root = join(fixture, 'root')
    outside = join(fixture, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel.txt'), 'untouched')
    await writeFile(join(root, 'source.txt'), 'source')
    await symlink(outside, join(root, 'escape'))
    driver = new LocalDriver({ root })
  })

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true })
  })

  test('rejects reads, streams, metadata and listings through directory links', async () => {
    const path = 'escape/sentinel.txt'
    for (const operation of [
      () => driver.get(path), () => driver.getStream(path), () => driver.exists(path),
      () => driver.size(path), () => driver.lastModified(path), () => driver.metadata(path),
      () => driver.files('escape'), () => driver.directories('escape'), () => driver.allFiles('escape'),
    ]) {
      await expect(operation()).rejects.toThrow('symbolic links')
    }
  })

  test('rejects writes and destructive operations on both source and destination paths', async () => {
    const path = 'escape/sentinel.txt'
    for (const operation of [
      () => driver.put(path, 'overwrite'), () => driver.put('escape/new/nested.txt', 'new'),
      () => driver.delete(path), () => driver.deleteDirectory('escape'),
      () => driver.makeDirectory('escape/new'),
      () => driver.copy(path, 'copy.txt'), () => driver.copy('source.txt', path),
      () => driver.move(path, 'moved.txt'), () => driver.move('source.txt', path),
    ]) {
      await expect(operation()).rejects.toThrow('symbolic links')
    }
    expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('untouched')
    expect(await driver.getAsString('source.txt')).toBe('source')
  })

  test('rejects final-component and dangling symlinks', async () => {
    await symlink(join(outside, 'sentinel.txt'), join(root, 'file-link'))
    await symlink(join(outside, 'missing.txt'), join(root, 'dangling'))
    await expect(driver.get('file-link')).rejects.toThrow('symbolic links')
    await expect(driver.put('dangling', 'created')).rejects.toThrow('symbolic links')
  })

  test('allows a configured root symlink and creates missing nested directories', async () => {
    const configuredRoot = join(fixture, 'configured-root')
    await symlink(root, configuredRoot)
    const disk = new LocalDriver({ root: configuredRoot })
    await disk.put('new/nested/file.txt', 'ok')
    expect(await disk.getAsString('new/nested/file.txt')).toBe('ok')
    expect(await disk.get('missing.txt')).toBeNull()
    expect(await disk.get('source.txt/child')).toBeNull()
    expect(await disk.exists('source.txt/child')).toBe(false)
    await expect(disk.put('../outside/sentinel.txt', 'bad')).rejects.toThrow('escapes the storage root')
  })
})
