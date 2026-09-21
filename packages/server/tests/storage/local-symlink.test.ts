import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
      await expect(operation()).rejects.toThrow('through a symbolic link')
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
      await expect(operation()).rejects.toThrow('through a symbolic link')
    }
    expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('untouched')
    expect(await driver.getAsString('source.txt')).toBe('source')
  })

  test('rejects escaping final-component and dangling symlinks', async () => {
    await symlink(join(outside, 'sentinel.txt'), join(root, 'file-link'))
    await symlink(join(outside, 'missing.txt'), join(root, 'dangling'))
    await expect(driver.get('file-link')).rejects.toThrow('through a symbolic link')
    await expect(driver.put('dangling', 'created')).rejects.toThrow('through a symbolic link')
  })

  test('allows links that stay inside the disk', async () => {
    await mkdir(join(root, 'real'))
    await writeFile(join(root, 'real', 'a.txt'), 'inside')
    await symlink(join(root, 'real'), join(root, 'inside-dir'))
    await symlink(join(root, 'real', 'a.txt'), join(root, 'inside-file'))
    expect(await driver.getAsString('inside-dir/a.txt')).toBe('inside')
    expect(await driver.getAsString('inside-file')).toBe('inside')
    expect(await driver.exists('inside-dir/a.txt')).toBe(true)
    await driver.put('inside-dir/written.txt', 'written')
    expect(await readFile(join(root, 'real', 'written.txt'), 'utf8')).toBe('written')
  })

  test('rejects a link whose target is routed through another escaping link', async () => {
    // Spelled with the canonical root so the target reads as inside the disk
    // until `escape` is resolved, and with a missing directory below it.
    await symlink(join(await realpath(root), 'escape', 'new', 'x.txt'), join(root, 'indirect'))
    await expect(driver.put('indirect', 'x')).rejects.toThrow('through a symbolic link')
    await expect(driver.get('indirect')).rejects.toThrow('through a symbolic link')
  })

  test('rejects a link cycle rather than spinning', async () => {
    await symlink(join(root, 'loop-b'), join(root, 'loop-a'))
    await symlink(join(root, 'loop-a'), join(root, 'loop-b'))
    await expect(driver.get('loop-a')).rejects.toThrow('too many symbolic links')
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
