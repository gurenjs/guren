/**
 * Fail the deploy when the Worker bundle takes development-only code: the
 * runtime error collector the framework loads only under GUREN_MCP=1, and
 * `@guren/cli`, which `cloudflare:build` stubs (RFC 0032 M5). Reads wrangler's
 * dry run on the assembled .cloudflare/, like `bundle:check`. Needs no credentials.
 *   bun scripts/check-dev-only-excluded.ts
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { judgeDevOnlyInputs } from './lib/dev-only-inputs.js'

const root = fileURLToPath(new URL('..', import.meta.url))

/** The directory holding the package's package.json. */
function packageRoot(specifier: string, from = root): string {
  let dir = dirname(realpathSync(Bun.resolveSync(specifier, from)))
  while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir)
  return dir
}

/** Source and built files alike: wrangler may read either, depending on the export conditions it resolves. */
function filesDefining(dir: string, marker: string): string[] {
  return ['src', 'dist']
    .map((sub) => join(dir, sub))
    .filter((sub) => existsSync(sub))
    .flatMap((sub) => readdirSync(sub, { recursive: true, encoding: 'utf8' }).map((file) => join(sub, file)))
    .filter((file) => /\.(?:ts|js)$/.test(file) && !file.endsWith('.d.ts') && !file.includes('.test.'))
    .filter((file) => readFileSync(file, 'utf8').includes(marker))
}

function realInput(input: string): string {
  const file = resolve(root, input)
  return existsSync(file) ? realpathSync(file) : file
}

/** `@guren/core` and the framework packages it depends on, where the collector lives whichever one owns it. */
function frameworkRoots(): string[] {
  const core = packageRoot('@guren/core')
  const manifest = JSON.parse(readFileSync(join(core, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  const dependencies = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@guren/'))
  return [core, ...dependencies.map((name) => packageRoot(name, core))]
}

const collectorFiles = frameworkRoots().flatMap((dir) => filesDefining(dir, 'class RuntimeErrorBuffer'))
const cliDir = `${packageRoot('@guren/cli')}/`

function bundleInputs(outDir: string): string[] {
  const metafile = join(outDir, 'meta.json')
  const result = Bun.spawnSync({
    cmd: ['bunx', 'wrangler', 'deploy', '--dry-run', '--outdir', join(outDir, 'out'), '--metafile', metafile],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`wrangler deploy --dry-run exited ${result.exitCode}.\n${result.stdout.toString()}${result.stderr.toString()}`)
  }
  const { outputs } = JSON.parse(readFileSync(metafile, 'utf8')) as { outputs: Record<string, { inputs: Record<string, unknown> }> }
  // The worker is the output with inputs; a source map has none.
  const inputs = Object.values(outputs)
    .map((output) => Object.keys(output.inputs))
    .reduce((best, next) => (next.length > best.length ? next : best), [])
  if (inputs.length === 0) throw new Error('wrangler wrote a metafile with no bundle inputs to judge.')
  return inputs.map(realInput)
}

const outDir = mkdtempSync(join(tmpdir(), 'guren-web-dev-only-'))
let inputs: string[]
try {
  inputs = bundleInputs(outDir)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

const verdict = judgeDevOnlyInputs(inputs, [
  { what: 'the development runtime error collector', files: collectorFiles },
  { what: '@guren/cli (Dev Center, development MCP)', files: [cliDir] },
])
for (const line of verdict.lines) console.log(line)
process.exit(verdict.ok ? 0 : 1)
