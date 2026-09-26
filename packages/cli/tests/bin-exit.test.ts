import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
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
const TEST_TIMEOUT_MS = HARD_TIMEOUT_MS + 5_000

// Tests match a whole Run, so a failure prints the child's stderr beside its code.
interface Run {
  exitCode: number | null
  stdout: string
  stderr: string
  killed: boolean
}

async function runBin(args: string[], cwd: string): Promise<Run> {
  assertWorkspaceBuilt([SERVER_DIST_ENTRY])
  const proc = Bun.spawn(['bun', CLI_BIN_PATH, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: HARD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode: proc.exitCode, stdout, stderr, killed: proc.signalCode === 'SIGKILL' }
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
    await rm(root, { recursive: true, force: true })
  })

  it('plan:status prints its report and exits 0', async () => {
    const run = await runBin(['plan:status', 'plans/comments.plan.json', '--app', app, '--json'], app)

    expect(run).toMatchObject({ killed: false, exitCode: 0 })
    expect(JSON.parse(run.stdout)).toHaveProperty('elements')
  }, TEST_TIMEOUT_MS)

  it('route:list prints the route the module registered and exits 0', async () => {
    const run = await runBin(['route:list', '--app', app, '--format', 'json'], app)

    expect(run).toMatchObject({ killed: false, exitCode: 0 })
    expect(JSON.stringify(JSON.parse(run.stdout))).toContain('posts.index')
  }, TEST_TIMEOUT_MS)

  it('exits with the failed diagnostic result returned by runCli', async () => {
    const run = await runBin(['check', '--ci', '--app', app], app)

    expect(run).toMatchObject({ killed: false, exitCode: 1 })
  }, TEST_TIMEOUT_MS)
})

describe('exitWhenFlushed', () => {
  // The probes import process-exit.ts from a temp dir outside the workspace, where no
  // package resolves, so that module must stay free of imports.
  const HELPER = JSON.stringify(resolve(import.meta.dir, '../src/process-exit.ts'))
  let root: string

  beforeAll(async () => {
    root = await createTempRoot('guren-cli-exit-flush-')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function runProbe(name: string, body: string, shell: string): Promise<Run> {
    await writeFile(join(root, name), `import { exitWhenFlushed, trackStdioWrites } from ${HELPER}
trackStdioWrites()
setInterval(() => {}, 60_000)
${body}
`)
    const proc = Bun.spawn(['bash', '-c', shell], { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: HARD_TIMEOUT_MS, killSignal: 'SIGKILL' })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { exitCode: proc.exitCode, stdout, stderr, killed: proc.signalCode === 'SIGKILL' }
  }

  it('delivers everything written before exiting, with the exit code a command set', async () => {
    // Bun's process.exit() drops a stdout write still queued on a pipe whose reader is
    // slow, which a spawned child's own pipe never is: Bun.spawn reads it eagerly. So the
    // reader here is a shell pipeline that sleeps before it reads.
    const run = await runProbe(
      'slow-pipe.ts',
      "process.stdout.write('x'.repeat(4 * 1024 * 1024))\nprocess.exitCode = 3\nawait exitWhenFlushed(0)",
      'set -o pipefail; bun slow-pipe.ts | (sleep 1; wc -c)',
    )

    expect(run.stdout.trim()).toBe(String(4 * 1024 * 1024))
    expect(run.exitCode).toBe(3)
  }, TEST_TIMEOUT_MS)

  it('waits for a write issued from another write\'s callback', async () => {
    const run = await runProbe(
      'callback-write.ts',
      "process.stdout.write('x'.repeat(1024 * 1024), () => { process.stdout.write('y'.repeat(4 * 1024 * 1024)) })\nawait exitWhenFlushed(0)",
      'set -o pipefail; bun callback-write.ts | (sleep 1; wc -c)',
    )

    expect(run).toMatchObject({ killed: false, exitCode: 0 })
    expect(run.stdout.trim()).toBe(String(5 * 1024 * 1024))
  }, TEST_TIMEOUT_MS)

  it('still waits for later writes after a write callback threw', async () => {
    // Bun runs a small write's callback inside write(), so its throw escapes write() too.
    const run = await runProbe(
      'throwing-callback.ts',
      "try { process.stdout.write('a', () => { throw new Error('from the callback') }) } catch {}\nprocess.stdout.write('x'.repeat(4 * 1024 * 1024))\nawait exitWhenFlushed(0)",
      'set -o pipefail; bun throwing-callback.ts | (sleep 1; wc -c)',
    )

    expect(run).toMatchObject({ killed: false, exitCode: 0 })
    expect(run.stdout.trim()).toBe(String(4 * 1024 * 1024 + 1))
  }, TEST_TIMEOUT_MS)

  it('still exits after a write that threw instead of calling back', async () => {
    const run = await runProbe(
      'throwing-write.ts',
      'try { process.stdout.write(123 as never) } catch {}\nawait exitWhenFlushed(4)',
      'bun throwing-write.ts',
    )

    expect(run.killed).toBe(false)
    expect(run.exitCode).toBe(4)
  }, TEST_TIMEOUT_MS)
})
