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

/**
 * Registry of all known deprecations.
 */
export const deprecations: Deprecation[] = [
  // Deprecations will be added as APIs are deprecated.
  // Example:
  // {
  //   id: 'static-route-class',
  //   what: 'Static Route class (Route.get(), Route.post())',
  //   since: '0.2.0',
  //   removedIn: '1.0.0',
  //   replacement: 'Use router instance methods: router.get(), router.post()',
  //   async detect(cwd) { return [] },
  // },
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
