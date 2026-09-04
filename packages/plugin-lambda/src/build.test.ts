import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildLambdaOutput } from './build'

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2))
}

/**
 * Import the bundle in a fresh process, like Lambda does, and return what its
 * `http` export produces. Out-of-process is required because `bun test
 * --isolate` resolves an in-process dynamic import of a top-level-await module
 * before the wrapper has settled.
 */
function probeHttpExport(root: string): string {
  const probe = 'const m = await import(process.argv[1]); console.log(m.http())'
  const result = Bun.spawnSync({
    cmd: [process.execPath, '-e', probe, join(root, '.lambda/function/handler.js')],
    stdout: 'pipe',
    stderr: 'pipe',
  })

  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
  return result.stdout.toString().trim()
}

/** The client manifest `scaffoldApp` writes — assertions derive from this. */
const CLIENT_MANIFEST = {
  'resources/js/app.tsx': { file: 'app-Abc123.js', css: ['app-Def456.css'] },
}

interface ScaffoldOptions {
  ssr?: boolean
  renderExport?: string
  /** Lines placed above the handler exports, plus the body of the `http` export. */
  entry?: { preamble?: string[]; http: string }
  /** Declare `@guren/plugin-mcp` under `dependencies` — the App MCP opt-in (RFC 0016 §7). */
  mcpPlugin?: boolean
}

/** Markers the fake SDK exports, so a test can tell "resolved" from "stubbed". */
const SDK_SERVER_INDEX_MARKER = 'fake-sdk-server-index'
const SDK_TRANSPORT_MARKER = 'fake-sdk-transport'

/**
 * A stand-in for `@modelcontextprotocol/sdk` inside the scaffolded app.
 * Deliberately without an `exports` map: a slightly wrong subpath under one
 * fails to resolve and reads exactly like the stub still intercepting, the
 * verdict these tests exist to distinguish. Both subpaths matter —
 * `webStandardStreamableHttp.js` is the entry `stubbableDevOnlyModules`
 * releases, and `server/index.js` is one `DEV_ONLY_MODULES` never named, so only
 * the SDK-prefix catch-all can stub it.
 */
function installFakeMcpSdk(root: string): void {
  const pkg = join(root, 'node_modules/@modelcontextprotocol/sdk')
  mkdirSync(join(pkg, 'server'), { recursive: true })
  writeJson(join(pkg, 'package.json'), {
    name: '@modelcontextprotocol/sdk',
    version: '1.30.0',
    type: 'module',
  })
  writeFileSync(join(pkg, 'server/index.js'), `export const MARKER = '${SDK_SERVER_INDEX_MARKER}'\n`)
  writeFileSync(
    join(pkg, 'server/webStandardStreamableHttp.js'),
    `export const WebStandardStreamableHTTPServerTransport = '${SDK_TRANSPORT_MARKER}'\n`,
  )
}

/**
 * An entry importing both SDK subpaths and reporting what it got.
 * `server/index.js` comes in as a *namespace*: the catch-all stub for an
 * unlisted subpath is a bare `throw` with no exports, so a named import would
 * fail the bundle rather than the bundled module — making the stubbed and
 * unstubbed cases fail at different stages. A namespace import bundles either
 * way and throws on evaluation.
 */
const SDK_ENTRY: ScaffoldOptions['entry'] = {
  preamble: [
    "import * as serverIndex from '@modelcontextprotocol/sdk/server/index.js'",
    "import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'",
  ],
  http: '`${serverIndex.MARKER}|${WebStandardStreamableHTTPServerTransport}`',
}

function scaffoldApp(root: string, options: ScaffoldOptions = {}): void {
  const {
    ssr = true,
    renderExport = 'export const render = () => ({ body: "", head: [] })',
    entry = { http: 'process.env.NODE_ENV' },
    mcpPlugin = false,
  } = options

  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src/lambda.ts'),
    [
      ...(entry.preamble ?? []),
      `export const http = () => ${entry.http}`,
      'export const queue = () => "queue"',
      'export const schedule = () => "schedule"',
      'const consoleHandler = () => "console"',
      'export { consoleHandler as console }',
      '',
    ].join('\n'),
  )
  writeJson(join(root, 'package.json'), {
    name: '@acme/demo-app',
    ...(mcpPlugin ? { dependencies: { '@guren/plugin-mcp': '^0.2.0' } } : {}),
  })

  mkdirSync(join(root, 'public/assets/.vite'), { recursive: true })
  writeFileSync(join(root, 'public/robots.txt'), 'User-agent: *\n')
  writeFileSync(join(root, 'public/assets/app-Abc123.js'), 'console.log("client")\n')
  writeJson(join(root, 'public/assets/.vite/manifest.json'), CLIENT_MANIFEST)

  mkdirSync(join(root, 'db/migrations/20260101000000_init'), { recursive: true })
  writeFileSync(join(root, 'db/migrations/20260101000000_init/migration.sql'), 'CREATE TABLE posts (id serial);\n')

  mkdirSync(join(root, 'db/seeders'), { recursive: true })
  writeFileSync(join(root, 'db/seeders/001_init.ts'), 'export default async () => {}\n')

  if (ssr) {
    mkdirSync(join(root, '.guren/ssr/.vite'), { recursive: true })
    writeFileSync(join(root, '.guren/ssr/ssr-Xyz789.js'), `${renderExport}\n`)
    writeJson(join(root, '.guren/ssr/.vite/manifest.json'), {
      'resources/js/ssr.tsx': { file: 'ssr-Xyz789.js' },
    })
  }
}

describe('buildLambdaOutput', () => {
  let root: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-lambda-build-'))
    savedEnv = {
      GUREN_INERTIA_ENTRY: process.env.GUREN_INERTIA_ENTRY,
      GUREN_INERTIA_STYLES: process.env.GUREN_INERTIA_STYLES,
      GUREN_INERTIA_SSR_ENTRY: process.env.GUREN_INERTIA_SSR_ENTRY,
      GUREN_INERTIA_SSR_MANIFEST: process.env.GUREN_INERTIA_SSR_MANIFEST,
    }
    for (const key of Object.keys(savedEnv)) {
      delete process.env[key]
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  test('should generate a handler wrapper that bakes env defaults before importing the app', async () => {
    scaffoldApp(root)

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    const wrapper = readFileSync(join(root, '.lambda/handler.ts'), 'utf8')
    expect(wrapper).toContain('process.env.GUREN_INERTIA_ENTRY ??= "/assets/app-Abc123.js"')
    expect(wrapper).toContain('process.env.GUREN_INERTIA_STYLES ??= "/assets/app-Def456.css"')
    expect(wrapper).toContain('process.env.GUREN_INERTIA_SSR_ENTRY ??= "./.guren/ssr/ssr-Xyz789.js"')
    expect(wrapper).toContain('const module = await import("../src/lambda.ts")')
    expect(wrapper).toContain('export const http = module.http')
    expect(wrapper).toContain('export { consoleHandler as console }')
    // The env assignments must precede the app import — static imports would
    // hoist past them.
    expect(wrapper.indexOf('GUREN_INERTIA_ENTRY')).toBeLessThan(wrapper.indexOf('await import'))
  })

  test('should bake the client manifest for viteAsset() into the wrapper, never into env.json', async () => {
    scaffoldApp(root)

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    // The function bundle ships no public/assets/manifest.json, so viteAsset()
    // resolves from the GUREN_VITE_MANIFEST injection.
    const wrapper = readFileSync(join(root, '.lambda/handler.ts'), 'utf8')
    expect(wrapper).toContain(
      `process.env.GUREN_VITE_MANIFEST ??= ${JSON.stringify(JSON.stringify(CLIENT_MANIFEST))}`,
    )
    expect(wrapper.indexOf('GUREN_VITE_MANIFEST')).toBeLessThan(wrapper.indexOf('await import'))

    // env.json feeds Lambda function configuration, which is capped at 4KB
    // total — a real manifest there would fail deploys, so it must stay out.
    const env = JSON.parse(readFileSync(join(root, '.lambda/env.json'), 'utf8')) as Record<string, string>
    expect(env.GUREN_VITE_MANIFEST).toBeUndefined()
  })

  test('should bundle an ESM function with NODE_ENV inlined to production', async () => {
    scaffoldApp(root)

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    const bundle = readFileSync(join(root, '.lambda/function/handler.js'), 'utf8')
    expect(bundle).toContain('"production"')
    expect(bundle).not.toContain('"development"')

    const funcPackage = JSON.parse(readFileSync(join(root, '.lambda/function/package.json'), 'utf8'))
    expect(funcPackage.type).toBe('module')
  })

  test('should export working handlers from the bundle', async () => {
    scaffoldApp(root)

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    // A fresh process, like Lambda: the wrapper's top-level await must settle
    // before the exports are read, and `bun test --isolate` resolves a dynamic
    // in-process import of such a module too early.
    const probe = [
      `const module = await import(${JSON.stringify(pathToFileURL(join(root, '.lambda/function/handler.js')).href)})`,
      'console.log(JSON.stringify({',
      '  http: typeof module.http,',
      '  console: typeof module.console,',
      '  nodeEnv: module.http(),',
      '  bakedEntry: process.env.GUREN_INERTIA_ENTRY,',
      '}))',
    ].join('\n')
    const result = Bun.spawnSync({ cmd: [process.execPath, '-e', probe], stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).toBe(0)

    const report = JSON.parse(result.stdout.toString().trim()) as Record<string, string>
    expect(report.http).toBe('function')
    expect(report.console).toBe('function')
    // NODE_ENV is substituted at bundle time, so the handler sees production
    // regardless of the invoking process's environment.
    expect(report.nodeEnv).toBe('production')
    // Importing the bundle applied the baked env defaults.
    expect(report.bakedEntry).toBe('/assets/app-Abc123.js')
  })

  test('should preserve class names through minification', async () => {
    // Regression test for the `minify` option in bundleHandler: the framework
    // keys the job registry on `JobClass.name`, so mangled identifiers make
    // `getJob()` miss and no job code ever runs.
    scaffoldApp(root, {
      entry: { preamble: ['class ProcessNewPostJob { handle() {} }'], http: 'ProcessNewPostJob.name' },
    })

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    expect(probeHttpExport(root)).toBe('ProcessNewPostJob')
  })

  test('should copy the SSR bundle and migrations, but never seeders, into the function directory', async () => {
    scaffoldApp(root)

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    expect(existsSync(join(root, '.lambda/function/.guren/ssr/ssr-Xyz789.js'))).toBe(true)
    expect(existsSync(join(root, '.lambda/function/db/migrations/20260101000000_init/migration.sql'))).toBe(true)
    expect(existsSync(join(root, '.lambda/function/db/seeders'))).toBe(false)

    const env = JSON.parse(readFileSync(join(root, '.lambda/env.json'), 'utf8'))
    expect(env.NODE_ENV).toBe('production')
    expect(env.GUREN_INERTIA_ENTRY).toBe('/assets/app-Abc123.js')
    expect(env.GUREN_INERTIA_SSR_ENTRY).toBe('./.guren/ssr/ssr-Xyz789.js')
    expect(env.GUREN_INERTIA_SSR_MANIFEST).toBe('./.guren/ssr/.vite/manifest.json')
  })

  test('should define import.meta.url so `new URL("../db/migrations", import.meta.url)` resolves against the function root', async () => {
    // Regression test: config/database.ts and config/app.ts resolve their
    // migrations/seeders folders via `new URL('../db/migrations',
    // import.meta.url)` from one directory below the app root. Left undefined,
    // every module in the single bundled output shares the deployed
    // `file:///var/task/handler.js`, collapsing that to `/var/db/migrations` and
    // silently skipping configureOrm()/seedDatabase() in production.
    scaffoldApp(root, {
      entry: {
        preamble: ["const resolved = new URL('../db/migrations', import.meta.url)"],
        http: 'resolved.pathname',
      },
    })

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    expect(probeHttpExport(root)).toBe('/var/task/db/migrations')
  })

  test('should stage public files for S3 with the /public/assets mirror', async () => {
    scaffoldApp(root)
    writeFileSync(join(root, 'public/index.html'), '<div id="app"></div>')

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    expect(readFileSync(join(root, '.lambda/assets/robots.txt'), 'utf8')).toContain('User-agent')
    expect(existsSync(join(root, '.lambda/assets/assets/app-Abc123.js'))).toBe(true)
    expect(existsSync(join(root, '.lambda/assets/public/assets/app-Abc123.js'))).toBe(true)
    expect(existsSync(join(root, '.lambda/assets/index.html'))).toBe(false)
  })

  test('should resolve the client manifest from a custom publicDir', async () => {
    scaffoldApp(root)
    const customPublic = join(root, 'static-site')
    mkdirSync(join(customPublic, 'assets/.vite'), { recursive: true })
    writeFileSync(join(customPublic, 'assets/app-Custom99.js'), 'console.log("custom")\n')
    writeJson(join(customPublic, 'assets/.vite/manifest.json'), {
      'resources/js/app.tsx': { file: 'app-Custom99.js' },
    })

    await buildLambdaOutput({ rootDir: root, publicDir: customPublic, skipAppBuild: true })

    const env = JSON.parse(readFileSync(join(root, '.lambda/env.json'), 'utf8'))
    expect(env.GUREN_INERTIA_ENTRY).toBe('/assets/app-Custom99.js')
    expect(existsSync(join(root, '.lambda/assets/assets/app-Custom99.js'))).toBe(true)
  })

  test('should point the SSR manifest env at the root-level fallback layout', async () => {
    scaffoldApp(root, { ssr: false })
    mkdirSync(join(root, '.guren/ssr'), { recursive: true })
    writeFileSync(join(root, '.guren/ssr/ssr-Xyz789.js'), 'export const render = () => ({ body: "", head: [] })\n')
    writeJson(join(root, '.guren/ssr/manifest.json'), {
      'resources/js/ssr.tsx': { file: 'ssr-Xyz789.js' },
    })

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    const env = JSON.parse(readFileSync(join(root, '.lambda/env.json'), 'utf8'))
    expect(env.GUREN_INERTIA_SSR_MANIFEST).toBe('./.guren/ssr/manifest.json')
  })

  test('should build a CSR-only function when no SSR manifest exists', async () => {
    scaffoldApp(root, { ssr: false })

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    expect(existsSync(join(root, '.lambda/function/.guren'))).toBe(false)

    const env = JSON.parse(readFileSync(join(root, '.lambda/env.json'), 'utf8'))
    expect(env.GUREN_INERTIA_SSR_ENTRY).toBeUndefined()
  })

  test('should reject an SSR manifest entry that escapes the SSR directory', async () => {
    scaffoldApp(root)
    writeJson(join(root, '.guren/ssr/.vite/manifest.json'), {
      'resources/js/ssr.tsx': { file: '../../outside.js' },
    })

    await expect(buildLambdaOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /escapes the SSR output directory/,
    )
  })

  test('should throw when the SSR entry exports no renderer', async () => {
    scaffoldApp(root, { renderExport: 'export const unrelated = 42' })

    await expect(buildLambdaOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /does not export a renderer/,
    )
  })

  test('should point at the plugin scaffold when the entrypoint is missing', async () => {
    scaffoldApp(root)
    rmSync(join(root, 'src/lambda.ts'))

    await expect(buildLambdaOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /guren plugin @guren\/plugin-lambda/,
    )
  })

  test('should refuse an outputDir that is or contains the app root', async () => {
    scaffoldApp(root)

    await expect(
      buildLambdaOutput({ rootDir: root, outputDir: root, skipAppBuild: true }),
    ).rejects.toThrow(/never the root itself/)
    await expect(
      buildLambdaOutput({ rootDir: root, outputDir: join(root, '..'), skipAppBuild: true }),
    ).rejects.toThrow(/never the root itself/)
    expect(existsSync(join(root, 'src/lambda.ts'))).toBe(true)
  })

  test('should keep the previous output when the build fails', async () => {
    scaffoldApp(root)
    // A previous successful deploy, and an entrypoint that has gone missing.
    mkdirSync(join(root, '.lambda/function'), { recursive: true })
    writeFileSync(join(root, '.lambda/function/handler.js'), 'export const http = () => "old"\n')
    rmSync(join(root, 'src/lambda.ts'))

    await expect(buildLambdaOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /entrypoint not found/,
    )

    // Deleting up front would take the last deployable artifact with it,
    // leaving nothing to roll back to or inspect.
    expect(existsSync(join(root, '.lambda/function/handler.js'))).toBe(true)
  })

  test('should refuse the filesystem root as outputDir', async () => {
    scaffoldApp(root)

    // `out + sep` is "//" here, which no absolute path is prefixed by — a
    // string-prefix containment test lets this through to the rmSync.
    await expect(
      buildLambdaOutput({ rootDir: root, outputDir: '/', skipAppBuild: true }),
    ).rejects.toThrow(/never the root itself or a parent of it/)
    expect(existsSync(join(root, 'src/lambda.ts'))).toBe(true)
  })

  test('should make an unlisted MCP SDK subpath throw rather than resolve empty', async () => {
    scaffoldApp(root, {
      entry: {
        preamble: ["import * as sdk from '@modelcontextprotocol/sdk/server/unlisted.js'"],
        http: 'String(sdk)',
      },
    })

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    const probe = 'await import(process.argv[1])'
    const result = Bun.spawnSync({
      cmd: [process.execPath, '-e', probe, join(root, '.lambda/function/handler.js')],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('The MCP endpoint is unavailable on AWS Lambda')
  })

  test('should stub both MCP SDK subpaths for an app that does not depend on the plugin', async () => {
    // The regression hold: nothing about RFC 0016 Phase 4a may reach an app
    // that never asked for the App MCP endpoint.
    scaffoldApp(root, { entry: SDK_ENTRY })
    installFakeMcpSdk(root)

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    const result = Bun.spawnSync({
      cmd: [process.execPath, '-e', 'await import(process.argv[1])', join(root, '.lambda/function/handler.js')],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('The MCP endpoint is unavailable on AWS Lambda')
    // Not merely "something threw": the SDK sits installed beside the app, so
    // its markers reaching the bundle is what "resolved for real" looks like.
    const bundle = readFileSync(join(root, '.lambda/function/handler.js'), 'utf8')
    expect(bundle).not.toContain(SDK_TRANSPORT_MARKER)
    expect(bundle).not.toContain(SDK_SERVER_INDEX_MARKER)
  })

  test('should bundle the real MCP SDK for an app depending on @guren/plugin-mcp', async () => {
    scaffoldApp(root, { entry: SDK_ENTRY, mcpPlugin: true })
    installFakeMcpSdk(root)

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    // Two separate mechanisms had to stop firing, and the markers tell them apart
    // from "resolved nothing": `webStandardStreamableHttp.js` is the entry the
    // stub map releases, and `server/index.js` is one no entry ever named — only
    // the catch-all could have stubbed it, and @guren/plugin-mcp imports it
    // *statically*, so a catch-all still in force leaves the endpoint shut.
    expect(probeHttpExport(root)).toBe(`${SDK_SERVER_INDEX_MARKER}|${SDK_TRANSPORT_MARKER}`)
  })

  test('should keep the Dev MCP server stubbed even for an app depending on the plugin', async () => {
    // Its McpServer drives the CLI's code generators against a filesystem the
    // function does not have, and the App MCP endpoint never touches it.
    scaffoldApp(root, {
      mcpPlugin: true,
      entry: {
        preamble: ["import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'"],
        http: 'String(McpServer)',
      },
    })
    installFakeMcpSdk(root)
    writeFileSync(
      join(root, 'node_modules/@modelcontextprotocol/sdk/server/mcp.js'),
      "export const McpServer = 'fake-sdk-mcp-server'\n",
    )

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    // The stub's throw is a *function body*, so importing succeeds and calling is
    // what fails — asserted on the bundle text rather than on a process exit
    // code, which would pass for the wrong reason.
    const bundle = readFileSync(join(root, '.lambda/function/handler.js'), 'utf8')
    expect(bundle).toContain('The MCP endpoint is unavailable on AWS Lambda')
    expect(bundle).not.toContain('fake-sdk-mcp-server')
  })
})
