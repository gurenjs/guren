/**
 * Framework-level deprecation warnings.
 *
 * Each deprecation targets a specific API, config, or pattern that will
 * be removed in a future version.
 */

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
  const { discoverModelFiles } = await import('./discovery')
  const { readFile } = await import('node:fs/promises')
  const { relative } = await import('node:path')
  const pattern = new RegExp(`\\bstatic\\s+(override\\s+)?(readonly\\s+)?${property}\\b`)

  const affected: string[] = []
  for (const filePath of await discoverModelFiles(cwd)) {
    const source = await readFile(filePath, 'utf-8')
    if (pattern.test(source)) {
      affected.push(relative(cwd, filePath))
    }
  }
  return affected
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
