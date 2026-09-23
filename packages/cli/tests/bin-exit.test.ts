import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { CLI_BIN_PATH, SERVER_DIST_ENTRY, assertWorkspaceBuilt, createTempRoot, linkWorkspaceCore, writeWorkspaceFiles } from './helpers'

// A routes module holding a timer open at import, as `new MemoryRateLimitStore()` at the
// top of examples/api/routes/api.ts does. The CLI imports it and must still exit.
const ROUTES = `import type { Router } from '@guren/core'

setInterval(() => {}, 60_000)

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => new Response('ok')).name('posts.index')
}
`

const ARCH_VIOLATION: Record<string, string> = {
  'guren.arch.ts': `export default {
  layers: { domain: 'app/Domain/**', http: 'app/Http/**' },
  rules: [{ from: 'domain', disallow: ['http'] }],
}
`,
  'app/Http/Controllers/PostController.ts': 'export class PostController {}\n',
  'app/Domain/OrderService.ts': "import { PostController } from '../Http/Controllers/PostController'\nexport class OrderService { controller = PostController }\n",
}

const HARD_TIMEOUT_MS = 20_000

interface Run {
  exitCode: number | null
  stdout: string
  stderr: string
  killed: boolean
}

async function runBin(args: string[], cwd: string): Promise<Run> {
  assertWorkspaceBuilt([SERVER_DIST_ENTRY])
  const proc = Bun.spawn(['bun', CLI_BIN_PATH, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  let killed = false
  const timer = setTimeout(() => {
    killed = true
    proc.kill('SIGKILL')
  }, HARD_TIMEOUT_MS)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { exitCode: killed ? null : exitCode, stdout, stderr, killed }
}

describe('guren exits after a command that imported app code holding a handle open', () => {
  let root: string
  let app: string

  beforeAll(async () => {
    root = await createTempRoot('guren-cli-bin-exit-')
    await writeFile(join(root, 'bunfig.toml'), '[install]\nauto = "disable"\n')
    await linkWorkspaceCore(root)
    app = join(root, 'app')
    await writeWorkspaceFiles(app, { 'routes/web.ts': ROUTES, ...ARCH_VIOLATION })
    await mkdir(join(app, 'plans'), { recursive: true })
    await copyFile(join(import.meta.dir, 'fixtures/plan/comments.plan.json'), join(app, 'plans/comments.plan.json'))
  })

  afterAll(async () => {
    await Bun.$`rm -rf ${root}`.quiet().nothrow()
  })

  it('plan:status prints its report and exits 0', async () => {
    const run = await runBin(['plan:status', 'plans/comments.plan.json', '--app', app, '--json'], app)

    expect(run.killed).toBe(false)
    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.stdout)).toHaveProperty('elements')
  }, HARD_TIMEOUT_MS + 5_000)

  it('route:list prints the route the module registered and exits 0', async () => {
    const run = await runBin(['route:list', '--app', app, '--format', 'json'], app)

    expect(run.killed).toBe(false)
    expect(run.exitCode).toBe(0)
    expect(JSON.stringify(JSON.parse(run.stdout))).toContain('posts.index')
  }, HARD_TIMEOUT_MS + 5_000)

  it('keeps the exit code a command set through process.exitCode', async () => {
    // `check --ci` loads the routes for its full suite and reports the arch violation by
    // setting process.exitCode, not by throwing, so runCli itself returns 0.
    const run = await runBin(['check', '--ci', '--app', app], app)

    expect(run.killed).toBe(false)
    expect(run.exitCode).toBe(1)
  }, HARD_TIMEOUT_MS + 5_000)
})

describe('exitWhenFlushed', () => {
  // Bun's process.exit() drops a stdout write still queued on a pipe whose reader is slow,
  // which a spawned child's own pipe never is: Bun.spawn reads it eagerly. So the reader
  // here is a shell pipeline that sleeps before it reads.
  const PROBE = `import { exitWhenFlushed, trackStdioWrites } from ${JSON.stringify(resolve(import.meta.dir, '../src/process-exit.ts'))}
trackStdioWrites()
setInterval(() => {}, 60_000)
process.stdout.write('x'.repeat(4 * 1024 * 1024))
process.exitCode = 3
await exitWhenFlushed(0)
`

  it('delivers everything written before exiting, with the exit code a command set', async () => {
    const root = await createTempRoot('guren-cli-exit-flush-')
    try {
      await writeFile(join(root, 'probe.ts'), PROBE)
      const proc = Bun.spawn(['bash', '-c', 'set -o pipefail; bun probe.ts | (sleep 1; wc -c)'], { cwd: root, stdout: 'pipe' })
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])

      expect(stdout.trim()).toBe(String(4 * 1024 * 1024))
      expect(exitCode).toBe(3)
    } finally {
      await Bun.$`rm -rf ${root}`.quiet().nothrow()
    }
  }, 20_000)
})
