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

const sources = new Map<string, string>()

beforeAll(async () => {
  for (const file of await sourceFiles(SRC)) {
    sources.set(file.slice(SRC.length + 1), await readFile(file, 'utf8'))
  }
})

describe('NODE_ENV gate form', () => {
  // The deploy plugins bundle with `--define 'process.env.NODE_ENV="production"'`, which
  // substitutes that one exact expression: an optional chain after `env` is a different one,
  // so the gate silently becomes a runtime read that answers "not production" wherever
  // platform vars never reach the environment. Dev endpoints, debug pages, cookie `Secure`
  // and HSTS all depend on it, runtime behaviour is identical, and only the source can pin it.
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
  // The Vercel plugin injects the manifest with `define: { 'process.env.GUREN_VITE_MANIFEST' }`,
  // matched the same exact-expression way, so an optional chain, an indexed read, or a second
  // read site anywhere else disarms it silently. This pins both the form and the single site.
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
