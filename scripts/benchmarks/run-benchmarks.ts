import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = resolve(import.meta.dir, '../..')
const RESULTS_FILE = resolve(ROOT, 'benchmarks.json')

interface LatencyResults {
  p50Ms: number
  p95Ms: number
  p99Ms: number
}

interface BenchmarkResults {
  timestamp: string
  commit: string
  startup: { durationMs: number }
  latency: LatencyResults
  build: { blogSizeKb: number; webSizeKb: number }
  memory: { heapUsedMb: number }
}

let bootedApp: { hono: { request: (path: string) => Promise<Response> } } | null = null

async function measureStartup(): Promise<number> {
  const start = performance.now()
  const { default: app } = await import('../../examples/blog/src/app.js')
  await app.boot()
  bootedApp = app
  return Math.round(performance.now() - start)
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

async function measureLatency(): Promise<LatencyResults> {
  if (!bootedApp) throw new Error('App must be booted before measuring latency')
  const hono = bootedApp.hono
  const N = 200

  // Warm up
  for (let i = 0; i < 20; i++) {
    await hono.request('/health')
  }

  // Measure
  const durations: number[] = []
  for (let i = 0; i < N; i++) {
    const start = performance.now()
    await hono.request('/health')
    durations.push(performance.now() - start)
  }

  durations.sort((a, b) => a - b)
  return {
    p50Ms: round(durations[Math.floor(N * 0.5)]),
    p95Ms: round(durations[Math.floor(N * 0.95)]),
    p99Ms: round(durations[Math.floor(N * 0.99)]),
  }
}

function measureBuildSize(): { blogSizeKb: number; webSizeKb: number } {
  const blogDist = resolve(ROOT, 'examples/blog/public/assets')
  const webDist = resolve(ROOT, 'web/public/assets')

  function dirSizeKb(dir: string): number {
    if (!existsSync(dir)) return 0
    const output = execSync(`du -sk "${dir}"`, { encoding: 'utf-8' })
    return parseInt(output.split('\t')[0], 10)
  }

  return {
    blogSizeKb: dirSizeKb(blogDist),
    webSizeKb: dirSizeKb(webDist),
  }
}

function measureMemory(): { heapUsedMb: number } {
  const mem = process.memoryUsage()
  return { heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10 }
}

async function main() {
  const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()

  console.log('Running benchmarks...')

  const startupMs = await measureStartup()
  console.log(`  Startup: ${startupMs}ms`)

  const latency = await measureLatency()
  console.log(`  Latency: p50=${latency.p50Ms}ms, p95=${latency.p95Ms}ms, p99=${latency.p99Ms}ms`)

  const buildSize = measureBuildSize()
  console.log(`  Blog build: ${buildSize.blogSizeKb}KB, Web build: ${buildSize.webSizeKb}KB`)

  const memory = measureMemory()
  console.log(`  Heap used: ${memory.heapUsedMb}MB`)

  const results: BenchmarkResults = {
    timestamp: new Date().toISOString(),
    commit,
    startup: { durationMs: startupMs },
    latency,
    build: buildSize,
    memory,
  }

  // Append to history
  const historyFile = resolve(ROOT, 'benchmark-history.json')
  let history: BenchmarkResults[] = []
  try {
    history = JSON.parse(readFileSync(historyFile, 'utf-8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  history.push(results)
  writeFileSync(historyFile, JSON.stringify(history, null, 2))

  // Write latest for CI comparison
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2))

  console.log('\nResults saved to benchmarks.json')

  // Check thresholds
  const THRESHOLDS = {
    startupMs: 3000,        // 3 seconds max startup
    p95LatencyMs: 10,       // 10ms max p95 request latency
    blogBuildKb: 800,       // 800KB max blog build
    webBuildKb: 800,        // 800KB max web build
    heapUsedMb: 256,        // 256MB max heap
  }

  let failed = false
  if (startupMs > THRESHOLDS.startupMs) {
    console.error(`FAIL: Startup ${startupMs}ms exceeds threshold ${THRESHOLDS.startupMs}ms`)
    failed = true
  }
  if (latency.p95Ms > THRESHOLDS.p95LatencyMs) {
    console.error(`FAIL: p95 latency ${latency.p95Ms}ms exceeds threshold ${THRESHOLDS.p95LatencyMs}ms`)
    failed = true
  }
  if (buildSize.blogSizeKb > THRESHOLDS.blogBuildKb) {
    console.error(`FAIL: Blog build ${buildSize.blogSizeKb}KB exceeds threshold ${THRESHOLDS.blogBuildKb}KB`)
    failed = true
  }
  if (memory.heapUsedMb > THRESHOLDS.heapUsedMb) {
    console.error(`FAIL: Heap ${memory.heapUsedMb}MB exceeds threshold ${THRESHOLDS.heapUsedMb}MB`)
    failed = true
  }

  if (failed) {
    process.exit(1)
  }

  console.log('All benchmarks within thresholds.')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
