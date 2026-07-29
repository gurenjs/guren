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
 * `http` export produces. Tests vary only that export via `scaffoldApp`'s
 * `entry` option; running out-of-process is required because `bun test
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

interface ScaffoldOptions {
  ssr?: boolean
  renderExport?: string
  /** Lines placed above the handler exports, plus the body of the `http` export. */
  entry?: { preamble?: string[]; http: string }
}

function scaffoldApp(root: string, options: ScaffoldOptions = {}): void {
  const {
    ssr = true,
    renderExport = 'export const render = () => ({ body: "", head: [] })',
    entry = { http: 'process.env.NODE_ENV' },
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
  writeJson(join(root, 'package.json'), { name: '@acme/demo-app' })

  mkdirSync(join(root, 'public/assets/.vite'), { recursive: true })
  writeFileSync(join(root, 'public/robots.txt'), 'User-agent: *\n')
  writeFileSync(join(root, 'public/assets/app-Abc123.js'), 'console.log("client")\n')
  writeJson(join(root, 'public/assets/.vite/manifest.json'), {
    'resources/js/app.tsx': { file: 'app-Abc123.js', css: ['app-Def456.css'] },
  })

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

    // Imported in a fresh process, like Lambda does: the wrapper's top-level
    // await must settle before the exports are read, and `bun test --isolate`
    // resolves a dynamic in-process import of such a module too early.
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
    // Seeders are raw .ts modules importing the app's schema and @guren/*
    // packages — the self-contained bundle can never load them, so shipping
    // them would only suggest a seeding path that does not exist.
    expect(existsSync(join(root, '.lambda/function/db/seeders'))).toBe(false)

    const env = JSON.parse(readFileSync(join(root, '.lambda/env.json'), 'utf8'))
    expect(env.NODE_ENV).toBe('production')
    expect(env.GUREN_INERTIA_ENTRY).toBe('/assets/app-Abc123.js')
    expect(env.GUREN_INERTIA_SSR_ENTRY).toBe('./.guren/ssr/ssr-Xyz789.js')
    expect(env.GUREN_INERTIA_SSR_MANIFEST).toBe('./.guren/ssr/.vite/manifest.json')
  })

  test('should define import.meta.url so `new URL("../db/migrations", import.meta.url)` resolves against the function root', async () => {
    // Regression test: config/database.ts and config/app.ts (both the
    // scaffolded default template and examples/blog) resolve their
    // migrations/seeders folders via `new URL('../db/migrations',
    // import.meta.url)` from a file one directory below the app root
    // (config/). Left undefined, every module in the single bundled
    // output shares one real import.meta.url — the deployed
    // `file:///var/task/handler.js` — collapsing that expression to
    // `/var/db/migrations` instead of `/var/task/db/migrations`, silently
    // skipping configureOrm()/seedDatabase() in production.
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
})
