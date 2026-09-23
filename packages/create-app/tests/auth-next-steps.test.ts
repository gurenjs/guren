import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { createTempWorkspace } from './helpers'

const CLI_PATH = new URL('../src/cli.ts', import.meta.url).pathname

// Matches the list entry under either consola reporter (the basic one, picked
// in CI, prefixes `[log]`), and not the warning that names the same command.
function isAddAuthEntry(line: string): boolean {
  return line.trimEnd().endsWith(' bunx guren add auth')
}

// Stands in for `bun install` and the app's `guren add auth`, which is the one
// that writes the migration, in the layout the pinned drizzle-kit 1.x writes.
// FAKE_ADD_AUTH picks how that step ends.
const FAKE_BUN = `#!/bin/sh
echo "$*" >> "$PWD/.fake-bun-calls"
if [ "$2" = add ] && [ "$3" = auth ]; then
  migration=db/migrations/20260923000000_create_users_sessions_tables
  case "$FAKE_ADD_AUTH" in
    migration) mkdir -p "$migration" && : > "$migration/migration.sql" && echo '{}' > "$migration/snapshot.json" ;;
    fail) exit 1 ;;
  esac
fi
exit 0
`

type AddAuthOutcome = 'migration' | 'no-migration' | 'fail'

// A subprocess rather than the in-process command: Bun's spawnSync without an
// explicit `env` resolves `bun` against the PATH the process started with, so
// a shim put on PATH at runtime is never reached.
async function scaffoldWithAuth(outcome: AddAuthOutcome): Promise<{ lines: string[]; calls: string }> {
  const workspace = await createTempWorkspace(`guren-create-app-auth-next-steps-${outcome}-`)
  try {
    const binDir = join(workspace.dir, 'bin')
    await mkdir(binDir)
    await writeFile(join(binDir, 'bun'), FAKE_BUN, 'utf8')
    await chmod(join(binDir, 'bun'), 0o755)

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
          FAKE_ADD_AUTH: outcome,
        },
      },
    )
    expect(result.status).toBe(0)

    return {
      lines: `${result.stdout}${result.stderr}`.split('\n'),
      calls: await readFile(join(workspace.dir, 'my-app/.fake-bun-calls'), 'utf8'),
    }
  } finally {
    await workspace.cleanup()
  }
}

describe('create-guren-app --auth next steps', () => {
  it('does not suggest add auth once it ran, and drops db:make when its migration exists', async () => {
    const { lines, calls } = await scaffoldWithAuth('migration')

    expect(calls).toContain('add auth --force')
    expect(lines.some((line) => line.includes('Authentication scaffolding added'))).toBe(true)
    expect(lines.some(isAddAuthEntry)).toBe(false)

    const usersStep = lines.find((line) => line.includes('Set up the users table'))
    expect(usersStep).toContain('bun run db:migrate && bun run db:seed')
    expect(usersStep).not.toContain('db:make')
  }, 30_000)

  it('keeps db:make in the users table step when add auth generated no migration', async () => {
    const { lines, calls } = await scaffoldWithAuth('no-migration')

    expect(calls).toContain('add auth --force')
    expect(lines.some(isAddAuthEntry)).toBe(false)
    expect(lines.find((line) => line.includes('Set up the users table'))).toContain(
      'bun run db:make && bun run db:migrate && bun run db:seed',
    )
  }, 30_000)

  it('lists add auth once, beside a warning that does not ask to install dependencies, when add auth failed', async () => {
    const { lines, calls } = await scaffoldWithAuth('fail')

    expect(calls).toContain('add auth --force')
    expect(lines.filter(isAddAuthEntry)).toHaveLength(1)
    expect(lines.some((line) => line.includes('included automatically'))).toBe(false)

    const warning = lines.find((line) => line.includes('Authentication scaffolding failed'))
    expect(warning).toBeDefined()
    expect(warning).not.toContain('after installing dependencies')
  }, 30_000)
})
