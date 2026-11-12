import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { createTempWorkspace, GIT_IDENTITY } from './helpers'

const CLI_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

// Stands in for `bun install`, `bun run codegen` and the app's `guren make:migration`,
// which writes the folder drizzle-kit would unless FAKE_NOTHING_TO_MIGRATE is set
// (drizzle-kit exits 0 either way). Each call is logged.
const FAKE_BUN = `#!/bin/sh
echo "$*" >> "$FAKE_BUN_LOG"
if [ "$2" = make:migration ] && [ -z "$FAKE_NOTHING_TO_MIGRATE" ]; then
  mkdir -p "db/migrations/20260101000000_$3" && echo '-- sql' > "db/migrations/20260101000000_$3/migration.sql"
fi
exit 0
`

interface Scaffolded {
  lines: string[]
  calls: string[]
  committed: string[]
}

// A subprocess, for the reason tests/auth-next-steps.test.ts gives: a `bun` shim
// put on PATH at runtime is not reached by an in-process spawnSync.
async function scaffold(flags: string[], env: Record<string, string> = {}): Promise<Scaffolded> {
  const workspace = await createTempWorkspace('guren-create-app-initial-migration-')
  try {
    const binDir = join(workspace.dir, 'bin')
    await mkdir(binDir)
    await writeFile(join(binDir, 'bun'), FAKE_BUN, 'utf8')
    await chmod(join(binDir, 'bun'), 0o755)
    const log = join(workspace.dir, 'bun-calls.log')

    const result = spawnSync(
      process.execPath,
      [CLI_PATH, 'my-app', '--git', '--db', 'sqlite', '--mode', 'spa', '--agents', 'none', ...flags],
      {
        cwd: workspace.dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          CONSOLA_LEVEL: '3',
          FAKE_BUN_LOG: log,
          ...GIT_IDENTITY,
          ...env,
        },
      },
    )
    if (result.status !== 0) {
      throw new Error(`create-guren-app exited with ${result.status}:\n${result.stderr}`)
    }
    const tree = spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: join(workspace.dir, 'my-app'), encoding: 'utf8' })
    return {
      lines: `${result.stdout}${result.stderr}`.split('\n'),
      // --no-install calls bun for nothing, so the log may not exist.
      calls: (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean),
      committed: tree.stdout.split('\n'),
    }
  } finally {
    await workspace.cleanup()
  }
}

// With or without the `[log]` prefix consola's basic reporter adds.
function suggestsDbMake(lines: string[]): boolean {
  return lines.some((line) => line.trimEnd().endsWith(' bun run db:make'))
}

function migrationCalls(calls: string[]): string[] {
  return calls.filter((call) => call.includes(' make:migration '))
}

describe('create-guren-app first migration', () => {
  it('generates the blog blueprint\'s first migration before codegen and commits it', async () => {
    const { lines, calls, committed } = await scaffold(['--blueprint', 'blog'])

    const generated = calls.findIndex((call) => call.endsWith(' make:migration create_users_and_posts'))
    expect(generated).toBeGreaterThan(calls.indexOf('install'))
    expect(calls.indexOf('run codegen')).toBeGreaterThan(generated)
    expect(committed).toContain('db/migrations/20260101000000_create_users_and_posts/migration.sql')
    expect(suggestsDbMake(lines)).toBe(false)
    expect(lines.some((line) => line.trimEnd().endsWith(' bun run db:migrate'))).toBe(true)
  }, 30_000)

  // drizzle-kit exits 0 for "No schema changes, nothing to migrate." too.
  it('keeps db:make in the next steps when the command wrote no migration', async () => {
    const { lines, calls } = await scaffold(['--blueprint', 'blog'], { FAKE_NOTHING_TO_MIGRATE: '1' })

    expect(migrationCalls(calls)).toHaveLength(1)
    expect(lines.some((line) => line.includes('The first migration was not generated'))).toBe(true)
    expect(suggestsDbMake(lines)).toBe(true)
  }, 30_000)

  it('leaves the migration to db:make under --no-install', async () => {
    const { lines, calls } = await scaffold(['--blueprint', 'blog', '--no-install'])

    expect(migrationCalls(calls)).toEqual([])
    expect(suggestsDbMake(lines)).toBe(true)
  }, 30_000)

  // The tutorial's first `db:make` creates the shipped users table beside the reader's own.
  it('generates none for the default blueprint', async () => {
    const { lines, calls } = await scaffold([])

    expect(calls).toContain('install')
    expect(migrationCalls(calls)).toEqual([])
    expect(suggestsDbMake(lines)).toBe(true)
  }, 30_000)
})
