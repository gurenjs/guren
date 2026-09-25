import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { cachedFileProbe, resolveImportPath } from '../src/import-resolution'
import { createTempWorkspace } from './helpers'

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), contents, 'utf8')
  }
}

describe('resolveImportPath', () => {
  it.each(['index.ts', 'index.tsx', 'index.mts', 'index.js', 'index.jsx', 'index.mjs'])(
    'resolves a directory through its %s',
    async (index) => {
      const workspace = await createTempWorkspace('guren-cli-resolve-index-')
      try {
        await writeFiles(workspace.dir, { [`lib/${index}`]: 'export {}' })
        expect(await resolveImportPath(join(workspace.dir, 'lib'))).toBe(join(workspace.dir, 'lib', index))
      } finally {
        await workspace.cleanup()
      }
    },
  )

  it('never resolves to a directory, and a directory with no index resolves to nothing', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-noindex-')
    try {
      await writeFiles(workspace.dir, { 'lib/Other.ts': 'export {}' })
      expect(await resolveImportPath(join(workspace.dir, 'lib'))).toBeNull()
    } finally {
      await workspace.cleanup()
    }
  })

  it('looks inside a directory whose name carries a known extension', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-dotdir-')
    try {
      await writeFiles(workspace.dir, { 'vendor/lib.js/index.ts': 'export {}' })
      expect(await resolveImportPath(join(workspace.dir, 'vendor/lib.js'))).toBe(join(workspace.dir, 'vendor/lib.js/index.ts'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('prefers the source over a stale emitted file of the same name', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-source-')
    try {
      await writeFiles(workspace.dir, { 'Service.ts': 'export {}', 'Service.js': 'export {}' })
      expect(await resolveImportPath(join(workspace.dir, 'Service.js'))).toBe(join(workspace.dir, 'Service.ts'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('follows a directory package.json main ahead of its index, and types for a type-only import', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-package-')
    try {
      await writeFiles(workspace.dir, {
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

  it('accepts a declaration file only for a type-only import', async () => {
    const workspace = await createTempWorkspace('guren-cli-resolve-dts-')
    try {
      await writeFiles(workspace.dir, { 'types/index.d.ts': 'export {}' })
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
      await writeFiles(workspace.dir, { 'lib/index.ts': 'export {}' })
      const probe = cachedFileProbe()
      const target = join(workspace.dir, 'lib')
      expect(await resolveImportPath(target, { probe })).toBe(join(target, 'index.ts'))
      await writeFiles(workspace.dir, { 'lib.ts': 'export {}' })
      // The cached miss for `lib.ts` answers again; an uncached probe now finds it.
      expect(await resolveImportPath(target, { probe })).toBe(join(target, 'index.ts'))
      expect(await resolveImportPath(target)).toBe(join(workspace.dir, 'lib.ts'))
    } finally {
      await workspace.cleanup()
    }
  })
})
