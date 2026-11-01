import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { createTempWorkspace } from './helpers'

const CLI_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

// Stands in for `bun install`, the app's `guren add auth` (failing when
// FAKE_ADD_AUTH_FAILS is set) and `bun run codegen`, logging each call.
const FAKE_BUN = `#!/bin/sh
echo "$*" >> "$FAKE_BUN_LOG"
[ "$2" = add ] && [ "$3" = auth ] && [ -n "$FAKE_ADD_AUTH_FAILS" ] && exit 1
exit 0
`

// Matches the list entry with or without the `[log]` prefix consola's basic
// reporter adds (picked under CI and NODE_ENV=test), and not the warning that
// names the same command.
function isAddAuthEntry(line: string): boolean {
  return line.trimEnd().endsWith(' bunx guren add auth')
}

// A subprocess rather than the in-process command: Bun's spawnSync without an
// explicit `env` resolves `bun` against the PATH the process started with, so
// a shim put on PATH at runtime is never reached.
async function scaffoldWithAuth(addAuthFails: boolean): Promise<{ lines: string[]; calls: string[] }> {
  const workspace = await createTempWorkspace('guren-create-app-auth-next-steps-')
  try {
    const binDir = join(workspace.dir, 'bin')
    await mkdir(binDir)
    await writeFile(join(binDir, 'bun'), FAKE_BUN, 'utf8')
    await chmod(join(binDir, 'bun'), 0o755)
    const log = join(workspace.dir, 'bun-calls.log')

    const result = spawnSync(
      process.execPath,
      [CLI_PATH, 'my-app', '--auth', '--db', 'sqlite', '--mode', 'spa', '--agents', 'none'],
      {
        cwd: workspace.dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // consola drops below `warn` when it sees the NODE_ENV=test bun test sets.
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          CONSOLA_LEVEL: '3',
          FAKE_BUN_LOG: log,
          ...(addAuthFails ? { FAKE_ADD_AUTH_FAILS: '1' } : {}),
        },
      },
    )
    if (result.status !== 0) {
      throw new Error(`create-guren-app exited with ${result.status}:\n${result.stderr}`)
    }
    return {
      lines: `${result.stdout}${result.stderr}`.split('\n'),
      calls: (await readFile(log, 'utf8')).trim().split('\n'),
    }
  } finally {
    await workspace.cleanup()
  }
}

describe('create-guren-app --auth next steps', () => {
  it('does not suggest add auth once the scaffolder ran it', async () => {
    const { lines } = await scaffoldWithAuth(false)

    expect(lines.some((line) => line.includes('Authentication scaffolding added'))).toBe(true)
    expect(lines.some(isAddAuthEntry)).toBe(false)
  }, 30_000)

  // add auth adds pages and routes the shipped .guren/ does not list, and the
  // initial commit is made right after this.
  it('regenerates the generated types after add auth, and no longer lists codegen', async () => {
    const { lines, calls } = await scaffoldWithAuth(false)

    const addAuth = calls.findIndex((call) => call.endsWith(' add auth --force'))
    expect(addAuth).toBeGreaterThan(-1)
    expect(calls.indexOf('run codegen')).toBeGreaterThan(addAuth)
    expect(lines.some((line) => line.trimEnd().endsWith(' bun run codegen'))).toBe(false)
  }, 30_000)

  it('lists add auth once, and does not ask to install dependencies, when add auth failed', async () => {
    const { lines } = await scaffoldWithAuth(true)

    expect(lines.filter(isAddAuthEntry)).toHaveLength(1)
    expect(lines.some((line) => line.includes('Authentication scaffolding failed'))).toBe(true)
  }, 30_000)
})
