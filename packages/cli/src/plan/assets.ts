import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundlePlanPage, composePlanTemplate } from './page-bundle'

export interface PlanAsset {
  path: string
  source: string
}

const cache = new Map<string, PlanAsset>()

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

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
      if (!isMissing(error)) throw error
      tried.push(path)
    }
  }

  throw new Error(`Could not locate ${name} of the plan page shipped with @guren/cli. Tried:\n  ${tried.join('\n  ')}`)
}

/**
 * The page template with its script in place. `page/` sits beside this module only in
 * the source tree, and there the template is composed on every run, so nothing run from
 * source reads a build that has gone stale. The published package ships the composed
 * file under `assets/plan/` and no `page/`.
 */
export function readPlanTemplate(): PlanAsset {
  const name = 'index.html'
  const hit = cache.get(name)
  if (hit !== undefined) return hit

  const pageDir = fileURLToPath(new URL('./page/', import.meta.url))
  const path = join(pageDir, name)
  let html: string
  try {
    html = readFileSync(path, 'utf8')
  } catch (error) {
    if (!isMissing(error)) throw error
    return readPlanAsset(name)
  }
  const asset = { path, source: composePlanTemplate(html, bundlePlanPage(join(pageDir, 'main.ts'))) }
  cache.set(name, asset)
  return asset
}
