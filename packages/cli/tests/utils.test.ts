import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import { assertScaffoldPath, safePathSegments, writeScaffoldFile } from '../src/utils'

describe('assertScaffoldPath', () => {
  it('accepts a nested path inside the project root', () => {
    expect(() => assertScaffoldPath('tests/auth/Login.test.ts')).not.toThrow()
  })

  it('refuses a path that escapes the project root', () => {
    expect(() => assertScaffoldPath('tests/../../../../tmp/evil.ts')).toThrow(
      'resolves outside the project root',
    )
    expect(() => assertScaffoldPath('/tmp/evil.ts')).toThrow('resolves outside the project root')
  })

  it('does not treat a sibling directory sharing the root prefix as inside', async () => {
    const workspace = await createTempWorkspace('guren-cli-scaffold-sibling-')
    try {
      const sibling = `../${workspace.dir.split('/').pop()}-evil/x.ts`
      expect(() => assertScaffoldPath(sibling, workspace.dir)).toThrow(
        'resolves outside the project root',
      )
    } finally {
      await workspace.cleanup()
    }
  })

  // The containment root has to be the directory the write resolves against.
  // These cover the failure mode where `cwd` reaches the writer but not the
  // guard: the guard would then vet paths against process.cwd() while the file
  // lands under `cwd`, so nothing it approves has actually been checked.
  describe('with an explicit cwd', () => {
    let root: string

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'guren-cli-scaffold-cwd-'))
    })

    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it('still refuses a path that escapes the given root', () => {
      expect(() => assertScaffoldPath('tests/../../../../tmp/evil.ts', root)).toThrow(
        'resolves outside the project root',
      )
      expect(() => assertScaffoldPath('/tmp/evil.ts', root)).toThrow(
        'resolves outside the project root',
      )
    })

    it('judges containment against the given root, not process.cwd()', () => {
      // Inside the process's own directory, so a guard still reading
      // process.cwd() would wave this through — but it escapes `root`, which
      // is where the write would land.
      const escapesRootButNotCwd = `${process.cwd()}/escaped.ts`

      expect(() => assertScaffoldPath(escapesRootButNotCwd, root)).toThrow(
        'resolves outside the project root',
      )
    })

    it('refuses to write outside the given root', async () => {
      await expect(
        writeScaffoldFile('../escaped.ts', 'export {}\n', { cwd: root }),
      ).rejects.toThrow('resolves outside the project root')
    })

    it('writes a contained path under the given root rather than process.cwd()', async () => {
      const written = await writeScaffoldFile('app/Jobs/Contained.ts', 'export {}\n', { cwd: root })

      expect(written).toBe(join(root, 'app/Jobs/Contained.ts'))
    })
  })
})

describe('safePathSegments', () => {
  it('splits a nested name into segments', () => {
    expect(safePathSegments('posts/Index', 'view name')).toEqual(['posts', 'Index'])
    expect(safePathSegments('/auth/Login/', 'test name')).toEqual(['auth', 'Login'])
    expect(safePathSegments('Login.test.ts', 'test name')).toEqual(['Login.test.ts'])
  })

  it('accepts names the filesystem accepts, narrowing only traversal', () => {
    expect(safePathSegments('admin/my page', 'view name')).toEqual(['admin', 'my page'])
    expect(safePathSegments('顧客/Index', 'view name')).toEqual(['顧客', 'Index'])
    expect(safePathSegments('reports+/Login', 'test name')).toEqual(['reports+', 'Login'])
    expect(safePathSegments('...', 'view name')).toEqual(['...'])
  })

  it('throws when the name has no segments', () => {
    expect(() => safePathSegments('', 'view name')).toThrow('A view name is required')
    expect(() => safePathSegments('///', 'test name')).toThrow('A test name is required')
  })

  it('rejects traversal segments', () => {
    expect(() => safePathSegments('../outside', 'view name')).toThrow('is a path traversal')
    expect(() => safePathSegments('posts/../../outside', 'view name')).toThrow(
      'is a path traversal',
    )
    expect(() => safePathSegments('posts/./Index', 'view name')).toThrow('is a path traversal')
    expect(() => safePathSegments('posts/..\\..\\outside', 'view name')).toThrow(
      'is a path traversal',
    )
  })
})
