import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Drives the guard in real processes, the two the unit tests can only simulate:
 * `bun --hot`, which re-evaluates the module graph against a surviving
 * `globalThis`, and a bundle, which inlines every copy at one `import.meta.url`.
 * A guard that trusts the identity in both directions goes quiet on the bundle.
 */

const ORM_SRC = join(import.meta.dir, '../src')
const GUARD = join(ORM_SRC, 'instance-guard.ts')
const WARNING = '2 copies of @guren/orm'
/** Four waits at this budget stay inside the test timeout below, which skips `finally`. */
const WAIT_TIMEOUT_MS = 10_000

/** A byte-identical guard at its own path: what a second installed copy looks like. */
function copyGuardInto(dir: string): string {
  mkdirSync(dir, { recursive: true })
  copyFileSync(GUARD, join(dir, 'instance-guard.ts'))
  copyFileSync(join(ORM_SRC, 'hot-reload-runtime.ts'), join(dir, 'hot-reload-runtime.ts'))
  return join(dir, 'instance-guard.ts')
}

function importLines(paths: string[]): string {
  return paths.map((path) => `import ${JSON.stringify(path)}`).join('\n')
}

function entrySource(tag: string, imports: string[]): string {
  return `${importLines(imports)}
console.log('READY:${tag}')
setInterval(() => {}, 1_000)
`
}

/** The environment a user's dev server has, minus any silencing this suite runs under. */
function envWithoutQuiet(): Record<string, string | undefined> {
  const { GUREN_QUIET_DUPLICATE_ORM: _silenced, ...rest } = process.env
  return rest
}

/** Output of a run that reached the end: a crash before the guard is silent too. */
async function runToCompletion(dir: string, file: string): Promise<string> {
  const proc = Bun.spawn(['bun', file], { cwd: dir, env: envWithoutQuiet(), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const output = stdout + stderr

  expect(await proc.exited, `${file} exited non-zero:\n${output}`).toBe(0)
  return output
}

describe('instance guard in a real process', () => {
  test('a bun --hot reload of one copy is silent, and a second copy still warns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guren-orm-hot-'))
    const duplicate = copyGuardInto(join(dir, 'copy'))
    const entry = join(dir, 'entry.ts')
    writeFileSync(entry, entrySource('first', [GUARD]))

    const proc = Bun.spawn(['bun', '--hot', 'entry.ts'], {
      cwd: dir,
      env: envWithoutQuiet(),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    let output = ''
    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder()
      for await (const chunk of stream) output += decoder.decode(chunk, { stream: true })
    }
    void pump(proc.stdout).catch(() => {})
    void pump(proc.stderr).catch(() => {})

    const waitFor = async (needle: string): Promise<void> => {
      const deadline = Date.now() + WAIT_TIMEOUT_MS
      while (!output.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}\n--- output ---\n${output}`)
        await Bun.sleep(50)
      }
    }

    try {
      await waitFor('READY:first')
      expect(output).not.toContain('[guren/orm]')

      // Rewriting the entry re-evaluates the guard it imports: the same copy, at the
      // same URL, against a `globalThis` that still holds its marker.
      writeFileSync(entry, entrySource('reloaded', [GUARD]))
      await waitFor('READY:reloaded')
      expect(output).not.toContain('[guren/orm]')

      writeFileSync(entry, entrySource('duplicated', [GUARD, duplicate]))
      await waitFor('READY:duplicated')
      await waitFor(WARNING)
    } finally {
      proc.kill()
      await proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a bundle warns for two inlined copies and stays silent for one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guren-orm-bundle-'))
    const duplicate = copyGuardInto(join(dir, 'copy'))

    try {
      for (const [name, imports] of [
        ['single', [GUARD]],
        ['double', [GUARD, duplicate]],
      ] as const) {
        writeFileSync(join(dir, `${name}.ts`), `${importLines([...imports])}\n`)
        const built = await Bun.build({ entrypoints: [join(dir, `${name}.ts`)], target: 'bun', outdir: dir })
        expect(built.success).toBe(true)
      }

      // Only the absence of a reloading runtime tells the repeat apart from one
      // module evaluated twice.
      expect(await runToCompletion(dir, 'single.js')).not.toContain('[guren/orm]')
      expect(await runToCompletion(dir, 'double.js')).toContain(WARNING)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
