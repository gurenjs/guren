import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = resolve(import.meta.dir, '../..')
const RESULTS_FILE = resolve(ROOT, 'benchmarks.json')

interface BenchmarkResults {
  timestamp: string
  commit: string
  startup: { durationMs: number }
  build: { blogSizeKb: number; webSizeKb: number }
  memory: { heapUsedMb: number }
}

async function measureStartup(): Promise<number> {
  const start = performance.now()
  // Import and boot the app without listening
  const { default: app } = await import('../../examples/blog/src/app.js')
  await app.boot()
  return Math.round(performance.now() - start)
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

  const buildSize = measureBuildSize()
  console.log(`  Blog build: ${buildSize.blogSizeKb}KB, Web build: ${buildSize.webSizeKb}KB`)

  const memory = measureMemory()
  console.log(`  Heap used: ${memory.heapUsedMb}MB`)

  const results: BenchmarkResults = {
    timestamp: new Date().toISOString(),
    commit,
    startup: { durationMs: startupMs },
    build: buildSize,
    memory,
  }

  // Append to history
  const historyFile = resolve(ROOT, 'benchmark-history.json')
  const history: BenchmarkResults[] = existsSync(historyFile)
    ? JSON.parse(readFileSync(historyFile, 'utf-8'))
    : []
  history.push(results)
  writeFileSync(historyFile, JSON.stringify(history, null, 2))

  // Write latest for CI comparison
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2))

  console.log('\nResults saved to benchmarks.json')

  // Check thresholds
  const THRESHOLDS = {
    startupMs: 3000,        // 3 seconds max startup
    blogBuildKb: 800,       // 800KB max blog build
    webBuildKb: 800,        // 800KB max web build
    heapUsedMb: 256,        // 256MB max heap
  }

  let failed = false
  if (startupMs > THRESHOLDS.startupMs) {
    console.error(`FAIL: Startup ${startupMs}ms exceeds threshold ${THRESHOLDS.startupMs}ms`)
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
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
