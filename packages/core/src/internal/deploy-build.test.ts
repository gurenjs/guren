import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertOutputDirOutsideRoot,
  DEV_ONLY_MODULES,
  importSpecifier,
  loadManifest,
  MCP_SDK_SUBPATH_PREFIX,
  resolvePathLike,
} from './deploy-build'

describe('assertOutputDirOutsideRoot', () => {
  test('should accept an output directory below the app root', () => {
    expect(() => assertOutputDirOutsideRoot('/app/.lambda', '/app', 'Test build')).not.toThrow()
  })

  test('should accept an output directory beside the app root', () => {
    expect(() => assertOutputDirOutsideRoot('/tmp/out', '/app', 'Test build')).not.toThrow()
  })

  test('should reject the app root itself', () => {
    expect(() => assertOutputDirOutsideRoot('/app', '/app', 'Test build')).toThrow(
      /never the root itself or a parent of it/,
    )
  })

  test('should reject a parent of the app root', () => {
    expect(() => assertOutputDirOutsideRoot('/app', '/app/nested', 'Test build')).toThrow(
      /never the root itself or a parent of it/,
    )
  })

  test('should reject the filesystem root', () => {
    // The reason this helper compares with `relative`: `out + sep` is "//"
    // here, so a string-prefix containment test would accept it.
    expect(() => assertOutputDirOutsideRoot('/', '/app', 'Test build')).toThrow(
      /never the root itself or a parent of it/,
    )
  })

  test('should name the calling platform in the message', () => {
    expect(() => assertOutputDirOutsideRoot('/', '/app', 'Cloudflare build')).toThrow(
      /^Cloudflare build:/,
    )
  })
})

describe('importSpecifier', () => {
  test('should produce an explicitly relative POSIX specifier', () => {
    expect(importSpecifier('/app/.lambda', '/app/src/lambda.ts', 'Test build')).toBe(
      '../src/lambda.ts',
    )
  })

  test('should prefix a same-directory target with ./', () => {
    expect(importSpecifier('/app/out', '/app/out/handler.js', 'Test build')).toBe('./handler.js')
  })
})

describe('loadManifest', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guren-deploy-build-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('should return the first manifest that exists', () => {
    writeFileSync(join(dir, 'second.json'), JSON.stringify({ 'a.tsx': { file: 'a.js' } }))

    expect(loadManifest(join(dir, 'missing.json'), join(dir, 'second.json'))).toEqual({
      'a.tsx': { file: 'a.js' },
    })
  })

  test('should skip a malformed manifest rather than throw', () => {
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ 'b.tsx': { file: 'b.js' } }))

    expect(loadManifest(join(dir, 'broken.json'), join(dir, 'good.json'))).toEqual({
      'b.tsx': { file: 'b.js' },
    })
  })

  test('should return undefined when nothing is found', () => {
    expect(loadManifest(join(dir, 'a.json'), join(dir, 'b.json'))).toBeUndefined()
  })
})

describe('resolvePathLike', () => {
  test('should accept a file URL', () => {
    expect(resolvePathLike(new URL('file:///app/src'))).toBe('/app/src')
  })

  test('should resolve a relative string against the cwd', () => {
    expect(resolvePathLike('src')).toBe(join(process.cwd(), 'src'))
  })
})

describe('DEV_ONLY_MODULES', () => {
  test('should list every MCP SDK entry under the documented subpath prefix', () => {
    const sdkEntries = DEV_ONLY_MODULES.filter((module) =>
      module.specifier.startsWith('@modelcontextprotocol/'),
    )

    expect(sdkEntries.length).toBeGreaterThan(0)
    for (const entry of sdkEntries) {
      expect(entry.specifier.startsWith(MCP_SDK_SUBPATH_PREFIX)).toBe(true)
      // A package-name alias does not cover subpaths, so a bare package entry
      // would silently leave the real SDK in a Workers bundle.
      expect(entry.specifier).not.toBe(MCP_SDK_SUBPATH_PREFIX.replace(/\/$/, ''))
    }
  })

  test('should not list the same specifier twice', () => {
    const specifiers = DEV_ONLY_MODULES.map((module) => module.specifier)
    expect(new Set(specifiers).size).toBe(specifiers.length)
  })

  test('should give every destructured module its export names', () => {
    // `@guren/cli` is read only through namespace property access, so an empty
    // module suffices; everything else is destructured and needs its names, or
    // the bundle fails with "no matching export".
    for (const module of DEV_ONLY_MODULES) {
      if (module.specifier === '@guren/cli') {
        expect(module.exportNames).toEqual([])
      } else {
        expect(module.exportNames.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('the module graph this list describes', () => {
  const repoRoot = join(import.meta.dir, '../../../..')

  function importersOf(specifier: string): string {
    const { stdout } = Bun.spawnSync({
      cmd: ['git', 'grep', '-l', '--fixed-strings', specifier, '--', 'packages/server/src', 'packages/orm/src'],
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return stdout.toString().trim()
  }

  // Checked per entry, not as one alternation: the point of the list is to
  // track @guren/core's own dev-only imports, and a single matching entry
  // would otherwise mask every stale one. A framework change that drops an
  // import should surface here rather than as dead weight in every plugin.
  test.each(DEV_ONLY_MODULES.map((module) => module.specifier))(
    'should still be imported by the framework: %s',
    (specifier) => {
      expect(importersOf(specifier)).not.toBe('')
    },
  )

  test('should detect a specifier the framework does not import', () => {
    // Guards the check above: without this, a `git grep` that silently stopped
    // working would let every case pass.
    expect(importersOf('@guren/not-a-real-dev-only-module')).toBe('')
  })
})
