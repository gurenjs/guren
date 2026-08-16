import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripAnsi } from 'consola/utils'
import {
  CLI_BIN_PATH,
  CLI_DIST_BIN,
  SERVER_DIST_ENTRY,
  assertWorkspaceBuilt,
  createTempWorkspace,
} from './helpers'

const MANIFEST_PATH = join(import.meta.dir, '../package.json')

async function manifestVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as { version: string }
  return manifest.version
}

async function runBin(bin: string, args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  // `bun test` sets NODE_ENV=test, which drops consola below the log level
  // `--version` prints at. Real invocations do not.
  const { NODE_ENV: _testEnv, ...env } = process.env
  const proc = Bun.spawn(['bun', bin, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { exitCode, stdout: stripAnsi(stdout) }
}

describe('guren --version', () => {
  // The version is read relative to the entry file, so `src/` and `dist/`
  // are genuinely different resolutions; only the built entry answers the
  // question an installed app asks. Both run from a temp directory outside
  // the repo, where no workspace `package.json` can stand in for the CLI's.
  for (const [label, bin, artifacts] of [
    ['from source', CLI_BIN_PATH, [SERVER_DIST_ENTRY]],
    ['from the built entry', CLI_DIST_BIN, [SERVER_DIST_ENTRY, CLI_DIST_BIN]],
  ] as const) {
    it(`prints the version from package.json and exits 0 (${label})`, async () => {
      assertWorkspaceBuilt([...artifacts])
      const workspace = await createTempWorkspace('guren-cli-version-')
      try {
        const { exitCode, stdout } = await runBin(bin, ['--version'], workspace.dir)

        expect(exitCode).toBe(0)
        // Other packages can log to stdout during module load (@guren/orm's
        // duplicate-copy warning, for one), so assert the version is among
        // the output lines rather than that it is all of it.
        const lines = stdout.split('\n').map((line) => line.trim())
        expect(lines).toContain(await manifestVersion())
      } finally {
        await workspace.cleanup()
      }
    })
  }
})
