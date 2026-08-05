import { describe, expect, it } from 'bun:test'
import { createTempWorkspace } from './helpers'
import { assertScaffoldPath, safePathSegments } from '../src/utils'

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
      expect(() => assertScaffoldPath(sibling)).toThrow('resolves outside the project root')
    } finally {
      await workspace.cleanup()
    }
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
