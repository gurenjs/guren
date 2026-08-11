import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '../src')

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return entry.name.endsWith('.ts') ? [path] : []
    }),
  )
  return files.flat()
}

describe('NODE_ENV gate form', () => {
  // The deploy plugins bundle server code with
  // `--define 'process.env.NODE_ENV="production"'`, which substitutes that one
  // exact expression. Inserting an optional chain after `env` makes it a
  // different expression, so the substitution misses and the gate silently
  // becomes a runtime read — and on hosts where platform vars never reach the
  // process environment, that read answers "not production". Every production
  // gate in this package depends on it: dev endpoints, debug pages, cookie
  // `Secure` flags, HSTS.
  //
  // Runtime behaviour is identical either way, so nothing but the source can
  // pin this. It is asserted package-wide rather than per file because the one
  // gate that drifted was the one nobody had written a per-file pin for.
  //
  // Scoped to NODE_ENV deliberately: `process.env?.SOMETHING_ELSE` is not a
  // `--define` target and a blanket rule would collect carve-outs and rot.
  test('every NODE_ENV read uses the literal form the bundlers substitute', async () => {
    const offenders: string[] = []

    for (const file of await sourceFiles(SRC)) {
      const source = await readFile(file, 'utf8')
      if (source.includes('process.env?.NODE_ENV')) {
        offenders.push(file.slice(SRC.length + 1))
      }
    }

    expect(offenders).toEqual([])
  })
})
