import { describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTempWorkspace } from './helpers'

/**
 * Behavioural coverage for the scaffolded `bin/serve.ts`.
 *
 * The file decides which port a generated app binds, and nothing tested it —
 * which is how `PORT=0` silently became 3333 and how a port walk could hand an
 * automated run somebody else's server. Asserting the file's *text* would pin
 * none of that, so each case runs the real template against a stub `src/main.js`
 * and reads back the ports it actually asked for.
 */

const templatesDir = fileURLToPath(new URL('../templates', import.meta.url))

const DEFAULT_SERVE = join(templatesDir, 'default/bin/serve.ts')
const API_ONLY_SERVE = join(templatesDir, 'api-only/bin/serve.ts')

/**
 * Stands in for a booted app. Records every port `listen()` is asked for and
 * fails the first `FAIL_TIMES` attempts with the error shape Bun throws for a
 * taken port — `code: 'EADDRINUSE'`, and a message that never says so.
 */
const STUB_MAIN = `
const failTimes = Number(process.env.FAIL_TIMES ?? 0)
let attempts = 0

const app = {
  async listen(options) {
    attempts += 1
    console.log('LISTEN ' + options.port)

    if (attempts <= failTimes) {
      const error = new Error('Failed to start server. Is port ' + options.port + ' in use?')
      error.code = 'EADDRINUSE'
      throw error
    }

    console.log('BOUND ' + options.port)
  },
}

export default app
export const ready = Promise.resolve()
`

type RunResult = {
  exitCode: number
  requestedPorts: number[]
  boundPort: number | undefined
  stderr: string
}

async function runServeTemplate(
  serveTemplate: string,
  env: Record<string, string>,
): Promise<RunResult> {
  const workspace = await createTempWorkspace('guren-serve-')

  try {
    await mkdir(join(workspace.dir, 'bin'), { recursive: true })
    await mkdir(join(workspace.dir, 'src'), { recursive: true })
    await writeFile(join(workspace.dir, 'src/main.js'), STUB_MAIN)
    await writeFile(join(workspace.dir, 'bin/serve.ts'), await readFile(serveTemplate, 'utf8'))

    const proc = Bun.spawnSync({
      cmd: ['bun', 'bin/serve.ts'],
      cwd: workspace.dir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = proc.stdout.toString()

    return {
      exitCode: proc.exitCode ?? 0,
      requestedPorts: [...stdout.matchAll(/^LISTEN (\d+)$/gmu)].map((match) => Number(match[1])),
      boundPort: [...stdout.matchAll(/^BOUND (\d+)$/gmu)].map((match) => Number(match[1]))[0],
      stderr: proc.stderr.toString(),
    }
  } finally {
    await workspace.cleanup()
  }
}

describe('scaffolded bin/serve.ts', () => {
  it('keeps the two starter templates identical', async () => {
    // The port logic existed in four hand-maintained copies; the two that ship
    // to users must at least not drift from each other.
    expect(await readFile(API_ONLY_SERVE, 'utf8')).toBe(await readFile(DEFAULT_SERVE, 'utf8'))
  })

  it('defaults to port 3333 when PORT is unset', async () => {
    const result = await runServeTemplate(DEFAULT_SERVE, {})

    expect(result.exitCode).toBe(0)
    expect(result.requestedPorts).toEqual([3333])
  })

  it('passes PORT=0 through instead of falling back to 3333', async () => {
    // `Number.parseInt(...) || 3333` swallowed 0, so "let the OS pick a free
    // port" was not expressible.
    const result = await runServeTemplate(DEFAULT_SERVE, { PORT: '0' })

    expect(result.exitCode).toBe(0)
    expect(result.requestedPorts).toEqual([0])
    expect(result.boundPort).toBe(0)
  })

  it('never walks off port 0 into the privileged range', async () => {
    // A walk from 0 would try 1, 2, 3. There is nothing to recover from
    // either: the OS was already asked for any free port.
    const result = await runServeTemplate(DEFAULT_SERVE, { PORT: '0', FAIL_TIMES: '1' })

    expect(result.exitCode).not.toBe(0)
    expect(result.requestedPorts).toEqual([0])
  })

  it('walks to the next free port in development', async () => {
    const result = await runServeTemplate(DEFAULT_SERVE, { PORT: '4000', FAIL_TIMES: '2' })

    expect(result.exitCode).toBe(0)
    expect(result.requestedPorts).toEqual([4000, 4001, 4002])
    expect(result.boundPort).toBe(4002)
    expect(result.stderr).toContain('Port 4000 is in use, trying 4001...')
  })

  it('fails fast on a busy port when GUREN_STRICT_PORT=1', async () => {
    const result = await runServeTemplate(DEFAULT_SERVE, {
      PORT: '4000',
      FAIL_TIMES: '1',
      GUREN_STRICT_PORT: '1',
    })

    expect(result.exitCode).not.toBe(0)
    // The walk is what makes an automated run silently test the wrong app, so
    // the strict flag has to stop it at the first attempt.
    expect(result.requestedPorts).toEqual([4000])
    expect(result.boundPort).toBeUndefined()
  })

  it('does not walk in production', async () => {
    const result = await runServeTemplate(DEFAULT_SERVE, {
      PORT: '4000',
      FAIL_TIMES: '1',
      NODE_ENV: 'production',
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.requestedPorts).toEqual([4000])
  })

  it('still targets a @guren/core that predates listen({ portFallback })', async () => {
    // The retry loop above duplicates what `Application.listen()` already does.
    // It stays only because templates resolve `@guren/*` from npm, so they
    // cannot call a framework option until the release that ships it.
    //
    // This pins the exit condition rather than leaving it to a changeset
    // sentence that `changeset version` deletes — in the very release that
    // unblocks the migration. `sync:template-deps` rewrites this range at
    // release time, so when it moves, this fails and says what to do.
    const templatePkg = JSON.parse(
      await readFile(join(templatesDir, 'default/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }

    expect(
      templatePkg.dependencies?.['@guren/core'],
      'The template @guren/core range moved, so listen({ portFallback }) is now published. ' +
        'Replace the retry loop in templates/{default,api-only}/bin/serve.ts with ' +
        'app.listen({ port, hostname }) and delete this test.',
    ).toBe('^1.5.2')
  })
})
