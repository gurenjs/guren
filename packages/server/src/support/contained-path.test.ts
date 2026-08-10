import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { isPathWithin, isRealPathWithin } from './contained-path'

describe('isPathWithin', () => {
  it('accepts a path below the root', () => {
    expect(isPathWithin(join(sep, 'srv', 'public'), join(sep, 'srv', 'public', 'app.css'))).toBe(true)
  })

  it('rejects the root itself', () => {
    expect(isPathWithin(join(sep, 'srv', 'public'), join(sep, 'srv', 'public'))).toBe(false)
  })

  it('rejects a sibling directory whose name extends the root', () => {
    expect(isPathWithin(join(sep, 'srv', 'public'), join(sep, 'srv', 'publicity', 'secret'))).toBe(false)
  })

  it('rejects an unrelated absolute path', () => {
    expect(isPathWithin(join(sep, 'srv', 'public'), join(sep, 'etc', 'passwd'))).toBe(false)
  })

  it('treats a root that already ends in a separator the same way', () => {
    expect(isPathWithin(join(sep, 'srv', 'public') + sep, join(sep, 'srv', 'public', 'app.css'))).toBe(true)
  })
})

describe('isRealPathWithin', () => {
  let tmpRoot: string
  let root: string

  beforeEach(async () => {
    // Canonicalized up front: on macOS `os.tmpdir()` sits under `/var`, itself a
    // symlink to `/private/var`, so a raw path here would fail containment for
    // reasons that have nothing to do with what these tests assert.
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'guren-contained-path-')))
    root = join(tmpRoot, 'root')

    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'nested', 'inside.txt'), 'inside')

    await mkdir(join(tmpRoot, 'outside'), { recursive: true })
    await writeFile(join(tmpRoot, 'outside', 'secret.txt'), 'secret')
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('accepts a real file below the root', async () => {
    expect(await isRealPathWithin(root, join(root, 'nested', 'inside.txt'))).toBe(true)
  })

  it('rejects a path reached through a directory symlink pointing out of the root', async () => {
    symlinkSync(join(tmpRoot, 'outside'), join(root, 'link'))

    // Lexically this is inside `root` — only canonicalization reveals otherwise.
    expect(isPathWithin(root, join(root, 'link', 'secret.txt'))).toBe(true)
    expect(await isRealPathWithin(root, join(root, 'link', 'secret.txt'))).toBe(false)
  })

  it('rejects a file symlink pointing out of the root', async () => {
    symlinkSync(join(tmpRoot, 'outside', 'secret.txt'), join(root, 'note.txt'))

    expect(await isRealPathWithin(root, join(root, 'note.txt'))).toBe(false)
  })

  it('accepts files under a root that is itself reached through a symlink', async () => {
    // Workspace, pnpm, and container layouts all do this. Canonicalizing only
    // the candidate — and not the root — would reject every asset such an app
    // serves, while leaving every escape test above green.
    const linkedRoot = join(tmpRoot, 'root-link')
    symlinkSync(root, linkedRoot)

    expect(await isRealPathWithin(linkedRoot, join(linkedRoot, 'nested', 'inside.txt'))).toBe(true)
  })

  it('rejects a candidate that does not exist', async () => {
    expect(await isRealPathWithin(root, join(root, 'missing.txt'))).toBe(false)
  })

  it('rejects when the root does not exist', async () => {
    const missingRoot = join(tmpRoot, 'missing-root')

    expect(await isRealPathWithin(missingRoot, join(missingRoot, 'inside.txt'))).toBe(false)
  })
})
