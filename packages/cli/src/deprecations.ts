/**
 * Framework-level deprecation warnings.
 *
 * Each deprecation targets a specific API, config, or pattern that will
 * be removed in a future version.
 */
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { discoverModelFiles } from './discovery'
import { extractClassDeclaration, findStaticClassProperty } from './model-parser'
import { parseSourceFile } from './parse-cache'

export interface Deprecation {
  /** Unique identifier */
  id: string
  /** What is deprecated */
  what: string
  /** Version when it was deprecated */
  since: string
  /** Version when it will be removed */
  removedIn: string
  /** What to use instead */
  replacement: string
  /** Detect usage in the project. Returns affected file paths. */
  detect(cwd: string): Promise<string[]>
}

async function detectModelStatic(cwd: string, property: string): Promise<string[]> {
  const files = await discoverModelFiles(cwd)
  const affected = await Promise.all(
    files.map(async (filePath) => {
      const source = await readFile(filePath, 'utf-8')
      // Same AST predicate `guren check`'s legacy rule uses, so the two
      // commands cannot drift on what counts as a declaration (and comments
      // or access modifiers neither fake nor hide one).
      const ast = parseSourceFile(source, filePath)
      for (const node of ast?.program.body ?? []) {
        const classDecl = extractClassDeclaration(node)
        if (classDecl && findStaticClassProperty(classDecl, property)) {
          return relative(cwd, filePath)
        }
      }
      return null
    }),
  )
  return affected.filter((file): file is string => file !== null)
}

/**
 * Registry of all known deprecations.
 */
export const deprecations: Deprecation[] = [
  {
    id: 'model-guarded',
    what: "Model 'static guarded' blacklist",
    since: '1.6.0',
    removedIn: '2.0.0',
    replacement:
      "Delete the declaration. The primary key is always stripped from mass assignment and credential columns "
      + "are denied by AuthenticatableModel; use 'static fillable = [...]' to allowlist the rest.",
    detect: (cwd) => detectModelStatic(cwd, 'guarded'),
  },
  {
    id: 'model-strict-fillable',
    what: "Model 'static strictFillable' flag",
    since: '1.6.0',
    removedIn: '2.0.0',
    replacement:
      'Delete the declaration — fillable is always strict. Each new throw is a field the model was silently '
      + 'dropping: add it to fillable or remove it from the payload.',
    detect: (cwd) => detectModelStatic(cwd, 'strictFillable'),
  },
]

/**
 * Check the project for deprecated API usage.
 */
export async function checkDeprecations(
  cwd: string,
): Promise<DeprecationWarning[]> {
  const warnings: DeprecationWarning[] = []

  for (const dep of deprecations) {
    const files = await dep.detect(cwd)
    if (files.length > 0) {
      warnings.push({
        id: dep.id,
        what: dep.what,
        since: dep.since,
        removedIn: dep.removedIn,
        replacement: dep.replacement,
        affectedFiles: files,
      })
    }
  }

  return warnings
}

export interface DeprecationWarning {
  id: string
  what: string
  since: string
  removedIn: string
  replacement: string
  affectedFiles: string[]
}
