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

async function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (message: string) => warnings.push(message)
  try {
    await run()
  } finally {
    console.warn = original
  }
  return warnings
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
  writeJson(join(root, 'package.json'), {
    name: '@acme/demo-app',
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
    expect(wrapper).toContain('process.env.GUREN_INERTIA_ENTRY ??= "/public/assets/app-Abc123.js"')
    expect(wrapper).toContain('process.env.GUREN_INERTIA_STYLES ??= "/public/assets/app-Def456.css"')
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

  test('should bake the lang/ catalogs into the wrapper, never into env.json', async () => {
    // The function ships no lang/, which createApp({ i18n }) otherwise reads.
    scaffoldApp(root)
    mkdirSync(join(root, 'lang/en'), { recursive: true })
    writeFileSync(join(root, 'lang/en/messages.json'), JSON.stringify({ welcome: 'Welcome to :name!' }))

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    const wrapper = readFileSync(join(root, '.lambda/handler.ts'), 'utf8')
    expect(wrapper).toContain(
      `process.env.GUREN_TRANSLATIONS ??= ${JSON.stringify(JSON.stringify({ en: { messages: { welcome: 'Welcome to :name!' } } }))}`,
    )
    expect(wrapper.indexOf('GUREN_TRANSLATIONS')).toBeLessThan(wrapper.indexOf('await import'))

    const env = JSON.parse(readFileSync(join(root, '.lambda/env.json'), 'utf8')) as Record<string, string>
    expect(env.GUREN_TRANSLATIONS).toBeUndefined()
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
    expect(report.bakedEntry).toBe('/public/assets/app-Abc123.js')
  })

  test('should preserve class and function names through minification', async () => {
    // The job registry keys on `JobClass.name`: mangling renames declarations, and
    // syntax minification alone drops an expression's name or swaps in the binding's.
    scaffoldApp(root, {
      entry: {
        preamble: [
          'class Job {}',
          'const registry: Array<{ name: string }> = []',
          'const register = (job: { name: string }) => { registry.push(job) }',
          'register(class SendWelcomeMailJob extends Job {})',
          'register(function inlineNamedFn() {})',
          'const makeJob = () => class ReturnedJob extends Job {}',
          'const SendMail = class SendMailJob extends Job {}',
        ],
        http: '[Job.name, ...registry.map((job) => job.name), makeJob().name, SendMail.name].join(",")',
      },
    })

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    expect(probeHttpExport(root)).toBe('Job,SendWelcomeMailJob,inlineNamedFn,ReturnedJob,SendMailJob')
  })

  test('should warn when the bundle renames a name-keyed class another module shares a name with', async () => {
    scaffoldApp(root, {
      entry: {
        preamble: [
          "import { OrderShipped as ShippedEvent } from '../app/Events/OrderShipped'",
          "import { OrderShipped as ShippedNotification } from '../app/Notifications/OrderShipped'",
        ],
        http: '[ShippedEvent.name, ShippedNotification.name].join(",")',
      },
    })
    for (const dir of ['app/Events', 'app/Notifications', 'node_modules/@guren/core']) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    writeFileSync(join(root, 'node_modules/@guren/core/package.json'), '{ "name": "@guren/core", "type": "module", "main": "index.js" }\n')
    writeFileSync(join(root, 'node_modules/@guren/core/index.js'), 'export class Event {}\nexport class Notification {}\n')
    writeFileSync(
      join(root, 'app/Events/OrderShipped.ts'),
      "import { Event } from '@guren/core'\nexport class OrderShipped extends Event {}\n",
    )
    writeFileSync(
      join(root, 'app/Notifications/OrderShipped.ts'),
      "import { Notification } from '@guren/core'\nexport class OrderShipped extends Notification {}\n",
    )

    const warnings = await captureWarnings(() => buildLambdaOutput({ rootDir: root, skipAppBuild: true }))

    const renamed = warnings.find((line) => line.startsWith('Lambda build: the bundle names a class OrderShipped as OrderShipped2'))
    expect(renamed).toBeDefined()
    // Whichever of the two the bundle renamed, named by its app-relative path.
    expect(renamed).toMatch(/ app[\\/](Events|Notifications)[\\/]OrderShipped\.ts declares a job/)
  })

  test('should copy the SSR bundle and migrations, but never seeders, into the function directory', async () => {
    scaffoldApp(root)

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    expect(existsSync(join(root, '.lambda/function/.guren/ssr/ssr-Xyz789.js'))).toBe(true)
    expect(existsSync(join(root, '.lambda/function/db/migrations/20260101000000_init/migration.sql'))).toBe(true)
    expect(existsSync(join(root, '.lambda/function/db/seeders'))).toBe(false)

    const env = JSON.parse(readFileSync(join(root, '.lambda/env.json'), 'utf8'))
    expect(env.NODE_ENV).toBe('production')
    expect(env.GUREN_INERTIA_ENTRY).toBe('/public/assets/app-Abc123.js')
    expect(env.GUREN_INERTIA_SSR_ENTRY).toBe('./.guren/ssr/ssr-Xyz789.js')
    expect(env.GUREN_INERTIA_SSR_MANIFEST).toBe('./.guren/ssr/.vite/manifest.json')
  })

  test('should define import.meta.url so `new URL("../db/migrations", import.meta.url)` resolves against the function root', async () => {
    // config/database.ts and config/app.ts resolve their migrations/seeders
    // folders via `new URL('../db/migrations', import.meta.url)` from one
    // directory below the app root. Left undefined, every module in the single
    // bundled output shares the deployed `file:///var/task/handler.js`, collapsing
    // that to `/var/db/migrations` and silently skipping configureOrm()/seedDatabase().
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
    expect(existsSync(join(root, '.lambda/assets/assets'))).toBe(false)
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
    expect(env.GUREN_INERTIA_ENTRY).toBe('/public/assets/app-Custom99.js')
    expect(existsSync(join(root, '.lambda/assets/public/assets/app-Custom99.js'))).toBe(true)
    expect(existsSync(join(root, '.lambda/assets/assets'))).toBe(false)
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

  test('should bundle the SDK v2 root @guren/plugin-mcp imports', async () => {
    scaffoldApp(root, {
      entry: {
        preamble: ["import { createMcpHandler } from '@modelcontextprotocol/server'"],
        http: 'String(createMcpHandler)',
      },
    })
    const v2 = join(root, 'node_modules/@modelcontextprotocol/server')
    mkdirSync(v2, { recursive: true })
    writeJson(join(v2, 'package.json'), { name: '@modelcontextprotocol/server', type: 'module' })
    writeFileSync(join(v2, 'index.js'), "export const createMcpHandler = 'fake-sdk-v2-server'\n")

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    expect(probeHttpExport(root)).toBe('fake-sdk-v2-server')
  })

  test('should stub @guren/cli, which serves the Dev MCP', async () => {
    scaffoldApp(root, {
      entry: { preamble: ["import * as cli from '@guren/cli'"], http: 'String(cli.default)' },
    })
    const cli = join(root, 'node_modules/@guren/cli')
    mkdirSync(cli, { recursive: true })
    writeJson(join(cli, 'package.json'), { name: '@guren/cli', type: 'module' })
    writeFileSync(join(cli, 'index.js'), "export default 'fake-guren-cli'\n")

    await buildLambdaOutput({ rootDir: root, skipAppBuild: true })

    const bundle = readFileSync(join(root, '.lambda/function/handler.js'), 'utf8')
    expect(bundle).toContain('The Dev MCP endpoint and docs viewer (@guren/cli) are unavailable on AWS Lambda')
    expect(bundle).not.toContain('fake-guren-cli')
  })
})

describe('buildLambdaOutput deploy-runtime warnings (RFC 0020 Part 0)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-lambda-deploy-check-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should warn before assembling when the app keeps sessions in memory', async () => {
    scaffoldApp(root)
    writeJson(join(root, 'package.json'), {
      name: '@acme/demo-app',
      dependencies: { '@guren/plugin-lambda': '^0.5.0' },
    })
    writeFileSync(
      join(root, 'src/app.ts'),
      "import { createApp } from '@guren/core'\nexport default createApp({ auth: { autoSession: true } })\n",
    )

    const warnings = await captureWarnings(() => buildLambdaOutput({ rootDir: root, skipAppBuild: true }))

    const hazard = warnings.find((line) => line.startsWith('Lambda build: AWS Lambda shares no memory'))
    expect(hazard).toBeDefined()
    expect(hazard).toContain('DatabaseSessionStore')
    expect(existsSync(join(root, '.lambda'))).toBe(true)
  })
})
