import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { cachedFileProbe, resolveImportPath } from '../src/import-resolution'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

describe('resolveImportPath', () => {
  it.each(['index.ts', 'index.tsx', 'index.mts', 'index.js', 'index.jsx', 'index.mjs'])(
    'resolves a directory through its %s',
    async (index) => {
      const workspace = await createTempWorkspace('guren-cli-resolve-index-')
      try {
        await writeWorkspaceFiles(workspace.dir, { [`lib/${index}`]: 'export {}' })
        expect(await resolveImportPath(join(workspace.dir, 'lib'))).toBe(join(workspace.dir, 'lib', index))
      } finally {
        await workspace.cleanup()
      }
    },
  )

  it('never resolves to a directory, and a directory with no index resolves to nothing', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-noindex-')
    try {
      await writeWorkspaceFiles(workspace.dir, { 'lib/Other.ts': 'export {}' })
      expect(await resolveImportPath(join(workspace.dir, 'lib'))).toBeNull()
    } finally {
      await workspace.cleanup()
    }
  })

  it('looks inside a directory whose name carries a known extension', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-dotdir-')
    try {
      await writeWorkspaceFiles(workspace.dir, { 'vendor/lib.js/index.ts': 'export {}' })
      expect(await resolveImportPath(join(workspace.dir, 'vendor/lib.js'))).toBe(join(workspace.dir, 'vendor/lib.js/index.ts'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('prefers the source over a stale emitted file of the same name', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-source-')
    try {
      await writeWorkspaceFiles(workspace.dir, { 'Service.ts': 'export {}', 'Service.js': 'export {}' })
      expect(await resolveImportPath(join(workspace.dir, 'Service.js'))).toBe(join(workspace.dir, 'Service.ts'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('follows a directory package.json main ahead of its index, and types for a type-only import', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-package-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'packages/shared/package.json': JSON.stringify({ main: './src/main.js', types: './types/main.d.ts' }),
        'packages/shared/src/main.ts': 'export {}',
        'packages/shared/types/main.d.ts': 'export {}',
        'packages/shared/index.ts': 'export {}',
      })
      const target = join(workspace.dir, 'packages/shared')
      expect(await resolveImportPath(target)).toBe(join(target, 'src/main.ts'))
      expect(await resolveImportPath(target, { declarations: true })).toBe(join(target, 'types/main.d.ts'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('reads main and not module, and follows an entry naming a directory', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-package-fields-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'esm/package.json': JSON.stringify({ module: './esm.js', main: './cjs.js' }),
        'esm/esm.js': 'export {}',
        'esm/cjs.js': 'export {}',
        'dir/package.json': JSON.stringify({ main: 'src' }),
        'dir/src/index.ts': 'export {}',
      })
      expect(await resolveImportPath(join(workspace.dir, 'esm'))).toBe(join(workspace.dir, 'esm/cjs.js'))
      expect(await resolveImportPath(join(workspace.dir, 'dir'))).toBe(join(workspace.dir, 'dir/src/index.ts'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('moves past a package entry that names no file', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-package-fallback-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'pkg/package.json': JSON.stringify({ types: './dist/index.d.ts', main: './src/main.ts' }),
        'pkg/src/main.ts': 'export {}',
        'gone/package.json': JSON.stringify({ main: './dist/index.js' }),
        'gone/index.ts': 'export {}',
      })
      expect(await resolveImportPath(join(workspace.dir, 'pkg'), { declarations: true })).toBe(join(workspace.dir, 'pkg/src/main.ts'))
      expect(await resolveImportPath(join(workspace.dir, 'gone'))).toBe(join(workspace.dir, 'gone/index.ts'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not read a specifier with an extension as the directory without it', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-no-strip-dir-')
    try {
      await writeWorkspaceFiles(workspace.dir, { 'lib/index.ts': 'export {}' })
      expect(await resolveImportPath(join(workspace.dir, 'lib.js'))).toBeNull()
    } finally {
      await workspace.cleanup()
    }
  })

  it('accepts a declaration file only for a type-only import', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-dts-')
    try {
      await writeWorkspaceFiles(workspace.dir, { 'types/index.d.ts': 'export {}' })
      const target = join(workspace.dir, 'types')
      expect(await resolveImportPath(target)).toBeNull()
      expect(await resolveImportPath(target, { declarations: true })).toBe(join(target, 'index.d.ts'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('stats each path once through a cached probe', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-cache-')
    try {
      await writeWorkspaceFiles(workspace.dir, { 'lib/index.ts': 'export {}' })
      const probe = cachedFileProbe()
      const target = join(workspace.dir, 'lib')
      expect(await resolveImportPath(target, { probe })).toBe(join(target, 'index.ts'))
      await writeWorkspaceFiles(workspace.dir, { 'lib.ts': 'export {}' })
      // The cached miss for `lib.ts` answers again; an uncached probe now finds it.
      expect(await resolveImportPath(target, { probe })).toBe(join(target, 'index.ts'))
      expect(await resolveImportPath(target)).toBe(join(workspace.dir, 'lib.ts'))
    } finally {
      await workspace.cleanup()
    }
  })
})
