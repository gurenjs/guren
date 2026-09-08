/**
 * Prototype mode end to end (RFC 0021 Part 1), on examples/blog: the production
 * client build carries no trace of the fixture (`GUREN_PROTOTYPE` is a literal
 * `false` there); `vite build --mode prototype` emits a static directory with
 * the SPA fallbacks, once at `/` and once under `/blog/`; Playwright drives
 * both from a plain file host with no Bun server. Judged by exit codes and by
 * the files each step must leave behind.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const blog = fileURLToPath(new URL('../../examples/blog', import.meta.url))
/** A string only the fixture's seed data contains. */
const FIXTURE_MARKER = 'Prototype first, backend second'

function run(label: string, cmd: string[], env: Record<string, string> = {}): void {
  console.log(`\n[smoke:prototype] ${label}`)
  const result = Bun.spawnSync(cmd, { cwd: blog, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } })
  if (result.exitCode !== 0) {
    console.error(`[smoke:prototype] ${label} failed with exit code ${result.exitCode}`)
    process.exit(result.exitCode || 1)
  }
}

function fail(message: string): never {
  console.error(`[smoke:prototype] ${message}`)
  process.exit(1)
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
}

function assertBuild(outDir: string, label: string): void {
  for (const name of ['index.html', '404.html', '_redirects', 'favicon.svg']) {
    if (!existsSync(path.join(outDir, name))) fail(`${label}: missing ${name} in ${outDir}`)
  }
  for (const stray of ['.guren', 'resources']) {
    if (existsSync(path.join(outDir, stray))) fail(`${label}: nested shell directory ${stray}/ left in ${outDir}`)
  }
  const index = readFileSync(path.join(outDir, 'index.html'), 'utf8')
  if (!index.includes('name="robots" content="noindex')) fail(`${label}: index.html lost its noindex tag`)
  if (readFileSync(path.join(outDir, '404.html'), 'utf8') !== index) fail(`${label}: 404.html differs from index.html`)
  const hit = filesUnder(outDir).some((file) => file.endsWith('.js') && readFileSync(file, 'utf8').includes(FIXTURE_MARKER))
  if (!hit) fail(`${label}: no chunk carries the fixture seed "${FIXTURE_MARKER}"`)
  console.log(`[smoke:prototype] ${label}: ok (${outDir})`)
}

// 1. Production build: the fixture must be absent.
run('production client build', ['bun', 'run', 'build'])
const assets = path.join(blog, 'public/assets')
const leaked = filesUnder(assets).filter((file) => file.endsWith('.js') && readFileSync(file, 'utf8').includes(FIXTURE_MARKER))
if (leaked.length > 0) fail(`production bundle carries the fixture: ${leaked.map((f) => path.relative(blog, f)).join(', ')}`)
if (filesUnder(assets).some((file) => /[\\/]prototype-[^\\/]+\.js$/u.test(file))) fail('production bundle emitted a prototype chunk')
console.log('[smoke:prototype] production bundle: no fixture, ok')

// 2. Prototype builds at the root and under a subpath.
const rootOut = path.join(blog, 'dist/prototype')
const subpathOut = path.join(blog, 'dist/prototype-blog')
rmSync(rootOut, { recursive: true, force: true })
rmSync(subpathOut, { recursive: true, force: true })
run('prototype build (/)', ['bun', 'run', 'build:prototype'])
assertBuild(rootOut, 'prototype build (/)')
run('prototype build (/blog/)', ['bunx', 'vite', 'build', '--mode', 'prototype', '--base', '/blog/', '--outDir', 'dist/prototype-blog'])
assertBuild(subpathOut, 'prototype build (/blog/)')
if (!readFileSync(path.join(subpathOut, 'index.html'), 'utf8').includes('src="/blog/')) {
  fail('subpath build does not prefix its assets with /blog/')
}

// 3. Playwright against the static host, both shapes.
run('playwright (static host)', ['bunx', 'playwright', 'test', '-c', 'playwright.prototype.config.ts'])
console.log('\n[smoke:prototype] all green')
