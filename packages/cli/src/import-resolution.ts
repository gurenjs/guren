/**
 * The one rule for which file a relative or `@/` import lands on. `guren check`'s
 * architecture and route-wiring stages both resolve through it, so the two cannot
 * disagree about one import. A directory is never the resolved file.
 */

import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { IMPORTABLE_EXTENSIONS } from './discovery'

/** Extensions a specifier without one may resolve to; the set's insertion order is the preference. */
const RESOLVED_EXTENSIONS = [...IMPORTABLE_EXTENSIONS]

/**
 * Source extension → the runtime extension it is emitted as. Apps following Node's ESM
 * rules import the *emitted* path (`'./auth.js'` for `auth.ts` on disk), and a printed
 * suggestion should spell the import the same way.
 */
export const SOURCE_TO_RUNTIME_EXTENSION: Record<string, string> = {
  '.ts': '.js',
  '.tsx': '.jsx',
  '.mts': '.mjs',
}

export const RUNTIME_TO_SOURCE_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(SOURCE_TO_RUNTIME_EXTENSION).map(([source, runtime]) => [runtime, source]),
)

/** `path` with its extension swapped per `map`, or `null` if it isn't in `map`. */
export function swapExtension(path: string, map: Record<string, string>): string | null {
  const extension = extname(path)
  const swapped = map[extension]
  return swapped ? `${path.slice(0, -extension.length)}${swapped}` : null
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export type FileProbe = (path: string) => Promise<boolean>

/** An {@link isFile} that stats each path once, for a run resolving many imports of one file. */
export function cachedFileProbe(): FileProbe {
  const seen = new Map<string, Promise<boolean>>()
  return (path) => {
    let hit = seen.get(path)
    if (!hit) {
      hit = isFile(path)
      seen.set(path, hit)
    }
    return hit
  }
}

interface ResolveImportOptions {
  /** A type-only import may land on a `.d.ts`; a runtime import may not. */
  declarations?: boolean
  probe?: FileProbe
}

/**
 * The file an import of the absolute `target` names, or `null` when none exists. `target`
 * is the specifier joined to its importer, before any extension guessing.
 */
export async function resolveImportPath(target: string, options: ResolveImportOptions = {}): Promise<string | null> {
  const { declarations = false, probe = isFile } = options
  return (await firstFile(fileCandidates(target, declarations), probe)) ?? resolveDirectoryImport(target, options)
}

/**
 * The file an import of `directory` as a directory lands on: its `package.json` entry,
 * then its index. Bun and TypeScript read `main` ahead of the index, and neither reads
 * `module` or `exports` for a relative import; TypeScript tries `types`/`typings` first.
 */
export async function resolveDirectoryImport(directory: string, options: ResolveImportOptions = {}): Promise<string | null> {
  const { declarations = false, probe = isFile } = options
  for (const entry of await packageEntries(directory, declarations, probe)) {
    const file = await firstFile([...fileCandidates(entry, declarations), ...indexCandidates(entry, declarations)], probe)
    if (file !== null) return file
  }
  return firstFile(indexCandidates(directory, declarations), probe)
}

function fileCandidates(target: string, declarations: boolean): string[] {
  const extension = extname(target)
  const stripped = RESOLVED_EXTENSIONS.includes(extension) ? target.slice(0, -extension.length) : target
  const source = RUNTIME_TO_SOURCE_EXTENSION[extension]
  return [
    ...new Set([
      // Ahead of the specifier as written, so a stale compiled `auth.js` beside `auth.ts`
      // is never what gets judged.
      ...(source === undefined ? [] : [`${stripped}${source}`]),
      target,
      ...RESOLVED_EXTENSIONS.map((ext) => `${stripped}${ext}`),
      ...(declarations ? [`${stripped}.d.ts`] : []),
    ]),
  ]
}

function indexCandidates(directory: string, declarations: boolean): string[] {
  return [
    ...RESOLVED_EXTENSIONS.map((ext) => join(directory, `index${ext}`)),
    ...(declarations ? [join(directory, 'index.d.ts')] : []),
  ]
}

async function packageEntries(directory: string, declarations: boolean, probe: FileProbe): Promise<string[]> {
  const manifestPath = join(directory, 'package.json')
  if (!(await probe(manifestPath))) return []
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    return []
  }
  if (typeof manifest !== 'object' || manifest === null) return []
  const fields = declarations ? ['types', 'typings', 'main'] : ['main']
  return fields.flatMap((field) => {
    const value = (manifest as Record<string, unknown>)[field]
    return typeof value === 'string' && value !== '' ? [resolve(directory, value)] : []
  })
}

async function firstFile(candidates: readonly string[], probe: FileProbe): Promise<string | null> {
  for (const candidate of candidates) {
    if (await probe(candidate)) return candidate
  }
  return null
}
