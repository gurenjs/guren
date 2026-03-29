/**
 * Codemod infrastructure for automated code transformations during upgrades.
 *
 * Each codemod targets a specific version range and transforms user code
 * to adapt to breaking changes.
 */

export interface Codemod {
  /** Unique identifier, e.g. 'rename-static-route' */
  id: string
  /** Human-readable description of what this codemod does */
  description: string
  /** Version range this codemod applies to (from → to) */
  fromVersion: string
  toVersion: string
  /** Detect whether this codemod is needed. Returns affected file paths. */
  detect(cwd: string): Promise<string[]>
  /** Apply the transformation. Returns number of files modified. */
  apply(cwd: string): Promise<number>
}

/**
 * Registry of all available codemods, ordered by version.
 * Add new codemods here as breaking changes are introduced.
 */
export const codemods: Codemod[] = [
  // Example codemod (commented out as reference for future use):
  // {
  //   id: 'rename-static-route',
  //   description: 'Replace static Route.get() calls with router instance methods',
  //   fromVersion: '0.2.0',
  //   toVersion: '0.3.0',
  //   async detect(cwd) {
  //     // scan for Route.get/post/put/delete patterns
  //     return []
  //   },
  //   async apply(cwd) {
  //     // replace patterns
  //     return 0
  //   },
  // },
]

/**
 * Find codemods applicable for upgrading between two versions.
 */
export function findApplicableCodemods(from: string, to: string): Codemod[] {
  return codemods.filter((c) => {
    return compareVersions(c.fromVersion, from) >= 0 && compareVersions(c.toVersion, to) <= 0
  })
}

/**
 * Run all applicable codemods in sequence.
 */
export async function runCodemods(
  cwd: string,
  from: string,
  to: string,
  options: { dryRun?: boolean } = {},
): Promise<CodemodResult[]> {
  const applicable = findApplicableCodemods(from, to)
  const results: CodemodResult[] = []

  for (const codemod of applicable) {
    const affectedFiles = await codemod.detect(cwd)
    if (affectedFiles.length === 0) {
      results.push({ id: codemod.id, description: codemod.description, status: 'skipped', filesAffected: 0 })
      continue
    }

    if (options.dryRun) {
      results.push({
        id: codemod.id,
        description: codemod.description,
        status: 'pending',
        filesAffected: affectedFiles.length,
        files: affectedFiles,
      })
    } else {
      const count = await codemod.apply(cwd)
      results.push({ id: codemod.id, description: codemod.description, status: 'applied', filesAffected: count })
    }
  }

  return results
}

export interface CodemodResult {
  id: string
  description: string
  status: 'applied' | 'skipped' | 'pending'
  filesAffected: number
  files?: string[]
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na !== nb) return na - nb
  }
  return 0
}
