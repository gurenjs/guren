/**
 * The one rule for which file a relative or `@/` import lands on. `guren check`'s
 * architecture and route-wiring stages both resolve through it, so the two cannot
 * disagree about one import. A directory is never the resolved file.
 */

import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

/** Extensions a specifier without one may resolve to, in preference order. */
export const RESOLVED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']

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

export async function isFile(path: string): Promise<boolean> {
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

export interface ResolveImportOptions {
  /** A type-only import may land on a `.d.ts`; a runtime import may not. */
  declarations?: boolean
  probe?: FileProbe
}

/**
 * The file an import of the absolute `target` names, or `null` when none exists. `target`
 * is the specifier joined to its importer, before any extension guessing.
 */
export async function resolveImportPath(target: string, options: ResolveImportOptions = {}): Promise<string | null> {
  const probe = options.probe ?? isFile
  const declarations = options.declarations ?? false

  const found = await firstFile(fileCandidates(target, declarations), probe)
  if (found !== null) return found

  // A directory's `package.json` entry wins over its index, as in Node and TypeScript.
  const entry = await packageEntry(target, declarations)
  const entryFile = entry === null ? null : await firstFile(fileCandidates(entry, declarations), probe)
  return entryFile ?? firstFile(indexCandidates(target, declarations), probe)
}

function fileCandidates(target: string, declarations: boolean): string[] {
  const stripped = stripResolvedExtension(target)
  const source = swapExtension(target, RUNTIME_TO_SOURCE_EXTENSION)
  return [
    // Ahead of the specifier as written, so a stale compiled `auth.js` beside `auth.ts`
    // is never what gets judged.
    ...(source === null ? [] : [source]),
    target,
    ...RESOLVED_EXTENSIONS.map((ext) => `${target}${ext}`),
    ...(stripped === target ? [] : RESOLVED_EXTENSIONS.map((ext) => `${stripped}${ext}`)),
    ...(declarations ? [`${stripped}.d.ts`] : []),
  ]
}

function indexCandidates(target: string, declarations: boolean): string[] {
  const stripped = stripResolvedExtension(target)
  const directories = stripped === target ? [target] : [target, stripped]
  return directories.flatMap((directory) => [
    ...RESOLVED_EXTENSIONS.map((ext) => join(directory, `index${ext}`)),
    ...(declarations ? [join(directory, 'index.d.ts')] : []),
  ])
}

/** The path `package.json` names as the directory's entry; `exports` maps are not followed. */
async function packageEntry(directory: string, declarations: boolean): Promise<string | null> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  if (typeof manifest !== 'object' || manifest === null) return null
  const fields = declarations ? ['types', 'typings', 'module', 'main'] : ['module', 'main']
  for (const field of fields) {
    const value = (manifest as Record<string, unknown>)[field]
    if (typeof value === 'string' && value !== '') return resolve(directory, value)
  }
  return null
}

async function firstFile(candidates: readonly string[], probe: FileProbe): Promise<string | null> {
  for (const candidate of candidates) {
    if (await probe(candidate)) return candidate
  }
  return null
}

function stripResolvedExtension(path: string): string {
  const extension = extname(path)
  return RESOLVED_EXTENSIONS.includes(extension) ? path.slice(0, -extension.length) : path
}
