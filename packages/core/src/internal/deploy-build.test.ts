import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SQL_CLIENT_MODULES,
  assertOutputDirOutsideRoot,
  CLIENT_ASSETS_URL_PREFIX,
  clientManifestJson,
  DATABASE_FACTORIES,
  detectDatabaseDialects,
  DEV_ONLY_MODULES,
  appUsesMcpPlugin,
  MCP_SDK_SUBPATH_PREFIX,
  MCP_TRANSPORT_SPECIFIER,
  parseDatabaseDialects,
  stubbableDevOnlyModules,
  unusedSqlClients,
  renderDevOnlyStub,
  importSpecifier,
  readManifest,
  resolveClientAssetEnv,
  resolvePathLike,
  ssrRuntimePaths,
  stageStaticAssets,
  translationCatalogJson,
} from './deploy-build'
import gurenVitePlugin from '../vite'

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

describe('resolveClientAssetEnv', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guren-client-asset-env-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('should address the entry and styles under the base the Vite plugin builds chunks with', () => {
    // The bundled modulepreload helper prefixes this base. An entry under any other
    // prefix makes the browser fetch every lazily loaded chunk twice, once per URL.
    const viteConfig: { base?: string } = {}
    gurenVitePlugin().config(viteConfig, { command: 'build', mode: 'production' })
    mkdirSync(join(dir, 'assets/.vite'), { recursive: true })
    writeFileSync(
      join(dir, 'assets/.vite/manifest.json'),
      JSON.stringify({ 'resources/js/app.tsx': { file: 'app-Abc123.js', css: ['app-Def456.css'] } }),
    )

    expect(viteConfig.base).toBe(CLIENT_ASSETS_URL_PREFIX)
    expect(resolveClientAssetEnv(dir, 'resources/js/app.tsx', 'Test build')).toEqual({
      entry: `${viteConfig.base}app-Abc123.js`,
      styles: `${viteConfig.base}app-Def456.css`,
    })
  })
})

describe('stageStaticAssets', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guren-stage-static-assets-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('should stage the built assets under the client prefix alone and keep every other public entry', () => {
    const publicDir = join(dir, 'public')
    const out = join(dir, 'out')
    mkdirSync(join(publicDir, 'assets/.vite'), { recursive: true })
    mkdirSync(join(publicDir, 'vendor/assets'), { recursive: true })
    writeFileSync(join(publicDir, 'assets/app-Abc123.js'), '')
    writeFileSync(join(publicDir, 'assets-map.json'), '{}')
    writeFileSync(join(publicDir, 'vendor/assets/logo.png'), '')

    stageStaticAssets(publicDir, out)

    expect(existsSync(join(out, CLIENT_ASSETS_URL_PREFIX, 'app-Abc123.js'))).toBe(true)
    expect(existsSync(join(out, 'assets'))).toBe(false)
    expect(existsSync(join(out, 'assets-map.json'))).toBe(true)
    expect(existsSync(join(out, 'vendor/assets/logo.png'))).toBe(true)
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

describe('translationCatalogJson', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-translations-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeCatalog(path: string, contents: string): void {
    mkdirSync(join(root, 'lang', path, '..'), { recursive: true })
    writeFileSync(join(root, 'lang', path), contents)
  }

  test('should key every lang/<locale>/<namespace>.json by locale and namespace', () => {
    writeCatalog('en/messages.json', JSON.stringify({ welcome: 'Welcome to :name!' }, null, 2))
    writeCatalog('en/auth.json', JSON.stringify({ failed: 'These credentials do not match.' }))
    writeCatalog('ja/messages.json', JSON.stringify({ welcome: ':nameへようこそ' }))
    writeCatalog('en/README.md', '# not a catalog')

    expect(JSON.parse(translationCatalogJson(root, 'Test build')!)).toEqual({
      en: {
        auth: { failed: 'These credentials do not match.' },
        messages: { welcome: 'Welcome to :name!' },
      },
      ja: { messages: { welcome: ':nameへようこそ' } },
    })
  })

  test('should answer undefined for an app with no lang/ directory', () => {
    expect(translationCatalogJson(root, 'Test build')).toBeUndefined()
  })

  test('should leave out a file that does not parse, and say which', () => {
    writeCatalog('en/messages.json', JSON.stringify({ hello: 'Hello' }))
    writeCatalog('en/broken.json', '{ "hello": ')
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      expect(JSON.parse(translationCatalogJson(root, 'Test build')!)).toEqual({
        en: { messages: { hello: 'Hello' } },
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Test build: lang/en/broken.json is not valid JSON'))
    } finally {
      warn.mockRestore()
    }
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

  function sourcesUnder(root: string): string[] {
    return readdirSync(join(repoRoot, root), { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
      .map((entry) => join(repoRoot, root, entry))
  }

  /**
   * Parsed imports, not a text search: `vite` alone also hits a `@vite-ignore`
   * comment and an identifier, and a line-based search misses an `import(` whose
   * specifier sits on the next line — reporting an import that was never deleted.
   */
  const transpilers = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }) }

  function importersOf(specifier: string, root: string): string[] {
    return sourcesUnder(root).filter((file) => {
      const source = readFileSync(file, 'utf8')
      // Text first, parse second: the parse is what rejects a mere mention.
      if (!source.includes(specifier)) return false
      return transpilers[file.endsWith('.tsx') ? 'tsx' : 'ts']
        // A CLI entry's shebang is not TypeScript, and the scan rejects it.
        .scanImports(source.replace(/^#!.*/, ''))
        .some((entry) => entry.path === specifier)
    })
  }

  // Per entry, and only inside the package the entry is listed for: searching every
  // package would let one package's import keep another's stale entry alive.
  test.each([...DEV_ONLY_MODULES])(
    'should still be imported by the package it is listed for: $specifier',
    (module) => {
      expect(importersOf(module.specifier, module.importedBy)).not.toEqual([])
    },
  )

  test('should not match a specifier that is merely mentioned', () => {
    // Guards the check above: a scan that stopped working would pass every case,
    // and a prefix match would accept a module only named in a comment.
    expect(importersOf('@guren/not-a-real-dev-only-module', 'packages/server/src')).toEqual([])
    expect(importersOf('vit', 'packages/server/src')).toEqual([])
  })

  test.each(DEV_ONLY_MODULES.filter((module) => module.exportNames.length > 0))(
    'should name exports the importer actually destructures: $specifier',
    (module) => {
      // A wrong name still renders a stub and fails only at bundle time with "no
      // matching export".
      const files = importersOf(module.specifier, module.importedBy)
      expect(files).not.toEqual([])

      const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')
      for (const name of module.exportNames) {
        expect(source).toContain(name)
      }
    },
  )
})

describe('the surface published deploy plugins link against', () => {
  // Deploy plugins already on npm import these names under a caret on core and look a
  // stub's message up by `kind`. Lambda and Vercel key only the dev-only kinds;
  // Cloudflare also walks SQL_CLIENT_MODULES with `sql-driver`. A missing name fails
  // their root module at link time; an unknown kind passes an undefined message.
  const DEV_ONLY_KEYS: readonly string[] = ['sqlite', 'vite', 'mcp']
  const SQL_CLIENT_KEYS: readonly string[] = ['sql-driver']

  function tableOf(keys: readonly string[]): Record<string, string> {
    return Object.fromEntries(keys.map((kind) => [kind, `${kind} is unavailable here.`]))
  }

  test('should keep every dev-only kind the Lambda and Vercel tables look up', () => {
    const table = tableOf(DEV_ONLY_KEYS)

    for (const module of stubbableDevOnlyModules({ mcpPlugin: false })) {
      expect(DEV_ONLY_KEYS).toContain(module.kind)
      expect(() => renderDevOnlyStub(module, table[module.kind])).not.toThrow()
    }
  })

  test('should keep every kind the Cloudflare table looks up across both lists', () => {
    const table = tableOf([...DEV_ONLY_KEYS, ...SQL_CLIENT_KEYS])

    for (const module of DEV_ONLY_MODULES) {
      expect(DEV_ONLY_KEYS).toContain(module.kind)
    }
    for (const module of SQL_CLIENT_MODULES) {
      expect(SQL_CLIENT_KEYS).toContain(module.kind)
    }
    for (const module of [...DEV_ONLY_MODULES, ...SQL_CLIENT_MODULES]) {
      expect(() => renderDevOnlyStub(module, table[module.kind])).not.toThrow()
    }
  })

  test('should keep the deprecated constants at their published values', () => {
    expect(MCP_TRANSPORT_SPECIFIER).toBe('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')
    expect(MCP_SDK_SUBPATH_PREFIX).toBe('@modelcontextprotocol/sdk/')
  })

  test('should list the same modules whether or not the app declares the MCP plugin', () => {
    expect(stubbableDevOnlyModules({ mcpPlugin: true })).toEqual(DEV_ONLY_MODULES)
    expect(stubbableDevOnlyModules({ mcpPlugin: false })).toEqual(DEV_ONLY_MODULES)
  })

  describe('appUsesMcpPlugin', () => {
    let root: string

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'guren-mcp-optin-'))
    })

    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    test('should report a runtime dependency on the plugin', () => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@guren/plugin-mcp': '^0.6.0' } }))

      expect(appUsesMcpPlugin(root)).toBe(true)
    })

    test('should not report a devDependency, a missing manifest or a malformed one', () => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@guren/plugin-mcp': '^0.6.0' } }))
      expect(appUsesMcpPlugin(root)).toBe(false)

      writeFileSync(join(root, 'package.json'), '{ not json')
      expect(appUsesMcpPlugin(root)).toBe(false)

      rmSync(join(root, 'package.json'))
      expect(appUsesMcpPlugin(root)).toBe(false)
    })
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
        { exportNames: [] },
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
        { exportNames: [] },
        `unavailable${separator}globalThis.INJECTED = true //`,
      )

      expect(stub).not.toContain(separator)
      expect(stub).toContain(separator === LINE_SEPARATOR ? '\\u2028' : '\\u2029')
    })
  }

  test('still names every export the importer destructures', () => {
    const stub = renderDevOnlyStub(
      { exportNames: ['Database', 'open'] },
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
