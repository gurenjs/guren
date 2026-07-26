import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { createTempWorkspace } from './helpers'

const CLI_BIN_PATH = resolve(import.meta.dir, '../src/bin.ts')

async function runBin(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // `bun test` sets NODE_ENV=test, which drops consola to the warn level and
  // hides the usage output these assertions inspect. Real invocations do not.
  const { NODE_ENV: _testEnv, ...env } = process.env
  const proc = Bun.spawn(['bun', CLI_BIN_PATH, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

// consola renders `showUsage`'s markdown-style code spans as ANSI styling on
// a TTY, but leaves the literal backticks in place on CI's non-TTY stdout
// (e.g. "USAGE `guren [OPTIONS] ...`"). Strip both so assertions work in
// either environment.
function plainText(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(/`/g, '')
}

describe('guren CLI error reporting', () => {
  it('reports a failing command once and exits 1', async () => {
    const workspace = await createTempWorkspace('guren-cli-bin-error-')
    try {
      const { exitCode, stderr } = await runBin(['db:migrate'], workspace.dir)

      expect(exitCode).toBe(1)
      expect(countOccurrences(stderr, 'Could not find config/database')).toBe(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports an unknown command once, with usage, and exits 1', async () => {
    const workspace = await createTempWorkspace('guren-cli-bin-unknown-')
    try {
      const { exitCode, stdout, stderr } = await runBin(['definitely-not-a-command'], workspace.dir)

      expect(exitCode).toBe(1)
      expect(countOccurrences(stderr, 'Unknown command')).toBe(1)
      expect(plainText(stdout)).toContain('USAGE guren')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports a missing required argument once, with subcommand usage, and exits 1', async () => {
    const workspace = await createTempWorkspace('guren-cli-bin-missing-arg-')
    try {
      const { exitCode, stdout, stderr } = await runBin(['make:controller'], workspace.dir)

      expect(exitCode).toBe(1)
      expect(countOccurrences(stderr, 'Missing required positional argument')).toBe(1)
      expect(plainText(stdout)).toContain('USAGE guren make:controller')
    } finally {
      await workspace.cleanup()
    }
  })

  it('renders subcommand usage for `<command> --help` and exits 0', async () => {
    const workspace = await createTempWorkspace('guren-cli-bin-subhelp-')
    try {
      const { exitCode, stdout } = await runBin(['make:controller', '--help'], workspace.dir)

      expect(exitCode).toBe(0)
      const normalized = plainText(stdout)
      expect(normalized).toContain('USAGE guren make:controller')
      expect(normalized).toContain('Controller class name')
    } finally {
      await workspace.cleanup()
    }
  })

  it('renders root usage for `--help` and for no arguments, exiting 0', async () => {
    const workspace = await createTempWorkspace('guren-cli-bin-help-')
    try {
      const withFlag = await runBin(['--help'], workspace.dir)
      expect(withFlag.exitCode).toBe(0)
      expect(withFlag.stdout).toContain('Guren framework CLI utilities.')

      const withoutArgs = await runBin([], workspace.dir)
      expect(withoutArgs.exitCode).toBe(0)
      expect(withoutArgs.stdout).toContain('Guren framework CLI utilities.')
    } finally {
      await workspace.cleanup()
    }
  })
})
