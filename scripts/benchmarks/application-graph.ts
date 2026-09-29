import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { APPLICATION_GRAPH_FIXTURE } from '../../packages/cli/tests/application-graph-fixture'

const execute = promisify(execFile)
const root = resolve(import.meta.dir, '../..')
const directory = await mkdtemp(join(tmpdir(), 'guren-graph-benchmark-'))
const samples = 10
const report: Record<string, unknown> = { runtime: process.versions.bun, samples, fixtureFiles: Object.keys(APPLICATION_GRAPH_FIXTURE).length }
try {
  for (const [file, source] of Object.entries(APPLICATION_GRAPH_FIXTURE)) {
    await mkdir(dirname(join(directory, file)), { recursive: true })
    await writeFile(join(directory, file), source)
  }
  await mkdir(join(directory, 'node_modules/@guren'), { recursive: true })
  await symlink(join(root, 'packages/core'), join(directory, 'node_modules/@guren/core'), 'dir')
  for (const command of ['context', 'graph']) {
    const durations: number[] = []
    let bytes = 0
    for (let sample = 0; sample < samples; sample++) {
      const started = performance.now()
      let stdout: string
      try {
        stdout = (await execute(process.execPath, [join(root, 'packages/cli/dist/bin.js'), command, '--json'], { cwd: directory, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: unknown }
        if (command !== 'graph' || failure.code !== 1 || typeof failure.stdout !== 'string') throw error
        stdout = failure.stdout
      }
      const parsed = JSON.parse(stdout) as { error?: unknown }
      if (parsed.error) throw new Error('Benchmark collection failed.')
      bytes = Buffer.byteLength(stdout)
      durations.push(performance.now() - started)
    }
    const sorted = durations.slice(1).sort((a, b) => a - b)
    report[command] = { firstInvocationMs: durations[0], warmP50Ms: sorted[Math.floor(sorted.length * 0.5)], warmP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], payloadBytes: bytes,
      processTopology: 'one CLI process and one registration child per sample; filesystem cache remains warm after the first sample' }
  }
  console.log(JSON.stringify(report, null, 2))
} finally { await rm(directory, { recursive: true, force: true }) }
