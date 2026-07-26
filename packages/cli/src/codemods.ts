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

/**
 * Compare two semver versions, prerelease tags included.
 *
 * Splitting on '.' alone turns `1.0.0-rc.4` into `[1, 0, NaN, 4]`, and a NaN
 * difference is neither greater nor less than zero — so every comparison
 * involving a prerelease used to answer "unordered", which reads as "equal"
 * to callers that only test for `< 0` or `> 0`. Guren shipped its whole 1.0
 * line as `1.0.0-rc.N`, so that covered the versions most likely to be
 * compared. Returns NaN only when a version is not numeric at all.
 */
export function compareVersions(a: string, b: string): number {
  const [mainA = '', preA] = splitPrerelease(a)
  const [mainB = '', preB] = splitPrerelease(b)

  const numbersA = mainA.split('.').map(Number)
  const numbersB = mainB.split('.').map(Number)
  for (let i = 0; i < Math.max(numbersA.length, numbersB.length); i++) {
    const na = numbersA[i] ?? 0
    const nb = numbersB[i] ?? 0
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      return Number.NaN
    }
    if (na !== nb) return na - nb
  }

  // A release outranks any prerelease of the same version (1.0.0 > 1.0.0-rc.4).
  if (preA === undefined && preB === undefined) return 0
  if (preA === undefined) return 1
  if (preB === undefined) return -1

  return comparePrerelease(preA, preB)
}

function splitPrerelease(version: string): [string, string | undefined] {
  const index = version.indexOf('-')
  return index === -1 ? [version, undefined] : [version.slice(0, index), version.slice(index + 1)]
}

function comparePrerelease(a: string, b: string): number {
  const partsA = a.split('.')
  const partsB = b.split('.')

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const pa = partsA[i]
    const pb = partsB[i]
    // Fewer identifiers sorts lower (rc.1 < rc.1.1).
    if (pa === undefined) return -1
    if (pb === undefined) return 1
    if (pa === pb) continue

    const na = Number(pa)
    const nb = Number(pb)
    const numericA = !Number.isNaN(na)
    const numericB = !Number.isNaN(nb)
    if (numericA && numericB) return na - nb
    // Numeric identifiers sort lower than alphanumeric ones.
    if (numericA) return -1
    if (numericB) return 1
    return pa < pb ? -1 : 1
  }

  return 0
}
