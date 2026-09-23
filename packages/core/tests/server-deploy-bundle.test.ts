import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  BUN_DEPLOY_MINIFY,
  DEV_ONLY_MODULES,
  SQL_CLIENT_MODULES,
  renderDevOnlyStub,
} from '../src/internal/deploy-build'

/**
 * Bundles @guren/server the way the Lambda and Vercel builds do (their minify
 * options and stubs, NODE_ENV defined) and reads what landed. The entry names the
 * built file directly: the root tsconfig paths send `@guren/server` to src, which
 * no installed app sees, and a src bundle cannot show what dist's chunking keeps.
 */

const SERVER_ROOT = join(import.meta.dir, '../../server')
const DEV_BANNER_PACKAGES = ['figlet', 'chalk']

/**
 * Runs in its own process: on Bun 1.3.14, `Bun.build` in a test process that has
 * already imported the server's dist (core's barrel does) fails with "Unexpected
 * reading file" on the files that import loaded.
 */
const BUILD_SCRIPT = `
const { entry, stubs, filter, minify, define } = JSON.parse(await Bun.file(process.argv[2]).text())
const result = await Bun.build({
  entrypoints: [entry],
  target: 'node',
  throw: false,
  metafile: true,
  minify,
  define,
  plugins: [{
    name: 'deploy-stubs',
    setup(build) {
      build.onResolve({ filter: new RegExp(filter) }, (args) => ({ path: args.path, namespace: 'deploy-stub' }))
      build.onLoad({ filter: /.*/, namespace: 'deploy-stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})
const text = result.success ? await result.outputs[0].text() : ''
console.log(JSON.stringify({
  success: result.success,
  logs: result.logs.map(String),
  inputs: Object.keys(result.metafile?.inputs ?? {}),
  parseFont: text.includes('parseFont'),
}))
`

interface BundleReport {
  success: boolean
  logs: string[]
  inputs: string[]
  parseFont: boolean
}

const temps: string[] = []

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function builtServerEntry(): string {
  const manifest = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')) as {
    exports: Record<string, { default: string }>
  }
  const entry = join(SERVER_ROOT, manifest.exports['.']!.default)
  if (!existsSync(entry)) {
    throw new Error(`Expected ${entry}; run \`bun run build server\` before this test.`)
  }
  return entry
}

/** The package an input belongs to, by its last `node_modules` segment. */
function packageOf(input: string): string | undefined {
  const parts = input.replaceAll('\\', '/').split('/')
  const at = parts.lastIndexOf('node_modules')
  if (at === -1) return undefined
  const name = parts[at + 1]
  return name?.startsWith('@') ? `${name}/${parts[at + 2]}` : name
}

async function bundleServer(define: Record<string, string>): Promise<BundleReport> {
  const dir = mkdtempSync(join(tmpdir(), 'guren-server-bundle-'))
  temps.push(dir)
  const entry = join(dir, 'entry.ts')
  writeFileSync(
    entry,
    `import { createApp } from ${JSON.stringify(builtServerEntry())}\nexport default createApp({})\n`,
  )

  const stubs = Object.fromEntries(
    [...DEV_ONLY_MODULES, ...SQL_CLIENT_MODULES].map((module) => [
      module.specifier,
      renderDevOnlyStub(module, `${module.specifier} is stubbed in this bundle.`),
    ]),
  )
  const filter = `^(?:${Object.keys(stubs).map((key) => key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`
  writeFileSync(join(dir, 'options.json'), JSON.stringify({ entry, stubs, filter, minify: BUN_DEPLOY_MINIFY, define }))
  writeFileSync(join(dir, 'build.ts'), BUILD_SCRIPT)

  const child = Bun.spawn([process.execPath, join(dir, 'build.ts'), join(dir, 'options.json')], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(await child.exited, stderr).toBe(0)

  const report = JSON.parse(stdout) as BundleReport
  expect(report.success, report.logs.join('\n')).toBe(true)
  // Metafile inputs are relative to the build's working directory.
  report.inputs = report.inputs.map((input) => (input.includes(':') ? input : resolve(dir, input)))
  return report
}

function expectBuiltFromDist(inputs: string[]): void {
  const fromSrc = inputs.filter((input) => /\/packages\/[^/]+\/src\//.test(input.replaceAll('\\', '/')))
  expect(fromSrc).toEqual([])
  expect(inputs.some((input) => input.replaceAll('\\', '/').includes('/packages/server/dist/'))).toBe(true)
}

describe('@guren/server in a deploy bundle', () => {
  test('should leave the dev banner, and figlet and chalk with it, out of a production bundle', async () => {
    const { inputs, parseFont } = await bundleServer({ 'process.env.NODE_ENV': '"production"' })

    expectBuiltFromDist(inputs)
    const bundled = new Set(inputs.map(packageOf))
    expect(DEV_BANNER_PACKAGES.filter((name) => bundled.has(name))).toEqual([])
    expect(parseFont).toBe(false)
  }, 30_000)

  test('should keep the dev banner in a development bundle', async () => {
    // The control: without it, a bundle that stopped resolving figlet at all
    // would pass the production case above.
    const { inputs, parseFont } = await bundleServer({ 'process.env.NODE_ENV': '"development"' })

    expectBuiltFromDist(inputs)
    const bundled = new Set(inputs.map(packageOf))
    expect(DEV_BANNER_PACKAGES.filter((name) => bundled.has(name))).toEqual(DEV_BANNER_PACKAGES)
    expect(parseFont).toBe(true)
  }, 30_000)
})
