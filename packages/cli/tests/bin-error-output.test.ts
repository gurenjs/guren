import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { stripAnsi } from 'consola/utils'
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

// consola renders `showUsage`'s markdown-style code spans as ANSI styling on
// a TTY, but leaves the literal backticks in place on CI's non-TTY stdout
// (e.g. "USAGE `guren [OPTIONS] ...`"). Strip both so assertions work in
// either environment.
function plainText(text: string): string {
  return stripAnsi(text).replace(/`/g, '')
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

  it('treats a name inherited from Object.prototype as an unknown command', async () => {
    const workspace = await createTempWorkspace('guren-cli-bin-proto-')
    try {
      const results = await Promise.all(
        ['valueOf', 'toString', 'constructor'].map((name) => runBin([name], workspace.dir)),
      )

      for (const { exitCode, stderr } of results) {
        expect(exitCode).toBe(1)
        expect(countOccurrences(stderr, 'Unknown command')).toBe(1)
      }
    } finally {
      await workspace.cleanup()
    }
  })

  it('runs the command a stray flag precedes without reporting it as unknown', async () => {
    const workspace = await createTempWorkspace('guren-cli-bin-leading-flag-')
    try {
      const { exitCode, stderr } = await runBin(['--zzz', 'model:list'], workspace.dir)

      // citty dispatches on the first non-flag argument, so `model:list` runs.
      expect(stderr).toContain('No models found')
      expect(countOccurrences(stderr, 'Unknown command')).toBe(0)
      expect(exitCode).toBe(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports an unknown command a stray flag precedes, naming the command', async () => {
    const workspace = await createTempWorkspace('guren-cli-bin-leading-flag-unknown-')
    try {
      const { exitCode, stderr } = await runBin(['--zzz', 'definitely-not-a-command'], workspace.dir)

      expect(exitCode).toBe(1)
      expect(countOccurrences(stderr, 'Unknown command')).toBe(1)
      expect(stderr).toContain('definitely-not-a-command')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports flags without a command once, with usage, and exits 1', async () => {
    const workspace = await createTempWorkspace('guren-cli-bin-no-command-')
    try {
      const { exitCode, stdout, stderr } = await runBin(['--zzz'], workspace.dir)

      expect(exitCode).toBe(1)
      expect(countOccurrences(stderr, 'No command specified')).toBe(1)
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
      const [withFlag, withoutArgs] = await Promise.all([
        runBin(['--help'], workspace.dir),
        runBin([], workspace.dir),
      ])

      expect(withFlag.exitCode).toBe(0)
      expect(plainText(withFlag.stdout)).toContain('Guren framework CLI utilities.')

      expect(withoutArgs.exitCode).toBe(0)
      expect(plainText(withoutArgs.stdout)).toContain('Guren framework CLI utilities.')
    } finally {
      await workspace.cleanup()
    }
  })
})
