import { describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTempWorkspace } from './helpers'

/**
 * The scaffolded `bin/serve.ts` decides which port a generated app asks for
 * (untested, `PORT=0` silently became 3333). The busy-port walk lives in
 * `Application.listen({ portFallback })`; what matters here is that the template
 * calls `listen()` once with the right port and never forces
 * `GUREN_STRICT_PORT`, which would nest with that walk.
 */

const templatesDir = fileURLToPath(new URL('../templates', import.meta.url))

const DEFAULT_SERVE = join(templatesDir, 'default/bin/serve.ts')
const API_ONLY_SERVE = join(templatesDir, 'api-only/bin/serve.ts')

/**
 * Stands in for a booted app. Records every port `listen()` is asked for,
 * whether the template forced `GUREN_STRICT_PORT` before the call, and fails
 * the first `FAIL_TIMES` attempts with the error shape Bun throws for a taken
 * port — `code: 'EADDRINUSE'`, and a message that never says so.
 */
const STUB_MAIN = `
const failTimes = Number(process.env.FAIL_TIMES ?? 0)
let attempts = 0

const app = {
  async listen(options) {
    attempts += 1
    console.log('LISTEN ' + options.port)
    console.log('STRICT ' + (process.env.GUREN_STRICT_PORT ?? 'unset'))

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
  strictPortAtListen: string | undefined
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
      strictPortAtListen: [...stdout.matchAll(/^STRICT (.+)$/gmu)].map((match) => match[1])[0],
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

  it('leaves the busy-port walk to listen()', async () => {
    // `listen({ portFallback })` owns the walk, so the template must call it
    // once and leave the strict-port decision to the environment: a
    // template-side retry nests into a much wider search, and a forced
    // GUREN_STRICT_PORT=1 switches the walk off.
    const result = await runServeTemplate(DEFAULT_SERVE, { PORT: '4000', FAIL_TIMES: '1' })

    expect(result.requestedPorts).toEqual([4000])
    expect(result.strictPortAtListen).toBe('unset')
    // The stub's rejection stands in for listen() giving up; it must surface
    // as a failed exit, not be swallowed by a leftover catch.
    expect(result.exitCode).not.toBe(0)
    expect(result.boundPort).toBeUndefined()
  })

  it('passes GUREN_STRICT_PORT through untouched', async () => {
    const result = await runServeTemplate(DEFAULT_SERVE, {
      PORT: '4000',
      GUREN_STRICT_PORT: '1',
    })

    expect(result.exitCode).toBe(0)
    expect(result.requestedPorts).toEqual([4000])
    expect(result.strictPortAtListen).toBe('1')
  })
})
