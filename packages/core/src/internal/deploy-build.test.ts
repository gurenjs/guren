import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertOutputDirOutsideRoot,
  DEV_ONLY_MODULES,
  importSpecifier,
  MCP_SDK_SUBPATH_PREFIX,
  readManifest,
  resolvePathLike,
  ssrRuntimePaths,
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

  test('should reject a root inside out whose name begins with ..', () => {
    // `relative` returns "..-source" here. Testing `startsWith('..')` reads
    // that as an escape and lets the delete run over a directory that really
    // is inside the output directory.
    expect(() => assertOutputDirOutsideRoot('/tmp/app', '/tmp/app/..-source', 'Test build')).toThrow(
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

  test('should reject an outputDir that reaches the app root through a symlink', () => {
    // The delete follows symlinks, so a lexical comparison is not enough. On
    // macOS /tmp is itself a symlink to /private/tmp, so this is ordinary.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'guren-symlink-')))
    try {
      mkdirSync(join(base, 'real/app'), { recursive: true })
      symlinkSync(join(base, 'real'), join(base, 'link'))

      expect(() =>
        assertOutputDirOutsideRoot(join(base, 'link/app'), join(base, 'real/app'), 'Test build'),
      ).toThrow(/never the root itself or a parent of it/)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('should still accept an output directory that does not exist yet', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'guren-symlink-')))
    try {
      mkdirSync(join(base, 'app'), { recursive: true })

      expect(() =>
        assertOutputDirOutsideRoot(join(base, 'app/.out'), join(base, 'app'), 'Test build'),
      ).not.toThrow()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
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

  test('should count .. segments from the real path when a symlink changes depth', () => {
    // The bundler resolves the emitted import from the module's real path, so
    // a specifier computed from the link path is short a `..` whenever the link
    // and its target sit at different depths — what macOS does with /tmp ->
    // /private/tmp and os.tmpdir() under /var -> /private/var.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'guren-symlink-')))
    try {
      mkdirSync(join(base, 'nested/out'), { recursive: true })
      symlinkSync(join(base, 'nested/out'), join(base, 'out'))

      expect(importSpecifier(join(base, 'out'), join(base, 'app/lambda.ts'), 'Test build')).toBe(
        '../../app/lambda.ts',
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('readManifest', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guren-deploy-build-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('should return the first manifest that exists, and its path', () => {
    writeFileSync(join(dir, 'second.json'), JSON.stringify({ 'a.tsx': { file: 'a.js' } }))

    expect(readManifest(join(dir, 'missing.json'), join(dir, 'second.json'))).toEqual({
      manifest: { 'a.tsx': { file: 'a.js' } },
      path: join(dir, 'second.json'),
    })
  })

  test('should skip a malformed manifest rather than throw', () => {
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ 'b.tsx': { file: 'b.js' } }))

    expect(readManifest(join(dir, 'broken.json'), join(dir, 'good.json'))?.path).toBe(
      join(dir, 'good.json'),
    )
  })

  test('should return undefined when nothing is found', () => {
    expect(readManifest(join(dir, 'a.json'), join(dir, 'b.json'))).toBeUndefined()
  })
})

describe('ssrRuntimePaths', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guren-ssr-paths-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('should place the entry and manifest under the caller prefix', () => {
    mkdirSync(join(dir, '.vite'), { recursive: true })
    writeFileSync(
      join(dir, '.vite/manifest.json'),
      JSON.stringify({ 'resources/js/ssr.tsx': { file: 'ssr.js' } }),
    )

    expect(ssrRuntimePaths(dir, join(dir, 'ssr.js'), './.guren/ssr')).toEqual({
      entry: './.guren/ssr/ssr.js',
      manifest: './.guren/ssr/.vite/manifest.json',
    })
  })

  test('should name the manifest it actually parsed, not the first that exists', () => {
    // A malformed .vite/manifest.json alongside a valid flat one: naming the
    // file that merely exists publishes the path to the one that was skipped.
    mkdirSync(join(dir, '.vite'), { recursive: true })
    writeFileSync(join(dir, '.vite/manifest.json'), '{ not json')
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ 'resources/js/ssr.tsx': { file: 'ssr.js' } }),
    )

    expect(ssrRuntimePaths(dir, join(dir, 'ssr.js'), './.guren/ssr').manifest).toBe(
      './.guren/ssr/manifest.json',
    )
  })

  test('should omit the manifest when none parses', () => {
    mkdirSync(join(dir, '.vite'), { recursive: true })
    writeFileSync(join(dir, '.vite/manifest.json'), '{ not json')
    writeFileSync(join(dir, 'manifest.json'), 'also { not json')

    expect(ssrRuntimePaths(dir, join(dir, 'ssr.js'), './.guren/ssr')).toEqual({
      entry: './.guren/ssr/ssr.js',
      manifest: undefined,
    })
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

    // A package-name alias does not cover subpaths, so a bare package entry
    // would silently leave the real SDK in a Workers bundle.
    expect(sdkEntries.length).toBeGreaterThan(0)
    for (const entry of sdkEntries) {
      expect(entry.specifier.startsWith(MCP_SDK_SUBPATH_PREFIX)).toBe(true)
    }
  })
})

describe('the built artifact', () => {
  test('should import nothing but node builtins', () => {
    // The module documents this, and the plugins rely on it: importing it must
    // not drag the framework runtime into a developer's build. It holds today
    // only because this tsup entry happens to share no code with core's
    // others — the day one does, ESM splitting emits a chunk and the property
    // disappears with nothing else to notice.
    const built = join(import.meta.dir, '../../dist/internal/deploy-build.js')
    if (!existsSync(built)) {
      throw new Error(`Expected ${built}; run \`bun run build core\` before this test.`)
    }

    // Every import form, not just `from "..."`: a side-effect import or a
    // dynamic `import()` of a bundled chunk would otherwise slip past while the
    // builtin `from` imports kept the assertion green.
    const source = readFileSync(built, 'utf8')
    const specifiers = [
      ...source.matchAll(/from\s*["']([^"']+)["']/g),
      ...source.matchAll(/(?:^|[^.\w])import\s*["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g),
    ].map(([, specifier]) => specifier)

    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(isBuiltin(specifier)).toBe(true)
    }
  })
})

describe('the module graph this list describes', () => {
  const repoRoot = join(import.meta.dir, '../../../..')

  /**
   * Files that actually import `specifier`, matched on the import form rather
   * than the bare string: `vite` alone also hits a `@vite-ignore` comment and
   * an identifier, which would leave this green after the real import was
   * deleted — the exact drift the check exists to catch.
   */
  function importersOf(specifier: string): string {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const { stdout } = Bun.spawnSync({
      cmd: [
        'git',
        'grep',
        '-lE',
        `(from|import\\(|require\\()[[:space:]]*['"]${escaped}['"]`,
        '--',
        'packages/server/src',
        'packages/orm/src',
      ],
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return stdout.toString().trim()
  }

  // Checked per entry, not as one alternation: a single matching entry would
  // otherwise mask every stale one. A framework change that drops one of these
  // imports should surface here rather than as dead weight in every plugin.
  test.each(DEV_ONLY_MODULES.map((module) => module.specifier))(
    'should still be imported by the framework: %s',
    (specifier) => {
      expect(importersOf(specifier)).not.toBe('')
    },
  )

  test('should not match a specifier that is merely mentioned', () => {
    // Guards the check above two ways: a grep that silently stopped working
    // would let every case pass, and a substring match would accept a module
    // the framework only names in a comment.
    expect(importersOf('@guren/not-a-real-dev-only-module')).toBe('')
    expect(importersOf('vit')).toBe('')
  })

  test.each(
    DEV_ONLY_MODULES.filter((module) => module.exportNames.length > 0).map((module) => [
      module.specifier,
      module.exportNames,
    ] as const),
  )('should name exports the importer actually destructures: %s', (specifier, exportNames) => {
    // A wrong name here still renders a stub, and only fails at bundle time
    // with "no matching export" — so check the names against the real importer.
    const found = importersOf(specifier)
    expect(found).not.toBe('')

    const files = found.split('\n')
    const source = files.map((file) => readFileSync(join(repoRoot, file), 'utf8')).join('\n')

    for (const name of exportNames) {
      expect(source).toContain(name)
    }
  })
})
