import { beforeAll, describe, expect, test } from 'bun:test'
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

// Walked and read once — both scans below assert over the same tree, with
// their own per-file filters.
const sources = new Map<string, string>()

beforeAll(async () => {
  for (const file of await sourceFiles(SRC)) {
    sources.set(file.slice(SRC.length + 1), await readFile(file, 'utf8'))
  }
})

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
  test('every NODE_ENV read uses the literal form the bundlers substitute', () => {
    const offenders: string[] = []

    for (const [file, source] of sources) {
      if (source.includes('process.env?.NODE_ENV')) {
        offenders.push(file)
      }
    }

    expect(offenders).toEqual([])
  })
})

describe('GUREN_VITE_MANIFEST read form', () => {
  // The Vercel plugin injects the client manifest by substituting the read
  // with `define: { 'process.env.GUREN_VITE_MANIFEST': ... }` — the same
  // exact-expression matching as the NODE_ENV rule above, so the same two
  // drifts would silently disarm it: an optional chain or an indexed read
  // (different expressions, no substitution), or a second read site somewhere
  // else (never substituted, answering undefined on serverless). The rule
  // lives in vite-manifest.ts; this pins both the form and the single site.
  test('the manifest injection is read once, in vite-manifest.ts, as the literal expression', () => {
    const readers: string[] = []

    for (const [file, source] of sources) {
      // Test files exercise the variable freely; only shipped code is bundled.
      if (file.endsWith('.test.ts')) continue

      const reads = source.match(/process\.env\s*[?.[]+\s*['"]?GUREN_VITE_MANIFEST/g) ?? []
      if (reads.length === 0) continue

      readers.push(file)
      expect(reads).toEqual(['process.env.GUREN_VITE_MANIFEST'])
    }

    expect(readers).toEqual(['http/vite-manifest.ts'])
  })
})
