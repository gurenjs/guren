import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertOutputDirOutsideRoot,
  clientManifestJson,
  DATABASE_FACTORIES,
  detectDatabaseDialects,
  DEV_ONLY_MODULES,
  parseDatabaseDialects,
  unusedSqlClients,
  renderDevOnlyStub,
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

describe('clientManifestJson', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guren-client-manifest-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('should serialize the client manifest from either Vite layout under public/assets', () => {
    mkdirSync(join(dir, 'assets/.vite'), { recursive: true })
    writeFileSync(
      join(dir, 'assets/.vite/manifest.json'),
      JSON.stringify({ 'resources/css/app.css': { file: 'app-Abc123.css' } }, null, 2),
    )

    // Re-serialized from the parsed object: the payload is compact JSON, not
    // the pretty-printed bytes on disk.
    expect(clientManifestJson(dir)).toBe(
      JSON.stringify({ 'resources/css/app.css': { file: 'app-Abc123.css' } }),
    )
  })

  test('should answer even when the manifest has no client entry', () => {
    // resolveClientAssetEnv warns and returns {} for this app (no
    // resources/js/app.tsx), but a content-page app's viteAsset() calls still
    // need the manifest — the two helpers deliberately answer differently.
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(
      join(dir, 'assets/manifest.json'),
      JSON.stringify({ 'resources/css/app.css': { file: 'app-CssOnly.css' } }),
    )

    expect(clientManifestJson(dir)).toContain('app-CssOnly.css')
  })

  test('should return undefined when no manifest exists', () => {
    expect(clientManifestJson(dir)).toBeUndefined()
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
    // only because this entry happens to share no code with core's
    // others — the day one does, ESM splitting emits a chunk and the property
    // disappears with nothing else to notice.
    const built = join(import.meta.dir, '../../dist/internal/deploy-build.js')
    if (!existsSync(built)) {
      throw new Error(`Expected ${built}; run \`bun run build core\` before this test.`)
    }

    // A real parse rather than regexes: the bundler keeps JSDoc blocks, and
    // the module's own prose quotes `import pgClient from "postgres"` as the
    // line a developer's bundle fails on. scanImports reports every form —
    // static, side-effect, dynamic `import()` and `require()` — so a bundled
    // chunk cannot slip past while the builtin imports keep the assertion green.
    const specifiers = new Bun.Transpiler({ loader: 'js' })
      .scanImports(readFileSync(built, 'utf8'))
      .map((entry) => entry.path)

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

describe('renderDevOnlyStub', () => {
  // The message lands in the file twice, and only the thrown copy is safe on
  // its own: `JSON.stringify` escapes it, while the leading comment would end
  // at the first line terminator and run whatever followed as code. Callers
  // pass literals today — the escape exists because this is where the file is
  // constructed, not because the strings are untrusted.
  const LINE_SEPARATOR = String.fromCharCode(0x2028)
  const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

  const terminators: Array<[string, string]> = [
    ['line feed', '\n'],
    ['carriage return', '\r'],
    ['CRLF', '\r\n'],
    ['line separator', LINE_SEPARATOR],
    ['paragraph separator', PARAGRAPH_SEPARATOR],
  ]

  for (const [name, terminator] of terminators) {
    test(`keeps a ${name} inside the leading comment`, () => {
      const stub = renderDevOnlyStub(
        { specifier: 'x', kind: 'sqlite', exportNames: [] },
        `unavailable${terminator}globalThis.INJECTED = true //`,
      )

      const [comment] = stub.split(new RegExp(`\r\n|[\r\n${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`))
      expect(comment).toBe('// unavailable globalThis.INJECTED = true //')
    })
  }

  // JSON and JavaScript disagree here: JSON leaves U+2028/U+2029 raw, and
  // JavaScript below ES2019 reads them as line terminators — so a message
  // carrying one would end the `throw` statement it was embedded in.
  for (const [name, separator] of [
    ['line separator', LINE_SEPARATOR],
    ['paragraph separator', PARAGRAPH_SEPARATOR],
  ] as const) {
    test(`escapes a ${name} in the thrown message`, () => {
      const stub = renderDevOnlyStub(
        { specifier: 'x', kind: 'sqlite', exportNames: [] },
        `unavailable${separator}globalThis.INJECTED = true //`,
      )

      expect(stub).not.toContain(separator)
      expect(stub).toContain(separator === LINE_SEPARATOR ? '\\u2028' : '\\u2029')
    })
  }

  test('still names every export the importer destructures', () => {
    const stub = renderDevOnlyStub(
      { specifier: 'x', kind: 'sqlite', exportNames: ['Database', 'open'] },
      'nope',
    )

    expect(stub).toContain('export function Database()')
    expect(stub).toContain('export function open()')
    // Callable, because `import pgClient from "postgres"` calls its default.
    expect(stub).toContain('function unavailable()')
    expect(stub).toContain('export default Object.assign(unavailable, { Database, open })')
  })
})

describe('detectDatabaseDialects', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-dialects-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeConfig(relativePath: string, source: string): void {
    const path = join(root, relativePath)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, source)
  }

  test('should read the dialect a config declares', () => {
    writeConfig('config/database.ts', "import { createPostgresDatabase } from '@guren/orm'\nexport const db = createPostgresDatabase({})\n")

    expect(detectDatabaseDialects(root)).toEqual({ dialects: ['postgres'], source: 'config/database.ts' })
  })

  test('should report every dialect a config declares, not the first', () => {
    // Real shape, not a hypothetical: an app picks its database at runtime,
    // D1 when deployed and sqlite locally. Stopping at the first match stubs
    // a client the app actually reaches for.
    writeConfig(
      'config/database.ts',
      "import { createD1Database, createSqliteDatabase } from '@guren/core'\n"
        + 'const db = isWorkers() ? createD1Database({}) : createSqliteDatabase({})\n',
    )

    expect(detectDatabaseDialects(root).dialects).toEqual(['sqlite', 'd1'])
  })

  test('should fall back to the second config location', () => {
    writeConfig('db/config.ts', 'export const db = createMySqlDatabase({})\n')

    expect(detectDatabaseDialects(root)).toEqual({ dialects: ['mysql'], source: 'db/config.ts' })
  })

  test('should prefer config/database.ts when both exist', () => {
    writeConfig('config/database.ts', 'export const db = createPostgresDatabase({})\n')
    writeConfig('db/config.ts', 'export const db = createMySqlDatabase({})\n')

    expect(detectDatabaseDialects(root).dialects).toEqual(['postgres'])
  })

  test('should report no dialects when the config names no factory', () => {
    // An indirection the scan cannot follow. Reporting "none" here would be
    // read as "stub everything"; the caller has to be able to tell this apart
    // from a positive answer.
    writeConfig('config/database.ts', "export * from './database/postgres'\n")

    expect(detectDatabaseDialects(root)).toEqual({ source: 'config/database.ts' })
  })

  test('should report nothing when the app has no database config', () => {
    expect(detectDatabaseDialects(root)).toEqual({})
  })

  test('should not match a factory name embedded in a longer identifier', () => {
    writeConfig('config/database.ts', 'export const db = notCreatePostgresDatabaseAtAll({})\n')

    expect(detectDatabaseDialects(root).dialects).toBeUndefined()
  })
})

describe('unusedSqlClients', () => {
  let root: string
  let warnings: string[]
  const realWarn = console.warn

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-unused-clients-'))
    warnings = []
    console.warn = (message: string) => warnings.push(String(message))
  })

  afterEach(() => {
    console.warn = realWarn
    rmSync(root, { recursive: true, force: true })
  })

  function writeConfig(source: string): void {
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config/database.ts'), source)
  }

  test('should stub the clients of every dialect the app does not declare', () => {
    writeConfig('export const db = createPostgresDatabase({})\n')

    const specifiers = unusedSqlClients({ root, label: 'Test build' }).map(({ module }) => module.specifier)

    expect(specifiers).toEqual(['mysql2', 'mysql2/promise', '@aws-sdk/client-rds-data'])
  })

  test('should keep every client of a declared dialect', () => {
    writeConfig('export const db = createMySqlDatabase({})\n')

    const specifiers = unusedSqlClients({ root, label: 'Test build' }).map(({ module }) => module.specifier)

    // Both mysql2 entries, not just the one the factory names: drizzle reaches
    // the client through `mysql2/promise` while the ORM's own type import
    // names `mysql2`.
    expect(specifiers).not.toContain('mysql2')
    expect(specifiers).not.toContain('mysql2/promise')
    expect(specifiers).toContain('postgres')
  })

  test('should keep the clients of every declared dialect when a config names two', () => {
    writeConfig('const db = env ? createPostgresDatabase({}) : createSqliteDatabase({})\n')

    const specifiers = unusedSqlClients({ root, label: 'Test build' }).map(({ module }) => module.specifier)

    expect(specifiers).not.toContain('postgres')
    expect(specifiers).toEqual(['mysql2', 'mysql2/promise', '@aws-sdk/client-rds-data'])
  })

  test('should stub nothing and warn when the config declares no dialect', () => {
    // Fail open. Under-stubbing leaves today's behaviour — a loud build
    // failure naming a client the app never installed. Over-stubbing ships a
    // bundle that builds clean and cannot reach its own database.
    writeConfig("export * from './database/postgres'\n")

    expect(unusedSqlClients({ root, label: 'Test build' })).toEqual([])
    expect(warnings.join('\n')).toContain('config/database.ts names no @guren/orm database factory')
  })

  test('should stub nothing and warn when the app has no database config', () => {
    expect(unusedSqlClients({ root, label: 'Test build' })).toEqual([])
    expect(warnings.join('\n')).toContain('no database config found')
  })

  test('should reject an empty dialect list rather than read it as "declares nothing"', () => {
    // An empty array is truthy, so a plain `input.dialects ?` test would take
    // the override branch and stub *every* client — including postgres, which
    // this app connects through. The bundle would build clean and the deployed
    // function would throw on its first query.
    writeConfig('export const db = createPostgresDatabase({})\n')

    expect(() => unusedSqlClients({ root, label: 'Test build', dialects: [] })).toThrow(
      /does not name a database/,
    )
  })

  test('should reject a misspelled dialect rather than stub its client', () => {
    // Same failure as the empty list, one letter at a time: a dialect the
    // filter never sees is a dialect whose client it stubs.
    writeConfig('export const db = createPostgresDatabase({})\n')

    expect(() =>
      unusedSqlClients({ root, label: 'Test build', dialects: ['postgress' as never] }),
    ).toThrow(/does not name a database/)
  })

  test('should let an explicit dialect list override the config', () => {
    writeConfig('export const db = createPostgresDatabase({})\n')

    const specifiers = unusedSqlClients({ root, label: 'Test build', dialects: ['mysql'] }).map(
      ({ module }) => module.specifier,
    )

    expect(specifiers).toContain('postgres')
    expect(specifiers).not.toContain('mysql2')
    expect(warnings).toEqual([])
  })

  test('should name the dialect and the override in the message a stub throws', () => {
    writeConfig('export const db = createPostgresDatabase({})\n')

    const [first] = unusedSqlClients({ root, label: 'Lambda build' })

    expect(first?.message).toContain('"mysql2" client is stubbed')
    expect(first?.message).toContain('declares postgres, not mysql')
    expect(first?.message).toContain("databaseDialects: ['mysql']")
  })
})

describe('parseDatabaseDialects', () => {
  test('should accept a comma-separated list', () => {
    expect(parseDatabaseDialects('postgres, sqlite', 'Test build')).toEqual(['postgres', 'sqlite'])
  })

  test('should reject a name that is not a dialect', () => {
    // Narrowing silently to nothing would stub every client — the exact
    // failure the override exists to prevent.
    expect(() => parseDatabaseDialects('postgres,mongo', 'Test build')).toThrow(/does not name a database/)
  })

  test('should reject an empty list', () => {
    expect(() => parseDatabaseDialects(' , ', 'Test build')).toThrow(/does not name a database/)
  })
})

describe('DATABASE_FACTORIES', () => {
  test('should name exactly the database factories @guren/core exports', () => {
    // Built from the public export surface, not from the ORM's implementation
    // files: a list read off the implementation admits names that were never
    // exported and misses the ones that were. A factory this map misspells
    // (`createMysqlDatabase` for `createMySqlDatabase`) detects nothing and
    // stubs nothing, and nothing else would notice.
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const exported = [...index.matchAll(/^\s*(create\w*Database),$/gm)].map(([, name]) => name)

    expect(exported.length).toBeGreaterThan(0)
    expect(new Set(Object.keys(DATABASE_FACTORIES))).toEqual(new Set(exported))
  })
})
