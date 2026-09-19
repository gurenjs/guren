import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface PlanAsset {
  path: string
  source: string
}

const cache = new Map<string, PlanAsset>()

/**
 * A file under `assets/plan/`, read once per process. The chunk this module is bundled
 * into sits at `dist/`, one hop below the package root; the source sits at `src/plan/`,
 * two. Both are tried rather than probed with `existsSync`, which reports a permission
 * error on a parent as absence.
 */
export function readPlanAsset(name: string): PlanAsset {
  const hit = cache.get(name)
  if (hit !== undefined) return hit

  const tried: string[] = []
  for (const root of ['../assets/plan/', '../../assets/plan/']) {
    const path = fileURLToPath(new URL(root + name, import.meta.url))
    try {
      const asset = { path, source: readFileSync(path, 'utf8') }
      cache.set(name, asset)
      return asset
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      tried.push(path)
    }
  }

  throw new Error(`Could not locate ${name} of the plan page shipped with @guren/cli. Tried:\n  ${tried.join('\n  ')}`)
}
