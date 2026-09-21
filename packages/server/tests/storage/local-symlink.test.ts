import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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

  const linked = 'escape/sentinel.txt'

  test.each([
    ['get', () => driver.get(linked)],
    ['getStream', () => driver.getStream(linked)],
    ['exists', () => driver.exists(linked)],
    ['size', () => driver.size(linked)],
    ['lastModified', () => driver.lastModified(linked)],
    ['metadata', () => driver.metadata(linked)],
    ['files', () => driver.files('escape')],
    ['directories', () => driver.directories('escape')],
    ['allFiles', () => driver.allFiles('escape')],
  ])('rejects %s through a directory link', async (_name, operation) => {
    await expect(operation()).rejects.toThrow('through a symbolic link')
  })

  const writes: Array<[string, () => Promise<unknown>]> = [
    ['put', () => driver.put(linked, 'overwrite')],
    ['put below the link', () => driver.put('escape/new/nested.txt', 'new')],
    ['delete', () => driver.delete(linked)],
    ['deleteDirectory', () => driver.deleteDirectory('escape')],
    ['makeDirectory', () => driver.makeDirectory('escape/new')],
    ['copy from', () => driver.copy(linked, 'copy.txt')],
    ['copy to', () => driver.copy('source.txt', linked)],
    ['move from', () => driver.move(linked, 'moved.txt')],
    ['move to', () => driver.move('source.txt', linked)],
  ]

  test.each(writes)('rejects %s through a directory link', async (_name, operation) => {
    await expect(operation()).rejects.toThrow('through a symbolic link')
  })

  // Separate from the per-operation cases, which abort on the rejection they
  // assert and so never reach a check on what reached the disk.
  test('leaves both sides untouched after every rejected write', async () => {
    for (const [, operation] of writes) {
      await operation().catch(() => {})
    }
    expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('untouched')
    expect(await readdir(outside)).toEqual(['sentinel.txt'])
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
    await expect(driver.get('loop-a')).rejects.toThrow('cannot resolve a symbolic link')
  })

  test('starts checking once a root that did not exist is created', async () => {
    const late = join(fixture, 'late')
    const disk = new LocalDriver({ root: late })
    expect(await disk.exists('x.txt')).toBe(false)
    await disk.put('a.txt', 'ok')
    await symlink(outside, join(late, 'escape'))
    await expect(disk.get('escape/sentinel.txt')).rejects.toThrow('through a symbolic link')
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
