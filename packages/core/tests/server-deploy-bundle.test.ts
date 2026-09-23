import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { BundleOptions, BundleReport } from './server-deploy-bundle-fixture'

/**
 * Bundles @guren/server with the deploy builds' minify options and NODE_ENV
 * define, every dev-only module and SQL client stubbed, and reads what landed.
 * The entry names the built file directly: the root tsconfig paths send
 * `@guren/server` to src, which no installed app sees, and a src bundle cannot
 * show what dist's chunking keeps.
 */

const SERVER_ROOT = join(import.meta.dir, '../../server')
const FIXTURE = `${import.meta.dir}/server-deploy-bundle-fixture.ts`
const DEV_BANNER_PACKAGES = ['figlet', 'chalk']
const BUILD_DEADLINE_MS = 20_000

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

/**
 * Builds in its own process: on Bun 1.3.14, once a test process has imported the
 * server's dist (core's barrel does), every `Bun.build` of it there after the
 * first fails with "Unexpected reading file".
 */
async function bundleServer(define: Record<string, string>): Promise<BundleReport> {
  const dir = mkdtempSync(join(tmpdir(), 'guren-server-bundle-'))
  temps.push(dir)
  const entry = join(dir, 'entry.ts')
  writeFileSync(
    entry,
    `import { createApp } from ${JSON.stringify(builtServerEntry())}\nexport default createApp({})\n`,
  )
  const options: BundleOptions = { entry, define }
  writeFileSync(join(dir, 'options.json'), JSON.stringify(options))

  const child = Bun.spawn([process.execPath, FIXTURE, join(dir, 'options.json')], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: BUILD_DEADLINE_MS,
    killSignal: 'SIGKILL',
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
  }, BUILD_DEADLINE_MS + 5_000)

  test('should keep the dev banner in a development bundle', async () => {
    // The control: without it, a bundle that stopped resolving figlet at all
    // would pass the production case above.
    const { inputs, parseFont } = await bundleServer({ 'process.env.NODE_ENV': '"development"' })

    expectBuiltFromDist(inputs)
    const bundled = new Set(inputs.map(packageOf))
    expect(DEV_BANNER_PACKAGES.filter((name) => bundled.has(name))).toEqual(DEV_BANNER_PACKAGES)
    expect(parseFont).toBe(true)
  }, BUILD_DEADLINE_MS + 5_000)
})
