import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appUsesMcpPlugin,
  assertOutputDirOutsideRoot,
  clientManifestJson,
  DATABASE_FACTORIES,
  MCP_TRANSPORT_SPECIFIER,
  stubbableDevOnlyModules,
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
    // `relative` returns "..-source"; `startsWith('..')` would read that as an
    // escape and let the delete run over a directory inside the output dir.
    expect(() => assertOutputDirOutsideRoot('/tmp/app', '/tmp/app/..-source', 'Test build')).toThrow(
      /never the root itself or a parent of it/,
    )
  })

  test('should reject the filesystem root', () => {
    // `out + sep` is "//" here, so a string-prefix containment test accepts it.
    expect(() => assertOutputDirOutsideRoot('/', '/app', 'Test build')).toThrow(
      /never the root itself or a parent of it/,
    )
  })

  test('should reject an outputDir that reaches the app root through a symlink', () => {
    // The delete follows symlinks, so a lexical comparison is not enough (on
    // macOS /tmp is itself a symlink to /private/tmp).
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
    // The bundler resolves the emitted import from the module's real path, so a
    // specifier computed from the link path is short a `..` whenever link and
    // target sit at different depths (macOS /tmp -> /private/tmp).
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

    // The payload is compact JSON, not the pretty-printed bytes on disk.
    expect(clientManifestJson(dir)).toBe(
      JSON.stringify({ 'resources/css/app.css': { file: 'app-Abc123.css' } }),
    )
  })

  test('should answer even when the manifest has no client entry', () => {
    // resolveClientAssetEnv returns {} for this app (no resources/js/app.tsx),
    // but a content-page app's viteAsset() calls still need the manifest.
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(
      join(dir, 'assets/manifest.json'),
      JSON.stringify({ 'resources/css/app.css': { file: 'app-CssOnly.css' } }),
    )

    expect(clientManifestJson(dir)).toContain('app-CssOnly.css')
  })

  test('should trim entries to the fields the runtime reads (file, css)', () => {
    // The payload ships inside executable code, and a real manifest is dominated
    // by per-chunk graph metadata nothing at runtime consumes.
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(
      join(dir, 'assets/manifest.json'),
      JSON.stringify({
        'resources/js/app.tsx': {
          file: 'app-Abc123.js',
          css: ['app-Def456.css'],
          src: 'resources/js/app.tsx',
          isEntry: true,
          imports: ['_chunk-AAA.js', '_chunk-BBB.js'],
          dynamicImports: ['_lazy-CCC.js'],
        },
        '_chunk-AAA.js': { file: 'chunk-AAA.js', imports: ['_chunk-BBB.js'] },
      }),
    )

    expect(clientManifestJson(dir)).toBe(
      JSON.stringify({
        'resources/js/app.tsx': { file: 'app-Abc123.js', css: ['app-Def456.css'] },
        '_chunk-AAA.js': { file: 'chunk-AAA.js' },
      }),
    )
  })

  test('should report parseable-but-not-a-manifest JSON as no manifest at build time', () => {
    // Baking `null` or an array in fails only at first render; the build is
    // where the file is fixable.
    mkdirSync(join(dir, 'assets'), { recursive: true })

    writeFileSync(join(dir, 'assets/manifest.json'), 'null')
    expect(clientManifestJson(dir)).toBeUndefined()

    writeFileSync(join(dir, 'assets/manifest.json'), '["not", "a", "manifest"]')
    expect(clientManifestJson(dir)).toBeUndefined()
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
    // A malformed .vite/manifest.json beside a valid flat one: naming the file
    // that merely exists publishes the path to the skipped one.
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
    // leaves the real SDK in a Workers bundle.
    expect(sdkEntries.length).toBeGreaterThan(0)
    for (const entry of sdkEntries) {
      expect(entry.specifier.startsWith(MCP_SDK_SUBPATH_PREFIX)).toBe(true)
    }
  })

  test('should carry the transport entry the App MCP endpoint needs', () => {
    // Dropped by specifier: an upstream rename would drop nothing and leave the
    // endpoint stubbed.
    expect(DEV_ONLY_MODULES.map((module) => module.specifier)).toContain(MCP_TRANSPORT_SPECIFIER)
  })
})

describe('appUsesMcpPlugin', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-mcp-optin-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeManifest(manifest: unknown): void {
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  }

  test('should report the opt-in when the plugin is a runtime dependency', () => {
    writeManifest({ name: 'app', dependencies: { '@guren/core': '^1.12.0', '@guren/plugin-mcp': '^0.2.0' } })

    expect(appUsesMcpPlugin(root)).toBe(true)
  })

  test('should not report the opt-in for a devDependency', () => {
    // A devDependency never ships, so the deployed app has no endpoint for the
    // transport to serve.
    writeManifest({ name: 'app', devDependencies: { '@guren/plugin-mcp': '^0.2.0' } })

    expect(appUsesMcpPlugin(root)).toBe(false)
  })

  test('should not report the opt-in when the manifest declares no dependencies', () => {
    writeManifest({ name: 'app' })

    expect(appUsesMcpPlugin(root)).toBe(false)
  })

  test('should not report the opt-in when there is no manifest', () => {
    // Absent evidence is not evidence of opt-in; false leaves it stubbed.
    expect(appUsesMcpPlugin(root)).toBe(false)
  })

  test('should not report the opt-in when the manifest is malformed', () => {
    writeFileSync(join(root, 'package.json'), '{ not json')

    expect(appUsesMcpPlugin(root)).toBe(false)
  })
})

describe('stubbableDevOnlyModules', () => {
  test('should stub every dev-only module for an app without the MCP plugin', () => {
    expect(stubbableDevOnlyModules({ mcpPlugin: false }).map((module) => module.specifier)).toEqual(
      DEV_ONLY_MODULES.map((module) => module.specifier),
    )
  })

  test('should drop only the transport for an app with the MCP plugin', () => {
    const specifiers = stubbableDevOnlyModules({ mcpPlugin: true }).map((module) => module.specifier)

    expect(specifiers).toEqual(
      DEV_ONLY_MODULES.map((module) => module.specifier).filter(
        (specifier) => specifier !== MCP_TRANSPORT_SPECIFIER,
      ),
    )
    // The Dev MCP's McpServer generates files on disk and must stay compiled
    // shut whatever the app depends on; `@guren/cli` behind it drags in Babel.
    expect(specifiers).toContain('@modelcontextprotocol/sdk/server/mcp.js')
    expect(specifiers).toContain('@guren/cli')
    expect(specifiers).toContain('bun:sqlite')
    expect(specifiers).toContain('vite')
    expect(specifiers).not.toContain(MCP_TRANSPORT_SPECIFIER)
  })
})

describe('the built artifact', () => {
  test('should import nothing but node builtins', () => {
    // Importing it must not drag the framework runtime into a developer's build.
    // That holds only while this entry shares no code with core's others: the
    // day one does, ESM splitting emits a chunk and nothing else would notice.
    const built = join(import.meta.dir, '../../dist/internal/deploy-build.js')
    if (!existsSync(built)) {
      throw new Error(`Expected ${built}; run \`bun run build core\` before this test.`)
    }

    // A real parse, not regexes: the bundler keeps JSDoc blocks, and the
    // module's own prose quotes `import pgClient from "postgres"`. scanImports
    // reports every form, so a bundled chunk cannot slip past.
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
   * Matched on the import form, not the bare string: `vite` alone also hits a
   * `@vite-ignore` comment and an identifier, leaving this green after the real
   * import was deleted.
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

  // Per entry, not one alternation: a single match would mask every stale one.
  test.each(DEV_ONLY_MODULES.map((module) => module.specifier))(
    'should still be imported by the framework: %s',
    (specifier) => {
      expect(importersOf(specifier)).not.toBe('')
    },
  )

  test('should not match a specifier that is merely mentioned', () => {
    // Guards the check above: a grep that stopped working would pass every case,
    // and a substring match would accept a module only named in a comment.
    expect(importersOf('@guren/not-a-real-dev-only-module')).toBe('')
    expect(importersOf('vit')).toBe('')
  })

  test.each(
    DEV_ONLY_MODULES.filter((module) => module.exportNames.length > 0).map((module) => [
      module.specifier,
      module.exportNames,
    ] as const),
  )('should name exports the importer actually destructures: %s', (specifier, exportNames) => {
    // A wrong name still renders a stub and fails only at bundle time with "no
    // matching export".
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
  // The message lands in the file twice and only the thrown copy is safe on its
  // own: the leading comment would end at the first line terminator and run
  // whatever followed as code.
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

  // JSON leaves U+2028/U+2029 raw while JavaScript below ES2019 reads them as
  // line terminators, ending the `throw` statement they were embedded in.
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
    // An app picks its database at runtime, D1 deployed and sqlite locally;
    // stopping at the first match stubs a client it actually reaches for.
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
    // An indirection the scan cannot follow: reporting "none" would read as
    // "stub everything".
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

    // Both mysql2 entries: drizzle reaches the client through `mysql2/promise`
    // while the ORM's own type import names `mysql2`.
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
    // Fail open: under-stubbing fails the build loudly, over-stubbing ships a
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
    // An empty array is truthy, so a plain `input.dialects ?` test takes the
    // override branch and stubs *every* client, postgres included.
    writeConfig('export const db = createPostgresDatabase({})\n')

    expect(() => unusedSqlClients({ root, label: 'Test build', dialects: [] })).toThrow(
      /does not name a database/,
    )
  })

  test('should reject a misspelled dialect rather than stub its client', () => {
    // A dialect the filter never sees is one whose client it stubs.
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
    // Narrowing silently to nothing would stub every client.
    expect(() => parseDatabaseDialects('postgres,mongo', 'Test build')).toThrow(/does not name a database/)
  })

  test('should reject an empty list', () => {
    expect(() => parseDatabaseDialects(' , ', 'Test build')).toThrow(/does not name a database/)
  })
})

describe('DATABASE_FACTORIES', () => {
  test('should name exactly the database factories @guren/core exports', () => {
    // Built from the public export surface, not the ORM's implementation files.
    // A factory this map misspells (`createMysqlDatabase`) detects nothing and
    // stubs nothing, with nothing else to notice.
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const exported = [...index.matchAll(/^\s*(create\w*Database),$/gm)].map(([, name]) => name)

    expect(exported.length).toBeGreaterThan(0)
    expect(new Set(Object.keys(DATABASE_FACTORIES))).toEqual(new Set(exported))
  })
})
